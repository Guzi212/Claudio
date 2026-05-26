// 三视图编排器：tab 切换 + URL 同步 + 全局 WS。
// chat / audio 逻辑搬到 views/player.js；这里只负责导航和跨视图的状态推送。
import { initPlayer, applyRuntime, appendToQueue } from './views/player.js';
import { initProfile } from './views/profile.js';
import { initSettings } from './views/settings.js';
import { setStatus, showAlert } from './views/ui.js';
// 增量组件 · DOMContentLoaded 自动 attach 到 #env-strip / #lyrics-panel
// player.js 会 dispatchEvent('claudio:trackchange') 给 lyrics 当作切歌信号
import './components/env-strip.js';
import './components/lyrics.js';
import './components/studio-visual.js';

const VIEWS = ['player', 'profile', 'settings'];
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

// 各视图自己负责懒加载，初始化只挂事件
initPlayer();
initProfile();
initSettings();

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => setView(btn.dataset.view, { push: true }));
});

window.addEventListener('popstate', () => setView(currentViewFromUrl()));

// 启动时根据 URL 落到对应 tab（默认 player）
setView(currentViewFromUrl());

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
    } catch { /* ignore */ }
  });
}
connectWs();

// 注册 service worker（壳层缓存）
if (location.protocol !== 'file:' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* 静默 */ });
}
