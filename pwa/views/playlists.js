// Playlists 视图 · 酷狗账号歌单 → 设候选池 / 整单播放。
// 候选池交给服务端持久化（prefs），Claudio 推荐时优先从池里选歌。
import { showAlert, toast } from './ui.js';

let listEl, poolStatusEl, poolClearBtn, refreshBtn;
let loaded = false;
let loading = false;
let playlists = [];

async function setPool(playlist) {
  try {
    const r = await fetch('/api/kugou/playlists/pool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playlist }),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || `HTTP ${r.status}`);
    renderPool(data.pool);
    toast(`候选池已设为《${playlist.name}》`);
  } catch (err) {
    showAlert(`设置候选池失败：${err.message}`);
  }
}

async function clearPool() {
  try {
    const r = await fetch('/api/kugou/playlists/pool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || `HTTP ${r.status}`);
    renderPool(null);
    toast('候选池已清除');
  } catch (err) {
    showAlert(`清除候选池失败：${err.message}`);
  }
}

async function playPlaylist(playlist) {
  try {
    const r = await fetch('/api/kugou/playlists/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playlist }),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || `HTTP ${r.status}`);
    toast(`开始播放《${playlist.name}》· ${data.count} 首`);
    // 让 Player 视图替换本地队列并从第一首开始播；同时切到 Player tab
    window.dispatchEvent(new CustomEvent('claudio:queue-replace', { detail: data.queue }));
    window.dispatchEvent(new CustomEvent('claudio:navigate', { detail: 'player' }));
  } catch (err) {
    showAlert(`整单播放失败：${err.message}`);
  }
}

function renderPool(pool) {
  if (pool) {
    poolStatusEl.textContent = `《${pool.name}》 · ${pool.trackCount} 首`;
    poolClearBtn.classList.remove('hidden');
  } else {
    poolStatusEl.textContent = '未设置（Claudio 会按 taste.md 自由推荐）';
    poolClearBtn.classList.add('hidden');
  }
}

function renderList(items) {
  listEl.textContent = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = '没有读到歌单，确认酷狗登录态是否有效';
    listEl.appendChild(li);
    return;
  }

  items.forEach((p, idx) => {
    const li = document.createElement('li');
    li.className = 'playlist-item';

    const meta = document.createElement('div');
    meta.className = 'playlist-meta';
    const name = document.createElement('span');
    name.className = 'playlist-name';
    name.textContent = p.name;
    const count = document.createElement('span');
    count.className = 'muted';
    count.textContent = ` · ${p.songCount || 0} 首`;
    meta.appendChild(name);
    meta.appendChild(count);

    const actions = document.createElement('div');
    actions.className = 'playlist-actions';
    const poolBtn = document.createElement('button');
    poolBtn.type = 'button';
    poolBtn.className = 'btn ghost';
    poolBtn.textContent = '设为候选池';
    poolBtn.addEventListener('click', () => setPool(playlists[idx]));
    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'btn primary';
    playBtn.textContent = '整单播放';
    playBtn.addEventListener('click', () => playPlaylist(playlists[idx]));
    actions.appendChild(poolBtn);
    actions.appendChild(playBtn);

    li.appendChild(meta);
    li.appendChild(actions);
    listEl.appendChild(li);
  });
}

async function load(force = false) {
  if (loading) return;
  if (loaded && !force) return;
  loading = true;
  refreshBtn.disabled = true;
  listEl.innerHTML = '<li class="muted">加载中…</li>';
  try {
    const [listRes, poolRes] = await Promise.all([
      fetch('/api/kugou/playlists'),
      fetch('/api/kugou/playlists/pool'),
    ]);
    const listData = await listRes.json();
    if (!listData.ok) throw new Error(listData.error || `HTTP ${listRes.status}`);
    const poolData = await poolRes.json();
    playlists = Array.isArray(listData.playlists) ? listData.playlists : [];
    renderPool(poolData.pool);
    renderList(playlists);
    loaded = true;
  } catch (err) {
    listEl.innerHTML = '';
    showAlert(`读取歌单失败：${err.message}`);
  } finally {
    refreshBtn.disabled = false;
    loading = false;
  }
}

export function initPlaylists() {
  listEl = document.getElementById('playlist-list');
  poolStatusEl = document.getElementById('pool-status');
  poolClearBtn = document.getElementById('pool-clear');
  refreshBtn = document.getElementById('playlists-refresh');

  refreshBtn.addEventListener('click', () => load(true));
  poolClearBtn.addEventListener('click', clearPool);

  window.addEventListener('claudio:view-shown', e => {
    if (e.detail === 'playlists') load();
  });
}
