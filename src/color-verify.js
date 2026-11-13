'use strict';
// 变换语义的独立校验。只依赖纯 JS 参考引擎（矩阵 / TRC / Bradford / Lab / CIEDE2000），
// 不调用 lcms2，也不做“同一库反向转换”当自证。输出结构化执行证据，供自动验收与界面共用。
//
// 证据分三类：
//   color  —— 实际输出像素与独立参考模型的 Lab/ΔE2000 偏差
//   alpha  —— 透明通道逐采样与源像素的一致性
//   profile—— 实际采用的源/目标配置 SHA-256 是否等于期望身份
//
const { RefRGB, deltaE2000 } = require('./ref-engine');

const REFERENCE_INTENTS = ['relative-colorimetric', 'absolute-colorimetric'];

function createRef(icc) {
  try { return new RefRGB(icc); } catch (e) { return null; }
}

// 从原始采样缓冲读出归一化 RGB 与 alpha（PNG/ICC 标准大端）
function readSample(buf, index, bits, channels) {
  const bpe = bits / 8;
  const o = index * channels * bpe;
  const raw = [];
  for (let c = 0; c < 3; c++) {
    raw.push(bits === 8 ? buf[o + c] : ((buf[o + c * 2] << 8) | buf[o + c * 2 + 1]));
  }
  const scale = bits === 8 ? 255 : 65535;
  const rgb01 = raw.map((v) => v / scale);
  const alpha01 = channels === 4
    ? (bits === 8 ? buf[o + 3] / 255 : ((buf[o + 6] << 8) | buf[o + 7]) / 65535)
    : null;
  return { rgb01, alpha01, raw };
}

function quantizedDiff(a01, b01, bits) {
  const scale = bits === 8 ? 255 : 65535;
  let m = 0;
  for (let i = 0; i < 3; i++) m = Math.max(m, Math.abs(Math.round(a01[i] * scale) - Math.round(b01[i] * scale)));
  return m;
}

function sortedStats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / Math.max(1, values.length);
  return {
    samples: values.length,
    mean,
    max: sorted.length ? sorted[sorted.length - 1] : 0,
    p95: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0,
  };
}

function pickSamples(width, height, step) {
  const total = width * height;
  const stride = Math.max(1, Math.floor(total / (step || 4096)));
  const out = [];
  for (let i = 0; i < total; i += stride) out.push(i);
  return out;
}

// 核心校验：把实际输出与独立参考模型逐采样比对，并核对配置身份与 alpha。
function verifyTransform(options) {
  const {
    srcIcc, dstIcc, srcPixels, outPixels,
    width, height, bits, channels, intent,
    gamutMode = 'clip', alarmColor = [255, 0, 255],
    actualSrcIcc = srcIcc, expectedSrcIcc = null,
    actualDstIcc = dstIcc, expectedDstIcc = null,
    sampleLimit = 4096,
    colorToleranceDE = 0.75,
    alphaTolerance = 0,
    requireColorVerification = false,
  } = options;
  if (![8, 16].includes(bits)) throw new Error('仅支持 8/16 位采样');
  if (![3, 4].includes(channels)) throw new Error('仅支持 3/4 通道采样');

  const srcRef = createRef(srcIcc);
  const dstRef = createRef(dstIcc);
  const matrixShaper = !!(srcRef && dstRef);
  const intentDerivable = REFERENCE_INTENTS.includes(intent);
  const referenceApplicable = matrixShaper && intentDerivable;
  const notApplicableReason = !matrixShaper
    ? '源或目标配置不是 matrix-shaper，纯 JS 参考引擎不适用'
    : !intentDerivable
      ? `参考引擎仅独立推导相对/绝对色度，当前意图: ${intent}`
      : null;

  const alarmTolerance = bits === 8 ? 0 : 300;
  const atAlarm = (rgb01) => {
    const scale = bits === 8 ? 255 : 65535;
    const rounded = rgb01.map((v) => Math.round(v * scale));
    return rounded.every((v, i) => Math.abs(v - alarmColor[i] * (scale / 255)) <= alarmTolerance);
  };

  const samples = pickSamples(width, height, sampleLimit);
  const colorRows = [];
  const deValues = [];
  const encodedDiffs = [];
  let alarmExpected = 0;
  let alarmMissing = 0;
  let alarmUnexpected = 0;

  for (const i of samples) {
    const src = readSample(srcPixels, i, bits, channels);
    const out = readSample(outPixels, i, bits, channels);
    if (channels === 4 && (src.alpha01 == null || src.alpha01 < 0.5)) continue;
    if (!referenceApplicable) {
      colorRows.push({ index: i, srcRgb01: src.rgb01, outRgb01: out.rgb01 });
      continue;
    }
    // 参考模型只用源编码值与 ICC 语义推导，不接触 lcms
    const ref = srcRef.convertTo(dstRef, src.rgb01, { intent });
    const refClamped = ref.rgb01;

    // 品红警报模式：超色域像素的实际输出必须是警报色；域内像素不得被误标
    const isAlarm = gamutMode === 'gamut-check' ? atAlarm(out.rgb01) : null;
    if (gamutMode === 'gamut-check') {
      if (!ref.inGamut) {
        alarmExpected++;
        if (!isAlarm) alarmMissing++;
      } else if (isAlarm) {
        alarmUnexpected++;
      }
    }

    const outLab = dstRef.rgbToLab(out.rgb01);
    const refLab = dstRef.rgbToLab(refClamped);
    const de = deltaE2000(refLab, outLab);
    // 警报模式下超界样本的输出被有意替换为警报色，色差不参与容差判定，仅由 gamut 证据核对
    const alarmExcluded = gamutMode === 'gamut-check' && !ref.inGamut;
    if (!alarmExcluded) deValues.push(de);
    const encoded = quantizedDiff(out.rgb01, refClamped, bits);
    if (!alarmExcluded) encodedDiffs.push(encoded);
    colorRows.push({
      index: i,
      srcRgb01: src.rgb01,
      outRgb01: out.rgb01,
      refRgb01: refClamped,
      refInGamut: ref.inGamut,
      isAlarm,
      deltaE2000: de,
      encodedMaxDiff: encoded,
    });
  }

  const color = {
    referenceApplicable,
    referenceEngine: 'pure JS RefRGB (matrix/TRC/Bradford/Lab/CIEDE2000), independent of lcms2',
    ...(notApplicableReason ? { reason: notApplicableReason } : {}),
    sampleCount: colorRows.length,
    ...(deValues.length ? {
      deltaE2000: sortedStats(deValues),
      encodedMaxDiff: Math.max(...encodedDiffs),
      toleranceDE: colorToleranceDE,
      withinTolerance: Math.max(...deValues) <= colorToleranceDE,
    } : {}),
    rows: colorRows.slice(0, 40),
  };

  const gamut = gamutMode === 'gamut-check' ? {
    mode: gamutMode,
    expectedOutOfGamutSamples: alarmExpected,
    missingAlarmSamples: alarmMissing,
    unexpectedAlarmSamples: alarmUnexpected,
    alarmConsistent: alarmMissing === 0 && alarmUnexpected === 0,
  } : { mode: gamutMode };

  // alpha 证据：逐全采样（不只抽样），来自源缓冲本身，与颜色引擎无关
  let alphaChecks = 0;
  let alphaMismatches = 0;
  const alphaRows = [];
  if (channels === 4) {
    const bpe = bits / 8;
    for (let px = 0; px < width * height; px++) {
      const o = px * 4 * bpe + 3 * bpe;
      let same = true;
      for (let k = 0; k < bpe; k++) if (outPixels[o + k] !== srcPixels[o + k]) same = false;
      alphaChecks++;
      if (!same) {
        alphaMismatches++;
        if (alphaRows.length < 20) {
          alphaRows.push({ pixel: px, before: [...srcPixels.slice(o, o + bpe)], after: [...outPixels.slice(o, o + bpe)] });
        }
      }
    }
  }
  const alpha = {
    applicable: channels === 4,
    checkedPixels: alphaChecks,
    mismatchedPixels: alphaMismatches,
    preserved: channels === 4 ? alphaMismatches <= alphaTolerance : true,
    evidence: alphaRows,
  };

  // 配置身份：实际采用的源/目标配置与期望身份是否一致
  // actual* 为引擎实际使用的 ICC；expected* 为要求核对的身份，缺省不比较。
  const actualSrcIdentity = identityOf(actualSrcIcc || srcIcc);
  const actualDstIdentity = identityOf(actualDstIcc || dstIcc);
  const expectedSrcIdentity = expectedSrcIcc ? identityOf(expectedSrcIcc) : null;
  const expectedDstIdentity = expectedDstIcc ? identityOf(expectedDstIcc) : null;
  const profiles = {
    source: {
      actualSha256: actualSrcIdentity.sha256,
      expectedSha256: expectedSrcIdentity ? expectedSrcIdentity.sha256 : null,
      matchesExpected: expectedSrcIdentity ? actualSrcIdentity.sha256 === expectedSrcIdentity.sha256 : null,
    },
    destination: {
      actualSha256: actualDstIdentity.sha256,
      expectedSha256: expectedDstIdentity ? expectedDstIdentity.sha256 : null,
      matchesExpected: expectedDstIdentity ? actualDstIdentity.sha256 === expectedDstIdentity.sha256 : null,
    },
  };

  const failures = [];
  if (profiles.source.matchesExpected === false) failures.push('source-profile-mismatch');
  if (profiles.destination.matchesExpected === false) failures.push('destination-profile-mismatch');
  if (color.withinTolerance === false) failures.push('color-delta-exceeds-tolerance');
  if (gamutMode === 'gamut-check' && !gamut.alarmConsistent) failures.push('gamut-alarm-inconsistent');
  if (!alpha.preserved) failures.push('alpha-not-preserved');
  if (requireColorVerification && !referenceApplicable) failures.push('color-verification-unavailable');

  return {
    intent,
    bits,
    channels,
    color,
    alpha,
    gamut,
    profiles,
    failures,
    ok: failures.length === 0,
  };
}

function identityOf(icc) {
  const crypto = require('crypto');
  const buf = Buffer.from(icc);
  return {
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    byteSize: buf.length,
  };
}

// 独立推导一组编码值在指定配置对下的期望转换（供测试直接断言）
function referenceTransform(srcIcc, dstIcc, rgb01, intent) {
  const srcRef = createRef(srcIcc);
  const dstRef = createRef(dstIcc);
  if (!srcRef || !dstRef) throw new Error('参考引擎仅支持 matrix-shaper 配置');
  return srcRef.convertTo(dstRef, rgb01, { intent });
}

module.exports = {
  verifyTransform,
  referenceTransform,
  readSample,
  sortedStats,
  REFERENCE_INTENTS,
};
