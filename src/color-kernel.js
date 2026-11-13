'use strict';
// 图像色管内核（JS 层）。UI/CLI 只通过本模块调用 lcms2 原生引擎；
// 任何失败都在此聚合成结构化错误，回传给图像色管界面，而不是由界面自行猜测。
const crypto = require('crypto');
const sharp = require('sharp');
const native = require('../build/Release/lcms_native.node');
const { RefRGB, deltaE2000 } = require('./ref-engine');
const { embedIcc: pngEmbedIcc, extractIcc: pngExtractIcc } = require('./png-icc');
const { encodePng } = require('./png-encode');
const { jpegEmbedIcc, jpegExtractIcc, jpegStripIcc } = require('./jpeg-icc');

const INTENTS = [
  { id: 'perceptual', name: '感知意图 (Perceptual)',
    explain: '为摄影图像压缩整个色域，保持颜色之间的相对关系；超色域颜色被平滑内收，色相关系优先，色度值不保证不变。' },
  { id: 'relative-colorimetric', name: '相对色度 (Relative Colorimetric)',
    explain: '白点映射到目标白点（适配媒体白），色域内颜色保持色度不变，超色域颜色裁剪到色域边界；配合黑点补偿可保留暗部层次。' },
  { id: 'saturation', name: '饱和度意图 (Saturation)',
    explain: '优先保持颜色鲜艳度与通道分离，适合图表/示意图形，不追求色度准确，不建议用于博物馆影像。' },
  { id: 'absolute-colorimetric', name: '绝对色度 (Absolute Colorimetric)',
    explain: '保留源白点与介质本色，不做白点适应；用于打样模拟纸张色，普通屏幕看图通常偏色。' },
];

const GAMUT_MODES = [
  { id: 'clip', name: '裁剪（按所选意图映射，超色域压到边界）' },
  { id: 'gamut-check', name: '警报（超色域像素输出品红标记，其余正常转换）' },
  { id: 'softproof', name: '软打样（正常转换，另由统计给出超色域数量与色差）' },
];

const BUILTIN_PROFILES = ['srgb', 'linear-srgb', 'display-p3', 'adobergb', 'narrow-gamut'];

class ColorError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'ColorError';
    this.code = code; // 供图像色管界面区分失败来源
    this.detail = detail || null;
  }
}

function fail(code, message, detail) { throw new ColorError(code, message, detail); }

const profileCache = new Map();
function builtinProfile(id) {
  if (!BUILTIN_PROFILES.includes(id)) fail('PROFILE_UNKNOWN', `未知内置配置: ${id}`);
  if (!profileCache.has(id)) {
    profileCache.set(id, Buffer.from(native.createBuiltinProfile(id)));
  }
  return profileCache.get(id);
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function profileIdentity(icc) {
  if (!Buffer.isBuffer(icc) || icc.length < 132) fail('PROFILE_INVALID', 'ICC 配置数据无效或过短');
  let info;
  try {
    info = native.profileInfo(icc);
  } catch (e) {
    fail('PROFILE_INVALID', 'lcms2 无法打开该 ICC 配置', e.message);
  }
  return {
    description: info.description || info.tagProfileDescription || '(无描述标签)',
    manufacturer: info.manufacturer,
    model: info.model,
    deviceClass: info.deviceClassSig,
    colorSpace: info.colorSpaceSig,
    pcs: info.pcsSig,
    version: info.version,
    isMatrixShaper: info.isMatrixShaper,
    hasAToB0: info.hasAToB0,
    byteSize: icc.length,
    sha256: sha256(icc),
  };
}

// 读取图像：返回原始像素（含 alpha 标记）、位深与现有嵌入 ICC
async function readImage(fileBuf) {
  let meta;
  try {
    meta = await sharp(fileBuf).metadata();
  } catch (e) {
    return fail('IMAGE_UNREADABLE', '无法解码图像（仅支持 PNG/JPEG/TIFF）', e.message);
  }
  if (!['srgb', 'rgb', 'rgb16', 'grey', 'b-w'].includes(meta.space)) {
    fail('IMAGE_UNSUPPORTED', `不支持的色彩空间: ${meta.space}`);
  }
  const hasAlpha = !!meta.hasAlpha;
  // sharp 默认把 16 位 PNG 降到 8 位，位深必须从容器头自行探测
  const containerBps = detectBitsPerSample(fileBuf, meta.format);
  const bps = containerBps || (meta.depth === 'ushort' ? 16 : 8);
  const targetChannels = hasAlpha ? 4 : 3;
  // ICC 一律由本模块手工解析，避免 sharp/libvips 按嵌入配置自动改动像素
  const manualIcc = img0IsPng(fileBuf) ? pngExtractIcc(fileBuf)
    : meta.format === 'jpeg' ? jpegExtractIcc(fileBuf) : (meta.icc || null);
  // sharp 的 'srgb' 仅表示 RGB 三通道排列；剥离 ICC 后它不会做色彩管理
  const pipeline = sharp(stripIccForDecode(fileBuf, meta.format)).toColourspace('srgb');
  if (!hasAlpha) pipeline.removeAlpha();
  const { data, info } = await pipeline
    .raw({ depth: bps === 16 ? 'ushort' : 'uchar' })
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== targetChannels) {
    fail('IMAGE_UNSUPPORTED', `通道数异常: 期望 ${targetChannels}，实际 ${info.channels}`);
  }
  if ((info.depth === 'ushort' ? 16 : 8) !== bps) {
    fail('IMAGE_DEPTH_LOST', `位深丢失: 容器为 ${bps} 位，解码为 ${info.depth}`);
  }
  // 16 位缓冲全程保持 PNG/ICC 标准大端，lcms2 TYPE_RGB_16 直接消费，不做字节序翻转
  return {
    pixels: data,
    width: info.width,
    height: info.height,
    channels: 3,
    hasAlpha,
    bitsPerSample: bps,
    embeddedIcc: manualIcc,
    format: meta.format,
  };
}

function stripIccForDecode(buf, format) {
  if (img0IsPng(buf)) return stripPngIcc(buf);
  if (format === 'jpeg') return jpegStripIcc(buf);
  return buf;
}

function stripPngIcc(pngBuffer) {
  const chunks = [];
  let off = 8;
  while (off < pngBuffer.length) {
    const len = pngBuffer.readUInt32BE(off);
    const type = pngBuffer.toString('latin1', off + 4, off + 8);
    if (type !== 'iCCP') chunks.push(pngBuffer.slice(off, off + 12 + len));
    off += 12 + len;
  }
  return Buffer.concat([pngBuffer.slice(0, 8), ...chunks]);
}

function img0IsPng(buf) {
  return buf.length > 8 && buf.toString('latin1', 1, 4) === 'PNG';
}

// 从容器头探测原始每通道位深，不信任 sharp 的默认降采样
function detectBitsPerSample(buf, format) {
  if (img0IsPng(buf) && buf.length >= 24) {
    // IHDR：宽度4 高度4 位深1（偏移 24）
    const bps = buf[24];
    if (bps === 8 || bps === 16) return bps;
  }
  if (format === 'tiff') {
    const little = buf.toString('latin1', 0, 2) === 'II';
    const read16 = (o) => little ? buf.readUInt16LE(o) : buf.readUInt16BE(o);
    const read32 = (o) => little ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
    const ifdOff = read32(4);
    const n = read16(ifdOff);
    for (let i = 0; i < n; i++) {
      const e = ifdOff + 2 + i * 12;
      if (read16(e) === 258) { // BitsPerSample tag
        const type = read16(e + 2);
        if (type === 3) return read16(e + 8);
        if (type === 4) return read32(e + 8) & 0xFFFF;
      }
    }
  }
  if (format === 'jpeg') return 8;
  return null;
}

// 操作一：给图像“指定配置”（assign profile）。
// 只重写元数据标签，绝不触碰像素值。返回带新标签的文件与审计记录。
async function assignProfile(fileBuf, iccBuf, options = {}) {
  const img = await readImage(fileBuf);
  const before = img.embeddedIcc ? profileIdentity(img.embeddedIcc) : null;
  const targetId = profileIdentity(iccBuf);
  // 关键审计：像素逐字节不变，只改标签
  // 关键审计：像素逐字节不变，只改标签。
  // PNG：直接替换 iCCP 块，连 IDAT 压缩数据都不重写；JPEG：只重写 APP2 段。
  let out;
  if (img0IsPng(fileBuf)) {
    out = pngEmbedIcc(stripPngIcc(fileBuf), iccBuf);
  } else if (img.format === 'jpeg') {
    const bare = jpegStripIcc(fileBuf);
    out = jpegEmbedIcc(bare, iccBuf);
  } else {
    const encoded = await sharp(fileBuf).toFormat('png').toBuffer();
    out = pngEmbedIcc(encoded, iccBuf);
  }
  const reread = await readImage(out);
  const pixelsUnchanged = reread.pixels.equals(img.pixels);
  if (!pixelsUnchanged) fail('KERNEL_INVARIANT', '指定配置后像素发生变化，违反“只改标签”约定');
  return {
    output: out,
    operation: 'assign',
    pixelsTouched: false,
    audit: {
      beforeProfile: before ? { description: before.description, sha256: before.sha256 } : null,
      assignedProfile: { description: targetId.description, sha256: targetId.sha256 },
      pixelBytesUnchanged: true,
      note: '本操作仅重写嵌入 ICC 标签，像素编码值逐字节保持原样；颜色外观是否正确取决于该假设是否符合真实来源。',
    },
  };
}

// 源配置缺失时的显式假设记录
function resolveSourceProfile(img, explicit) {
  if (img.embeddedIcc) return { icc: img.embeddedIcc, assumed: false, assumption: null };
  if (!explicit || !explicit.assumeProfileId) {
    fail('SOURCE_PROFILE_MISSING',
      '图像未嵌入 ICC 配置。必须由使用者明确指定一个来源假设，内核不会自动假定所有图像同属某色域。');
  }
  const icc = builtinProfile(explicit.assumeProfileId);
  return {
    icc,
    assumed: true,
    assumption: {
      assumedProfileId: explicit.assumeProfileId,
      reason: explicit.reason || '(未填写依据)',
      recordedAt: new Date().toISOString(),
      warning: '该配置为人工假设而非文件自带，转换结果的可信度取决于假设是否成立；已写入审计记录。',
    },
  };
}

// 操作二：实际转换像素。
async function convertImage(fileBuf, opts) {
  const img = await readImage(fileBuf);
  const src = resolveSourceProfile(img, opts.source || {});
  const dstIcc = opts.destinationProfileId
    ? builtinProfile(opts.destinationProfileId)
    : Buffer.isBuffer(opts.destinationIcc) ? opts.destinationIcc : null;
  if (!dstIcc) fail('PROFILE_UNKNOWN', '未指定目标配置');

  const intent = opts.renderingIntent || 'relative-colorimetric';
  if (!INTENTS.some((i) => i.id === intent)) fail('BAD_INTENT', `未知渲染意图: ${intent}`);
  const bpc = !!opts.blackPointCompensation;
  const gamutMode = opts.gamutMode || 'clip';
  if (!GAMUT_MODES.some((m) => m.id === gamutMode)) fail('BAD_GAMUT_MODE', `未知超色域处理: ${gamutMode}`);
  if (bpc && intent === 'absolute-colorimetric') {
    fail('BAD_COMBINATION', '黑点补偿与绝对色度意图互斥（绝对意图本身保留介质黑点）');
  }

  const srcId = profileIdentity(src.icc);
  const dstId = profileIdentity(dstIcc);
  const sameProfile = srcId.sha256 === dstId.sha256;

  const bps = img.bitsPerSample;
  const out = Buffer.alloc(img.pixels.length);
  let gamut = { totalPixels: img.width * img.height, outOfGamutPixels: 0, ratio: 0 };

  if (!sameProfile) {
    const mode = gamutMode === 'clip' ? 'convert'
      : gamutMode === 'gamut-check' ? 'gamut-check' : 'softproof';
    try {
      native.convertPixels({
        srcIcc: src.icc, dstIcc,
        input: img.pixels, output: out,
        width: img.width, height: img.height,
        channels: 3, bitsPerSample: bps,
        renderingIntent: intent,
        blackPointCompensation: bpc,
        mode, hasAlpha: img.hasAlpha,
      });
    } catch (e) {
      fail('ENGINE_TRANSFORM_FAILED', 'lcms2 像素变换失败', e.message);
    }
    gamut = await gamutStatistics(img, src.icc, dstIcc);
  } else {
    img.pixels.copy(out);
  }

  // 透明通道核验：有 alpha 时必须逐字节保持（每像素 4 通道，alpha 在第 4 个）
  if (img.hasAlpha) {
    const bytesPerSample = bps / 8;
    for (let px = 0; px < img.width * img.height; px++) {
      const o = px * 4 * bytesPerSample + 3 * bytesPerSample;
      for (let k = 0; k < bytesPerSample; k++) {
        if (out[o + k] !== img.pixels[o + k]) {
          fail('KERNEL_INVARIANT', '透明通道在转换中被改变');
        }
      }
    }
  }

  const encoded = await encodeOutput(out, img, dstIcc);
  const delta = await deltaEStats(img, src.icc, out, dstIcc, bps, img.hasAlpha, sameProfile);
  const probePoints = opts.probePoints || defaultProbePoints(img.width, img.height);
  const probes = probePointsFn(img, src.icc, sameProfile ? null : out, dstIcc, probePoints, bps, img.hasAlpha);

  return {
    output: encoded,
    operation: 'convert',
    pixelsTouched: !sameProfile,
    bitsPerSample: bps,
    settings: { renderingIntent: intent, blackPointCompensation: bpc, gamutMode },
    source: { identity: srcId, assumed: src.assumed, assumption: src.assumption },
    destination: { identity: dstId },
    gamut,
    deltaE: delta,
    probes,
    audit: {
      engine: 'LittleCMS2 (liblcms2 2.14) 经 node-addon-api 原生封装',
      alphaPreserved: true,
      highBitDepthPath: bps === 16 ? '16 位缓冲直通 lcms2（TYPE_RGB_16），未经过 8 位降级' : '8 位',
    },
  };
}

function defaultProbePoints(width, height) {
  const pts = [];
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      pts.push([
        Math.min(width - 1, Math.floor((i + 0.5) * width / 4)),
        Math.min(height - 1, Math.floor((j + 0.5) * height / 4)),
      ]);
    }
  }
  return pts;
}

async function encodeOutput(pixels, img, icc) {
  // 输出仅 PNG / JPEG：PNG 由自有编码器处理 8/16 位与透明，JPEG 由 sharp 编码后手工嵌 APP2。
  // 不输出 TIFF，避免图像库在嵌入 ICC 时自动改动像素。
  if (img.format === 'jpeg' && !img.hasAlpha && img.bitsPerSample === 8) {
    const encoded = await sharp(pixels, {
      raw: { width: img.width, height: img.height, channels: 3, depth: 'uchar' },
    }).jpeg({ quality: 95, mozjpeg: true }).toBuffer();
    return jpegEmbedIcc(encoded, icc);
  }
  const bare = encodePng({
    width: img.width, height: img.height,
    channels: img.hasAlpha ? 4 : 3,
    bitsPerSample: img.bitsPerSample,
    pixels,
  });
  return pngEmbedIcc(bare, icc);
}

const max = (a) => a.reduce((m, v) => Math.max(m, v), 0);
const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);

// 抽样统计 Lab 色差（含不透明像素），全部经 lcms Lab 变换 + 手写 CIEDE2000
async function deltaEStats(srcImg, srcIcc, dstPixels, dstIcc, bps, hasAlpha, skipped) {
  if (skipped) return { skipped: true, reason: '源与目标配置指纹相同，未执行像素变换' };
  const step = (bps / 8) * (hasAlpha ? 4 : 3);
  const total = srcImg.width * srcImg.height;
  const cap = 20000;
  const stride = Math.max(1, Math.floor(total / cap));
  const scale = bps === 8 ? 255 : 65535;
  const srcRGB = [], dstRGB = [], pickIdx = [];
  for (let n = 0, i = 0; i < total; i += stride, n++) {
    const o = i * step;
    if (hasAlpha) {
      const a = bps === 8 ? srcImg.pixels[o + 3] : ((srcImg.pixels[o + 6] << 8) | srcImg.pixels[o + 7]);
      if (a / scale < 0.5) continue;
    }
    const read = (buf, base) => bps === 8
      ? [buf[base], buf[base + 1], buf[base + 2]].map((v) => v / 255)
      : [((buf[base] << 8) | buf[base + 1]), ((buf[base + 2] << 8) | buf[base + 3]),
        ((buf[base + 4] << 8) | buf[base + 5])].map((v) => v / 65535);
    srcRGB.push(...read(srcImg.pixels, o));
    dstRGB.push(...read(dstPixels, o));
    pickIdx.push(i);
  }
  const lab1 = Array.from(native.rgbToLab({ icc: srcIcc, rgb: Float32Array.from(srcRGB) }));
  const lab2 = Array.from(native.rgbToLab({ icc: dstIcc, rgb: Float32Array.from(dstRGB) }));
  const des = [];
  for (let i = 0; i < lab1.length; i += 3) {
    des.push(deltaE2000(lab1.slice(i, i + 3), lab2.slice(i, i + 3)));
  }
  const sorted = [...des].sort((a, b) => a - b);
  return {
    samples: des.length,
    mean: mean(des),
    max: max(des),
    p95: sorted[Math.floor(sorted.length * 0.95)] || 0,
    samplePixelIndexes: pickIdx.slice(0, 50),
  };
}

// 超色域统计：用 lcms 软打样 GAMUTCHECK（浮点路径），抽样
async function gamutStatistics(img, srcIcc, dstIcc) {
  const bps = img.bitsPerSample, hasAlpha = img.hasAlpha;
  const step = (bps / 8) * (hasAlpha ? 4 : 3);
  const total = img.width * img.height;
  const cap = 30000;
  const stride = Math.max(1, Math.floor(total / cap));
  const scale = bps === 8 ? 255 : 65535;
  const rgb = [];
  let counted = 0;
  for (let i = 0; i < total; i += stride) {
    const o = i * step;
    if (hasAlpha) {
      const a = bps === 8 ? img.pixels[o + 3] : ((img.pixels[o + 6] << 8) | img.pixels[o + 7]);
      if (a / scale < 0.5) continue;
    }
    const vals = bps === 8
      ? [img.pixels[o], img.pixels[o + 1], img.pixels[o + 2]].map((v) => v / 255)
      : [((img.pixels[o] << 8) | img.pixels[o + 1]), ((img.pixels[o + 2] << 8) | img.pixels[o + 3]),
        ((img.pixels[o + 4] << 8) | img.pixels[o + 5])].map((v) => v / 65535);
    rgb.push(...vals);
    counted++;
  }
  if (!counted) return { totalPixels: total, outOfGamutPixels: 0, ratio: 0, sampled: 0 };
  const flags = native.inGamut({ srcIcc, dstIcc, rgb: Float32Array.from(rgb) });
  let oo = 0;
  for (const f of flags) if (!f) oo++;
  const ratio = oo / counted;
  return {
    totalPixels: total,
    sampled: counted,
    outOfGamutSampled: oo,
    outOfGamutPixels: Math.round(ratio * total),
    ratio,
  };
}

// 取若干像素点在“转换前后”的编码值与 Lab，供页面数值核对
function probePointsFn(img, srcIcc, converted, dstIcc, points, bps, hasAlpha) {
  const step = (bps / 8) * (hasAlpha ? 4 : 3);
  const read = (buf, x, y) => {
    const o = (y * img.width + x) * step;
    if (bps === 8) return { rgb: [buf[o], buf[o + 1], buf[o + 2]], alpha: hasAlpha ? buf[o + 3] : null };
    // 16 位缓冲为 PNG 标准大端
    return {
      rgb: [(buf[o] << 8) | buf[o + 1], (buf[o + 2] << 8) | buf[o + 3], (buf[o + 4] << 8) | buf[o + 5]],
      alpha: hasAlpha ? (buf[o + 6] << 8) | buf[o + 7] : null,
    };
  };
  return points.map(([x, y]) => {
    const before = read(img.pixels, x, y);
    const after = converted ? read(converted, x, y) : null;
    const toLab = (icc, rgb8or16) => Array.from(native.rgbToLab({
      icc, rgb: Float32Array.from(rgb8or16.map((v) => v / (bps === 8 ? 255 : 65535))),
    }));
    return {
      x, y,
      before: { ...before, Lab: toLab(srcIcc, before.rgb) },
      after: after ? { ...after, Lab: toLab(dstIcc, after.rgb) } : null,
    };
  });
}

// 独立参考核对：对 matrix-shaper 配置，用纯 JS 引擎复核 lcms 的 Lab 与转换结果
function referenceCrossCheck(icc, samples) {
  const id = profileIdentity(icc);
  if (!id.isMatrixShaper) {
    return { applicable: false, reason: '参考引擎仅支持 matrix-shaper 配置（LUT 配置跳过独立核对）' };
  }
  const ref = new RefRGB(icc);
  const rows = samples.map((rgb01) => {
    const refLab = ref.rgbToLab(rgb01);
    const lcmsLab = Array.from(native.rgbToLab({ icc, rgb: Float32Array.from(rgb01) }));
    return {
      rgb: rgb01,
      refLab, lcmsLab,
      dE: deltaE2000(refLab, lcmsLab),
    };
  });
  return {
    applicable: true,
    profileSha256: id.sha256,
    maxDE: Math.max(...rows.map((r) => r.dE)),
    meanDE: rows.reduce((s, r) => s + r.dE, 0) / rows.length,
    rows,
  };
}

function capabilities() {
  return {
    intents: INTENTS,
    gamutModes: GAMUT_MODES,
    builtinProfiles: BUILTIN_PROFILES.map((id) => ({ id, identity: profileIdentity(builtinProfile(id)) })),
    supportedBits: [8, 16],
    ruleMissingSource: '源配置缺失时必须显式假设并记录，禁止自动套用默认色域',
    ruleTwoOperations: 'assign（只改标签）与 convert（变换像素）是两个独立操作，界面分区呈现',
  };
}

module.exports = {
  ColorError,
  capabilities,
  builtinProfile,
  profileIdentity,
  readImage,
  assignProfile,
  convertImage,
  probePoints: probePointsFn,
  referenceCrossCheck,
  INTENTS,
  GAMUT_MODES,
  BUILTIN_PROFILES,
};
