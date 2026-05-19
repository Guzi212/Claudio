// 歌词面板 · LRC 解析 + 当前行高亮滚动
//
// 用法（W2 接入）：
//   import { init } from '/components/lyrics.js';
//   init({ audio, container, getCurrentTrack });
//
// 兜底：如果 W2 没有显式调 init，DOMContentLoaded 时会自动找
// #lyrics-panel + #audio 并监听 window 上的 'claudio:trackchange' 事件。

const META_TAGS = new Set(['ti', 'ar', 'al', 'by', 'offset', 're', 've', 'au', 'la']);

export function parseLRC(text) {
  if (typeof text !== 'string' || !text) return [];

  const TS_RE = /\[(\d{1,3}):(\d{1,2})(?:\.(\d{1,3}))?\]/g;
  const META_RE = /^\[([a-zA-Z]+):[^\]]*\]\s*$/;

  const out = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const metaMatch = META_RE.exec(line);
    if (metaMatch && META_TAGS.has(metaMatch[1].toLowerCase())) continue;

    const timestamps = [];
    let lastEnd = 0;
    let m;
    TS_RE.lastIndex = 0;
    while ((m = TS_RE.exec(line)) !== null) {
      if (m.index !== lastEnd) break;
      const mm = parseInt(m[1], 10);
      const ss = parseInt(m[2], 10);
      const frac = m[3] ? parseInt(m[3], 10) / Math.pow(10, m[3].length) : 0;
      timestamps.push(mm * 60 + ss + frac);
      lastEnd = TS_RE.lastIndex;
    }

    if (timestamps.length === 0) continue;

    const lyricText = line.slice(lastEnd).trim();
    for (const t of timestamps) out.push({ time: t, text: lyricText });
  }

  out.sort((a, b) => a.time - b.time);
  return out;
}

let initialized = false;

export function init({ audio, container, getCurrentTrack } = {}) {
  if (!audio || !container) return null;
  initialized = true;

  let lines = [];
  let activeIdx = -1;
  let currentHash = null;
  let lastUpdateAt = 0;

  function setHidden(hidden) {
    container.classList.toggle('hidden', !!hidden);
  }

  function clearLyrics() {
    lines = [];
    activeIdx = -1;
    container.innerHTML = '';
    setHidden(true);
  }

  async function loadLyric(track) {
    if (!track || track.isTts) {
      currentHash = null;
      clearLyrics();
      return;
    }
    const hash = track.kugouId;
    if (!hash) {
      currentHash = null;
      clearLyrics();
      return;
    }
    if (hash === currentHash) return;
    currentHash = hash;

    let lrcText = '';
    try {
      const res = await fetch(`/api/lyric?hash=${encodeURIComponent(hash)}`);
      if (res.ok) {
        const data = await res.json();
        lrcText = data?.lyric || '';
      }
    } catch {
      lrcText = '';
    }

    // 防止竞态：fetch 期间又切歌了
    if (hash !== currentHash) return;

    lines = parseLRC(lrcText);
    renderLines();
  }

  function renderLines() {
    container.innerHTML = '';
    if (!lines.length) {
      setHidden(true);
      return;
    }
    setHidden(false);
    const frag = document.createDocumentFragment();
    for (let i = 0; i < lines.length; i++) {
      const div = document.createElement('div');
      div.className = 'lyric-line';
      div.dataset.idx = String(i);
      div.textContent = lines[i].text || ' ';
      frag.appendChild(div);
    }
    container.appendChild(frag);
    activeIdx = -1;
  }

  function updateHighlight() {
    if (!lines.length) return;
    const now = audio.currentTime || 0;

    // 线性查找：歌词行数通常 < 200，简单且 cache-friendly
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].time <= now) idx = i;
      else break;
    }

    if (idx === activeIdx) return;
    const els = container.querySelectorAll('.lyric-line');
    if (activeIdx >= 0 && els[activeIdx]) els[activeIdx].classList.remove('active');
    activeIdx = idx;
    if (idx >= 0 && els[idx]) {
      els[idx].classList.add('active');
      els[idx].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  audio.addEventListener('loadedmetadata', () => {
    const track = typeof getCurrentTrack === 'function' ? getCurrentTrack() : null;
    loadLyric(track);
  });

  audio.addEventListener('timeupdate', () => {
    const t = Date.now();
    if (t - lastUpdateAt < 250) return;
    lastUpdateAt = t;
    updateHighlight();
  });

  audio.addEventListener('emptied', () => {
    currentHash = null;
    clearLyrics();
  });

  return { loadLyric, refresh: renderLines };
}

// ──── 兜底：DOMContentLoaded 自动 attach（W2 没显式接入时生效）────
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const tryAuto = () => {
    if (initialized) return;
    const registry = window.__claudioInit;
    if (registry && registry.lyrics) return;

    const panel = document.getElementById('lyrics-panel');
    const audioEl = document.getElementById('audio');
    if (!panel || !audioEl) return;

    let currentTrack = null;
    window.addEventListener('claudio:trackchange', (ev) => {
      currentTrack = ev.detail || null;
    });
    init({
      audio: audioEl,
      container: panel,
      getCurrentTrack: () => currentTrack,
    });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryAuto);
  } else {
    tryAuto();
  }
}
