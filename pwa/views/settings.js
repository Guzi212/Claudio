// Settings 视图 · 集成健康 + 配置表单
import { showAlert, toast } from './ui.js';

const MASK = '****已配置';

const fields = {
  weatherKey:  '#set-weather-key',
  weatherCity: '#set-weather-city',
  ttsKey:      '#set-tts-key',
  ttsVoice:    '#set-tts-voice',
};

let nodes = {};
let healthList, kugouStatus, btnSave, btnRefresh;
let loaded = false;
let loading = false;

const HEALTH_KEYS = [
  { key: 'kugou',   label: 'KuGou'   },
  { key: 'weather', label: 'Weather' },
  { key: 'tts',     label: 'TTS'     },
  { key: 'lark',    label: 'Lark'    },
];

function renderHealth(health) {
  healthList.innerHTML = '';
  for (const { key, label } of HEALTH_KEYS) {
    const row = health?.[key] || {};
    const ok = !!row.ok;
    const msg = row.message || (ok ? 'ok' : 'unconfigured');
    const li = document.createElement('li');
    li.className = ok ? 'ok' : 'off';
    li.innerHTML = `<span class="mark">${ok ? '✓' : '○'}</span><span class="label">${label}</span><span class="msg">${msg}</span>`;
    healthList.appendChild(li);
  }
  // Kugou 状态镜像到下方
  const k = health?.kugou;
  if (k) {
    kugouStatus.textContent = k.ok ? `alive · ${k.message || 'cookie ok'}` : (k.message || 'unknown');
    kugouStatus.className = 'readonly ' + (k.ok ? 'ok' : 'off');
  }
}

function applySettings(s) {
  nodes.weatherKey.value  = s?.weather?.apiKey ?? '';
  nodes.weatherCity.value = s?.weather?.city   ?? '';
  nodes.ttsKey.value      = s?.tts?.apiKey     ?? '';
  nodes.ttsVoice.value    = s?.tts?.voiceId    ?? '';
}

// 构造 PUT body：跳过 mask 占位（避免覆盖原 key）
function buildPayload() {
  const payload = { weather: {}, tts: {} };
  const wk = nodes.weatherKey.value;
  if (wk !== MASK) payload.weather.apiKey = wk;
  payload.weather.city = nodes.weatherCity.value;

  const tk = nodes.ttsKey.value;
  if (tk !== MASK) payload.tts.apiKey = tk;
  payload.tts.voiceId = nodes.ttsVoice.value;
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

export function initSettings() {
  for (const [k, sel] of Object.entries(fields)) {
    nodes[k] = document.querySelector(sel);
  }
  healthList  = document.getElementById('health-list');
  kugouStatus = document.getElementById('kugou-status');
  btnSave     = document.getElementById('settings-save');
  btnRefresh  = document.getElementById('settings-refresh');

  btnSave.addEventListener('click', save);
  btnRefresh.addEventListener('click', () => load(true));

  // 占位按钮：[test] / [试听] / [重扫码登录] —— 提示用户后续补
  document.querySelectorAll('button[data-test]').forEach(b => {
    b.addEventListener('click', () => toast('该功能尚未接入'));
  });

  window.addEventListener('claudio:view-shown', e => {
    if (e.detail === 'settings') load();
  });
}
