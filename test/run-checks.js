'use strict';
// 端到端核对：所有断言基于数值与参考值，不依赖肉眼、不依赖浏览器显示。
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const sharp = require('sharp');
const kernel = require('../src/color-kernel');
const { RefRGB, deltaE2000 } = require('../src/ref-engine');
const native = require('../build/Release/lcms_native.node');

const DATA = path.join(__dirname, '..', 'testdata');
const read = (n) => fs.readFileSync(path.join(DATA, n));
let pass = 0;
function ok(name, cond, extra) {
  assert.ok(cond, name + (extra ? ' :: ' + JSON.stringify(extra) : ''));
  pass++;
  console.log('  PASS', name);
}

(async () => {
  console.log('== 1. 独立参考引擎 vs lcms2 内核（Lab / ΔE2000）==');
  for (const id of ['srgb', 'display-p3', 'adobergb', 'narrow-gamut', 'linear-srgb']) {
    const icc = kernel.builtinProfile(id);
    const samples = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.5, 0.5, 0.5], [0.18, 0.72, 0.33], [0.95, 0.95, 0.95]];
    const check = kernel.referenceCrossCheck(icc, samples);
    ok(`参考引擎适用 ${id}`, check.applicable);
    ok(`${id} 纯JS参考与lcms2 Lab 最大 ΔE2000 < 0.5`, check.maxDE < 0.5, { maxDE: check.maxDE });
  }

  // 教科书参考值：sRGB D65 红（编码255,0,0）的 Lab 约 L=53.24,a=80.09,b=67.20（D65 白点）；
  // ICC 管线经 Bradford 适应到 D50 后约 L=54.3,a=80.8,b=69.9。核对 lcms 与纯 JS 都落在该区间。
  const srgb = kernel.builtinProfile('srgb');
  const labLcms = Array.from(native.rgbToLab({ icc: srgb, rgb: Float32Array.from([1, 0, 0]) }));
  const labRef = new RefRGB(srgb).rgbToLab([1, 0, 0]);
  ok('sRGB 红 L 通道在 D50 参考区间 53..56', labLcms[0] > 53 && labLcms[0] < 56, labLcms);
  ok('参考引擎 sRGB 红 L 与 lcms 一致（ΔE<0.3）', deltaE2000(labLcms, labRef) < 0.3, { labLcms, labRef });

  console.log('== 2. 指定配置（assign）只改标签，像素逐字节不变 ==');
  const patches8 = read('patches-8.png');
  const before = await kernel.readImage(patches8);
  const assigned = await kernel.assignProfile(patches8, kernel.builtinProfile('display-p3'));
  ok('assign 返回 pixelsTouched=false', assigned.pixelsTouched === false);
  ok('assign 像素逐字节不变', assigned.audit.pixelBytesUnchanged === true);
  const afterAssign = await kernel.readImage(assigned.output);
  ok('assign 后嵌入的是新配置指纹', afterAssign.embeddedIcc &&
    kernel.profileIdentity(afterAssign.embeddedIcc).sha256 === kernel.profileIdentity(kernel.builtinProfile('display-p3')).sha256);
  ok('assign 后像素与原文件完全相同', afterAssign.pixels.equals(before.pixels));
  ok('assign 审计保留了前后配置身份', !!assigned.audit.beforeProfile && !!assigned.audit.assignedProfile);

  console.log('== 3. 实际转换（convert）像素确实改变，且输出嵌入目标配置 ==');
  const converted = await kernel.convertImage(patches8, {
    source: {}, destinationProfileId: 'display-p3',
    renderingIntent: 'relative-colorimetric', blackPointCompensation: true, gamutMode: 'clip',
  });
  ok('convert 返回 pixelsTouched=true', converted.pixelsTouched === true);
  const afterConv = await kernel.readImage(converted.output);
  ok('convert 输出嵌入目标 P3 配置', kernel.profileIdentity(afterConv.embeddedIcc).description === 'display-p3');
  ok('convert 像素确实发生变化', !afterConv.pixels.equals(before.pixels));
  // 白场在相对色度下应保持近白
  const whiteIdx = 0; // 第一个色块即白色
  const wBefore = before.pixels.slice(whiteIdx * 3, whiteIdx * 3 + 3);
  const wAfter = afterConv.pixels.slice(whiteIdx * 3, whiteIdx * 3 + 3);
  ok('白点相对色度映射后仍近白', wAfter.every((v) => v >= 252), { wBefore: [...wBefore], wAfter: [...wAfter] });
  // 颜色身份在 Lab 空间保持（同色块转换前后 ΔE 应较小，P3 覆盖 sRGB）
  ok('转换平均 ΔE2000 较小（P3⊇sRGB 色块）', converted.deltaE.mean < 2, converted.deltaE);

  console.log('== 4. 超色域检测：P3 纯色 -> 窄色域配置 ==');
  const wide = read('wide-to-narrow.png');
  const narrow = await kernel.convertImage(wide, {
    source: {}, destinationProfileId: 'narrow-gamut',
    renderingIntent: 'relative-colorimetric', blackPointCompensation: false, gamutMode: 'softproof',
  });
  ok('检出超色域像素且比例 > 0', narrow.gamut.outOfGamutPixels > 0 && narrow.gamut.ratio > 0, narrow.gamut);
  const alarm = await kernel.convertImage(wide, {
    source: {}, destinationProfileId: 'narrow-gamut',
    renderingIntent: 'relative-colorimetric', blackPointCompensation: false, gamutMode: 'gamut-check',
  });
  const alarmImg = await kernel.readImage(alarm.output);
  const isMagenta = (o) => alarmImg.pixels[o] === 255 && alarmImg.pixels[o + 1] === 0 && alarmImg.pixels[o + 2] === 255;
  let magentaCells = 0;
  for (let c = 0; c < 3; c++) {
    const o = (32 * 192 + c * 64 + 32) * 3;
    if (isMagenta(o)) magentaCells++;
  }
  ok('警报模式下超界单元格被品红标记', magentaCells >= 2, { magentaCells });

  console.log('== 5. 暗部与黑点补偿 ==');
  const shadows = read('shadows-8.png');
  const noBpc = await kernel.convertImage(shadows, {
    source: {}, destinationProfileId: 'adobergb',
    renderingIntent: 'relative-colorimetric', blackPointCompensation: false,
  });
  const withBpc = await kernel.convertImage(shadows, {
    source: {}, destinationProfileId: 'adobergb',
    renderingIntent: 'relative-colorimetric', blackPointCompensation: true,
  });
  const imgNo = await kernel.readImage(noBpc.output);
  const imgBpc = await kernel.readImage(withBpc.output);
  // 最暗几阶：BPC 打开后不应出现比无补偿更多的并阶（比较非零暗阶数量）
  const distinctNo = new Set(); const distinctBpc = new Set();
  for (let x = 0; x < 256; x++) {
    const o = (32 * 256 + x) * 3;
    distinctNo.add(imgNo.pixels[o]); distinctBpc.add(imgBpc.pixels[o]);
  }
  ok('黑点补偿保留的暗部阶数不少于无补偿', distinctBpc.size >= distinctNo.size,
    { noBpc: distinctNo.size, bpc: distinctBpc.size });

  console.log('== 6. 16 位高位深精度保留 ==');
  const g16 = read('gradient-16.png');
  const gImg = await kernel.readImage(g16);
  ok('源被识别为 16 位', gImg.bitsPerSample === 16);
  const gConv = await kernel.convertImage(g16, {
    source: {}, destinationProfileId: 'adobergb',
    renderingIntent: 'relative-colorimetric', blackPointCompensation: false,
  });
  ok('16 位输出仍是 16 位', gConv.bitsPerSample === 16);
  const gOut = await kernel.readImage(gConv.output);
  ok('16 位输出未被降级为 8 位', gOut.bitsPerSample === 16);
  const distinct16 = new Set();
  let non8bitRepresentable = 0;
  const totalSamples = [];
  for (let x = 0; x < 256; x++) {
    const o = (32 * 256 + x) * 6;
    const v = (gOut.pixels[o] << 8) | gOut.pixels[o + 1];
    distinct16.add(v);
    totalSamples.push(v);
    // 8 位容器只能表示 257 的偶数倍（0,257,514...）；其余值证明保留了 16 位精度
    if (v % 257 !== 0) non8bitRepresentable++;
  }
  ok('16 位渐变保留多阶调（>150）', distinct16.size > 150, { steps: distinct16.size });
  ok('输出含 8 位容器无法表示的 16 位采样（精度未被降级）', non8bitRepresentable > 100,
    { non8bitRepresentable });
  // 端序回归保护：渐变最右列为 16 位纯白(65535)，相对色度转换后绝不能塌缩成近黑
  const wo = (32 * 256 + 255) * 6;
  const whiteBE = (gOut.pixels[wo] << 8) | gOut.pixels[wo + 1];
  ok('16 位纯白转换后仍近白（大端字节序正确，未塌缩为近黑）', whiteBE > 60000, { whiteBE });
  ok('16 位色差处于色度合理范围（均值 < 3）', gConv.deltaE.mean < 3, { mean: gConv.deltaE.mean });

  console.log('== 7. 透明通道不参与颜色变换（逐字节保持）==');
  const alpha = read('alpha-8.png');
  const aConv = await kernel.convertImage(alpha, {
    source: {}, destinationProfileId: 'display-p3',
    renderingIntent: 'relative-colorimetric', blackPointCompensation: false,
  });
  ok('alpha 图像转换未触发内核不变量错误', !!aConv.output);
  const aBefore = await kernel.readImage(alpha);
  const aAfter = await kernel.readImage(aConv.output);
  let alphaSame = true; let colorChanged = false;
  for (let i = 0; i < aBefore.width * aBefore.height; i++) {
    const o = i * 4;
    if (aBefore.pixels[o + 3] !== aAfter.pixels[o + 3]) alphaSame = false;
    if (aBefore.pixels[o] !== aAfter.pixels[o] || aBefore.pixels[o + 1] !== aAfter.pixels[o + 1]) colorChanged = true;
  }
  ok('alpha 通道全部逐字节保持', alphaSame);
  ok('RGB 颜色通道确实被变换', colorChanged);

  // 16 位 RGBA：高位深下端序、alpha 隔离同时成立
  const alpha16 = read('alpha-16.png');
  const a16Before = await kernel.readImage(alpha16);
  ok('16 位 RGBA 源识别为 16 位且含 alpha', a16Before.bitsPerSample === 16 && a16Before.hasAlpha === true);
  const a16Conv = await kernel.convertImage(alpha16, {
    source: {}, destinationProfileId: 'display-p3',
    renderingIntent: 'relative-colorimetric', blackPointCompensation: false,
  });
  const a16After = await kernel.readImage(a16Conv.output);
  let a16AlphaSame = true, a16ColorChanged = false;
  const nPx = a16Before.width * a16Before.height;
  for (let px = 0; px < nPx; px++) {
    const o = px * 8;
    if (a16Before.pixels.readUInt16BE(o + 6) !== a16After.pixels.readUInt16BE(o + 6)) a16AlphaSame = false;
    if (a16Before.pixels.readUInt16BE(o) !== a16After.pixels.readUInt16BE(o)) a16ColorChanged = true;
  }
  ok('16 位 alpha 通道逐字节保持', a16AlphaSame);
  ok('16 位 RGB 颜色通道被正确变换（端序正确）', a16ColorChanged);

  console.log('== 8. 源配置缺失：必须显式假设并记录，禁止自动认定 ==');
  const untagged = read('untagged-8.png');
  let threw = null;
  try {
    await kernel.convertImage(untagged, { source: {}, destinationProfileId: 'display-p3' });
  } catch (e) { threw = e; }
  ok('无假设时拒绝转换并返回 SOURCE_PROFILE_MISSING', threw && threw.code === 'SOURCE_PROFILE_MISSING');
  const assumed = await kernel.convertImage(untagged, {
    source: { assumeProfileId: 'srgb', reason: '馆藏数字化规范约定该批次为 sRGB 采集' },
    destinationProfileId: 'display-p3',
  });
  ok('显式假设被记录进审计', assumed.source.assumed === true && /sRGB/.test(assumed.source.assumption.reason));
  ok('假设警告写入结果', !!assumed.source.assumption.warning);

  console.log('== 9. 失败结构化回传（图像色管内核 -> 界面）==');
  const cases = [
    [{}, 'PROFILE_UNKNOWN'],
    [{ source: {}, destinationProfileId: 'srgb', renderingIntent: 'bogus' }, 'BAD_INTENT'],
    [{ source: {}, destinationProfileId: 'srgb', renderingIntent: 'absolute-colorimetric', blackPointCompensation: true }, 'BAD_COMBINATION'],
  ];
  for (const [opts, code] of cases) {
    let e = null;
    try { await kernel.convertImage(patches8, opts); } catch (err) { e = err; }
    ok(`失败返回错误码 ${code}`, e && e.code === code, e && e.message);
  }

  console.log('== 10. 配置身份可核对（SHA-256 + 描述）==');
  const id1 = kernel.profileIdentity(kernel.builtinProfile('srgb'));
  const id2 = kernel.profileIdentity(kernel.builtinProfile('srgb'));
  const id3 = kernel.profileIdentity(kernel.builtinProfile('display-p3'));
  ok('同配置指纹稳定', id1.sha256 === id2.sha256);
  ok('不同配置指纹不同', id1.sha256 !== id3.sha256);
  ok('身份包含描述/类别/位深信息', id1.description && id1.deviceClass === 'mntr' && id1.isMatrixShaper === true);

  console.log('== 11. JPEG 容器：APP2 ICC 嵌入/提取与转换往返 ==');
  const { jpegEmbedIcc, jpegExtractIcc } = require('../src/jpeg-icc');
  // 先用 sharp 造一张不含 ICC 的 JPEG
  const jpegRaw = await sharp(patches8).jpeg({ quality: 98 }).toBuffer();
  ok('原始 JPEG 无 ICC', jpegExtractIcc(jpegRaw) === null);
  const jpegWithIcc = jpegEmbedIcc(jpegRaw, kernel.builtinProfile('display-p3'));
  const extracted = jpegExtractIcc(jpegWithIcc);
  ok('JPEG 可提取回完整 ICC（字节一致）', extracted &&
    extracted.equals(kernel.builtinProfile('display-p3')));
  const jpegImg = await kernel.readImage(jpegWithIcc);
  ok('内核能读取 JPEG 嵌入配置', jpegImg.embeddedIcc &&
    kernel.profileIdentity(jpegImg.embeddedIcc).description === 'display-p3');
  const jpegConv = await kernel.convertImage(jpegWithIcc, {
    source: {}, destinationProfileId: 'srgb',
    renderingIntent: 'relative-colorimetric', blackPointCompensation: false,
  });
  const jpegOut = await kernel.readImage(jpegConv.output);
  ok('JPEG 转换输出嵌入 sRGB 配置', kernel.profileIdentity(jpegOut.embeddedIcc).description === 'srgb');
  ok('JPEG 转换输出仍是 JPEG 可读格式', jpegOut.format === 'jpeg');
  // 重复嵌入不应产生重复 APP2 段
  const twice = jpegEmbedIcc(jpegWithIcc, kernel.builtinProfile('srgb'));
  ok('重复嵌入先剥离旧段，ICC 唯一', jpegExtractIcc(twice).equals(kernel.builtinProfile('srgb')));

  console.log(`\n全部 ${pass} 项核对通过。`);
})().catch((e) => {
  console.error('FAIL:', e.message);
  if (e.detail) console.error('detail:', e.detail);
  process.exit(1);
});
