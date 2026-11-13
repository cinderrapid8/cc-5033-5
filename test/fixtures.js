'use strict';
// 受控色管验证样例：已知颜色补丁 + 显式参数构造的 ICC 资料。
// 所有样例由本模块确定性生成，参数即唯一事实来源；期望值可由 ICC 语义独立推导，
// 不依赖 lcms，也不使用任何“反向转换”作为真值。
const fs = require('fs');
const path = require('path');
const { buildMatrixShaperProfile } = require('../src/profile-fixture');
const { embedIcc } = require('../src/png-icc');
const { encodePng } = require('../src/png-encode');

const FIXTURE_DIR = path.join(__dirname, '..', 'testdata', 'controlled');

const PROFILE_SPECS = [
  {
    id: 'ctrl-srgb', file: 'ctrl-srgb.icc', description: 'Ctrl sRGB (D65, gamma 2.2)',
    white: [0.3127, 0.3290],
    primaries: [[0.64, 0.33], [0.30, 0.60], [0.15, 0.06]],
    gamma: 2.20000000,
  },
  {
    id: 'ctrl-p3', file: 'ctrl-p3.icc', description: 'Ctrl Wide P3 (D65, gamma 2.2)',
    white: [0.3127, 0.3290],
    primaries: [[0.68, 0.32], [0.265, 0.69], [0.15, 0.06]],
    gamma: 2.20000000,
  },
  {
    id: 'ctrl-narrow', file: 'ctrl-narrow.icc', description: 'Ctrl Narrow (D65, gamma 2.2)',
    white: [0.3127, 0.3290],
    primaries: [[0.50, 0.40], [0.30, 0.55], [0.20, 0.20]],
    gamma: 2.20000000,
  },
  {
    id: 'ctrl-linear', file: 'ctrl-linear.icc', description: 'Ctrl Linear (D65, gamma 1.0)',
    white: [0.3127, 0.3290],
    primaries: [[0.64, 0.33], [0.30, 0.60], [0.15, 0.06]],
    gamma: 1.00000000,
  },
  {
    id: 'ctrl-warm', file: 'ctrl-warm.icc', description: 'Ctrl Warm media white (sRGB primaries)',
    white: [0.3800, 0.3600],
    primaries: [[0.64, 0.33], [0.30, 0.60], [0.15, 0.06]],
    gamma: 2.20000000,
  },
  {
    id: 'ctrl-cool', file: 'ctrl-cool.icc', description: 'Ctrl Cool media white (sRGB primaries)',
    white: [0.2800, 0.3000],
    primaries: [[0.64, 0.33], [0.30, 0.60], [0.15, 0.06]],
    gamma: 2.20000000,
  },
];

// 已知补丁：名称 + 8 位编码值。编码值按所属样例的源配置解读。
const PATCHES = [
  ['white', [255, 255, 255]], ['neutral-128', [128, 128, 128]], ['black', [0, 0, 0]],
  ['red', [255, 0, 0]], ['green', [0, 255, 0]], ['blue', [0, 0, 255]],
  ['cyan', [0, 255, 255]], ['magenta', [255, 0, 255]], ['yellow', [255, 255, 0]],
  ['skin', [222, 184, 135]], ['navy', [25, 25, 112]], ['brown', [101, 67, 33]],
];

const NEUTRAL_STEPS = [0, 32, 64, 96, 128, 160, 192, 224];

const IMAGE_SPECS = [
  { kind: 'patches', file: 'ctrl-patches-8.png', profileId: 'ctrl-srgb', bits: 8, cell: 32,
    description: '已知 12 色补丁（Ctrl sRGB 8 位）' },
  { kind: 'patches', file: 'ctrl-patches-16.png', profileId: 'ctrl-srgb', bits: 16, cell: 32,
    description: '已知 12 色补丁（Ctrl sRGB 16 位）' },
  { kind: 'patches', file: 'ctrl-warm-patches-8.png', profileId: 'ctrl-warm', bits: 8, cell: 32,
    description: '已知 12 色补丁（Ctrl Warm 8 位，用于绝对/相对色度区分）' },
  { kind: 'alpha', file: 'ctrl-alpha-8.png', profileId: 'ctrl-srgb', bits: 8, width: 16, height: 16,
    rgb: [200, 50, 90], description: '透明通道样例（8 位 RGBA，alpha 横向渐变）' },
  { kind: 'alpha', file: 'ctrl-alpha-16.png', profileId: 'ctrl-srgb', bits: 16, width: 8, height: 8,
    rgb16: [52000, 12000, 24000], description: '透明通道样例（16 位 RGBA）' },
  { kind: 'wide', file: 'ctrl-wide-8.png', profileId: 'ctrl-p3', bits: 8, cell: 24,
    description: '域外颜色样例（Ctrl P3 高饱和原色，对窄色域超界）' },
  { kind: 'neutral', file: 'ctrl-neutral-8.png', profileId: 'ctrl-srgb', bits: 8, cell: 16,
    description: '域内中性阶（Ctrl sRGB -> 窄色域不应超界）' },
  { kind: 'ramp', file: 'ctrl-ramp-8.png', profileId: 'ctrl-linear', bits: 8, width: 256, height: 8,
    description: '线性 TRC 渐变（语义推导用）' },
  { kind: 'constant', file: 'ctrl-untagged-8.png', profileId: null, bits: 8, width: 16, height: 16,
    rgb: [18, 72, 140], description: '无配置样例（用于缺失源配置正反例）' },
  { kind: 'alphaConstant', file: 'ctrl-untagged-alpha-8.png', profileId: null, bits: 8, width: 8, height: 8,
    rgb: [90, 140, 60], description: '无配置透明样例（缺失配置 + alpha 同时验证）' },
];

function specById(id) {
  const p = PROFILE_SPECS.find((s) => s.id === id);
  if (!p) throw new Error('未知受控配置: ' + id);
  return p;
}
function imageSpecByFile(file) {
  const s = IMAGE_SPECS.find((i) => i.file === file);
  if (!s) throw new Error('未知受控样例图像: ' + file);
  return s;
}

function scale8to16(v) { return Math.round((v / 255) * 65535); }

function fillSolid(buf, width, height, channels, bits, rgb) {
  const bpe = bits / 8;
  const vals = bits === 8 ? rgb : rgb.map(scale8to16);
  for (let i = 0; i < width * height; i++) {
    const o = i * channels * bpe;
    for (let c = 0; c < 3; c++) {
      if (bits === 8) buf[o + c] = vals[c];
      else { buf[o + c * 2] = vals[c] >> 8; buf[o + c * 2 + 1] = vals[c] & 255; }
    }
  }
}

function buildPatches(spec) {
  const cell = spec.cell || 32, cols = 6, rows = 2;
  const width = cell * cols, height = cell * rows;
  const ch = 3;
  const bpe = spec.bits / 8;
  const buf = Buffer.alloc(width * height * ch * bpe);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const rgb = PATCHES[idx][1];
      const vals = spec.bits === 8 ? rgb : rgb.map(scale8to16);
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const o = ((r * cell + y) * width + c * cell + x) * ch * bpe;
          for (let k = 0; k < 3; k++) {
            if (spec.bits === 8) buf[o + k] = vals[k];
            else { buf[o + k * 2] = vals[k] >> 8; buf[o + k * 2 + 1] = vals[k] & 255; }
          }
        }
      }
    }
  }
  return { pixels: buf, width, height, channels: ch };
}

function buildAlpha(spec) {
  const width = spec.width, height = spec.height, ch = 4, bpe = spec.bits / 8;
  const buf = Buffer.alloc(width * height * ch * bpe);
  const vals = spec.bits === 8 ? spec.rgb : spec.rgb16;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * ch * bpe;
      if (spec.bits === 8) {
        buf[o] = vals[0]; buf[o + 1] = vals[1]; buf[o + 2] = vals[2];
        buf[o + 3] = Math.round(255 * x / Math.max(1, width - 1));
      } else {
        buf.writeUInt16BE(vals[0], o);
        buf.writeUInt16BE(vals[1], o + 2);
        buf.writeUInt16BE(vals[2], o + 4);
        buf.writeUInt16BE(Math.round(65535 * x / Math.max(1, width - 1)), o + 6);
      }
    }
  }
  return { pixels: buf, width, height, channels: ch };
}

function buildWide(spec) {
  const cell = spec.cell || 24, cols = 3, rows = 1;
  const width = cell * cols, height = cell * rows, ch = 3, bpe = spec.bits / 8;
  const buf = Buffer.alloc(width * height * ch * bpe);
  const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];
  colors.forEach((rgb, c) => {
    const vals = spec.bits === 8 ? rgb : rgb.map(scale8to16);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < cell; x++) {
        const o = (y * width + c * cell + x) * ch * bpe;
        for (let k = 0; k < 3; k++) {
          if (spec.bits === 8) buf[o + k] = vals[k];
          else { buf[o + k * 2] = vals[k] >> 8; buf[o + k * 2 + 1] = vals[k] & 255; }
        }
      }
    }
  });
  return { pixels: buf, width, height, channels: ch };
}

function buildNeutral(spec) {
  const cell = spec.cell || 16, ch = 3, bpe = spec.bits / 8;
  const width = cell * NEUTRAL_STEPS.length, height = cell;
  const buf = Buffer.alloc(width * height * ch * bpe);
  NEUTRAL_STEPS.forEach((v, c) => {
    const val = spec.bits === 8 ? v : scale8to16(v);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < cell; x++) {
        const o = (y * width + c * cell + x) * ch * bpe;
        for (let k = 0; k < 3; k++) {
          if (spec.bits === 8) buf[o + k] = val;
          else { buf[o + k * 2] = val >> 8; buf[o + k * 2 + 1] = val & 255; }
        }
      }
    }
  });
  return { pixels: buf, width, height, channels: ch };
}

function buildRamp(spec) {
  const width = spec.width, height = spec.height, ch = 3, bpe = spec.bits / 8;
  const buf = Buffer.alloc(width * height * ch * bpe);
  for (let x = 0; x < width; x++) {
    const v = x;
    for (let y = 0; y < height; y++) {
      const o = (y * width + x) * ch * bpe;
      for (let k = 0; k < 3; k++) {
        if (spec.bits === 8) buf[o + k] = v;
        else { const v16 = scale8to16(v); buf[o + k * 2] = v16 >> 8; buf[o + k * 2 + 1] = v16 & 255; }
      }
    }
  }
  return { pixels: buf, width, height, channels: ch };
}

function buildAlphaConstant(spec) {
  const width = spec.width, height = spec.height, ch = 4, bpe = spec.bits / 8;
  const buf = Buffer.alloc(width * height * ch * bpe);
  const vals = spec.bits === 8 ? spec.rgb : spec.rgb.map(scale8to16);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * ch * bpe;
      for (let k = 0; k < 3; k++) {
        if (spec.bits === 8) buf[o + k] = vals[k];
        else { buf[o + k * 2] = vals[k] >> 8; buf[o + k * 2 + 1] = vals[k] & 255; }
      }
      const a = Math.round(255 * (x + y) / Math.max(1, width + height - 2));
      if (spec.bits === 8) buf[o + 3] = a;
      else buf.writeUInt16BE(scale8to16(a), o + 6);
    }
  }
  return { pixels: buf, width, height, channels: ch };
}

function buildImage(spec) {
  switch (spec.kind) {
    case 'patches': return buildPatches(spec);
    case 'alpha': return buildAlpha(spec);
    case 'wide': return buildWide(spec);
    case 'neutral': return buildNeutral(spec);
    case 'ramp': return buildRamp(spec);
    case 'constant': return buildConstant(spec);
    case 'alphaConstant': return buildAlphaConstant(spec);
    default: throw new Error('未知样例类型: ' + spec.kind);
  }
}

function buildConstant(spec) {
  const width = spec.width, height = spec.height, ch = 3, bpe = spec.bits / 8;
  const buf = Buffer.alloc(width * height * ch * bpe);
  fillSolid(buf, width, height, ch, spec.bits, spec.rgb);
  return { pixels: buf, width, height, channels: ch };
}

function writeFixtures({ quiet = false } = {}) {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const profiles = [];
  for (const spec of PROFILE_SPECS) {
    const icc = buildMatrixShaperProfile({
      description: spec.description,
      tagName: spec.id,
      white: spec.white,
      primaries: spec.primaries,
      gamma: spec.gamma,
    });
    fs.writeFileSync(path.join(FIXTURE_DIR, spec.file), icc);
    profiles.push({ id: spec.id, file: spec.file, description: spec.description,
      white: spec.white, primaries: spec.primaries, gamma: spec.gamma,
      bytes: icc.length, sha256: require('crypto').createHash('sha256').update(icc).digest('hex') });
    if (!quiet) console.log('写出配置', spec.file, icc.length, 'bytes');
  }
  const images = [];
  for (const spec of IMAGE_SPECS) {
    const img = buildImage(spec);
    const bits = spec.bits || 8;
    const bare = encodePng({
      width: img.width, height: img.height,
      channels: img.channels, bitsPerSample: bits, pixels: img.pixels,
    });
    const icc = spec.profileId
      ? fs.readFileSync(path.join(FIXTURE_DIR, specById(spec.profileId).file))
      : null;
    const out = icc ? embedIcc(bare, icc, spec.profileId) : bare;
    fs.writeFileSync(path.join(FIXTURE_DIR, spec.file), out);
    images.push({ file: spec.file, kind: spec.kind, profileId: spec.profileId,
      bits, channels: img.channels, width: img.width, height: img.height,
      description: spec.description,
      sha256: require('crypto').createHash('sha256').update(out).digest('hex') });
    if (!quiet) console.log('写出样例', spec.file, `${img.width}x${img.height}`, bits + 'bit', img.channels + 'ch');
  }
  const manifest = {
    generatedBy: 'test/fixtures.js (deterministic)',
    profiles,
    images,
    patches: PATCHES.map(([name, rgb]) => ({ name, rgb8: rgb })),
    neutralSteps: NEUTRAL_STEPS,
  };
  fs.writeFileSync(path.join(FIXTURE_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  if (!quiet) console.log('样例清单已写入', path.join(FIXTURE_DIR, 'manifest.json'));
  return manifest;
}

function ensureFixtures({ quiet = true } = {}) {
  const manifestPath = path.join(FIXTURE_DIR, 'manifest.json');
  const missing = !fs.existsSync(manifestPath)
    || PROFILE_SPECS.some((p) => !fs.existsSync(path.join(FIXTURE_DIR, p.file)))
    || IMAGE_SPECS.some((i) => !fs.existsSync(path.join(FIXTURE_DIR, i.file)));
  if (missing || process.env.REGEN_FIXTURES === '1') return writeFixtures({ quiet });
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function loadProfile(idOrFile) {
  const spec = PROFILE_SPECS.find((s) => s.id === idOrFile);
  const file = spec ? spec.file : idOrFile;
  return fs.readFileSync(path.join(FIXTURE_DIR, file));
}
function loadImage(file) { return fs.readFileSync(path.join(FIXTURE_DIR, file)); }

module.exports = {
  FIXTURE_DIR, PROFILE_SPECS, IMAGE_SPECS, PATCHES, NEUTRAL_STEPS,
  writeFixtures, ensureFixtures, loadProfile, loadImage, specById, imageSpecByFile,
};
