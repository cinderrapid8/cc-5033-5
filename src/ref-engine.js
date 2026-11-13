'use strict';
// 独立参考引擎：不调用 lcms2，也不依赖任何色彩管理库。
// 仅实现 ICC matrix-shaper RGB 配置的解析与正/逆向色度计算，用于与 lcms2 内核交叉核对。
// 链路：RGB --TRC--> 线性RGB --3x3(media-relative XYZ, D50)--> XYZ --Bradford--> Lab / ΔE2000

const crypto = require('crypto');

function u32(b, o) { return (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]; }
function u16(b, o) { return (b[o] << 8) | b[o + 1]; }
function s15Fixed16(b, o) {
  const v = u32(b, o);
  return (v >= 0x80000000 ? v - 0x100000000 : v) / 65536;
}

function tagTable(buf) {
  const n = u32(buf, 128);
  const tags = new Map();
  for (let i = 0; i < n; i++) {
    const o = 132 + i * 12;
    const sig = buf.toString('latin1', o, o + 4);
    tags.set(sig, { offset: u32(buf, o + 4), size: u32(buf, o + 8) });
  }
  return tags;
}

// 解析 toneCurve（curveType 0x63757276 或 paraType 0x70617261）
function parseTRC(buf, loc) {
  const type = buf.toString('latin1', loc.offset, loc.offset + 4);
  if (type === 'curv') {
    const count = u32(buf, loc.offset + 8);
    if (count === 0) return { kind: 'gamma', g: 1.0 };
    if (count === 1) return { kind: 'gamma', g: u16(buf, loc.offset + 12) / 256 };
    const table = [];
    for (let i = 0; i < count; i++) {
      table.push(u16(buf, loc.offset + 12 + i * 2) / 65535);
    }
    return { kind: 'table', table };
  }
  if (type === 'para') {
    const fnType = u16(buf, loc.offset + 8);
    // ICC paraType：type0=1(g), type1=3(g,a,b), type2=4(g,a,b,c), type3=4(g,a,b,c), type4=7
    const paramCount = [1, 3, 4, 4, 7][fnType];
    const p = [];
    for (let i = 0; i < paramCount; i++) {
      p.push(s15Fixed16(buf, loc.offset + 12 + i * 4));
    }
    // type3 不存储阈值 d，由两段在 d 处连续导出：d = b*c / (g*a - a*c)
    if (fnType === 3) {
      const [g, a, b, c] = p;
      p.push((b * c) / (g * a - a * c));
    }
    return { kind: 'para', fnType, p };
  }
  throw new Error('参考引擎不支持的 TRC 类型: ' + type);
}

function paraForward(x, trc) {
  // ICC para 类型参数按文件顺序：g,a,b,c,d,...（type3 只有 5 个参数）
  const g = trc.p[0], a = trc.p[1], b = trc.p[2], c = trc.p[3], d = trc.p[4];
  const e = trc.p[5], f = trc.p[6];
  switch (trc.fnType) {
    case 0: return Math.pow(x, g);
    case 1: return x >= -b / a ? Math.pow(a * x + b, g) : 0;
    case 2: return x >= -b / a ? Math.pow(a * x + b, g) + c : c;
    // ICC type 3：高段 (ax+b)^g（不加 c）；低段线性 c/d * x，保证 d 处连续
    case 3: return x >= d ? Math.pow(a * x + b, g) : (c / d) * x;
    case 4: return x >= d ? Math.pow(a * x + b, g) + e * x + c : x * f + (c || 0);
    default: throw new Error('未知 para 类型 ' + trc.fnType);
  }
}

function paraInverse(y, trc) {
  const g = trc.p[0], a = trc.p[1], b = trc.p[2], c = trc.p[3], d = trc.p[4];
  const e = trc.p[5], f = trc.p[6];
  switch (trc.fnType) {
    case 0: return Math.pow(y, 1 / g);
    case 1: return (Math.pow(y, 1 / g) - b) / a;
    case 2: return (Math.pow(y - c, 1 / g) - b) / a;
    // type3：低段 y=(c/d)x；高段 y=(ax+b)^g
    case 3: {
      const eLin = c / d;
      return y >= c ? (Math.pow(y, 1 / g) - b) / a : y / eLin;
    }
    case 4: {
      // 高段含 e*x，二分求解
      if (y < d) return (y - (c || 0)) / f;
      let lo = d, hi = 1;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (paraForward(mid, trc) < y) lo = mid; else hi = mid;
      }
      return (lo + hi) / 2;
    }
    default: throw new Error('未知 para 类型 ' + trc.fnType);
  }
}

function tableForward(x, table) {
  const p = x * (table.length - 1);
  const i = Math.min(Math.floor(p), table.length - 2);
  const t = p - i;
  return table[i] * (1 - t) + table[i + 1] * t;
}
function tableInverse(y, table) {
  let i = 0;
  while (i < table.length - 2 && table[i + 1] < y) i++;
  const t = (y - table[i]) / Math.max(1e-12, table[i + 1] - table[i]);
  return (i + Math.min(1, Math.max(0, t))) / (table.length - 1);
}

function trcForward(x, trc) {
  x = Math.min(1, Math.max(0, x));
  if (trc.kind === 'gamma') return Math.pow(x, trc.g);
  if (trc.kind === 'para') return paraForward(x, trc);
  return tableForward(x, trc.table);
}
function trcInverse(y, trc) {
  y = Math.min(1, Math.max(0, y));
  if (trc.kind === 'gamma') return Math.pow(y, 1 / trc.g);
  if (trc.kind === 'para') return paraInverse(y, trc);
  return tableInverse(y, trc.table);
}

function parseXYZ(buf, loc) {
  return {
    X: s15Fixed16(buf, loc.offset + 8),
    Y: s15Fixed16(buf, loc.offset + 12),
    Z: s15Fixed16(buf, loc.offset + 16),
  };
}

// 解析一个 matrix-shaper RGB 配置
function parseMatrixShaper(icc) {
  const buf = Buffer.from(icc);
  const tags = tagTable(buf);
  const need = ['rXYZ', 'gXYZ', 'bXYZ', 'rTRC', 'gTRC', 'bTRC'];
  for (const t of need) if (!tags.has(t)) throw new Error('缺少标签 ' + t + '，参考引擎仅支持 matrix-shaper 配置');
  const rXYZ = parseXYZ(buf, tags.get('rXYZ'));
  const gXYZ = parseXYZ(buf, tags.get('gXYZ'));
  const bXYZ = parseXYZ(buf, tags.get('bXYZ'));
  const M = [
    [rXYZ.X, gXYZ.X, bXYZ.X],
    [rXYZ.Y, gXYZ.Y, bXYZ.Y],
    [rXYZ.Z, gXYZ.Z, bXYZ.Z],
  ];
  const wt = tags.has('wtpt') ? parseXYZ(buf, tags.get('wtpt')) : { X: 0.9642, Y: 1, Z: 0.8249 };
  const trc = [
    parseTRC(buf, tags.get('rTRC')),
    parseTRC(buf, tags.get('gTRC')),
    parseTRC(buf, tags.get('bTRC')),
  ];
  return { M, Minv: inv3(M), white: wt, trc, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

function mul3(M, v) {
  return [
    M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
    M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
    M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
  ];
}
function inv3(M) {
  const a = M, d = [];
  for (let i = 0; i < 3; i++) d.push([0, 0, 0]);
  const det = a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
            - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
            + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const id = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const A = a.map((row, i) => row.concat(id[i]));
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
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) d[i][j] = A[i][j + 3];
  void det;
  return d;
}

const D50 = [0.9642, 1.0, 0.8249];

function xyzToLab(xyz, white = D50) {
  const f = (t) => t > Math.pow(6 / 29, 3) ? Math.cbrt(t) : t / (3 * Math.pow(6 / 29, 2)) + 4 / 29;
  const fx = f(xyz[0] / white[0]), fy = f(xyz[1] / white[1]), fz = f(xyz[2] / white[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// CIEDE2000（Sharma 等公式，手写实现）
function deltaE2000(Lab1, Lab2) {
  const [L1, a1, b1] = Lab1, [L2, a2, b2] = Lab2;
  const avgL = (L1 + L2) / 2;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const avgC = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(avgC, 7) / (Math.pow(avgC, 7) + Math.pow(25, 7))));
  const a1p = a1 * (1 + G), a2p = a2 * (1 + G);
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const avgCp = (C1p + C2p) / 2;
  let h1p = Math.atan2(b1, a1p) * 180 / Math.PI; if (h1p < 0) h1p += 360;
  let h2p = Math.atan2(b2, a2p) * 180 / Math.PI; if (h2p < 0) h2p += 360;
  const avgLp = (L1 + L2) / 2;
  let avgHp;
  if (C1p * C2p === 0) avgHp = h1p + h2p;
  else if (Math.abs(h1p - h2p) > 180) avgHp = (h1p + h2p + 360) / 2;
  else avgHp = (h1p + h2p) / 2;
  const T = 1 - 0.17 * Math.cos((avgHp - 30) * Math.PI / 180)
    + 0.24 * Math.cos(2 * avgHp * Math.PI / 180)
    + 0.32 * Math.cos((3 * avgHp + 6) * Math.PI / 180)
    - 0.20 * Math.cos((4 * avgHp - 63) * Math.PI / 180);
  let dhp;
  if (C1p * C2p === 0) dhp = 0;
  else if (h2p - h1p > 180) dhp = h2p - h1p - 360;
  else if (h2p - h1p < -180) dhp = h2p - h1p + 360;
  else dhp = h2p - h1p;
  const dLp = L2 - L1, dCp = C2p - C1p;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(dhp * Math.PI / 360);
  const Sl = 1 + 0.015 * Math.pow(avgLp - 50, 2) / Math.sqrt(20 + Math.pow(avgLp - 50, 2));
  const Sc = 1 + 0.045 * avgCp;
  const Sh = 1 + 0.015 * avgCp * T;
  const dTheta = 30 * Math.exp(-Math.pow((avgHp - 275) / 25, 2));
  const Rc = 2 * Math.sqrt(Math.pow(avgCp, 7) / (Math.pow(avgCp, 7) + Math.pow(25, 7)));
  const Rt = -Math.sin(2 * dTheta * Math.PI / 180) * Rc;
  const kL = 1, kC = 1, kH = 1;
  return Math.sqrt(
    Math.pow(dLp / (kL * Sl), 2) +
    Math.pow(dCp / (kC * Sc), 2) +
    Math.pow(dHp / (kH * Sh), 2) +
    Rt * (dCp / (kC * Sc)) * (dHp / (kH * Sh))
  );
}

class RefRGB {
  constructor(icc) { this.p = parseMatrixShaper(icc); }
  get sha256() { return this.p.sha256; }
  rgbToXyz(rgb) {
    const lin = rgb.map((v, i) => trcForward(v, this.p.trc[i]));
    // ICC rXYZ/gXYZ/bXYZ 矩阵输出即 D50 media-relative XYZ，直接相乘，不再做白点缩放
    return mul3(this.p.M, lin);
  }
  xyzToRgb(xyz) {
    const lin = mul3(this.p.Minv, xyz);
    return lin.map((v, i) => trcInverse(v, this.p.trc[i]));
  }
  rgbToLab(rgb) { return xyzToLab(this.rgbToXyz(rgb)); }
}

module.exports = { RefRGB, deltaE2000, xyzToLab, D50 };
