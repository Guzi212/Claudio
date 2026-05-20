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
let healthList, kugouStatus, btnSave, btnRefresh, btnRelogin;
let loaded = false;
let loading = false;
let reloginState = null;  // { key, pollId, modal } 当前活的扫码会话

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
  nodes.weatherKey.value  = s?.openweather_api_key ?? '';
  nodes.weatherCity.value = s?.openweather_city    ?? '';
  nodes.ttsKey.value      = s?.fish_api_key        ?? '';
  nodes.ttsVoice.value    = s?.fish_voice_id       ?? '';
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
  if (reloginState.pollId) clearInterval(reloginState.pollId);
  if (reloginState.modal?.parentNode) reloginState.modal.parentNode.removeChild(reloginState.modal);
  reloginState = null;
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
      <p class="modal-status" data-status>等扫码…</p>
    </div>
  `;
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
      statusEl.textContent = statusText + (savedCookie ? ' · cookie 已保存' : '');
      if (status === 4 && savedCookie) {
        clearInterval(pollId);
        setTimeout(() => {
          closeReloginModal();
          toast('登录成功 · 已刷新 cookie');
          load(true); // 健康列表会从 ○ 变 ✓
        }, 800);
      } else if (status === 0) {
        clearInterval(pollId);
        statusEl.textContent = '二维码过期 · 关闭后重试';
      }
    } catch (err) {
      statusEl.textContent = `轮询失败：${err.message}`;
    }
  }, 2_000);

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

  const btnTestWeather = document.querySelector('button[data-test="weather"]');
  if (btnTestWeather) {
    btnTestWeather.disabled = false;
    btnTestWeather.removeAttribute('title');
    btnTestWeather.addEventListener('click', async () => {
      btnTestWeather.disabled = true;
      const orig = btnTestWeather.textContent;
      btnTestWeather.textContent = '测试中…';
      try {
        const r = await fetch('/api/test/weather', { method: 'POST' });
        const data = await r.json();
        if (data.ok) {
          const d = data.data;
          toast(`天气 OK · ${d.city} ${d.temp}°C ${d.condition}`);
        } else {
          showAlert(`天气测试失败：${data.error}`);
        }
      } catch (err) {
        showAlert(`天气测试失败：${err.message}`);
      } finally {
        btnTestWeather.textContent = orig;
        btnTestWeather.disabled = false;
      }
    });
  }

  const btnTestTts = document.querySelector('button[data-test="tts"]');
  if (btnTestTts) {
    btnTestTts.disabled = false;
    btnTestTts.removeAttribute('title');
    btnTestTts.addEventListener('click', async () => {
      btnTestTts.disabled = true;
      const orig = btnTestTts.textContent;
      btnTestTts.textContent = '合成中…';
      try {
        const r = await fetch('/api/test/tts', { method: 'POST' });
        const data = await r.json();
        if (data.ok) {
          new Audio(data.url).play();
          toast('TTS OK · 正在播放');
        } else {
          showAlert(`TTS 测试失败：${data.error}`);
        }
      } catch (err) {
        showAlert(`TTS 测试失败：${err.message}`);
      } finally {
        btnTestTts.textContent = orig;
        btnTestTts.disabled = false;
      }
    });
  }

  window.addEventListener('claudio:view-shown', e => {
    if (e.detail === 'settings') load();
  });
}
