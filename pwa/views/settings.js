// Settings 视图 · 集成健康 + 配置表单 + 多音源统一扫码登录
import { showAlert, toast } from './ui.js';
import { applyPixelHostSetting, readPixelHostEnabled } from '../host-mood.js';

const MASK = '****已配置';
export const FEEDBACK_URL = 'https://github.com/Guzi212/Claudio/issues/new/choose';

const fields = {
  brainMode:        '#set-brain-mode',
  djEnabled:        '#set-dj-enabled',
  djPoll:           '#set-dj-poll',
  djMinRem:         '#set-dj-min-rem',
  djBatch:          '#set-dj-batch',
  deepseekKey:      '#set-deepseek-key',
  deepseekModel:    '#set-deepseek-model',
  musicProvider:    '#set-music-provider',
  adaptiveVol:      '#set-adaptive-vol',
  playbackQuality:  '#set-playback-quality',
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
  alwaysTopMini:    '#set-always-top-mini',
};

export const RELOGIN_PROVIDERS = {
  kugou: {
    key: 'kugou',
    label: '酷狗音乐',
    dialogLabel: '酷狗扫码登录',
    title: '用手机酷狗 App 扫码',
    qrAlt: '酷狗登录二维码',
    startUrl: '/api/kugou/relogin/start',
    statusUrl: '/api/kugou/relogin/status',
    probeUrl: '/api/kugou/relogin/probe',
    statusId: 'kugou-status',
    buttonId: 'btn-kugou-relogin',
    successToast: '酷狗登录成功，可以放歌了',
  },
  netease: {
    key: 'netease',
    label: '网易云音乐',
    dialogLabel: '网易云扫码登录',
    title: '用网易云音乐 App 扫码',
    qrAlt: '网易云登录二维码',
    startUrl: '/api/netease/relogin/start',
    statusUrl: '/api/netease/relogin/status',
    probeUrl: '',
    statusId: 'netease-status',
    buttonId: 'btn-netease-relogin',
    successToast: '网易云登录成功，凭证已落盘',
  },
  qq: {
    key: 'qq',
    label: 'QQ 音乐',
    dialogLabel: 'QQ 音乐扫码登录',
    title: '用手机 QQ 扫码登录',
    wxTitle: '用微信扫码登录 QQ 音乐',
    qrAlt: 'QQ 音乐登录二维码',
    startUrl: '/api/qq/relogin/start',
    statusUrl: '/api/qq/relogin/status',
    probeUrl: '',
    statusId: 'qq-status',
    buttonId: 'btn-qq-relogin',
    successToast: 'QQ 音乐登录成功，凭证已落盘',
  },
};

let nodes = {};
let healthList, btnSave, btnRefresh;
let loginEls = {};
let loaded = false;
let loading = false;
let reloginState = null;  // { provider, key, pollId, probeId, modal } 当前活的扫码会话
let lastSavedProvider = 'multi';

const HEALTH_KEYS = [
  { key: 'kugou',    label: 'KuGou'    },
  { key: 'netease',  label: 'Netease'  },
  { key: 'qq',       label: 'QQ Music' },
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

export function renderProviderLoginState(statusEl, buttonEl, row) {
  if (!statusEl) return;
  if (!row || typeof row !== 'object') {
    statusEl.textContent = 'unknown';
    statusEl.className = 'readonly off';
    return;
  }
  const msg = row.message || row.detail || '';
  const loggedIn = row.loggedIn != null
    ? Boolean(row.loggedIn)
    : Boolean(row.ok && !row.anonymous && !/anonymous|unauth|search only|未登录|expired/i.test(msg));
  if (loggedIn) {
    statusEl.textContent = `已登录 · ${msg || row.account || 'cookie ok'}`;
    statusEl.className = 'readonly ok';
  } else if (row.configured === false) {
    statusEl.textContent = `未配置 · ${msg || 'API 未启用'}`;
    statusEl.className = 'readonly off';
  } else if (row.ok) {
    statusEl.textContent = `未登录 · ${msg || '匿名可用'}`;
    statusEl.className = 'readonly off';
  } else {
    statusEl.textContent = msg || '未连接';
    statusEl.className = 'readonly off';
  }
  if (buttonEl) {
    buttonEl.textContent = loggedIn ? '重扫码' : '扫码登录';
    buttonEl.disabled = row.configured === false;
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

export function createReloginModal({ qrImg, qrUrl, provider = 'kugou', qqType = 'qq' } = {}) {
  const cfg = RELOGIN_PROVIDERS[provider] || RELOGIN_PROVIDERS.kugou;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-label', cfg.dialogLabel);
  const close = document.createElement('button');
  close.className = 'modal-close';
  close.type = 'button';
  close.setAttribute('aria-label', '关闭');
  close.textContent = '×';
  const title = document.createElement('h3');
  title.textContent = provider === 'qq' && qqType === 'wx' ? cfg.wxTitle : cfg.title;
  modal.append(close, title);

  if (provider === 'qq') {
    const tabs = document.createElement('div');
    tabs.className = 'modal-tabs';
    for (const [kind, text] of [['qq', '手机 QQ'], ['wx', '微信扫码']]) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'btn ghost' + (qqType === kind ? ' active' : '');
      tab.dataset.qqType = kind;
      tab.textContent = text;
      tabs.appendChild(tab);
    }
    modal.appendChild(tabs);
  }

  const imageUrl = httpUrl(qrImg) || (String(qrImg || '').startsWith('data:image/') ? String(qrImg) : '');
  if (imageUrl) {
    const image = document.createElement('img');
    image.className = 'qr';
    image.src = imageUrl;
    image.alt = cfg.qrAlt;
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
  for (const provider of Object.keys(RELOGIN_PROVIDERS)) {
    const els = loginEls[provider];
    if (els) {
      renderProviderLoginState(els.status, els.button, health?.[provider]);
    }
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
  if (nodes.musicProvider) {
    lastSavedProvider = s?.music_provider || 'multi';
    nodes.musicProvider.value = lastSavedProvider;
  }
  if (nodes.playbackQuality) nodes.playbackQuality.value = s?.playback_quality || 'flac';
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

  if (nodes.musicProvider) payload.music_provider = nodes.musicProvider.value || 'multi';
  if (nodes.playbackQuality) payload.playback_quality = nodes.playbackQuality.value || 'flac';
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
      for (const provider of Object.keys(RELOGIN_PROVIDERS)) {
        const els = loginEls[provider];
        if (els) renderProviderLoginState(els.status, els.button, { ok: false, detail: hRes.reason.message });
      }
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

// ──────────── 三源统一扫码登录弹窗 ────────────
function closeReloginModal() {
  if (!reloginState) return;
  clearInterval(reloginState.pollId);
  if (reloginState.probeId) clearInterval(reloginState.probeId);
  if (reloginState.modal?.parentNode) reloginState.modal.parentNode.removeChild(reloginState.modal);
  reloginState = null;
}

function onLoginSuccess(statusEl, cfg) {
  statusEl.textContent = '✓ 登录成功 · 凭证已保存';
  statusEl.className = 'modal-status ok';
  setTimeout(() => {
    closeReloginModal();
    toast(cfg.successToast);
    loaded = false;
    load(true);
  }, 800);
}

function openReloginModal(provider, { qrImg, qrUrl, key, type = 'qq' }) {
  closeReloginModal();
  const cfg = RELOGIN_PROVIDERS[provider] || RELOGIN_PROVIDERS.kugou;
  const qqType = type === 'wx' ? 'wx' : 'qq';
  const backdrop = createReloginModal({ qrImg, qrUrl, provider, qqType });
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeReloginModal(); });
  backdrop.querySelector('.modal-close').addEventListener('click', closeReloginModal);
  for (const tabBtn of backdrop.querySelectorAll('[data-qq-type]')) {
    tabBtn.addEventListener('click', () => {
      const nextType = tabBtn.dataset.qqType;
      if (nextType && nextType !== qqType) {
        startProviderRelogin('qq', { qqType: nextType });
      }
    });
  }
  document.body.appendChild(backdrop);

  const statusEl   = backdrop.querySelector('[data-status]');
  const checkedEl  = backdrop.querySelector('[data-checked]');
  const probeEl    = backdrop.querySelector('[data-probe]');
  const refreshBtn = backdrop.querySelector('[data-refresh]');

  let checking = false;
  let done = false;

  async function checkQrStatus() {
    if (checking || done) return;
    checking = true;
    refreshBtn.disabled = true;
    try {
      const r = await fetch(`${cfg.statusUrl}?key=${encodeURIComponent(key)}`);
      const data = await r.json();
      checkedEl.textContent = `QR 检查 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;

      if (!data.ok) {
        statusEl.textContent = `上游错误：${data.error || '未知'}`;
        statusEl.className = 'modal-status off';
        return;
      }
      const { status, savedCookie, loggedIn, statusText } = data;
      if (status === 4) {
        if (savedCookie || loggedIn) {
          done = true;
          onLoginSuccess(statusEl, cfg);
          return;
        }
        statusEl.textContent = cfg.probeUrl
          ? 'QR status=4 但 token 提取失败，等待 probe…'
          : '扫码已完成但未拿到有效登录凭证，请关闭后重试';
        statusEl.className = 'modal-status off';
        return;
      }
      if (status === 0) {
        clearInterval(reloginState?.pollId);
        statusEl.textContent = statusText === '已拒绝'
          ? '已取消授权 · 关闭后重新扫码'
          : '二维码已过期 · 关闭后重新生成';
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

  async function probeUpstream() {
    if (done || !cfg.probeUrl) return;
    try {
      const r = await fetch(cfg.probeUrl, { method: 'POST' });
      const data = await r.json();
      if (data.ok && data.found) {
        done = true;
        probeEl.textContent = '';
        onLoginSuccess(statusEl, cfg);
      } else {
        probeEl.textContent = `后台探测中… ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
      }
    } catch {
      // probe 静默失败，不打扰 QR 状态显示
    }
  }

  refreshBtn.addEventListener('click', () => {
    checkQrStatus();
    if (cfg.probeUrl) probeUpstream();
  });

  checkQrStatus();
  if (cfg.probeUrl) probeUpstream();
  const pollId  = setInterval(checkQrStatus, 2_000);
  const probeId = cfg.probeUrl ? setInterval(probeUpstream, 3_000) : null;

  reloginState = { provider, key, pollId, probeId, modal: backdrop };
}

async function startProviderRelogin(provider, { qqType = 'qq' } = {}) {
  const cfg = RELOGIN_PROVIDERS[provider];
  if (!cfg) return;
  const btn = loginEls[provider]?.button;
  const originalText = btn ? btn.textContent : '扫码登录';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '生成中…';
  }
  try {
    const startEndpoint = provider === 'qq'
      ? `${cfg.startUrl}?type=${encodeURIComponent(qqType)}`
      : cfg.startUrl;
    const r = await fetch(startEndpoint, { method: 'POST' });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || `HTTP ${r.status}`);
    openReloginModal(provider, { ...data, type: data.type || qqType });
  } catch (err) {
    showAlert(`${cfg.label}扫码启动失败：${err.message}`);
  } finally {
    if (btn) {
      btn.textContent = originalText;
      btn.disabled = false;
    }
  }
}

export function initSettings() {
  for (const [k, sel] of Object.entries(fields)) {
    nodes[k] = document.querySelector(sel);
  }
  healthList = document.getElementById('health-list');
  btnSave    = document.getElementById('settings-save');
  btnRefresh = document.getElementById('settings-refresh');

  loginEls = {};
  for (const [provider, cfg] of Object.entries(RELOGIN_PROVIDERS)) {
    const status = document.getElementById(cfg.statusId);
    const button = document.getElementById(cfg.buttonId);
    loginEls[provider] = { status, button };
    if (button) {
      button.disabled = false;
      button.removeAttribute('title');
      button.addEventListener('click', () => startProviderRelogin(provider));
    }
  }

  btnSave.addEventListener('click', save);
  btnRefresh.addEventListener('click', () => load(true));

  const feedbackLink = document.getElementById('settings-feedback');
  if (feedbackLink) {
    feedbackLink.href = FEEDBACK_URL;
    feedbackLink.target = '_blank';
    feedbackLink.rel = 'noopener noreferrer';
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
  nodes.musicProvider?.addEventListener('change', async () => {
    const next = nodes.musicProvider.value || 'multi';
    nodes.musicProvider.disabled = true;
    try {
      const r = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ music_provider: next }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      lastSavedProvider = next;
      toast('音源已切换并生效');
    } catch (err) {
      nodes.musicProvider.value = lastSavedProvider;
      showAlert(`切换音源失败：${err.message}`);
    } finally {
      nodes.musicProvider.disabled = false;
    }
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
