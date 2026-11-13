'use strict';
// JPEG ICC 嵌入：APP2 标记，标识符 "ICC_PROFILE\0" + 序号(1B) + 总数(1B) + 分片数据。
// 单段载荷上限 65519 - 14 = 65505 字节，ICC 超过则分片。

const MARKER = Buffer.from([0xFF, 0xE2]);
const IDENT = Buffer.from('ICC_PROFILE\0', 'latin1');
const MAX_PAYLOAD = 65505;

function embedIcc(jpegBuffer, iccBuffer) {
  if (jpegBuffer[0] !== 0xFF || jpegBuffer[1] !== 0xD8) {
    throw new Error('不是 JPEG 文件，无法嵌入 ICC APP2');
  }
  // 移除已存在的 ICC_PROFILE APP2 段，避免重复
  const cleaned = stripIccSegments(jpegBuffer);
  const chunks = [];
  for (let off = 0; off < iccBuffer.length; off += MAX_PAYLOAD) {
    chunks.push(iccBuffer.slice(off, off + MAX_PAYLOAD));
  }
  const segments = chunks.map((data, i) => {
    const body = Buffer.concat([IDENT, Buffer.from([i + 1, chunks.length]), data]);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(body.length + 2, 0);
    return Buffer.concat([MARKER, len, body]);
  });
  // 插入到 SOI(2 字节) 之后
  return Buffer.concat([cleaned.slice(0, 2), ...segments, cleaned.slice(2)]);
}

function stripIccSegments(jpegBuffer) {
  let off = 2;
  const keep = [jpegBuffer.slice(0, 2)];
  while (off < jpegBuffer.length) {
    if (jpegBuffer[off] !== 0xFF) break;
    const marker = jpegBuffer[off + 1];
    if (marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) {
      keep.push(jpegBuffer.slice(off, off + 2));
      off += 2;
      continue;
    }
    const segLen = jpegBuffer.readUInt16BE(off + 2);
    const seg = jpegBuffer.slice(off, off + 2 + segLen);
    const isIccApp2 = marker === 0xE2 &&
      seg.slice(4, 4 + IDENT.length).equals(IDENT);
    if (!isIccApp2) keep.push(seg);
    off += 2 + segLen;
    if (marker === 0xDA) { keep.push(jpegBuffer.slice(off)); break; } // SOS 后为熵数据
  }
  return Buffer.concat(keep);
}

function extractIcc(jpegBuffer) {
  let off = 2;
  const parts = new Map();
  while (off < jpegBuffer.length) {
    if (jpegBuffer[off] !== 0xFF) break;
    const marker = jpegBuffer[off + 1];
    if (marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) { off += 2; continue; }
    const segLen = jpegBuffer.readUInt16BE(off + 2);
    if (marker === 0xE2 && jpegBuffer.slice(off + 4, off + 4 + IDENT.length).equals(IDENT)) {
      const seq = jpegBuffer[off + 4 + IDENT.length];
      const total = jpegBuffer[off + 4 + IDENT.length + 1];
      const data = jpegBuffer.slice(off + 4 + IDENT.length + 2, off + 2 + segLen);
      parts.set(seq, { total, data });
    }
    off += 2 + segLen;
    if (marker === 0xDA) break;
  }
  if (!parts.size) return null;
  const total = parts.values().next().value.total;
  const ordered = [];
  for (let i = 1; i <= total; i++) ordered.push(parts.get(i).data);
  return Buffer.concat(ordered);
}

module.exports = { jpegEmbedIcc: embedIcc, jpegExtractIcc: extractIcc, jpegStripIcc: stripIccSegments };
