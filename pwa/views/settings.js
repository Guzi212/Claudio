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
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = ok ? '✓' : '○';
    const labelEl = document.createElement('span');
    labelEl.className = 'label';
    labelEl.textContent = label;
    const msgEl = document.createElement('span');
    msgEl.className = 'msg';
    msgEl.textContent = msg;
    li.append(mark, labelEl, msgEl);
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
    else {
      const li = document.createElement('li');
      li.className = 'off';
      li.textContent = `健康检查失败：${hRes.reason.message}`;
      healthList.replaceChildren(li);
    }

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
  if (reloginState.pollId) clearInterval(reloginState.pollId);
  if (reloginState.modal?.parentNode) reloginState.modal.parentNode.removeChild(reloginState.modal);
  reloginState = null;
}

function openReloginModal({ qrImg, qrUrl, key }) {
  closeReloginModal();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-label', '酷狗扫码登录');

  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', '关闭');
  closeBtn.textContent = '×';
  modal.appendChild(closeBtn);

  const h3 = document.createElement('h3');
  h3.textContent = '用手机酷狗 App 扫码';
  modal.appendChild(h3);

  if (qrImg) {
    const img = document.createElement('img');
    img.className = 'qr';
    img.alt = 'QR';
    img.src = qrImg;
    modal.appendChild(img);
  }
  if (qrUrl) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.textContent = '或浏览器打开：';
    const a = document.createElement('a');
    a.target = '_blank';
    a.rel = 'noopener';
    // 只允许 http(s)，阻断 javascript:/data: 等危险协议
    a.href = /^https?:\/\//i.test(qrUrl) ? qrUrl : '#';
    a.textContent = qrUrl;
    p.appendChild(a);
    modal.appendChild(p);
  }
  const statusP = document.createElement('p');
  statusP.className = 'modal-status';
  statusP.setAttribute('data-status', '');
  statusP.textContent = '等扫码…';
  modal.appendChild(statusP);
  backdrop.appendChild(modal);
  backdrop.addEventListener('click', e => {
    if (e.target === backdrop) closeReloginModal();
  });
  backdrop.querySelector('.modal-close').addEventListener('click', closeReloginModal);
  document.body.appendChild(backdrop);

  const statusEl = backdrop.querySelector('[data-status]');

  const pollId = setInterval(async () => {
    try {
      const r = await fetch(`/api/kugou/relogin/status?key=${encodeURIComponent(key)}`);
      const data = await r.json();
      if (!data.ok) {
        statusEl.textContent = `失败：${data.error || '未知'}`;
        return;
      }
      const { status, statusText, savedCookie } = data;

      if (status === 4) {
        clearInterval(pollId);
        if (savedCookie) {
          statusEl.textContent = '✓ 登录成功 · cookie 已保存';
          setTimeout(() => {
            closeReloginModal();
            toast('酷狗登录成功，可以放歌了');
            load(true);
          }, 600);
        } else {
          // token 提取失败：给出明确提示，让用户知道发生了什么
          statusEl.textContent = '登录已确认，但 token 提取失败，请重试';
          statusEl.style.color = 'var(--accent, #e07)';
        }
        return;
      }

      statusEl.textContent = statusText;

      if (status === 0) {
        clearInterval(pollId);
        statusEl.textContent = '二维码过期 · 关闭后重试';
      }
    } catch (err) {
      statusEl.textContent = `轮询失败：${err.message}`;
    }
  }, 1_500);

  reloginState = { key, pollId, modal: backdrop };
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
