'use strict';
// PNG iCCP 块读写：不经过任何色彩管理库，确保嵌入 ICC 标签时像素逐字节不变。
// iCCP = profile name (latin1, 0 终止) + compression method(1B=0) + zlib(deflate) 压缩的 ICC
const zlib = require('zlib');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// 在 IHDR 之后插入/替换 iCCP；若已存在 iCCP 则先移除
function embedIcc(pngBuffer, iccBuffer, profileName = 'museum-color-tool') {
  if (pngBuffer.toString('latin1', 1, 4) !== 'PNG') {
    throw new Error('不是 PNG 文件，无法嵌入 iCCP');
  }
  const chunks = [];
  let off = 8;
  while (off < pngBuffer.length) {
    const len = pngBuffer.readUInt32BE(off);
    const type = pngBuffer.toString('latin1', off + 4, off + 8);
    if (type !== 'iCCP') chunks.push(pngBuffer.slice(off, off + 12 + len));
    off += 12 + len;
  }
  const name = Buffer.from(profileName + '\0', 'latin1');
  const payload = Buffer.concat([
    name,
    Buffer.from([0]), // compression method 0 = zlib deflate
    zlib.deflateSync(iccBuffer),
  ]);
  const iccp = chunk('iCCP', payload);
  const out = [Buffer.from(pngBuffer.slice(0, 8))];
  let inserted = false;
  for (const c of chunks) {
    out.push(c);
    const t = c.toString('latin1', 4, 8);
    if (t === 'IHDR' && !inserted) { out.push(iccp); inserted = true; }
  }
  if (!inserted) out.splice(1, 0, iccp);
  return Buffer.concat(out);
}

// 提取 iCCP 中的 ICC；无则返回 null
function extractIcc(pngBuffer) {
  let off = 8;
  while (off < pngBuffer.length) {
    const len = pngBuffer.readUInt32BE(off);
    const type = pngBuffer.toString('latin1', off + 4, off + 8);
    if (type === 'iCCP') {
      const data = pngBuffer.slice(off + 8, off + 8 + len);
      const nul = data.indexOf(0);
      const method = data[nul + 1];
      if (method !== 0) throw new Error('不支持的 iCCP 压缩方式: ' + method);
      return zlib.inflateSync(data.slice(nul + 2));
    }
    off += 12 + len;
  }
  return null;
}

module.exports = { embedIcc, extractIcc };
