// Settings 视图 · 集成健康 + 配置表单
import { showAlert, toast } from './ui.js';

const MASK = '****已配置';

const fields = {
  weatherKey:    '#set-weather-key',
  weatherCity:   '#set-weather-city',
  ttsKey:        '#set-tts-key',
  ttsVoice:      '#set-tts-voice',
  deepseekKey:   '#set-deepseek-key',
  deepseekModel: '#set-deepseek-model',
};

let nodes = {};
let healthList, kugouStatus, btnSave, btnRefresh, btnRelogin;
let loaded = false;
let loading = false;
let reloginState = null;  // { key, pollId, modal } 当前活的扫码会话

const HEALTH_KEYS = [
  { key: 'kugou',   label: 'KuGou'   },
  { key: 'weather', label: 'Weather' },
  { key: 'tts',     label: 'TTS'     },
  { key: 'ai',      label: 'AI'      },
  { key: 'lark',    label: 'Lark'    },
];

function renderHealth(health) {
  healthList.innerHTML = '';
  for (const { key, label } of HEALTH_KEYS) {
    const row = health?.[key] || {};
    const ok = !!row.ok;
    const msg = row.message || row.detail || (ok ? 'ok' : 'unconfigured');
    const li = document.createElement('li');
    li.className = ok ? 'ok' : 'off';
    li.innerHTML = `<span class="mark">${ok ? '✓' : '○'}</span><span class="label">${label}</span><span class="msg">${msg}</span>`;
    healthList.appendChild(li);
  }
  // Kugou 状态镜像到下方
  const k = health?.kugou;
  if (k) {
    const msg = k.message || k.detail;
    kugouStatus.textContent = k.ok ? `alive · ${msg || 'cookie ok'}` : (msg || 'unknown');
    kugouStatus.className = 'readonly ' + (k.ok ? 'ok' : 'off');
  }
}

function pickSetting(s, flatKey, groupKey, nestedKey) {
  return s?.[flatKey] ?? s?.[groupKey]?.[nestedKey] ?? '';
}

function applySettings(s) {
  nodes.weatherKey.value  = pickSetting(s, 'openweather_api_key', 'weather', 'apiKey');
  nodes.weatherCity.value = pickSetting(s, 'openweather_city', 'weather', 'city');
  nodes.ttsKey.value      = pickSetting(s, 'fish_api_key', 'tts', 'apiKey');
  nodes.ttsVoice.value    = pickSetting(s, 'fish_voice_id', 'tts', 'voiceId');
  nodes.deepseekKey.value = s?.deepseek_api_key || '';
  const savedModel = s?.deepseek_model;
  if (savedModel) nodes.deepseekModel.value = savedModel;
}

// 构造 PUT body：跳过 mask 占位（避免覆盖原 key）
function buildPayload() {
  const payload = {};
  const wk = nodes.weatherKey.value;
  if (wk !== MASK) payload.openweather_api_key = wk;
  payload.openweather_city = nodes.weatherCity.value;

  const tk = nodes.ttsKey.value;
  if (tk !== MASK) payload.fish_api_key = tk;
  payload.fish_voice_id = nodes.ttsVoice.value;

  const dk = nodes.deepseekKey.value;
  if (dk !== MASK) payload.deepseek_api_key = dk;
  payload.deepseek_model = nodes.deepseekModel.value;
  return payload;
}

async function load(force = false) {
  if (loading) return;
  if (loaded && !force) return;
  loading = true;
  try {
    const [hRes, sRes] = await Promise.allSettled([
      fetch('/api/health/integrations').then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),
      fetch('/api/settings').then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),
    ]);
    if (hRes.status === 'fulfilled') renderHealth(hRes.value);
    else healthList.innerHTML = `<li class="off">健康检查失败：${hRes.reason.message}</li>`;

    if (sRes.status === 'fulfilled') applySettings(sRes.value);
    else showAlert(`读取 settings 失败：${sRes.reason.message}`);

    loaded = true;
  } finally {
    loading = false;
  }
}

async function save() {
  btnSave.disabled = true;
  const original = btnSave.textContent;
  btnSave.textContent = '保存中…';
  try {
    const r = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload()),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    toast('已保存');
    // 保存后刷新健康（key 填上后可能从 ○ 变 ✓）
    load(true);
  } catch (err) {
    showAlert(`保存失败：${err.message}`);
  } finally {
    btnSave.textContent = original;
    btnSave.disabled = false;
  }
}

// ──────────── 酷狗扫码续登录 ────────────
function closeReloginModal() {
  if (!reloginState) return;
  clearInterval(reloginState.pollId);
  clearInterval(reloginState.probeId);
  if (reloginState.modal?.parentNode) reloginState.modal.parentNode.removeChild(reloginState.modal);
  reloginState = null;
}

function onLoginSuccess(statusEl) {
  statusEl.textContent = '✓ 登录成功 · cookie 已保存';
  statusEl.className = 'modal-status ok';
  setTimeout(() => {
    closeReloginModal();
    toast('酷狗登录成功，可以放歌了');
    loaded = false;
    load(true);
  }, 800);
}

function openReloginModal({ qrImg, qrUrl, key }) {
  closeReloginModal();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-label="酷狗扫码登录">
      <button class="modal-close" type="button" aria-label="关闭">×</button>
      <h3>用手机酷狗 App 扫码</h3>
      ${qrImg ? `<img class="qr" src="${qrImg}" alt="QR" />` : ''}
      ${qrUrl ? `<p class="muted small">或浏览器打开：<a href="${qrUrl}" target="_blank" rel="noopener">${qrUrl}</a></p>` : ''}
      <div class="modal-status-row">
        <span class="modal-status" data-status>检查中…</span>
        <button type="button" class="btn ghost modal-refresh" data-refresh>手动刷新</button>
      </div>
      <p class="modal-checked" data-checked></p>
      <p class="modal-probe" data-probe></p>
    </div>
  `;
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeReloginModal(); });
  backdrop.querySelector('.modal-close').addEventListener('click', closeReloginModal);
  document.body.appendChild(backdrop);

  const statusEl  = backdrop.querySelector('[data-status]');
  const checkedEl = backdrop.querySelector('[data-checked]');
  const probeEl   = backdrop.querySelector('[data-probe]');
  const refreshBtn = backdrop.querySelector('[data-refresh]');

  let checking = false;
  let done = false;

  // ── 路径 1：QR 状态码（标准流，部分 API 可靠）──
  async function checkQrStatus() {
    if (checking || done) return;
    checking = true;
    refreshBtn.disabled = true;
    try {
      const r = await fetch(`/api/kugou/relogin/status?key=${encodeURIComponent(key)}`);
      const data = await r.json();
      checkedEl.textContent = `QR 检查 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;

      if (!data.ok) {
        statusEl.textContent = `上游错误：${data.error || '未知'}`;
        statusEl.className = 'modal-status off';
        return;
      }
      const { status, savedCookie } = data;
      if (status === 4) {
        if (savedCookie) { done = true; onLoginSuccess(statusEl); return; }
        statusEl.textContent = 'QR status=4 但 token 提取失败，等待 probe…';
        statusEl.className = 'modal-status off';
        return;
      }
      if (status === 0) {
        clearInterval(reloginState?.pollId);
        statusEl.textContent = '二维码已过期 · 关闭后重新生成';
        statusEl.className = 'modal-status off';
        return;
      }
      const label = status === 2 ? '📱 已扫码，等待手机确认…' : '⏳ 等待扫码…';
      statusEl.textContent = label;
      statusEl.className = status === 2 ? 'modal-status ok' : 'modal-status';
    } catch (err) {
      statusEl.textContent = `网络错误：${err.message}`;
      statusEl.className = 'modal-status off';
    } finally {
      checking = false;
      refreshBtn.disabled = false;
    }
  }

  // ── 路径 2：probe 上游 session（QR 状态码卡住时的兜底）──
  async function probeUpstream() {
    if (done) return;
    try {
      const r = await fetch('/api/kugou/relogin/probe', { method: 'POST' });
      const data = await r.json();
      if (data.ok && data.found) {
        done = true;
        probeEl.textContent = '';
        onLoginSuccess(statusEl);
      } else {
        probeEl.textContent = `后台探测中… ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
      }
    } catch {
      // probe 静默失败，不打扰 QR 状态显示
    }
  }

  refreshBtn.addEventListener('click', () => { checkQrStatus(); probeUpstream(); });

  checkQrStatus();
  probeUpstream();
  const pollId  = setInterval(checkQrStatus,  2_000);
  const probeId = setInterval(probeUpstream,  3_000);  // probe 频率稍低，避免压上游

  reloginState = { key, pollId, probeId, modal: backdrop };
}

async function startRelogin() {
  btnRelogin.disabled = true;
  const originalText = btnRelogin.textContent;
  btnRelogin.textContent = '生成二维码…';
  try {
    const r = await fetch('/api/kugou/relogin/start', { method: 'POST' });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || `HTTP ${r.status}`);
    openReloginModal(data);
  } catch (err) {
    showAlert(`扫码登录启动失败：${err.message}`);
  } finally {
    btnRelogin.textContent = originalText;
    btnRelogin.disabled = false;
  }
}

export function initSettings() {
  for (const [k, sel] of Object.entries(fields)) {
    nodes[k] = document.querySelector(sel);
  }
  healthList  = document.getElementById('health-list');
  kugouStatus = document.getElementById('kugou-status');
  btnSave     = document.getElementById('settings-save');
  btnRefresh  = document.getElementById('settings-refresh');
  btnRelogin  = document.getElementById('btn-kugou-relogin');

  btnSave.addEventListener('click', save);
  btnRefresh.addEventListener('click', () => load(true));

  if (btnRelogin) {
    btnRelogin.disabled = false;
    btnRelogin.removeAttribute('title');
    btnRelogin.addEventListener('click', startRelogin);
  }

  // 占位按钮：[test] / [试听] —— 后续补
  document.querySelectorAll('button[data-test]').forEach(b => {
    b.addEventListener('click', () => toast('该功能尚未接入'));
  });

  window.addEventListener('claudio:view-shown', e => {
    if (e.detail === 'settings') load();
  });
}
