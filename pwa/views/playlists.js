// Playlists 视图 · 酷狗账号歌单 → 设候选池 / 整单播放。
// 候选池交给服务端持久化（prefs），Claudio 推荐时优先从池里选歌。
import { showAlert, toast } from './ui.js';

let listEl, poolStatusEl, poolClearBtn, refreshBtn;
let searchForm, searchInput, searchResults, searchStatus;
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

function formatDuration(ms) {
  const total = Math.round(Number(ms) / 1000);
  if (!Number.isFinite(total) || total <= 0) return '';
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

async function playTrack(track, mode) {
  try {
    const r = await fetch('/api/kugou/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        track: {
          hash: track.hash,
          title: track.title,
          artist: track.artist,
          album: track.album,
          duration: track.duration,
          cover: track.cover,
        },
        mode,
      }),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || `HTTP ${r.status}`);
    if (mode === 'append') {
      toast(`已加入队列：${track.title}`);
      return;
    }
    toast(`开始播放：${track.title}`);
    window.dispatchEvent(new CustomEvent('claudio:queue-replace', { detail: data.queue }));
    window.dispatchEvent(new CustomEvent('claudio:navigate', { detail: 'player' }));
  } catch (err) {
    showAlert(`播放失败：${err.message}`);
  }
}

function renderSearchResults(tracks) {
  searchResults.textContent = '';
  if (!tracks.length) {
    searchStatus.textContent = '没有找到';
    return;
  }
  searchStatus.textContent = `找到 ${tracks.length} 首`;
  tracks.forEach(track => {
    const li = document.createElement('li');
    li.className = 'search-result';

    const meta = document.createElement('div');
    meta.className = 'search-meta';
    const title = document.createElement('span');
    title.className = 'search-title';
    title.textContent = track.title;
    const artist = document.createElement('span');
    artist.className = 'muted';
    artist.textContent = track.artist || '';
    const album = document.createElement('span');
    album.className = 'muted';
    album.textContent = track.album ? ` · ${track.album}` : '';
    const duration = document.createElement('span');
    duration.className = 'muted';
    const time = formatDuration(track.duration);
    duration.textContent = time ? ` · ${time}` : '';
    meta.appendChild(title);
    meta.appendChild(artist);
    meta.appendChild(album);
    meta.appendChild(duration);

    const actions = document.createElement('div');
    actions.className = 'search-actions';
    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'btn primary';
    playBtn.textContent = '播放';
    playBtn.addEventListener('click', () => playTrack(track, 'replace'));
    const queueBtn = document.createElement('button');
    queueBtn.type = 'button';
    queueBtn.className = 'btn ghost';
    queueBtn.textContent = '加入队列';
    queueBtn.addEventListener('click', () => playTrack(track, 'append'));
    actions.appendChild(playBtn);
    actions.appendChild(queueBtn);

    li.appendChild(meta);
    li.appendChild(actions);
    searchResults.appendChild(li);
  });
}

async function searchTracks(query) {
  const q = String(query || '').trim();
  if (!q) {
    searchResults.textContent = '';
    searchStatus.textContent = '';
    return;
  }
  searchStatus.textContent = '搜索中…';
  searchResults.textContent = '';
  try {
    const r = await fetch(`/api/kugou/search?q=${encodeURIComponent(q)}`);
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || `HTTP ${r.status}`);
    renderSearchResults(Array.isArray(data.tracks) ? data.tracks : []);
  } catch (err) {
    searchStatus.textContent = '';
    showAlert(`搜索失败：${err.message}`);
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
  searchForm = document.getElementById('search-form');
  searchInput = document.getElementById('search-input');
  searchResults = document.getElementById('search-results');
  searchStatus = document.getElementById('search-status');

  refreshBtn.addEventListener('click', () => load(true));
  poolClearBtn.addEventListener('click', clearPool);
  if (searchForm) {
    searchForm.addEventListener('submit', e => {
      e.preventDefault();
      searchTracks(searchInput.value);
    });
  }

  window.addEventListener('claudio:view-shown', e => {
    if (e.detail === 'playlists') load();
  });
}
