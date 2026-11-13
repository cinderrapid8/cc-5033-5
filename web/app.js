'use strict';
// 界面逻辑：控件选项全部来自内核 /api/capabilities；错误统一展示内核回传的结构化 code/message。
const $ = (id) => document.getElementById(id);
let caps = null;
let imageMeta = null;
let lastImageFile = null;

function showError(err) {
  const box = $('error');
  box.style.display = 'block';
  const code = err && err.error ? err.error.code : 'NETWORK';
  const msg = err && err.error ? err.error.message : String(err);
  const detail = err && err.error && err.error.detail ? `<br><span style="color:#c98">细节：${escapeHtml(err.error.detail)}</span>` : '';
  box.innerHTML = `<b>图像色管内核返回失败：</b> <code>${escapeHtml(code)}</code> — ${escapeHtml(msg)}${detail}`;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function clearError() { $('error').style.display = 'none'; }
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadCapabilities() {
  const r = await fetch('/api/capabilities');
  const j = await r.json();
  if (!j.ok) throw j;
  caps = j.capabilities;
  fillSelect($('assignProfile'), caps.builtinProfiles);
  fillSelect($('destProfile'), caps.builtinProfiles, 'display-p3');
  fillSelect($('assumeProfile'), caps.builtinProfiles, 'srgb');
  fillSelect($('intent'), caps.intents.map((i) => ({ id: i.id, description: i.name })), 'relative-colorimetric');
  fillSelect($('gamutMode'), caps.gamutModes, 'clip');
  updateExplain();
}

async function loadFixtures() {
  const sel = $('fixtureSelect');
  try {
    const r = await fetch('/api/fixtures');
    const j = await r.json();
    if (!j.ok) throw j;
    sel.innerHTML = '';
    if (!j.fixtures.length) {
      const o = document.createElement('option');
      o.textContent = '（服务端未找到受控样例，请先运行 npm run gen:fixtures）';
      o.disabled = true; o.selected = true;
      sel.appendChild(o);
      $('btnLoadFixture').disabled = true;
      return;
    }
    for (const f of j.fixtures) {
      const o = document.createElement('option');
      o.value = f.url;
      const cfg = f.profileMissing ? '无嵌入配置' : f.profileDescription;
      o.textContent = `${f.description} — ${f.width}×${f.height} ${f.bits}位 ${cfg}`;
      sel.appendChild(o);
    }
  } catch (e) { showError(e); }
}

function fillSelect(sel, items, selectedId) {
  sel.innerHTML = '';
  for (const it of items) {
    const o = document.createElement('option');
    o.value = it.id;
    o.textContent = `${it.id} — ${it.description || ''}`;
    if (it.id === selectedId) o.selected = true;
    sel.appendChild(o);
  }
}

function updateExplain() {
  const intent = caps.intents.find((i) => i.id === $('intent').value);
  $('intentExplain').textContent = intent ? intent.explain : '';
  const gm = caps.gamutModes.find((m) => m.id === $('gamutMode').value);
  $('gamutExplain').textContent = gm
    ? ({ clip: '超色域颜色按渲染意图裁剪到目标色域边界，不另作标记。',
        'gamut-check': '可正常转换的像素照常处理；超出目标色域的像素以品红 (255,0,255) 明确标记，便于定位。',
        softproof: '全部像素正常转换，同时在统计区给出超色域像素数量、占比与色差。' })[gm.id]
    : '';
}

function identityBlock(label, iden, missing) {
  if (missing || !iden) {
    return `<div class="idbox"><span class="missing">${escapeHtml(label)}：缺失（无嵌入 ICC）</span></div>`;
  }
  return `<div class="idbox">
    <b>${escapeHtml(label)}</b><br>
    描述：${escapeHtml(iden.description)}　类别：${escapeHtml(iden.deviceClass)}　色彩空间：${escapeHtml(iden.colorSpace)}　v${iden.version}<br>
    matrix-shaper：${iden.isMatrixShaper ? '是' : '否'}　字节：${iden.byteSize}<br>
    SHA-256 指纹：<code>${escapeHtml(iden.sha256)}</code>
  </div>`;
}

$('file').addEventListener('change', async () => {
  clearError();
  const f = $('file').files[0];
  if (!f) return;
  await inspectFile(f);
});

async function inspectFile(f) {
  lastImageFile = f;
  const fd = new FormData();
  fd.append('image', f);
  try {
    const r = await fetch('/api/inspect', { method: 'POST', body: fd });
    const j = await r.json();
    if (!j.ok) throw j;
    imageMeta = j.image;
    $('imageInfo').innerHTML =
      `<div class="idbox">
        <b>${escapeHtml(j.image.filename)}</b> — ${j.image.width}×${j.image.height}，
        ${j.image.bitsPerSample} 位，${j.image.hasAlpha ? '含透明通道' : '不透明'}，${escapeHtml(j.image.format).toUpperCase()}
      </div>
      ${identityBlock('当前嵌入的源配置', j.image.embeddedProfile, j.image.profileMissing)}`;
    $('missingSource').style.display = j.image.profileMissing ? 'block' : 'none';
    $('comparePanel').innerHTML = '<div class="idbox" style="color:var(--muted)">执行转换后在此显示采样点编码值、Lab、配置指纹与 ΔE2000。</div>';
    $('verifyPanel').innerHTML = '<div class="idbox" style="color:var(--muted)">执行转换后在此显示独立验收结果。</div>';
  } catch (e) { showError(e); }
}

$('btnLoadFixture').addEventListener('click', async () => {
  clearError();
  const url = $('fixtureSelect').value;
  if (!url) return;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw { error: { code: 'FIXTURE_FETCH', message: '受控样例获取失败' } };
    const blob = await resp.blob();
    const name = url.split('/').pop();
    const f = new File([blob], name, { type: 'image/png' });
    $('file').value = '';
    await inspectFile(f);
  } catch (e) { showError(e); }
});

$('intent').addEventListener('change', updateExplain);
$('gamutMode').addEventListener('change', updateExplain);
$('bpc').addEventListener('change', () => {
  if ($('bpc').checked && $('intent').value === 'absolute-colorimetric') {
    showError({ error: { code: 'BAD_COMBINATION', message: '黑点补偿与绝对色度意图互斥，内核将拒绝该组合。' } });
  } else { clearError(); }
});

function formData() {
  const fd = new FormData();
  fd.append('image', lastImageFile);
  return fd;
}

$('btnAssign').addEventListener('click', async () => {
  clearError();
  if (!lastImageFile) return showError({ error: { code: 'NO_IMAGE', message: '请先选择图像' } });
  const fd = formData();
  fd.append('profileId', $('assignProfile').value);
  $('btnAssign').disabled = true;
  try {
    const r = await fetch('/api/assign', { method: 'POST', body: fd });
    const j = await r.json();
    if (!j.ok) throw j;
    $('assignResult').innerHTML = `<div class="idbox" style="border-color:#3c5a44">
      <b class="badge-ok">指定配置完成（像素未触碰：${j.audit.pixelBytesUnchanged ? '是，逐字节不变' : '否'}）</b><br>
      前配置：${j.audit.beforeProfile ? escapeHtml(j.audit.beforeProfile.description) : '（原本缺失）'}<br>
      写入配置：${escapeHtml(j.audit.assignedProfile.description)}　<code>${escapeHtml(j.audit.assignedProfile.sha256.slice(0, 24))}…</code><br>
      <a href="${j.downloadPath}" download>下载仅改标签的文件</a><br>
      <span style="color:var(--muted)">${escapeHtml(j.audit.note)}</span>
    </div>`;
  } catch (e) { showError(e); } finally { $('btnAssign').disabled = false; }
});

$('btnConvert').addEventListener('click', async () => {
  clearError();
  if (!lastImageFile) return showError({ error: { code: 'NO_IMAGE', message: '请先选择图像' } });
  const fd = formData();
  fd.append('destinationProfileId', $('destProfile').value);
  fd.append('renderingIntent', $('intent').value);
  fd.append('blackPointCompensation', $('bpc').checked);
  fd.append('gamutMode', $('gamutMode').value);
  if (imageMeta && imageMeta.profileMissing) {
    const reason = $('assumptionReason').value.trim();
    if (!reason) {
      return showError({ error: { code: 'SOURCE_PROFILE_MISSING', message: '源配置缺失时必须填写假设依据，内核不接受无记录的自动假设。' } });
    }
    fd.append('assumeProfileId', $('assumeProfile').value);
    fd.append('assumptionReason', reason);
  }
  $('btnConvert').disabled = true;
  try {
    const r = await fetch('/api/convert', { method: 'POST', body: fd });
    const j = await r.json();
    if (!j.ok) throw j;
    renderConvert(j);
  } catch (e) { showError(e); } finally { $('btnConvert').disabled = false; }
});

function renderVerification(v) {
  const panel = $('verifyPanel');
  if (!v) {
    panel.innerHTML = '<div class="idbox" style="color:var(--muted)">本次结果未回传导独立验收证据。</div>';
    return;
  }
  if (v.color && v.color.skipped) {
    panel.innerHTML = `<div class="idbox"><span class="verify-badge na">未执行像素变换</span>${escapeHtml(v.color.reason)}</div>`;
    return;
  }
  const colorApplicable = v.color && v.color.referenceApplicable;
  const badgeClass = v.ok ? 'ok' : 'bad';
  const badgeText = v.ok ? '独立验收通过' : '独立验收失败';
  const de = v.color && v.color.deltaE2000;
  const alpha = v.alpha || {};
  const gamut = v.gamut || {};

  const colorRow = colorApplicable && de
    ? `<tr><td>色彩（纯 JS 参考引擎）</td>
        <td>平均 ΔE2000 <b>${de.mean.toFixed(3)}</b>，最大 <b>${de.max.toFixed(3)}</b>，P95 ${de.p95.toFixed(3)}（容差 ${v.color.toleranceDE}）</td>
        <td>${v.color.withinTolerance ? '<span class="badge-ok">通过</span>' : '<span class="badge-bad">超容差</span>'}</td></tr>
        <tr><td>编码值偏差</td><td>实际输出 vs 独立推导，最大 ${v.color.encodedMaxDiff} 码值</td><td>—</td></tr>`
    : `<tr><td>色彩</td><td colspan="2"><span class="verify-badge na">无独立推导</span>${escapeHtml((v.color && v.color.reason) || '不适用')}</td></tr>`;

  const alphaRow = alpha.applicable
    ? `<tr><td>透明通道</td>
        <td>逐像素检查 <b>${alpha.checkedPixels}</b> 个，与源不一致 <b>${alpha.mismatchedPixels}</b> 个</td>
        <td>${alpha.preserved ? '<span class="badge-ok">逐字节保留</span>' : '<span class="badge-bad">被改变</span>'}</td></tr>`
    : `<tr><td>透明通道</td><td colspan="2">该图不含 alpha，逐像素比对结果为“不适用”（不是未检查）</td></tr>`;

  const gamutRow = gamut.mode === 'gamut-check'
    ? `<tr><td>品红警报</td>
        <td>独立推导超界 <b>${gamut.expectedOutOfGamutSamples}</b> 个，缺失警报 <b>${gamut.missingAlarmSamples}</b>，误标 <b>${gamut.unexpectedAlarmSamples}</b></td>
        <td>${gamut.alarmConsistent ? '<span class="badge-ok">一致</span>' : '<span class="badge-bad">不一致</span>'}</td></tr>`
    : '';

  const prof = v.profiles || {};
  const sha = (s) => s ? s.slice(0, 20) + '…' : '—';
  const match = (m) => m === true ? '<span class="badge-ok">一致</span>'
    : m === false ? '<span class="badge-bad">不一致</span>' : '未要求比对';

  panel.innerHTML = `
    <div style="margin-bottom:10px">
      <span class="verify-badge ${badgeClass}">${badgeText}</span>
      实际源/目标配置身份：源 <code>${escapeHtml(sha(prof.source && prof.source.actualSha256))}</code>
      → 目标 <code>${escapeHtml(sha(prof.destination && prof.destination.actualSha256))}</code>
      ${v.failures && v.failures.length ? `<div class="warnbox" style="margin-top:8px">失败项：${escapeHtml(v.failures.join('、'))}</div>` : ''}
    </div>
    <table class="verify-table">
      <tr><th>证据</th><th>执行依据（来自内核实际像素/配置）</th><th>结论</th></tr>
      ${colorRow}
      ${alphaRow}
      ${gamutRow}
      <tr><td>源配置身份</td>
        <td>实际 <code>${escapeHtml(sha(prof.source && prof.source.actualSha256))}</code>
          期望 <code>${escapeHtml(sha(prof.source && prof.source.expectedSha256))}</code></td>
        <td>${match(prof.source && prof.source.matchesExpected)}</td></tr>
      <tr><td>目标配置身份</td>
        <td>实际 <code>${escapeHtml(sha(prof.destination && prof.destination.actualSha256))}</code>
          期望 <code>${escapeHtml(sha(prof.destination && prof.destination.expectedSha256))}</code></td>
        <td>${match(prof.destination && prof.destination.matchesExpected)}</td></tr>
    </table>
    <p class="note">独立模型只读取 ICC 参数与源编码值，不调用 lcms；颜色证据与透明证据均来自本次实际输出像素。</p>`;
}

function renderConvert(j) {
  $('convertResult').innerHTML = `<div class="idbox" style="border-color:#3c5a44">
    <b class="badge-ok">真实像素转换完成（pixelsTouched=${j.pixelsTouched}，${j.bitsPerSample} 位）</b><br>
    意图：${escapeHtml(j.settings.renderingIntent)}　BPC：${j.settings.blackPointCompensation ? '开' : '关'}　超色域：${escapeHtml(j.settings.gamutMode)}<br>
    <a href="${j.downloadPath}" download>下载嵌入目标 ICC 的转换结果</a>
  </div>`;

  const de = j.deltaE;
  const gamut = j.gamut;
  const deHtml = de.skipped
    ? `<div class="idbox">${escapeHtml(de.reason)}</div>`
    : `<div>
        <span class="stat"><b class="badge-ok">${de.mean.toFixed(2)}</b><span>平均 ΔE2000</span></span>
        <span class="stat"><b class="${de.max > 5 ? 'badge-bad' : 'badge-warn'}">${de.max.toFixed(2)}</b><span>最大 ΔE2000</span></span>
        <span class="stat"><b>${de.p95.toFixed(2)}</b><span>P95 ΔE2000</span></span>
        <span class="stat"><b>${de.samples}</b><span>采样点数</span></span>
      </div>`;
  const gamutHtml = `<div>
      <span class="stat"><b class="${gamut.ratio > 0 ? 'badge-warn' : 'badge-ok'}">${(gamut.ratio * 100).toFixed(2)}%</b><span>超色域占比</span></span>
      <span class="stat"><b>${gamut.outOfGamutPixels}</b><span>超色域像素(估)</span></span>
      <span class="stat"><b>${gamut.sampled || 0}</b><span>受检采样</span></span>
    </div>`;

  const rows = j.probes.slice(0, 8).map((p) => {
    const a = p.before, b = p.after;
    const f = (v) => (v == null ? '—' : Number(v).toFixed(1));
    const swatch = (rgb, bps) => {
      const s = bps === 16 ? rgb.map((v) => Math.round(v / 65535 * 255)) : rgb;
      return `<span class="swatch" style="background:rgb(${s[0]},${s[1]},${s[2]})"></span>`;
    };
    return `<tr>
      <td class="lbl">(${p.x},${p.y})</td>
      <td>${swatch(a.rgb, j.bitsPerSample)}[${a.rgb.join(',')}]${a.alpha != null ? ' α=' + a.alpha : ''}</td>
      <td class="mono">${a.Lab.map(f).join(', ')}</td>
      <td>${b ? swatch(b.rgb, j.bitsPerSample) + '[' + b.rgb.join(',') + ']' + (b.alpha != null ? ' α=' + b.alpha : '') : '—'}</td>
      <td class="mono">${b ? b.Lab.map(f).join(', ') : '—'}</td>
    </tr>`;
  }).join('');

  $('comparePanel').innerHTML = `    ${j.source.assumed ? `<div class="warnbox"><b>源配置为人工假设：</b> ${escapeHtml(j.source.assumption.assumedProfileId)}
      — ${escapeHtml(j.source.assumption.reason)}（记录于 ${escapeHtml(j.source.assumption.recordedAt)}）<br>${escapeHtml(j.source.assumption.warning)}</div>` : ''}
    <div class="grid" style="margin-top:12px">
      ${identityBlock('源配置身份（转换依据）', j.source.identity, false)}
      ${identityBlock('目标配置身份（嵌入输出）', j.destination.identity, false)}
    </div>
    <h3 style="font-size:14px;margin:18px 0 4px">色差（CIEDE2000，Lab 经 lcms2 计算）</h3>
    ${deHtml}
    <h3 style="font-size:14px;margin:18px 0 4px">超色域统计</h3>
    ${gamutHtml}
    <h3 style="font-size:14px;margin:18px 0 4px">采样点：转换前后编码值与 Lab</h3>
    <table>
      <tr><th class="lbl">坐标</th><th class="lbl">转换前 RGB${j.bitsPerSample === 16 ? '(16位)' : ''}</th><th class="lbl">前 Lab(D50)</th><th class="lbl">转换后 RGB</th><th class="lbl">后 Lab(D50)</th></tr>
      ${rows}
    </table>
    <p class="note">α 列在转换前后必须相同——透明通道不参与颜色变换。ΔE 小且超色域为 0 表示目标配置可容纳源颜色；超色域占比高时应查看警报/软打样结果，而非凭屏幕观感判断。</p>`;

  renderVerification(j.verification);
}

loadCapabilities().then(loadFixtures).catch(showError);
