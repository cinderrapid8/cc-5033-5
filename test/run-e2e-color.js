'use strict';
// 端到端色管验收：受控 ICC 资料 + 已知颜色补丁。
// 期望值独立推导，来源只有三类，均不含“用 lcms 反向调用当自证”：
//   1) 由 ICC 参数可解析出的解析式（如线性 TRC -> gamma 编码）；
//   2) src/ref-engine.js 的纯 JS 矩阵/TRC/Bradford/Lab/CIEDE2000；
//   3) alpha 保留由源像素缓冲逐字节直接比对。
// 断言同时检查数值与实际采用的配置身份（SHA-256），故意换错源空间必须被捕获。
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const kernel = require('../src/color-kernel');
const { RefRGB, deltaE2000 } = require('../src/ref-engine');
const { verifyTransform, referenceTransform } = require('../src/color-verify');
const { buildMatrixShaperProfile } = require('../src/profile-fixture');
const { embedIcc, extractIcc } = require('../src/png-icc');
const { encodePng } = require('../src/png-encode');
const fixtures = require('./fixtures');

let pass = 0;
const results = [];
function ok(name, cond, extra) {
  assert.ok(cond, name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
  pass++;
  results.push(name);
  console.log('  PASS', name);
}
function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

async function convertWith(file, opts) {
  const buf = fixtures.loadImage(file);
  const r = await kernel.convertImage(buf, {
    renderingIntent: 'relative-colorimetric',
    blackPointCompensation: false,
    gamutMode: 'clip',
    ...opts,
  });
  const before = await kernel.readImage(buf);
  const after = await kernel.readImage(r.output);
  return { before, after, result: r };
}

function verificationFor(before, after, srcIcc, dstIcc, opts = {}) {
  return verifyTransform({
    srcIcc, dstIcc,
    srcPixels: before.pixels, outPixels: after.pixels,
    width: before.width, height: before.height, bits: before.bitsPerSample,
    channels: before.hasAlpha ? 4 : 3,
    intent: opts.intent || 'relative-colorimetric',
    gamutMode: opts.gamutMode || 'clip',
    actualSrcIcc: opts.actualSrcIcc || srcIcc,
    actualDstIcc: opts.actualDstIcc || dstIcc,
    expectedSrcIcc: opts.expectedSrcIcc,
    expectedDstIcc: opts.expectedDstIcc,
    requireColorVerification: opts.requireColorVerification || false,
  });
}

(async () => {
  console.log('== 0. 受控样例自洽：参数即事实来源，样例文件可由参数确定性重建 ==');
  const manifest = fixtures.ensureFixtures();
  for (const spec of fixtures.PROFILE_SPECS) {
    const rebuilt = buildMatrixShaperProfile({
      description: spec.description, tagName: spec.id,
      white: spec.white, primaries: spec.primaries, gamma: spec.gamma,
    });
    const onDisk = fixtures.loadProfile(spec.id);
    ok(`${spec.id} 文件与声明参数确定性一致`, rebuilt.equals(onDisk),
      { disk: sha(onDisk).slice(0, 16), rebuilt: sha(rebuilt).slice(0, 16) });
    const ref = new RefRGB(onDisk);
    ok(`${spec.id} 媒体白点由参数可推导`,
      Math.abs(ref.mediaWhite[0] - (spec.white[0] / spec.white[1])) < 1e-4,
      { mediaWhite: ref.mediaWhite, whiteXY: spec.white });
  }
  // 已知补丁的像素内容与清单一致（独立于任何颜色库）
  const patches8 = fixtures.loadImage('ctrl-patches-8.png');
  const patchesImg = await kernel.readImage(patches8);
  let patchMismatch = 0;
  const cell = fixtures.IMAGE_SPECS.find((i) => i.file === 'ctrl-patches-8.png').cell;
  const cols = 6;
  fixtures.PATCHES.forEach(([, rgb8], idx) => {
    const r = Math.floor(idx / cols), c = idx % cols;
    const px = (r * cell + Math.floor(cell / 2)) * patchesImg.width + c * cell + Math.floor(cell / 2);
    const o = px * 3;
    if (patchesImg.pixels[o] !== rgb8[0] || patchesImg.pixels[o + 1] !== rgb8[1] || patchesImg.pixels[o + 2] !== rgb8[2]) patchMismatch++;
  });
  ok('12 个已知色补丁的编码值与清单逐像素一致', patchMismatch === 0, { patchMismatch });

  console.log('== 1. 变换语义：期望值由 ICC 参数独立推导（线性 TRC 解析式）==');
  const lin = fixtures.loadProfile('ctrl-linear');
  const srgb = fixtures.loadProfile('ctrl-srgb');
  const ramp = fixtures.loadImage('ctrl-ramp-8.png');
  const rampImg = await kernel.readImage(ramp);
  const rampConv = await kernel.convertImage(ramp, {
    source: {}, destinationIcc: srgb,
    renderingIntent: 'relative-colorimetric', blackPointCompensation: false, gamutMode: 'clip',
  });
  const rampOut = await kernel.readImage(rampConv.output);
  // 同一原色集合、src gamma 1.0、dst gamma 2.2：解析期望 = round(255*(v/255)^(1/2.2))
  let maxAnalytic = 0;
  for (const x of [0, 32, 64, 96, 128, 160, 192, 224, 255]) {
    const expected = Math.round(255 * Math.pow(x / 255, 1 / 2.2));
    const o = (4 * rampImg.width + x) * 3;
    maxAnalytic = Math.max(maxAnalytic, Math.abs(rampOut.pixels[o] - expected));
  }
  ok('线性->sRGB 渐变的编码值符合解析式（±1 码）', maxAnalytic <= 1, { maxAnalytic });
  // 同一转换的独立矩阵推导一致性，并核对实际采用配置身份
  const rv = verificationFor(rampImg, rampOut, lin, srgb, {
    expectedSrcIcc: lin, expectedDstIcc: srgb, requireColorVerification: true,
  });
  ok('渐变转换独立推导 ΔE2000 < 0.5', rv.color.deltaE2000.max < 0.5, rv.color.deltaE2000);
  ok('渐变转换实际采用源/目标配置身份与期望一致',
    rv.profiles.source.matchesExpected === true && rv.profiles.destination.matchesExpected === true);
  ok('渐变转换独立校验无失败项', rv.ok && rv.failures.length === 0, rv.failures);
  ok('内核回传的独立校验同样通过', rampConv.verification.ok === true,
    rampConv.verification.failures);

  console.log('== 2. 渲染意图：相对色度 vs 绝对色度可独立区分 ==');
  const warm = fixtures.loadProfile('ctrl-warm');
  const cool = fixtures.loadProfile('ctrl-cool');
  const warmBuf = fixtures.loadImage('ctrl-warm-patches-8.png');
  const warmImg = await kernel.readImage(warmBuf);
  const relConv = await kernel.convertImage(warmBuf, {
    source: {}, destinationIcc: cool,
    renderingIntent: 'relative-colorimetric', blackPointCompensation: false, gamutMode: 'clip',
  });
  const absConv = await kernel.convertImage(warmBuf, {
    source: {}, destinationIcc: cool,
    renderingIntent: 'absolute-colorimetric', blackPointCompensation: false, gamutMode: 'clip',
  });
  const relOut = await kernel.readImage(relConv.output);
  const absOut = await kernel.readImage(absConv.output);
  ok('内核记录实际渲染意图', relConv.settings.renderingIntent === 'relative-colorimetric'
    && absConv.settings.renderingIntent === 'absolute-colorimetric');
  ok('相对色度保持媒体中性：白补丁仍为 255,255,255',
    relOut.pixels[0] === 255 && relOut.pixels[1] === 255 && relOut.pixels[2] === 255,
    [...relOut.pixels.slice(0, 3)]);
  ok('绝对色度保留介质白：白补丁在冷暖目标下不再中性',
    absOut.pixels[0] !== absOut.pixels[2] || absOut.pixels[1] !== absOut.pixels[2],
    [...absOut.pixels.slice(0, 3)]);
  // 白补丁的绝对色度期望值由独立模型推导，与 lcms 输出比较（只用产出作被测对象）
  const refAbsWhite = referenceTransform(warm, cool, [1, 1, 1], 'absolute-colorimetric').rgb01
    .map((v) => Math.round(v * 255));
  const absWhiteActual = [...absOut.pixels.slice(0, 3)];
  const absWhiteDeltaE = deltaE2000(
    new RefRGB(cool).rgbToLab(refAbsWhite.map((v) => v / 255)),
    new RefRGB(cool).rgbToLab(absWhiteActual.map((v) => v / 255)));
  ok('绝对色度白补丁与独立推导 ΔE < 1', absWhiteDeltaE < 1, { refAbsWhite, absWhiteActual });
  ok('绝对色度独立推导含透明/配置证据且通过',
    verificationFor(warmImg, absOut, warm, cool, {
      intent: 'absolute-colorimetric', expectedSrcIcc: warm, expectedDstIcc: cool,
      requireColorVerification: true,
    }).ok === true);
  const relVerify = verificationFor(warmImg, relOut, warm, cool, {
    expectedSrcIcc: warm, expectedDstIcc: cool, requireColorVerification: true,
  });
  ok('相对色度独立推导通过且与绝对色度输出不同',
    relVerify.ok && !relOut.pixels.equals(absOut.pixels));

  console.log('== 3. 感知/饱和度意图：无独立推导时必须显式标记，不得默认通过 ==');
  const percConv = await kernel.convertImage(warmBuf, {
    source: {}, destinationIcc: cool,
    renderingIntent: 'perceptual', blackPointCompensation: false, gamutMode: 'clip',
  });
  ok('感知意图内核回传 referenceApplicable=false',
    percConv.verification.color.referenceApplicable === false
    && /感知|intent|perceptual/i.test(percConv.verification.color.reason || ''),
    percConv.verification.color.reason);
  const percVerify = verificationFor(warmImg, await kernel.readImage(percConv.output), warm, cool, {
    intent: 'perceptual', requireColorVerification: true,
  });
  ok('要求独立校验时感知意图必须报 color-verification-unavailable',
    percVerify.failures.includes('color-verification-unavailable'), percVerify.failures);

  console.log('== 4. 透明通道：逐采样保留，色差与 alpha 均来自执行证据 ==');
  for (const [file, bits, expectedSamples] of [
    ['ctrl-alpha-8.png', 8, 16 * 16],
    ['ctrl-alpha-16.png', 16, 8 * 8],
  ]) {
    const { before, after, result } = await convertWith(file, { destinationIcc: fixtures.loadProfile('ctrl-p3') });
    ok(`${file} 源位深/通道数符合样例声明`,
      before.bitsPerSample === bits && before.hasAlpha === true &&
      before.width * before.height === expectedSamples,
      { bits: before.bitsPerSample, alpha: before.hasAlpha, pixels: before.width * before.height });
    const cv = verificationFor(before, after, before.embeddedIcc, fixtures.loadProfile('ctrl-p3'), {
      expectedSrcIcc: before.embeddedIcc, expectedDstIcc: fixtures.loadProfile('ctrl-p3'),
      requireColorVerification: true,
    });
    ok(`${file} alpha 逐像素保留（检查数=${expectedSamples}）`,
      cv.alpha.preserved && cv.alpha.checkedPixels === expectedSamples && cv.alpha.mismatchedPixels === 0,
      { checked: cv.alpha.checkedPixels, mismatched: cv.alpha.mismatchedPixels });
    let rgbChanged = 0;
    for (let p = 0; p < before.width * before.height; p++) {
      const o = p * 4 * (bits / 8);
      const bytes = bits / 8;
      for (let k = 0; k < 3 * bytes; k++) {
        if (after.pixels[o + k] !== before.pixels[o + k]) { rgbChanged++; break; }
      }
    }
    ok(`${file} RGB 确实被变换（源与输出逐像素比较）`, rgbChanged > 0, { rgbChanged });
    ok(`${file} 独立推导与实际输出的偏差在容差内（非零即真实比对）`,
      cv.color.encodedMaxDiff <= (bits === 8 ? 3 : 300) && cv.color.sampleCount > 0,
      { encodedMaxDiff: cv.color.encodedMaxDiff, samples: cv.color.sampleCount });
    ok(`${file} 独立校验通过（无默认值掩盖）`, cv.ok && cv.failures.length === 0, cv.failures);
    ok(`${file} 内核 alphaPreserved 与执行证据一致`,
      result.audit.alphaPreserved === cv.alpha.preserved);
  }

  console.log('== 5. 缺失配置：反例拒绝，正例显式假设且写入身份 ==');
  const untagged = fixtures.loadImage('ctrl-untagged-8.png');
  let rejected = null;
  try {
    await kernel.convertImage(untagged, { source: {}, destinationProfileId: 'display-p3' });
  } catch (e) { rejected = e; }
  ok('无假设时必须拒绝并报 SOURCE_PROFILE_MISSING',
    rejected && rejected.code === 'SOURCE_PROFILE_MISSING');
  const assumed = await kernel.convertImage(untagged, {
    source: { assumeIcc: fixtures.loadProfile('ctrl-srgb'), assumeProfileId: 'ctrl-srgb', reason: '馆藏规范约定该批次为 sRGB 采集' },
    destinationIcc: fixtures.loadProfile('ctrl-p3'),
  });
  ok('假设配置身份被记录（不是仅写文本）',
    assumed.source.assumed === true
    && assumed.source.assumption.assumedProfileSha256 === sha(fixtures.loadProfile('ctrl-srgb'))
    && assumed.source.identity.sha256 === sha(fixtures.loadProfile('ctrl-srgb')),
    { assumed: assumed.source.assumption.assumedProfileId, sha: assumed.source.identity.sha256.slice(0, 16) });
  const untaggedAfter = await kernel.readImage(assumed.output);
  const assumedVerify = verificationFor(await kernel.readImage(untagged), untaggedAfter,
    fixtures.loadProfile('ctrl-srgb'), fixtures.loadProfile('ctrl-p3'), {
      expectedSrcIcc: fixtures.loadProfile('ctrl-srgb'),
      expectedDstIcc: fixtures.loadProfile('ctrl-p3'),
      requireColorVerification: true,
    });
  ok('假设下的转换仍有独立色差证据', assumedVerify.color.referenceApplicable
    && assumedVerify.color.deltaE2000.max < 1, assumedVerify.color.deltaE2000);
  // 无配置 + 透明：缺失配置与 alpha 同时验证
  let alphaRejected = null;
  try {
    await kernel.convertImage(fixtures.loadImage('ctrl-untagged-alpha-8.png'), {
      source: {}, destinationProfileId: 'ctrl-p3',
    });
  } catch (e) { alphaRejected = e; }
  ok('无配置透明图同样先拒绝缺失源配置',
    alphaRejected && alphaRejected.code === 'SOURCE_PROFILE_MISSING');
  const alphaAssumed = await kernel.convertImage(fixtures.loadImage('ctrl-untagged-alpha-8.png'), {
    source: { assumeIcc: fixtures.loadProfile('ctrl-srgb'), reason: '测试假设记录' },
    destinationIcc: fixtures.loadProfile('ctrl-p3'),
  });
  const uaBefore = await kernel.readImage(fixtures.loadImage('ctrl-untagged-alpha-8.png'));
  const uaAfter = await kernel.readImage(alphaAssumed.output);
  ok('无配置透明图在假设下 alpha 逐像素保留',
    alphaAssumed.verification.alpha.preserved && alphaAssumed.verification.alpha.mismatchedPixels === 0
    && uaBefore.hasAlpha && uaAfter.hasAlpha,
    alphaAssumed.verification.alpha);

  console.log('== 6. 故意换错源空间必须被捕获（身份 + 数值双证据）==');
  // (a) 断言期望源身份与实际嵌入不一致 -> 身份证据捕获
  {
    const { before, after } = await convertWith('ctrl-patches-8.png', {
      destinationIcc: fixtures.loadProfile('ctrl-cool'),
    });
    const wrongExpectation = verificationFor(before, after, before.embeddedIcc, fixtures.loadProfile('ctrl-cool'), {
      expectedSrcIcc: fixtures.loadProfile('ctrl-p3'), expectedDstIcc: fixtures.loadProfile('ctrl-cool'),
      requireColorVerification: true,
    });
    ok('换错期望源配置被身份断言捕获',
      wrongExpectation.profiles.source.matchesExpected === false
      && wrongExpectation.failures.includes('source-profile-mismatch'), wrongExpectation.failures);
  }
  {
    // 真实错误：像素按 ctrl-srgb 编码，却被贴成 ctrl-p3 标签；内核按嵌入 p3 解读
    const original = fixtures.loadImage('ctrl-patches-8.png');
    const reTagged = embedIcc(original, fixtures.loadProfile('ctrl-p3'), 'ctrl-p3');
    const reTaggedImg = await kernel.readImage(reTagged);
    const conv = await kernel.convertImage(reTagged, {
      source: {}, destinationIcc: fixtures.loadProfile('ctrl-cool'),
      renderingIntent: 'relative-colorimetric', gamutMode: 'clip',
    });
    const after = await kernel.readImage(conv.output);
    // 实际采用的是错误标签 ctrl-p3；真实语义是 ctrl-srgb
    const caught = verificationFor(reTaggedImg, after, fixtures.loadProfile('ctrl-srgb'), fixtures.loadProfile('ctrl-cool'), {
      actualSrcIcc: reTaggedImg.embeddedIcc,
      expectedSrcIcc: fixtures.loadProfile('ctrl-srgb'),
      expectedDstIcc: fixtures.loadProfile('ctrl-cool'),
      requireColorVerification: true,
    });
    ok('错误源标签同时触发身份不符与色差超容差',
      caught.failures.includes('source-profile-mismatch')
      && caught.failures.includes('color-delta-exceeds-tolerance'),
      caught.failures);
    ok('错误源标签的色差显著（> 2），证明数值证据不是默认值',
      caught.color.deltaE2000.max > 2, caught.color.deltaE2000);
    assert.ok(!conv.verification.color.referenceApplicable || conv.verification.ok,
      '内核自校验不得静默掩盖错误（错误来自标签，不是内核）');
  }

  console.log('== 7. 独立真值来源：同一转换库的反向调用不能当作真值 ==');
  {
    // 清晰反例：像素其实是 ctrl-srgb 编码，却被错误贴成 ctrl-p3 标签，再“转换到 p3”。
    // 内核按错误标签执行 p3->p3 恒等，输出与输入逐字节相同；任何“同一库反向调用”的往返
    // 也必然逐字节相同 —— 往返自洽对源空间解读错误完全失明。
    // 只有“独立模型按真实源 ctrl-srgb 推导”或已知补丁真值能捕获该错误。
    const red = [255, 0, 0];
    const png = encodePng({ width: 1, height: 1, channels: 3, bitsPerSample: 8, pixels: Buffer.from(red) });
    const misLabeled = embedIcc(png, fixtures.loadProfile('ctrl-p3'), 'ctrl-p3');
    const trueLabeled = embedIcc(png, fixtures.loadProfile('ctrl-srgb'), 'ctrl-srgb');
    const misConv = await kernel.convertImage(misLabeled, {
      source: {}, destinationIcc: fixtures.loadProfile('ctrl-p3'),
      renderingIntent: 'relative-colorimetric', gamutMode: 'clip',
    });
    const misOut = await kernel.readImage(misConv.output);
    const reverse = await kernel.convertImage(misConv.output, {
      source: {}, destinationIcc: fixtures.loadProfile('ctrl-p3'),
      renderingIntent: 'relative-colorimetric', gamutMode: 'clip',
    });
    const backOut = await kernel.readImage(reverse.output);
    ok('错误标签下 lcms 往返逐字节恒等（反向自证完全失明）',
      backOut.pixels.equals(misOut.pixels) && misOut.pixels.equals(Buffer.from(red)),
      { misOut: [...misOut.pixels] });
    // 正确标签的同一像素，内核真实转换为 p3，才是应有的目标值
    const trueConv = await kernel.convertImage(trueLabeled, {
      source: {}, destinationIcc: fixtures.loadProfile('ctrl-p3'),
      renderingIntent: 'relative-colorimetric', gamutMode: 'clip',
    });
    const trueOut = await kernel.readImage(trueConv.output);
    // 独立模型按真实源 ctrl-srgb 推导 p3 下的红
    const srcRef = new RefRGB(fixtures.loadProfile('ctrl-srgb'));
    const dstRef = new RefRGB(fixtures.loadProfile('ctrl-p3'));
    const truth = srcRef.convertTo(dstRef, red.map((v) => v / 255), { intent: 'relative-colorimetric' }).rgb01;
    const truthDE = deltaE2000(dstRef.rgbToLab(truth), dstRef.rgbToLab([...trueOut.pixels].map((v) => v / 255)));
    ok('正确标签的真实转换与独立真值一致（ΔE < 0.5）', truthDE < 0.5, { truthDE });
    const misDE = deltaE2000(dstRef.rgbToLab(truth), dstRef.rgbToLab([...misOut.pixels].map((v) => v / 255)));
    ok('错误标签的输出相对独立真值有显著色差（> 5），证明数值证据不可由反向自证替代',
      misDE > 5, { misDE });
    ok('同一像素：反向自证判“无误”，独立真值判“显著错误”',
      (await kernel.readImage(reverse.output)).pixels.equals(misOut.pixels) && misDE > 5);
  }

  console.log('== 8. 受控错误注入：色差/透明保留必须暴露坏结果 ==');  {
    // 7.1 输出像素被篡改 -> 色差超容差
    const { before, after, result } = await convertWith('ctrl-patches-8.png', {
      destinationIcc: fixtures.loadProfile('ctrl-p3'),
    });
    const corrupted = Buffer.from(after.pixels);
    for (let i = 0; i < corrupted.length; i += 12) corrupted[i] = Math.min(255, corrupted[i] + 60);
    const cvColor = verificationFor(before, { ...after, pixels: corrupted },
      before.embeddedIcc, fixtures.loadProfile('ctrl-p3'), {
        expectedSrcIcc: before.embeddedIcc, expectedDstIcc: fixtures.loadProfile('ctrl-p3'),
        requireColorVerification: true,
      });
    ok('篡改输出像素被色差证据捕获',
      cvColor.failures.includes('color-delta-exceeds-tolerance') && !cvColor.ok,
      cvColor.failures);
    ok('对照组（未篡改）同一变换通过，说明失败来自实际像素',
      result.verification.ok === true);
  }
  {
    // 7.2 alpha 被改为 0 -> 透明保留失败，且失败计数来自实际像素
    const { before, after } = await convertWith('ctrl-alpha-8.png', {
      destinationIcc: fixtures.loadProfile('ctrl-p3'),
    });
    const zeroed = Buffer.from(after.pixels);
    let touched = 0;
    for (let p = 0; p < before.width * before.height; p++) {
      const o = p * 4 + 3;
      if (zeroed[o] !== before.pixels[o]) { zeroed[o] = before.pixels[o]; touched++; }
    }
    // 现在故意清零偶数行像素的 alpha
    const zeroedCount = Math.ceil(before.width * before.height / 2);
    for (let p = 0; p < before.width * before.height; p += 2) zeroed[p * 4 + 3] = 0;
    const cvAlpha = verificationFor(before, { ...after, pixels: zeroed },
      before.embeddedIcc, fixtures.loadProfile('ctrl-p3'), {
        expectedSrcIcc: before.embeddedIcc, expectedDstIcc: fixtures.loadProfile('ctrl-p3'),
        requireColorVerification: true,
      });
    ok('篡改 alpha 被透明保留证据捕获',
      cvAlpha.failures.includes('alpha-not-preserved')
      && cvAlpha.alpha.mismatchedPixels > 0, cvAlpha.alpha);
    // 源图 alpha 首像素为 0，清零后与源相同，故不计数；只有源 alpha 非零且被清零的像素才算改动
    let expectedMismatch = 0;
    for (let p = 0; p < before.width * before.height; p += 2) {
      if (before.pixels[p * 4 + 3] !== 0) expectedMismatch++;
    }
    ok('透明保留失败计数等于被清零像素数',
      cvAlpha.alpha.mismatchedPixels === expectedMismatch,
      { mismatched: cvAlpha.alpha.mismatchedPixels, expectedMismatch });
  }
  {
    // 7.3 警报模式品红被抹掉 -> 警报一致性失败
    const wide = fixtures.loadImage('ctrl-wide-8.png');
    const wideImg = await kernel.readImage(wide);
    const alarm = await kernel.convertImage(wide, {
      source: {}, destinationIcc: fixtures.loadProfile('ctrl-narrow'),
      renderingIntent: 'relative-colorimetric', gamutMode: 'gamut-check',
    });
    const alarmOut = await kernel.readImage(alarm.output);
    const cleaned = Buffer.from(alarmOut.pixels);
    for (let i = 0; i < cleaned.length; i += 3) {
      if (cleaned[i] === 255 && cleaned[i + 1] === 0 && cleaned[i + 2] === 255) {
        cleaned[i + 1] = 40; // 抹掉品红警报
        if ((i / 3) % 97 === 0) break;
      }
    }
    const cvAlarm = verificationFor(wideImg, { ...alarmOut, pixels: cleaned },
      wideImg.embeddedIcc, fixtures.loadProfile('ctrl-narrow'), {
        intent: 'relative-colorimetric', gamutMode: 'gamut-check',
        expectedSrcIcc: wideImg.embeddedIcc, expectedDstIcc: fixtures.loadProfile('ctrl-narrow'),
        requireColorVerification: true,
      });
    ok('抹掉品红警报被超色域证据捕获',
      cvAlarm.failures.includes('gamut-alarm-inconsistent'), cvAlarm.failures);
    ok('未篡改的警报转换零缺失零误标',
      alarm.verification.gamut.alarmConsistent === true
      && alarm.verification.gamut.missingAlarmSamples === 0
      && alarm.verification.gamut.unexpectedAlarmSamples === 0);
  }
  {
    // 7.4 目标配置身份不符 -> destination-profile-mismatch
    const { before, after } = await convertWith('ctrl-patches-8.png', {
      destinationIcc: fixtures.loadProfile('ctrl-p3'),
    });
    const cvDst = verificationFor(before, after, before.embeddedIcc, fixtures.loadProfile('ctrl-p3'), {
      expectedSrcIcc: before.embeddedIcc, expectedDstIcc: fixtures.loadProfile('ctrl-cool'),
    });
    ok('目标配置身份不符被捕获',
      cvDst.failures.includes('destination-profile-mismatch'), cvDst.failures);
  }

  console.log('== 9. 域内/域外颜色：超色域判定与独立推导一致 ==');
  {
    const neutral = fixtures.loadImage('ctrl-neutral-8.png');
    const neutralImg = await kernel.readImage(neutral);
    let expectedOutside = 0, checked = 0;
    const srcRef = new RefRGB(neutralImg.embeddedIcc);
    const dstRef = new RefRGB(fixtures.loadProfile('ctrl-narrow'));
    for (const v of fixtures.NEUTRAL_STEPS) {
      const model = srcRef.convertTo(dstRef, [v / 255, v / 255, v / 255], { intent: 'relative-colorimetric' });
      checked++;
      if (!model.inGamut) expectedOutside++;
    }
    ok('域内中性阶独立推导全部在窄色域内', expectedOutside === 0, { expectedOutside, checked });
    const soft = await kernel.convertImage(neutral, {
      source: {}, destinationIcc: fixtures.loadProfile('ctrl-narrow'),
      renderingIntent: 'relative-colorimetric', gamutMode: 'softproof',
    });
    ok('域内中性样例软打样报告超色域为 0',
      soft.gamut.ratio === 0 && soft.gamut.outOfGamutPixels === 0, soft.gamut);
  }
  {
    const wide = fixtures.loadImage('ctrl-wide-8.png');
    const wideImg = await kernel.readImage(wide);
    const dstRef = new RefRGB(fixtures.loadProfile('ctrl-narrow'));
    const srcRef = new RefRGB(wideImg.embeddedIcc);
    const colors = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const outsideModel = colors.filter((c) => !srcRef.convertTo(dstRef, c, { intent: 'relative-colorimetric' }).inGamut).length;
    ok('域外原色独立推导全部超窄色域', outsideModel === 3, { outsideModel });
    const soft = await kernel.convertImage(wide, {
      source: {}, destinationIcc: fixtures.loadProfile('ctrl-narrow'),
      renderingIntent: 'relative-colorimetric', gamutMode: 'softproof',
    });
    ok('域外样例软打样报告有超色域像素', soft.gamut.outOfGamutPixels > 0, soft.gamut);
  }

  console.log('== 10. 旧图像色管样例运行到底（改动范围复核）==');
  const legacyDir = path.join(__dirname, '..', 'testdata');
  const legacyFiles = fs.readdirSync(legacyDir).filter((f) => f.endsWith('.png'));
  for (const file of legacyFiles) {
    const buf = fs.readFileSync(path.join(legacyDir, file));
    const img = await kernel.readImage(buf);
    if (!img.embeddedIcc) {
      let e = null;
      try { await kernel.convertImage(buf, { source: {}, destinationProfileId: 'display-p3' }); } catch (err) { e = err; }
      ok(`旧样例 ${file} 无配置时按约定拒绝`, e && e.code === 'SOURCE_PROFILE_MISSING');
      continue;
    }
    const conv = await kernel.convertImage(buf, {
      source: {}, destinationProfileId: 'display-p3',
      renderingIntent: 'relative-colorimetric', blackPointCompensation: false, gamutMode: 'clip',
    });
    const out = await kernel.readImage(conv.output);
    ok(`旧样例 ${file} 转换完成且输出可读`,
      out.width === img.width && out.height === img.height
      && out.bitsPerSample === img.bitsPerSample && out.hasAlpha === img.hasAlpha,
      { in: `${img.width}x${img.height}@${img.bitsPerSample}`, out: `${out.width}x${out.height}@${out.bitsPerSample}` });
    ok(`旧样例 ${file} 内核独立校验不报执行错误`, conv.verification.ok === true,
      conv.verification.failures);
  }

  console.log(`\n全部 ${pass} 项端到端色管验收通过。`);
})().catch((e) => {
  console.error('FAIL:', e.message);
  if (e.detail) console.error('detail:', e.detail);
  process.exit(1);
});
