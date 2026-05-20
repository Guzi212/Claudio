// Player 视图 · 保留原 chat + audio player 全部逻辑。
// 入口：initPlayer() — 在 DOM 就绪后调用一次。
// 对外：applyRuntime(runtime) — 让 app.js 把 WS 推来的 runtime 同步进来。
import { showAlert, clearAlert, setStatus } from './ui.js';

const $ = sel => document.querySelector(sel);

const state = {
  queue: [],
  index: 0,
};

let chat, composer, input, submitBtn, audio, npBox, npTitle, npArtist, consolePlayBtn, consoleFavoriteBtn;
const STUDIO_THEME_KEY = 'claudio:studio-theme';
const STUDIO_THEMES = new Set(['dark', 'poetry', 'focus']);

// autoplay 在浏览器策略下需要"用户已交互过页面"才生效
let userActivated = false;
function markActivated() { userActivated = true; }

// 把服务端的真实位置推回前端的镜像状态（避免 server / client 两边索引漂移）
function syncToServer(index, { paused = false } = {}) {
  fetch('/api/runtime/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index, paused }),
  }).catch(() => {});
}

function addBubble(role, content, meta = null) {
  const div = document.createElement('div');
  div.className = `bubble ${role}`;
  div.textContent = content;
  if (meta) {
    const m = document.createElement('div');
    m.className = 'meta';
    m.innerHTML = meta;
    div.appendChild(m);
  }
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

function setConsoleDialog(text) {
  const el = document.getElementById('console-dialog-text');
  if (!el || !text) return;
  el.textContent = text.length > 72 ? `${text.slice(0, 70)}…` : text;
}

function setStudioTrack(track) {
  const title = document.getElementById('studio-track-title');
  const artist = document.getElementById('studio-track-artist');
  if (!title || !artist || !track) return;
  title.textContent = track.title || 'Claudio Radio';
  artist.textContent = track.artist || 'Claude DJ · 私人电台';
}

function normalizeStudioTheme(theme) {
  const value = String(theme || '').trim().toLowerCase();
  return STUDIO_THEMES.has(value) ? value : 'focus';
}

function savedStudioTheme() {
  try {
    return localStorage.getItem(STUDIO_THEME_KEY);
  } catch {
    return null;
  }
}

function setStudioTheme(theme, { persist = true } = {}) {
  const next = normalizeStudioTheme(theme);
  const stage = document.querySelector('.studio-stage');
  if (stage) stage.dataset.theme = next;

  document.querySelectorAll('[data-studio-theme]').forEach(btn => {
    const active = btn.dataset.studioTheme === next;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });

  if (persist) {
    try {
      localStorage.setItem(STUDIO_THEME_KEY, next);
    } catch {
      // 浏览器禁用存储时，主题仍在当前页面生效。
    }
  }
}

function bindStudioThemes() {
  document.querySelectorAll('[data-studio-theme]').forEach(btn => {
    btn.addEventListener('click', () => {
      setStudioTheme(btn.dataset.studioTheme);
    });
  });
}

function currentTrack() {
  return state.queue[state.index] || null;
}

function resetFavoriteState() {
  if (!consoleFavoriteBtn) return;
  consoleFavoriteBtn.setAttribute('aria-pressed', 'false');
  consoleFavoriteBtn.classList.remove('active');
}

function updatePlayButtons(isPlaying) {
  const label = isPlaying ? '暂停' : '播放';
  const mark = isPlaying ? 'Ⅱ' : '▷';
  if (consolePlayBtn) {
    consolePlayBtn.textContent = mark;
    consolePlayBtn.setAttribute('aria-label', label);
  }
}

function applyStudioState(studio) {
  if (!studio) return;
  setStudioTheme(savedStudioTheme() || studio.activeMode, { persist: false });
  if (studio.displayTrack) setStudioTrack(studio.displayTrack);
  if (studio.dialog) setConsoleDialog(studio.dialog);

  const clock = document.getElementById('studio-clock');
  const weekday = document.getElementById('studio-weekday');
  const date = document.getElementById('studio-date');
  if (studio.clock) {
    if (clock) clock.textContent = studio.clock.hhmm || clock.textContent;
    if (weekday) weekday.textContent = studio.clock.weekday || weekday.textContent;
    if (date) date.textContent = studio.clock.date || date.textContent;
  }

  const onAir = document.querySelector('.on-air');
  if (onAir) {
    onAir.textContent = studio.onAir ? '● ON AIR' : 'Ⅱ PAUSED';
    onAir.classList.toggle('paused', !studio.onAir);
  }
}

function playIndex(i, { autoplay = true } = {}) {
  if (i < 0 || i >= state.queue.length) {
    npBox.classList.add('hidden');
    audio.removeAttribute('src');
    window.dispatchEvent(new CustomEvent('claudio:trackchange', { detail: null }));
    return;
  }
  state.index = i;
  const t = state.queue[i];
  resetFavoriteState();
  if (t.isTts) {
    // TTS 播报：不覆盖 NOW TUNING 大字和 AI RADIO 文案，它们已显示 say 文本
    npTitle.textContent = 'Claudio';
    npArtist.textContent = '语音播报';
  } else {
    npTitle.textContent = t.title;
    npArtist.textContent = t.artist;
    setStudioTrack(t);
    setConsoleDialog(`接下来播放 ${t.title} — ${t.artist}。`);
  }
  audio.src = t.audioUrl;
  // 通知 components/lyrics.js 当前是哪首（它通过 #lyrics-panel 自动 attach）
  window.dispatchEvent(new CustomEvent('claudio:trackchange', { detail: t }));
  if (autoplay && userActivated) {
    audio.play().catch(err => {
      console.warn('audio.play failed:', err.message);
      showAlert('浏览器拦了自动播放，点一下页面上的 ▶ 按钮');
    });
  }
  npBox.classList.remove('hidden');
  syncToServer(state.index);
}

function goPrev() {
  if (state.index > 0) {
    playIndex(state.index - 1);
    return;
  }
  showAlert('已经是第一首');
}

function goNext() {
  if (state.index < state.queue.length - 1) {
    playIndex(state.index + 1);
    return;
  }
  showAlert(state.queue.length ? '已经是最后一首' : '队列还是空的');
}

function togglePlayback() {
  if (!audio.src && state.queue.length) {
    playIndex(state.index || 0, { autoplay: false });
  }
  if (!audio.src) {
    showAlert('还没有可播放队列');
    return;
  }
  if (audio.paused) audio.play().catch(err => showAlert(`播放失败：${err.message}`));
  else audio.pause();
}

function toggleFavorite() {
  if (!consoleFavoriteBtn) return;
  const pressed = consoleFavoriteBtn.getAttribute('aria-pressed') === 'true';
  const next = !pressed;
  const track = currentTrack();
  consoleFavoriteBtn.setAttribute('aria-pressed', String(next));
  consoleFavoriteBtn.classList.toggle('active', next);
  showAlert(next
    ? `已收藏：${track?.title || '当前电台氛围'}`
    : `已取消收藏：${track?.title || '当前电台氛围'}`);
}

function showQueue() {
  const message = state.queue.length
    ? '当前队列：\n' + state.queue.map((q, i) => `${i === state.index ? '▶' : '  '} ${q.title} — ${q.artist}`).join('\n')
    : '当前队列还是空的。';
  addBubble('assistant', message);
  setConsoleDialog(state.queue.length ? '队列已展开在下方对话里。' : message);
}

function bindConsoleControls() {
  const controls = document.querySelectorAll('[data-console-control]');
  controls.forEach(btn => {
    btn.addEventListener('click', () => {
      markActivated();
      const action = btn.dataset.consoleControl;
      if (action === 'prev') goPrev();
      if (action === 'play-pause') togglePlayback();
      if (action === 'next') goNext();
      if (action === 'favorite') toggleFavorite();
      if (action === 'queue') showQueue();
    });
  });
}

async function send(message) {
  addBubble('user', message);
  input.value = '';
  submitBtn.disabled = true;
  setStatus('思考中…');

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    let metaHtml = '';
    if (data.queue && data.queue.length) {
      const songItems = data.queue.filter(q => !q.isTts);
      if (songItems.length) {
        const list = songItems.map(q => `<li>${q.title} — ${q.artist}</li>`).join('');
        metaHtml += `<ol>${list}</ol>`;
      }
    }
    if (data.reason) metaHtml += `<div>${data.reason}</div>`;

    addBubble('assistant', data.say || '(无回应)', metaHtml || null);
    setConsoleDialog(data.say || '我已经整理好这一轮电台推荐。');

    if (data.queue && data.queue.length) {
      state.queue = data.queue;
      state.index = 0;
      playIndex(0);
    }
    clearAlert();
  } catch (err) {
    addBubble('assistant', `(出错：${err.message})`);
    showAlert(`服务异常：${err.message}`);
  } finally {
    submitBtn.disabled = false;
    setStatus('');
    input.focus();
  }
}

// 服务端 WS 推 runtime 时同步进本地状态（仅当本地没有超前播放）
export function applyRuntime(runtime) {
  if (!runtime || !runtime.queue) return;
  if (state.queue.length === 0 && runtime.queue.length) {
    state.queue = runtime.queue;
    state.index = runtime.index || 0;
  }
}

export function initPlayer() {
  chat      = $('#chat');
  composer  = $('#composer');
  input     = $('#input');
  submitBtn = composer.querySelector('button');
  audio     = $('#audio');
  npBox     = $('#now-playing');
  npTitle   = $('#np-title');
  npArtist  = $('#np-artist');

  document.addEventListener('click', markActivated, { capture: true, once: true });
  document.addEventListener('keydown', markActivated, { capture: true, once: true });

  audio.addEventListener('ended', () => {
    if (state.index < state.queue.length - 1) {
      playIndex(state.index + 1);
    } else {
      npBox.classList.add('hidden');
      syncToServer(state.index, { paused: true });
    }
  });

  audio.addEventListener('play',  () => syncToServer(state.index, { paused: false }));
  audio.addEventListener('pause', () => syncToServer(state.index, { paused: true }));

  consolePlayBtn = $('[data-console-control="play-pause"]');
  consoleFavoriteBtn = $('[data-console-control="favorite"]');
  bindConsoleControls();
  bindStudioThemes();
  setStudioTheme(savedStudioTheme() || 'focus', { persist: false });
  audio.addEventListener('play',  () => { updatePlayButtons(true); clearAlert(); });
  audio.addEventListener('pause', () => { updatePlayButtons(false); });
  updatePlayButtons(false);

  composer.addEventListener('submit', e => {
    e.preventDefault();
    const m = input.value.trim();
    if (m) send(m);
  });

  // 启动时拉一下当前队列 / 上次会话
  bootCurrent();
}

async function bootCurrent() {
  if (location.protocol === 'file:') return;

  try {
    try {
      const studioRes = await fetch('/api/studio/state');
      if (studioRes.ok) {
        const data = await studioRes.json();
        applyStudioState(data.studio);
      }
    } catch {
      // 视觉接口不可用时继续走旧的播放状态接口。
    }

    const r = await fetch('/api/now');
    if (!r.ok) return;
    const data = await r.json();
    if (data.queue && data.queue.length) {
      state.queue = data.queue;
      state.index = data.index || 0;
      // cold-load 不自动播放，但展示当前曲信息
      const t = state.queue[state.index];
      if (t) {
        npTitle.textContent = t.title;
        npArtist.textContent = t.artist;
        setStudioTrack(t);
        setConsoleDialog(`回到电台：${t.title} — ${t.artist}。`);
        audio.src = t.audioUrl;
        npBox.classList.remove('hidden');
      }
    }
    if (data.lastSay) {
      addBubble('assistant', data.lastSay, '(上次会话)');
      setConsoleDialog(data.lastSay);
    }
  } catch (err) {
    showAlert(`无法连接服务：${err.message}`);
  }
}
