'use strict';
// 自制测试图像生成：全部像素由本脚本按已知数值合成，不使用任何外部素材。
// 输出：
//   patches-8.png / patches-16.png  已知色块（sRGB 编码值）
//   gradient-16.png                 16 位平滑渐变（精度保留验证）
//   shadows-8.png                   暗部阶梯（黑点补偿验证）
//   wide-to-narrow.png              以宽色域编码、对窄色域必然超界的颜色
//   alpha-8.png                     含透明通道（alpha 不参与变换验证）
const fs = require('fs');
const path = require('path');
const kernel = require('../src/color-kernel');
const { embedIcc } = require('../src/png-icc');
const { encodePng } = require('../src/png-encode');

const OUT = path.join(__dirname, '..', 'testdata');
fs.mkdirSync(OUT, { recursive: true });

async function save(name, pixels, width, height, channels, depth, icc) {
  const bitsPerSample = depth === 'ushort' ? 16 : 8;
  const bare = encodePng({ width, height, channels, bitsPerSample, pixels });
  const buf = icc ? embedIcc(bare, icc, kernel.profileIdentity(icc).description) : bare;
  fs.writeFileSync(path.join(OUT, name), buf);
  console.log('写出', name, `${width}x${height}`, depth, channels + 'ch', icc ? `(嵌入 ${kernel.profileIdentity(icc).description})` : '(无 ICC)');
  return buf;
}

// 已知 sRGB 色块：名称 + 8 位编码
const PATCHES = [
  ['白色', [255, 255, 255]], ['中性灰128', [128, 128, 128]], ['黑色', [0, 0, 0]],
  ['sRGB红', [255, 0, 0]], ['sRGB绿', [0, 255, 0]], ['sRGB蓝', [0, 0, 255]],
  ['青', [0, 255, 255]], ['品红', [255, 0, 255]], ['黄', [255, 255, 0]],
  ['肤色参考', [222, 184, 135]], ['暗蓝', [25, 25, 112]], ['深棕', [101, 67, 33]],
];

async function patches(depth) {
  const cell = 64, cols = 6, rows = 2;
  const width = cell * cols, height = cell * rows;
  const bps = depth === 'ushort' ? 16 : 8;
  const ch = 3, bpe = bps / 8;
  const buf = Buffer.alloc(width * height * ch * bpe);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const [, rgb8] = PATCHES[idx];
      const val = rgb8.map((v) => (bps === 8 ? v : Math.round((v / 255) * 65535)));
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const o = ((r * cell + y) * width + c * cell + x) * ch * bpe;
          if (bps === 8) buf.set(val, o);
          else { buf[o] = val[0] >> 8; buf[o + 1] = val[0] & 255; buf[o + 2] = val[1] >> 8; buf[o + 3] = val[1] & 255; buf[o + 4] = val[2] >> 8; buf[o + 5] = val[2] & 255; }
        }
      }
    }
  }
  await save(bps === 8 ? 'patches-8.png' : 'patches-16.png', buf, width, height, ch, depth, kernel.builtinProfile('srgb'));
}

async function gradient16() {
  const width = 256, height = 64, ch = 3;
  const buf = Buffer.alloc(width * height * ch * 2);
  for (let x = 0; x < width; x++) {
    // 16 位渐变：相邻编码相差 257（=65535/255），并在暗部加入仅 16 位可分辨的细阶
    const v = x * 257;
    for (let y = 0; y < height; y++) {
      const o = (y * width + x) * ch * 2;
      buf[o] = v >> 8; buf[o + 1] = v & 255;
      buf[o + 2] = v >> 8; buf[o + 3] = v & 255;
      buf[o + 4] = v >> 8; buf[o + 5] = v & 255;
    }
  }
  await save('gradient-16.png', buf, width, height, ch, 'ushort', kernel.builtinProfile('srgb'));
}

async function shadows() {
  const width = 256, height = 64, ch = 3;
  const buf = Buffer.alloc(width * height * ch);
  for (let x = 0; x < width; x++) {
    const v = Math.min(40, Math.floor(x * 40 / 255)); // 0..40 暗部阶梯
    for (let y = 0; y < height; y++) {
      const o = (y * width + x) * ch;
      buf[o] = v; buf[o + 1] = v; buf[o + 2] = v;
    }
  }
  await save('shadows-8.png', buf, width, height, ch, 'uchar', kernel.builtinProfile('srgb'));
}

// 宽色域源（Display P3）中高饱和原色，对窄色域配置必然超界
async function wideToNarrow() {
  const cell = 64, cols = 3, rows = 1;
  const width = cell * cols, height = cell, ch = 3;
  const buf = Buffer.alloc(width * height * ch);
  const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];
  colors.forEach((val, c) => {
    for (let y = 0; y < height; y++) for (let x = 0; x < cell; x++) buf.set(val, (y * width + c * cell + x) * ch);
  });
  await save('wide-to-narrow.png', buf, width, height, ch, 'uchar', kernel.builtinProfile('display-p3'));
}

async function alphaImage() {
  const width = 128, height = 128, ch = 4;
  const buf = Buffer.alloc(width * height * ch);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * ch;
      buf[o] = 200; buf[o + 1] = 50; buf[o + 2] = 90;
      buf[o + 3] = Math.round(255 * x / (width - 1)); // alpha 横向 0..255
    }
  }
  await save('alpha-8.png', buf, width, height, ch, 'uchar', kernel.builtinProfile('srgb'));
}

// 16 位 RGBA：验证高位深下 RGB 被正确变换而 alpha 逐字节保持
async function alpha16Image() {
  const width = 64, height = 64, ch = 4;
  const buf = Buffer.alloc(width * height * ch * 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * ch * 2;
      buf.writeUInt16BE(52000, o);
      buf.writeUInt16BE(12000, o + 2);
      buf.writeUInt16BE(24000, o + 4);
      buf.writeUInt16BE(Math.round(65535 * x / (width - 1)), o + 6);
    }
  }
  await save('alpha-16.png', buf, width, height, ch, 'ushort', kernel.builtinProfile('srgb'));
}

// 无 ICC 的图像：用于验证“缺失源配置必须显式假设”
async function untagged() {
  const width = 64, height = 64, ch = 3;
  const buf = Buffer.alloc(width * height * ch);
  for (let i = 0; i < buf.length; i += 3) buf.set([18, 72, 140], i);
  await save('untagged-8.png', buf, width, height, ch, 'uchar', null);
}

(async () => {
  await patches('uchar');
  await patches('ushort');
  await gradient16();
  await shadows();
  await wideToNarrow();
  await alphaImage();
  await alpha16Image();
  await untagged();
  // 同步落盘一份色块参考表，供测试核对
  fs.writeFileSync(path.join(OUT, 'patches-reference.json'), JSON.stringify(PATCHES, null, 2));
  console.log('全部测试图像已生成于', OUT);
})().catch((e) => { console.error(e); process.exit(1); });
