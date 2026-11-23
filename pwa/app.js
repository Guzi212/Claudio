// 顶层视图协调器：tab 切换 + 主题同步 + 全局 WS + 桌面壳桥接。
import {
  initPlayer,
  applyRuntime,
  applyLeader,
  applyRemoteProgress,
  appendToQueue,
  applyExternalQueue,
  syncFromServer,
} from './views/player.js';
import { getClientId } from './client-id.js';
import { installMediaSession } from './media-session.js';
import { initPlaylists } from './views/playlists.js';
import { initProfile } from './views/profile.js';
import { initSettings } from './views/settings.js';
import { setStatus, showAlert } from './views/ui.js';
import { urlWithoutToken } from './session-url.js';
import { applyTheme, readSavedTheme } from './theme-store.js';
import { applyPixelHostSetting, readPixelHostEnabled } from './host-mood.js';
import './components/lyrics.js';

const VIEWS = ['player', 'playlists', 'profile', 'settings'];
const DEFAULT_VIEW = 'player';
let mediaSession = { noteRuntime() {} };

export { applyTheme };

export function detectClientKind(win = globalThis.window) {
  return win?.claudioDesktop?.isDesktop ? 'electron' : 'pwa';
}

function currentViewFromUrl() {
  const v = new URLSearchParams(location.search).get('view');
  return VIEWS.includes(v) ? v : DEFAULT_VIEW;
}

function bindCornerMenu() {
  const btn = document.getElementById('corner-menu-btn');
  const panel = document.getElementById('corner-panel');
  if (!btn || !panel) return;
  const close = () => {
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  };
  btn.addEventListener('click', event => {
    event.stopPropagation();
    const open = panel.hidden;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  });
  panel.addEventListener('click', event => {
    const jump = event.target.closest('[data-view-jump]');
    if (!jump) return;
    close();
    setView(jump.dataset.viewJump, { push: true });
  });
  document.addEventListener('click', event => {
    if (panel.hidden || event.target.closest('.corner-menu')) return;
    close();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') close();
  });
}

function setView(name, { push = false } = {}) {
  if (!VIEWS.includes(name)) name = DEFAULT_VIEW;
  document.body?.classList.toggle('view-player', name === 'player');
  for (const v of VIEWS) {
    const sec = document.getElementById(`view-${v}`);
    const tab = document.querySelector(`.tab[data-view="${v}"]`);
    if (sec) sec.classList.toggle('hidden', v !== name);
    if (tab) tab.classList.toggle('active', v === name);
  }
  const url = new URL(location.href);
  url.searchParams.set('view', name);
  const method = push ? 'pushState' : 'replaceState';
  history[method](null, '', url);
  window.dispatchEvent(new CustomEvent('claudio:view-shown', { detail: name }));
}

function initDesktopChrome() {
  const desktop = window.claudioDesktop;
  if (!desktop?.isDesktop) return;
  document.documentElement.classList.add('is-desktop');
  const titlebar = document.getElementById('desktop-titlebar');
  if (titlebar) titlebar.hidden = false;

  document.getElementById('win-min-btn')?.addEventListener('click', () => desktop.minimize?.());
  document.getElementById('win-close-btn')?.addEventListener('click', () => desktop.close?.());
  document.getElementById('win-mini-btn')?.addEventListener('click', () => desktop.toggleMini?.());
  document.getElementById('mini-expand-btn')?.addEventListener('click', () => desktop.setMini?.(false));

  desktop.onMiniChanged?.(isMini => {
    document.documentElement.classList.toggle('is-mini', Boolean(isMini));
  });
}

async function loadInitialTheme() {
  const saved = readSavedTheme();
  if (saved) applyTheme(saved, { persist: false });
  try {
    const r = await fetch('/api/settings');
    if (r.ok) {
      const s = await r.json();
      if (s?.ui_theme) applyTheme(s.ui_theme);
    }
  } catch { /* */ }
}

async function adoptUrlToken() {
  if (location.protocol === 'file:') return;
  const token = new URLSearchParams(location.search).get('token')?.trim() || '';
  if (token) {
    let ok = false;
    try {
      const res = await fetch('/api/session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Authorization: `Bearer ${token}` },
      });
      ok = res.ok;
    } catch {
      ok = false;
    }
    if (!ok) {
      showAlert('这个 token 无效。请核对后再用带 ?token= 的地址打开一次。');
      return;
    }
    history.replaceState(null, '', urlWithoutToken(location.href));
    return;
  }

  try {
    const res = await fetch('/api/health', { credentials: 'same-origin' });
    if (res.status === 401) {
      showAlert('需要先用带 ?token= 的地址打开一次。页面会换成 cookie，并从地址栏去掉 token。密钥不会写进页面。');
    }
  } catch { /* 离线时不挡壳层 */ }
}

async function startApp() {
  initDesktopChrome();
  applyPixelHostSetting(readPixelHostEnabled(), { persist: false });
  await loadInitialTheme();
  await adoptUrlToken();
  mediaSession = installMediaSession();

  initPlayer();
  initPlaylists();
  initProfile();
  initSettings();

  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => setView(btn.dataset.view, { push: true }));
  });
  bindCornerMenu();

  window.addEventListener('claudio:theme', e => applyTheme(e.detail));
  window.addEventListener('claudio:navigate', e => setView(e.detail, { push: true }));
  window.addEventListener('popstate', () => setView(currentViewFromUrl()));

  setView(currentViewFromUrl());
  connectWs();
  document.documentElement.dataset.appReady = 'true';

  if (location.protocol !== 'file:' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* 静默 */ });
  }
}

function connectWs() {
  if (location.protocol === 'file:') return;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/stream`;
  let ws = null;
  let attempt = 0;
  let retryTimer = null;
  let everConnected = false;

  const clearRetry = () => {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  };

  const scheduleRetry = () => {
    if (retryTimer) return;
    const backoff = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
    const wait = backoff + Math.floor(Math.random() * 400);
    attempt += 1;
    setStatus(`● 离线，${Math.ceil(wait / 1000)} 秒后重连`);
    retryTimer = setTimeout(() => { retryTimer = null; open(); }, wait);
  };

  function open() {
    clearRetry();
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    try {
      ws = new WebSocket(url);
    } catch {
      scheduleRetry();
      return;
    }
    ws.addEventListener('open', () => {
      const reconnected = everConnected;
      everConnected = true;
      attempt = 0;
      setStatus('● 在线');
      if (reconnected) syncFromServer({ silent: true, keepOverlay: true });
    });
    ws.addEventListener('close', () => {
      setStatus('● 离线');
      scheduleRetry();
    });
    ws.addEventListener('error', () => {
      try { ws.close(); } catch { /* ignore */ }
    });
    ws.addEventListener('message', ev => {
      let evt;
      try { evt = JSON.parse(ev.data); } catch { return; }
      if ((evt.type === 'hello' || evt.type === 'state') && evt.runtime) {
        if (evt.type === 'hello' && ws?.readyState === 1) {
          try {
            ws.send(JSON.stringify({
              type: 'identify',
              clientId: getClientId(),
              kind: detectClientKind(),
            }));
          } catch { /* ignore */ }
        }
        mediaSession.noteRuntime(evt.runtime, { origin: evt.origin });
        applyRuntime(evt.runtime, { origin: evt.origin });
        return;
      }
      if (evt.type === 'leader') {
        applyLeader(evt.leader);
        return;
      }
      if (evt.type === 'progress') {
        applyRemoteProgress(evt);
        return;
      }
      if (evt.type === 'queue-append' && evt.tracks) appendToQueue(evt.tracks);
      if (evt.type === 'external-queue') applyExternalQueue(evt);
      if (evt.type === 'continue-pool') applyRuntime({ continuePool: evt.continuePool });
      if (evt.type === 'settings-updated') {
        loadInitialTheme();
        window.dispatchEvent(new CustomEvent('claudio:settings-updated', { detail: evt.applied || [] }));
      }
    });
  }

  window.addEventListener('claudio:progress', ev => {
    if (!ws || ws.readyState !== 1) return;
    try { ws.send(JSON.stringify({ type: 'progress', ...ev.detail })); } catch { /* ignore */ }
  });

  const kick = () => {
    if (document.visibilityState === 'hidden') return;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    attempt = 0;
    clearRetry();
    open();
  };
  document.addEventListener('visibilitychange', kick);
  window.addEventListener('online', kick);
  window.addEventListener('pageshow', ev => { if (ev.persisted) kick(); });

  open();
}

startApp();
