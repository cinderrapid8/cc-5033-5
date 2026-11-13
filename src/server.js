'use strict';
// 图像色管 Web 服务：只做 HTTP 编排，所有色彩决策与错误定义来自 color-kernel。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const kernel = require('./color-kernel');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const PUBLIC = path.join(__dirname, '..', 'web');
const FIXTURE_DIR = path.join(__dirname, '..', 'testdata', 'controlled');

// 仅暴露清单内文件名，避免路径穿越；无清单时返回空列表
function readFixtureManifest() {
  const manifestPath = path.join(FIXTURE_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try { return JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) { return null; }
}
const FIXTURE_MANIFEST = readFixtureManifest();
const FIXTURE_NAMES = new Set(
  FIXTURE_MANIFEST ? FIXTURE_MANIFEST.images.map((i) => i.file) : []);

function listFixtures() {
  if (!FIXTURE_MANIFEST) return [];
  return FIXTURE_MANIFEST.images.map((img) => ({
    file: img.file,
    url: '/fixtures/' + img.file,
    kind: img.kind,
    description: img.description,
    bits: img.bits,
    width: img.width,
    height: img.height,
    profileId: img.profileId,
    profileDescription: img.profileId
      ? (FIXTURE_MANIFEST.profiles.find((p) => p.id === img.profileId) || {}).description || null
      : null,
    profileMissing: !img.profileId,
  }));
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 200 * 1024 * 1024) reject(new Error('上传超过 200MB 限制'));
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// multipart/form-data 简易解析（本工具字段简单，不引第三方）
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new kernel.ColorError('BAD_REQUEST', '缺少 multipart boundary');
  const boundary = '--' + (m[1] || m[2]).trim();
  const parts = [];
  let start = buf.indexOf(boundary);
  while (start !== -1) {
    const next = buf.indexOf(boundary, start + boundary.length);
    if (next === -1) break;
    let part = buf.slice(start + boundary.length, next);
    if (part.slice(0, 2).toString() === '\r\n') part = part.slice(2);
    const end = part.lastIndexOf('\r\n');
    if (end > 0) part = part.slice(0, end);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd > 0) {
      const header = part.slice(0, headerEnd).toString('latin1');
      const data = part.slice(headerEnd + 4);
      const nameM = /name="([^"]+)"/.exec(header);
      const fileM = /filename="([^"]*)"/.exec(header);
      parts.push({
        name: nameM ? nameM[1] : null,
        filename: fileM ? fileM[1] : null,
        data,
      });
    }
    start = next;
  }
  const fields = {};
  const files = {};
  for (const p of parts) {
    if (p.filename) files[p.name] = p;
    else fields[p.name] = p.data.toString('utf8');
  }
  return { fields, files };
}

function errorResponse(res, err) {
  if (err instanceof kernel.ColorError) {
    return sendJson(res, 422, { ok: false, error: { code: err.code, message: err.message, detail: err.detail } });
  }
  return sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: err.message } });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/capabilities') {
      return sendJson(res, 200, { ok: true, capabilities: kernel.capabilities() });
    }

    if (req.method === 'POST' && url.pathname === '/api/inspect') {
      const { files } = parseMultipart(await readBody(req), req.headers['content-type']);
      if (!files.image) return sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: '缺少 image 文件' } });
      const img = await kernel.readImage(files.image.data);
      const identity = img.embeddedIcc ? kernel.profileIdentity(img.embeddedIcc) : null;
      return sendJson(res, 200, {
        ok: true,
        image: {
          filename: files.image.filename,
          width: img.width, height: img.height,
          bitsPerSample: img.bitsPerSample, hasAlpha: img.hasAlpha, format: img.format,
          embeddedProfile: identity,
          profileMissing: !img.embeddedIcc,
        },
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/assign') {
      const { fields, files } = parseMultipart(await readBody(req), req.headers['content-type']);
      if (!files.image) return sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: '缺少 image 文件' } });
      const icc = kernel.builtinProfile(fields.profileId);
      const result = await kernel.assignProfile(files.image.data, icc);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        ok: true,
        audit: result.audit,
        pixelsTouched: result.pixelsTouched,
        downloadPath: await stashResult(result.output, files.image.filename, 'assign',
          result.output[0] === 0xFF && result.output[1] === 0xD8 ? 'jpg' : 'png'),
      }));
    }

    if (req.method === 'POST' && '/api/convert' === url.pathname) {
      const { fields, files } = parseMultipart(await readBody(req), req.headers['content-type']);
      if (!files.image) return sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: '缺少 image 文件' } });
      const opts = {
        destinationProfileId: fields.destinationProfileId,
        renderingIntent: fields.renderingIntent,
        blackPointCompensation: fields.blackPointCompensation === 'true',
        gamutMode: fields.gamutMode,
        source: fields.assumeProfileId
          ? { assumeProfileId: fields.assumeProfileId, reason: fields.assumptionReason || '' }
          : {},
      };
      const result = await kernel.convertImage(files.image.data, opts);
      const isJpeg = result.output[0] === 0xFF && result.output[1] === 0xD8;
      const downloadPath = await stashResult(result.output, files.image.filename, 'convert', isJpeg ? 'jpg' : 'png');
      return sendJson(res, 200, {
        ok: true,
        operation: result.operation,
        pixelsTouched: result.pixelsTouched,
        bitsPerSample: result.bitsPerSample,
        settings: result.settings,
        source: result.source,
        destination: result.destination,
        gamut: result.gamut,
        deltaE: result.deltaE,
        probes: result.probes,
        verification: result.verification,
        audit: result.audit,
        downloadPath,
      });
    }

    // 受控色管验证样例：从图像色管界面直接打开，供手动切换配置比对
    if (req.method === 'GET' && url.pathname === '/api/fixtures') {
      return sendJson(res, 200, { ok: true, fixtures: listFixtures() });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/fixtures/')) {
      const name = path.basename(url.pathname.replace('/fixtures/', ''));
      const file = path.join(FIXTURE_DIR, name);
      if (!FIXTURE_NAMES.has(name) || !fs.existsSync(file)) {
        return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '样例不存在' } });
      }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return fs.createReadStream(file).pipe(res);
    }

    if (req.method === 'GET' && url.pathname.startsWith('/download/')) {
      const name = path.basename(url.pathname.replace('/download/', ''));
      const file = path.join(require('os').tmpdir(), 'museum-color-results', name);
      if (!fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '结果已过期或不存在' } });
      const mime = name.endsWith('.jpg') || name.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Disposition': `attachment; filename="${name}"`,
      });
      return fs.createReadStream(file).pipe(res);
    }

    if (req.method === 'GET') {
      const file = url.pathname === '/' ? '/index.html' : url.pathname;
      const fp = path.join(PUBLIC, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
      if (!fp.startsWith(PUBLIC) || !fs.existsSync(fp)) {
        res.writeHead(404); return res.end('not found');
      }
      const type = fp.endsWith('.html') ? 'text/html; charset=utf-8'
        : fp.endsWith('.js') ? 'text/javascript; charset=utf-8'
        : fp.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type });
      return fs.createReadStream(fp).pipe(res);
    }
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '未知路由' } });
  } catch (err) {
    errorResponse(res, err);
  }
});

const resultDir = path.join(require('os').tmpdir(), 'museum-color-results');
fs.mkdirSync(resultDir, { recursive: true });
let resultSeq = 0;
async function stashResult(buffer, originalName, op, ext = 'png') {
  const base = path.basename(originalName || 'image.png').replace(/\.[^.]+$/, '');
  const name = `${op}-${Date.now()}-${++resultSeq}-${base}.${ext}`;
  fs.writeFileSync(path.join(resultDir, name), buffer);
  return '/download/' + name;
}

server.listen(PORT, () => {
  console.log(`博物馆图像色管界面已启动: http://localhost:${PORT}`);
});

module.exports = { server };
