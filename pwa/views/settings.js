// Settings 视图 · 集成健康 + 配置表单
import { showAlert, toast } from './ui.js';
import { applyPixelHostSetting, readPixelHostEnabled } from '../host-mood.js';

const MASK = '****已配置';

const fields = {
  brainMode:        '#set-brain-mode',
  djEnabled:        '#set-dj-enabled',
  djPoll:           '#set-dj-poll',
  djMinRem:         '#set-dj-min-rem',
  djBatch:          '#set-dj-batch',
  deepseekKey:      '#set-deepseek-key',
  deepseekModel:    '#set-deepseek-model',
  adaptiveVol:      '#set-adaptive-vol',
  volMax:           '#set-vol-max',
  likeTargetName:   '#set-like-target-name',
  likeTargetId:     '#set-like-target-id',
  ttsKey:           '#set-tts-key',
  ttsVoice:         '#set-tts-voice',
  weatherEnabled:   '#set-weather-enabled',
  weatherKey:       '#set-weather-key',
  weatherCity:      '#set-weather-city',
  calendarProvider: '#set-calendar-provider',
  uiTheme:          '#set-ui-theme',
  pixelHost:        '#set-pixel-host',
  globalHotkey:     '#set-global-hotkey',
  hotkeyMedia:      '#set-hotkey-media',
  closeToTray:      '#set-close-to-tray',
  playWindowMode:   '#set-play-window-mode',
  alwaysTopMini:    '#set-always-top-mini',
};

let nodes = {};
let healthList, kugouStatus, btnSave, btnRefresh, btnRelogin;
let loaded = false;
let loading = false;
let reloginState = null;  // { key, pollId, modal } 当前活的扫码会话

const HEALTH_KEYS = [
  { key: 'kugou',    label: 'KuGou'    },
  { key: 'weather',  label: 'Weather'  },
  { key: 'tts',      label: 'TTS'      },
  { key: 'ai',       label: 'AI'       },
  { key: 'lark',     label: 'Lark'     },
  { key: 'calendar', label: 'Calendar' },
  { key: 'dj',       label: 'DJ'       },
];

export function renderHealthItems(container, items) {
  container.textContent = '';
  for (const { label, ok, message } of items) {
    const li = document.createElement('li');
    li.className = ok ? 'ok' : 'off';
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = ok ? '✓' : '○';
    const name = document.createElement('span');
    name.className = 'label';
    name.textContent = label;
    const msg = document.createElement('span');
    msg.className = 'msg';
    msg.textContent = message;
    li.append(mark, name, msg);
    container.appendChild(li);
  }
}

function httpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

export function createReloginModal({ qrImg, qrUrl }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-label', '酷狗扫码登录');
  const close = document.createElement('button');
  close.className = 'modal-close';
  close.type = 'button';
  close.setAttribute('aria-label', '关闭');
  close.textContent = '×';
  const title = document.createElement('h3');
  title.textContent = '用手机酷狗 App 扫码';
  modal.append(close, title);
  const imageUrl = httpUrl(qrImg) || (String(qrImg || '').startsWith('data:image/') ? String(qrImg) : '');
  if (imageUrl) {
    const image = document.createElement('img');
    image.className = 'qr';
    image.src = imageUrl;
    image.alt = '酷狗登录二维码';
    modal.appendChild(image);
  }
  const linkUrl = httpUrl(qrUrl);
  if (linkUrl) {
    const hint = document.createElement('p');
    hint.className = 'muted small';
    hint.textContent = '或浏览器打开：';
    const link = document.createElement('a');
    link.href = linkUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = linkUrl;
    hint.appendChild(link);
    modal.appendChild(hint);
  }
  const statusRow = document.createElement('div');
  statusRow.className = 'modal-status-row';
  const status = document.createElement('span');
  status.className = 'modal-status';
  status.dataset.status = '';
  status.textContent = '检查中…';
  const refresh = document.createElement('button');
  refresh.className = 'btn ghost modal-refresh';
  refresh.type = 'button';
  refresh.dataset.refresh = '';
  refresh.textContent = '手动刷新';
  statusRow.append(status, refresh);
  modal.appendChild(statusRow);
  for (const [className, key] of [['modal-checked', 'checked'], ['modal-probe', 'probe']]) {
    const line = document.createElement('p');
    line.className = className;
    line.dataset[key] = '';
    modal.appendChild(line);
  }
  backdrop.appendChild(modal);
  return backdrop;
}

function renderHealth(health) {
  renderHealthItems(healthList, HEALTH_KEYS.map(({ key, label }) => {
    const row = health?.[key] || {};
    const ok = !!row.ok;
    return { label, ok, message: row.message || row.detail || (ok ? 'ok' : 'unconfigured') };
  }));
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

function boolFrom(raw, fallback) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return fallback;
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function applySettings(s) {
  if (nodes.brainMode) nodes.brainMode.value = s?.brain_mode || 'external';
  if (nodes.djEnabled) nodes.djEnabled.checked = boolFrom(s?.dj_enabled, false);
  if (nodes.djPoll) nodes.djPoll.value = s?.dj_poll_seconds || '20';
  if (nodes.djMinRem) nodes.djMinRem.value = s?.dj_min_remaining_minutes || '10';
  if (nodes.djBatch) nodes.djBatch.value = s?.dj_batch_size || '5';
  if (nodes.deepseekKey) nodes.deepseekKey.value = s?.deepseek_api_key || '';
  if (nodes.deepseekModel) nodes.deepseekModel.value = s?.deepseek_model || 'deepseek-chat';
  if (nodes.adaptiveVol) nodes.adaptiveVol.checked = boolFrom(s?.adaptive_volume_enabled, true);
  if (nodes.volMax) nodes.volMax.value = s?.volume_safe_max || '85';
  if (nodes.likeTargetId) nodes.likeTargetId.value = s?.like_target_listid || '';
  if (nodes.likeTargetName) nodes.likeTargetName.value = s?.like_target_name || '';
  if (nodes.ttsKey) nodes.ttsKey.value = pickSetting(s, 'fish_api_key', 'tts', 'apiKey');
  if (nodes.ttsVoice) nodes.ttsVoice.value = pickSetting(s, 'fish_voice_id', 'tts', 'voiceId');
  if (nodes.weatherEnabled) nodes.weatherEnabled.checked = boolFrom(s?.weather_enabled, true);
  if (nodes.weatherKey) nodes.weatherKey.value = pickSetting(s, 'openweather_api_key', 'weather', 'apiKey');
  if (nodes.weatherCity) nodes.weatherCity.value = pickSetting(s, 'openweather_city', 'weather', 'city');
  if (nodes.calendarProvider) nodes.calendarProvider.value = s?.calendar_provider || 'none';
  if (nodes.uiTheme) {
    nodes.uiTheme.value = s?.ui_theme || 'auto';
    window.dispatchEvent(new CustomEvent('claudio:theme', { detail: nodes.uiTheme.value }));
  }
  if (nodes.pixelHost) {
    const on = readPixelHostEnabled();
    nodes.pixelHost.checked = on;
    applyPixelHostSetting(on, { persist: false });
  }
  if (nodes.globalHotkey) nodes.globalHotkey.value = s?.global_hotkey || 'CTRL+ALT+K';
  if (nodes.hotkeyMedia) nodes.hotkeyMedia.checked = boolFrom(s?.hotkey_media_key, false);
  if (nodes.closeToTray) nodes.closeToTray.checked = boolFrom(s?.close_to_tray, true);
  if (nodes.playWindowMode) {
    // 未配置（''）或非法值统一显示「后台播放」，读取时不写库。
    nodes.playWindowMode.value = s?.play_window_mode === 'popup' ? 'popup' : 'background';
  }
  if (nodes.alwaysTopMini) nodes.alwaysTopMini.checked = boolFrom(s?.always_on_top_mini, true);
}

// 构造 PUT body：跳过 mask 占位（避免覆盖原 key）
function buildPayload() {
  const payload = {};
  if (nodes.brainMode) payload.brain_mode = nodes.brainMode.value || 'external';
  if (nodes.djEnabled) payload.dj_enabled = String(Boolean(nodes.djEnabled.checked));
  if (nodes.djPoll) payload.dj_poll_seconds = String(nodes.djPoll.value || '20').trim();
  if (nodes.djMinRem) payload.dj_min_remaining_minutes = String(nodes.djMinRem.value || '10').trim();
  if (nodes.djBatch) payload.dj_batch_size = String(nodes.djBatch.value || '5').trim();

  if (nodes.deepseekKey && nodes.deepseekKey.value !== MASK) {
    payload.deepseek_api_key = nodes.deepseekKey.value;
  }
  if (nodes.deepseekModel) payload.deepseek_model = nodes.deepseekModel.value || 'deepseek-chat';

  if (nodes.adaptiveVol) payload.adaptive_volume_enabled = String(Boolean(nodes.adaptiveVol.checked));
  if (nodes.volMax) payload.volume_safe_max = String(nodes.volMax.value || '85').trim();
  if (nodes.likeTargetId) payload.like_target_listid = nodes.likeTargetId.value.trim();
  if (nodes.likeTargetName) payload.like_target_name = nodes.likeTargetName.value.trim();

  if (nodes.ttsKey && nodes.ttsKey.value !== MASK) {
    payload.fish_api_key = nodes.ttsKey.value;
  }
  if (nodes.ttsVoice) payload.fish_voice_id = nodes.ttsVoice.value.trim();

  if (nodes.weatherEnabled) payload.weather_enabled = String(Boolean(nodes.weatherEnabled.checked));
  if (nodes.weatherKey && nodes.weatherKey.value !== MASK) {
    payload.openweather_api_key = nodes.weatherKey.value;
  }
  if (nodes.weatherCity) payload.openweather_city = nodes.weatherCity.value.trim();
  if (nodes.calendarProvider) payload.calendar_provider = nodes.calendarProvider.value || 'none';
  if (nodes.uiTheme) payload.ui_theme = nodes.uiTheme.value || 'auto';
  if (nodes.globalHotkey) payload.global_hotkey = nodes.globalHotkey.value.trim() || 'CTRL+ALT+K';
  if (nodes.hotkeyMedia) payload.hotkey_media_key = String(Boolean(nodes.hotkeyMedia.checked));
  if (nodes.closeToTray) payload.close_to_tray = String(Boolean(nodes.closeToTray.checked));
  if (nodes.playWindowMode) {
    payload.play_window_mode = nodes.playWindowMode.value === 'popup' ? 'popup' : 'background';
  }
  if (nodes.alwaysTopMini) payload.always_on_top_mini = String(Boolean(nodes.alwaysTopMini.checked));
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
      healthList.textContent = '';
      const item = document.createElement('li');
      item.className = 'off';
      item.textContent = `健康检查失败：${hRes.reason.message}`;
      healthList.appendChild(item);
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
    const payload = buildPayload();
    const r = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (payload.ui_theme) {
      window.dispatchEvent(new CustomEvent('claudio:theme', { detail: payload.ui_theme }));
    }
    if (nodes.pixelHost) {
      applyPixelHostSetting(nodes.pixelHost.checked);
    }
    window.claudioDesktop?.syncSettings?.(payload);
    toast('已保存并生效');
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
  const backdrop = createReloginModal({ qrImg, qrUrl });
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

  const btnTtsTest = document.querySelector('button[data-test="tts"]');
  if (btnTtsTest) {
    btnTtsTest.addEventListener('click', async () => {
      btnTtsTest.disabled = true;
      const original = btnTtsTest.textContent;
      btnTtsTest.textContent = '合成中…';
      try {
        const voiceId = nodes.ttsVoice.value.trim();
        const r = await fetch('/api/test/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(voiceId ? { voice_id: voiceId } : {}),
        });
        const data = await r.json();
        if (!data.ok) throw new Error(data.error || '合成失败');
        new Audio(data.url).play();
      } catch (err) {
        showAlert(`试听失败：${err.message}`);
      } finally {
        btnTtsTest.textContent = original;
        btnTtsTest.disabled = false;
      }
    });
  }

  const btnWeatherTest = document.querySelector('button[data-test="weather"]');
  if (btnWeatherTest) {
    btnWeatherTest.addEventListener('click', async () => {
      btnWeatherTest.disabled = true;
      const original = btnWeatherTest.textContent;
      btnWeatherTest.textContent = '检测中…';
      try {
        const r = await fetch('/api/test/weather', { method: 'POST' });
        const data = await r.json();
        if (!data.ok) throw new Error(data.error || '请求失败');
        const { temp, condition, city, humidity } = data.data;
        toast(`${city} ${temp}°C · ${condition} · 湿度 ${humidity}%`);
      } catch (err) {
        showAlert(`天气测试失败：${err.message}`);
      } finally {
        btnWeatherTest.textContent = original;
        btnWeatherTest.disabled = false;
      }
    });
  }

  const btnAiTest = document.querySelector('button[data-test="ai"]');
  if (btnAiTest) {
    btnAiTest.addEventListener('click', async () => {
      btnAiTest.disabled = true;
      const original = btnAiTest.textContent;
      btnAiTest.textContent = '测试中…';
      try {
        const r = await fetch('/api/test/ai', { method: 'POST' });
        const data = await r.json();
        if (!data.ok) throw new Error(data.error || '连接失败');
        toast(`AI 响应正常：${data.reply}`);
      } catch (err) {
        showAlert(`AI 测试失败：${err.message}`);
      } finally {
        btnAiTest.textContent = original;
        btnAiTest.disabled = false;
      }
    });
  }

  const btnCalTest = document.querySelector('button[data-test="calendar"]');
  if (btnCalTest) {
    btnCalTest.addEventListener('click', async () => {
      btnCalTest.disabled = true;
      const original = btnCalTest.textContent;
      btnCalTest.textContent = '检测中…';
      try {
        const provider = nodes.calendarProvider?.value || 'none';
        const r = await fetch('/api/test/calendar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider }),
        });
        const data = await r.json();
        if (!data.ok) throw new Error(data.error || '连接失败');
        toast(`${data.provider} 日历正常（今日 ${data.count} 条日程）`);
      } catch (err) {
        showAlert(`日历测试失败：${err.message}`);
      } finally {
        btnCalTest.textContent = original;
        btnCalTest.disabled = false;
      }
    });
  }

  const btnClearLike = document.getElementById('btn-clear-like-target');
  if (btnClearLike) {
    btnClearLike.addEventListener('click', () => {
      if (nodes.likeTargetName) nodes.likeTargetName.value = '';
      if (nodes.likeTargetId) nodes.likeTargetId.value = '';
    });
  }
  nodes.likeTargetName?.addEventListener('input', () => {
    // 手动改过名字后，旧 listid 已不对应当前名字，清掉让服务端按名称兜底。
    if (nodes.likeTargetId) nodes.likeTargetId.value = '';
  });
  nodes.uiTheme?.addEventListener('change', () => {
    window.dispatchEvent(new CustomEvent('claudio:theme', { detail: nodes.uiTheme.value }));
  });
  if (nodes.pixelHost) {
    nodes.pixelHost.checked = readPixelHostEnabled();
    nodes.pixelHost.addEventListener('change', () => {
      applyPixelHostSetting(nodes.pixelHost.checked);
    });
  }

  window.addEventListener('claudio:view-shown', e => {
    if (e.detail === 'settings') load();
  });
  window.addEventListener('claudio:settings-updated', () => {
    loaded = false;
  });
}
