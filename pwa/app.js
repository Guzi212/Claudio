// 三视图编排器：tab 切换 + URL 同步 + 全局 WS。
// chat / audio 逻辑搬到 views/player.js；这里只负责导航和跨视图的状态推送。
import { initPlayer, applyRuntime, appendToQueue, applyExternalQueue } from './views/player.js';
import { initPlaylists } from './views/playlists.js';
import { initProfile } from './views/profile.js';
import { initSettings } from './views/settings.js';
import { setStatus, showAlert } from './views/ui.js';
import { urlWithoutToken } from './session-url.js';
// 增量组件 · DOMContentLoaded 自动 attach 到 #env-strip / #lyrics-panel
// player.js 会 dispatchEvent('claudio:trackchange') 给 lyrics 当作切歌信号
import './components/env-strip.js';
import './components/lyrics.js';
import './components/studio-visual.js';

const VIEWS = ['player', 'playlists', 'profile', 'settings'];
const DEFAULT_VIEW = 'player';

function currentViewFromUrl() {
  const v = new URLSearchParams(location.search).get('view');
  return VIEWS.includes(v) ? v : DEFAULT_VIEW;
}

function setView(name, { push = false } = {}) {
  if (!VIEWS.includes(name)) name = DEFAULT_VIEW;
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

// CLAUDIO_REQUIRE_TOKEN 打开时，回环也要凭证。静态页面不写密钥：
// 第一次用 ?token= 打开，换成 HttpOnly cookie，再从地址栏去掉 token。
// 必须在 initPlayer / WebSocket 之前做完，否则 /api/now 会先 401。
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
  await adoptUrlToken();

  // 各视图自己负责懒加载，初始化只挂事件
  initPlayer();
  initPlaylists();
  initProfile();
  initSettings();

  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => setView(btn.dataset.view, { push: true }));
  });

  // 视图内部（如 Playlists 整单播放后）请求跳转
  window.addEventListener('claudio:navigate', e => setView(e.detail, { push: true }));

  window.addEventListener('popstate', () => setView(currentViewFromUrl()));

  // 启动时根据 URL 落到对应 tab（默认 player）
  setView(currentViewFromUrl());
  connectWs();

  if (location.protocol !== 'file:' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* 静默 */ });
  }
}

// ──────────────── 全局 WS（所有 tab 都保持连接） ────────────────
function connectWs() {
  if (location.protocol === 'file:') return;
  let ws;
  try {
    ws = new WebSocket(`ws://${location.host}/stream`);
  } catch {
    return; // WS 不可用不挡主流程
  }
  ws.addEventListener('open',  () => setStatus('● 在线'));
  ws.addEventListener('close', () => setStatus('● 离线'));
  ws.addEventListener('message', ev => {
    try {
      const evt = JSON.parse(ev.data);
      if (evt.type === 'state' && evt.runtime) applyRuntime(evt.runtime);
      if (evt.type === 'queue-append' && evt.tracks) appendToQueue(evt.tracks);
      if (evt.type === 'external-queue') applyExternalQueue(evt);
    } catch { /* ignore */ }
  });
}
startApp();
