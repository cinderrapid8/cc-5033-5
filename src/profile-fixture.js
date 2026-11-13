'use strict';
// 受控 ICC matrix-shaper 资料生成器：所有参数（白点、原色、TRC）由调用方显式给定，
// 不经过 lcms、不依赖任何已安装颜色库。用于建立“已知补丁 + 已知配置”的端到端色管测试，
// 使期望值可从 ICC 语义独立推导，而不是把 lcms 的反向调用当作真值。
//
// 生成的是 ICC v2 matrix-shaper 描述文件：
//   - wtpt 标签记录介质白点（media white），绝对值即该白点；
//   - rXYZ/gXYZ/bXYZ 记录经 Bradford 白点适应到 D50 的矩阵（D50 media-relative）；
//   - TRC 为单一 gamma 曲线（curv count=1）。
// 这套语义下，相对色度与绝对色度意图可分别由矩阵与媒体白点独立推导。

const crypto = require('crypto');

function s15(v) {
  let x = Math.round(v * 65536);
  if (x < 0) x += 0x100000000;
  const b = Buffer.alloc(4);
  b.writeUInt32BE(x >>> 0, 0);
  return b;
}
function u32(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0, 0);
  return b;
}
function u16(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v & 0xFFFF, 0);
  return b;
}
function pad4(b) {
  const r = (4 - (b.length % 4)) % 4;
  return Buffer.concat([b, Buffer.alloc(r)]);
}
function xyzTag(x, y, z) {
  return Buffer.concat([Buffer.from('XYZ ', 'latin1'), Buffer.alloc(4), s15(x), s15(y), s15(z)]);
}
function curvGamma(g) {
  return Buffer.concat([Buffer.from('curv', 'latin1'), Buffer.alloc(4), u32(1), u16(Math.round(g * 256))]);
}
function mluc(str) {
  const utf16 = Buffer.from(str, 'utf16le');
  const swapped = Buffer.alloc(utf16.length);
  for (let i = 0; i < utf16.length; i += 2) {
    swapped[i] = utf16[i + 1];
    swapped[i + 1] = utf16[i];
  }
  return Buffer.concat([
    Buffer.from('mluc', 'latin1'), Buffer.alloc(4),
    u32(1), u32(12), Buffer.from('enUS', 'latin1'),
    u32(swapped.length), u32(28), swapped,
  ]);
}
function textTag(str) {
  return Buffer.concat([Buffer.from('text', 'latin1'), Buffer.alloc(4), Buffer.from(str + '\0', 'latin1')]);
}
function sf32(m) {
  const vals = [];
  for (const row of m) for (const v of row) vals.push(s15(v));
  return Buffer.concat([Buffer.from('sf32', 'latin1'), Buffer.alloc(4), ...vals]);
}

function inv3(M) {
  const A = M.map((row, i) => row.concat([i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0]));
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    const pv = A[col][col];
    for (let k = 0; k < 6; k++) A[col][k] /= pv;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = A[r][col];
      for (let k = 0; k < 6; k++) A[r][k] -= f * A[col][k];
    }
  }
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[i][j] = A[i][j + 3];
  return out;
}
function mul3(M, v) {
  return [
    M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
    M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
    M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
  ];
}
function mulMM(A, B) {
  const R = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) R[i][j] += A[i][k] * B[k][j];
  return R;
}
function xyToXYZ(x, y) { return [x / y, 1, (1 - x - y) / y]; }

// 线性 RGB 原色 -> 媒体相对 XYZ 矩阵（未做白点适应）
function rgbMatrix(whiteXY, primariesXY) {
  const P = [
    primariesXY.map((p) => p[0] / p[1]),
    [1, 1, 1],
    primariesXY.map((p) => (1 - p[0] - p[1]) / p[1]),
  ];
  const Wh = xyToXYZ(whiteXY[0], whiteXY[1]);
  const S = mul3(inv3(P), Wh);
  return mulMM(P, [[S[0], 0, 0], [0, S[1], 0], [0, 0, S[2]]]);
}

const BRADFORD = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];
const D50 = [0.9642, 1.0, 0.8249];

function bradfordAdapt(srcWhiteXYZ, dstWhiteXYZ) {
  const s = mul3(BRADFORD, srcWhiteXYZ);
  const d = mul3(BRADFORD, dstWhiteXYZ);
  const Dm = [[d[0] / s[0], 0, 0], [0, d[1] / s[1], 0], [0, 0, d[2] / s[2]]];
  return mulMM(inv3(BRADFORD), mulMM(Dm, BRADFORD));
}

// 由显式参数构造 ICC v2 matrix-shaper 资料字节。
// spec: { description, white: [x,y], primaries: [[x,y],[x,y],[x,y]], gamma }
function buildMatrixShaperProfile(spec) {
  const description = spec.description || 'controlled-profile';
  const white = spec.white || [0.3127, 0.3290];
  const primaries = spec.primaries || [[0.64, 0.33], [0.30, 0.60], [0.15, 0.06]];
  const gamma = spec.gamma || 2.20000000;
  const tagName = spec.tagName || 'controlled-fixture';

  const whiteXYZ = xyToXYZ(white[0], white[1]);
  const mediaM = rgbMatrix(white, primaries);
  const A = bradfordAdapt(whiteXYZ, D50);
  const pcsM = mulMM(A, mediaM);

  const tags = [
    ['desc', mluc(description)],
    ['wtpt', xyzTag(whiteXYZ[0], whiteXYZ[1], whiteXYZ[2])],
    ['chad', sf32(A)],
    ['rXYZ', xyzTag(pcsM[0][0], pcsM[1][0], pcsM[2][0])],
    ['gXYZ', xyzTag(pcsM[0][1], pcsM[1][1], pcsM[2][1])],
    ['bXYZ', xyzTag(pcsM[0][2], pcsM[1][2], pcsM[2][2])],
    ['rTRC', curvGamma(gamma)],
    ['gTRC', curvGamma(gamma)],
    ['bTRC', curvGamma(gamma)],
    ['cprt', textTag('controlled fixture: ' + tagName)],
  ].sort((a, b) => (a[0] < b[0] ? -1 : 1));

  const header = Buffer.alloc(128);
  header.write('mntr', 12, 'latin1');
  header.write('RGB ', 16, 'latin1');
  header.write('XYZ ', 20, 'latin1');
  header.write('acsp', 36, 'latin1');
  header[8] = 4; header[9] = 0x30; // ICC v4.3：wtpt 记录介质白、chad 记录适应矩阵
  s15(D50[0]).copy(header, 68);
  s15(D50[1]).copy(header, 72);
  s15(D50[2]).copy(header, 76);

  let offset = 128 + 4 + tags.length * 12;
  const table = [];
  const data = [];
  for (const [sig, body] of tags) {
    table.push(Buffer.concat([Buffer.from(sig, 'latin1'), u32(offset), u32(body.length)]));
    const padded = pad4(body);
    data.push(padded);
    offset += padded.length;
  }
  const body = Buffer.concat([u32(tags.length), ...table, ...data]);
  header.writeUInt32BE(128 + body.length, 0);

  const profile = Buffer.concat([header, body]);
  // ICC v2 的 profile ID 规约未强制；仍写入 MD5 以便身份稳定且可核对
  crypto.createHash('md5').update(profile).digest().copy(profile, 84);
  return profile;
}

module.exports = { buildMatrixShaperProfile, inv3, mul3, mulMM, xyToXYZ, D50, rgbMatrix, bradfordAdapt };
