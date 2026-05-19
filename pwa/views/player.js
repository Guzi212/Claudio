// Player 视图 · 保留原 chat + audio player 全部逻辑。
// 入口：initPlayer() — 在 DOM 就绪后调用一次。
// 对外：applyRuntime(runtime) — 让 app.js 把 WS 推来的 runtime 同步进来。
import { showAlert, clearAlert, setStatus } from './ui.js';

const $ = sel => document.querySelector(sel);

const state = {
  queue: [],
  index: 0,
};

let chat, composer, input, submitBtn, audio, npBox, npTitle, npArtist;

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

function playIndex(i, { autoplay = true } = {}) {
  if (i < 0 || i >= state.queue.length) {
    npBox.classList.add('hidden');
    audio.removeAttribute('src');
    window.dispatchEvent(new CustomEvent('claudio:trackchange', { detail: null }));
    return;
  }
  state.index = i;
  const t = state.queue[i];
  npTitle.textContent = t.title;
  npArtist.textContent = t.artist;
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
      const list = data.queue.map(q => `<li>${q.title} — ${q.artist}</li>`).join('');
      metaHtml += `<ol>${list}</ol>`;
    }
    if (data.reason) metaHtml += `<div>${data.reason}</div>`;

    addBubble('assistant', data.say || '(无回应)', metaHtml || null);

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

  $('#btn-prev').addEventListener('click', () => {
    if (state.index > 0) playIndex(state.index - 1);
  });
  $('#btn-next').addEventListener('click', () => {
    if (state.index < state.queue.length - 1) playIndex(state.index + 1);
  });
  const btnPp = $('#btn-pp');
  btnPp.addEventListener('click', () => {
    if (audio.paused) audio.play().catch(err => showAlert(`播放失败：${err.message}`));
    else audio.pause();
  });
  audio.addEventListener('play',  () => { btnPp.textContent = '⏸'; btnPp.title = '暂停'; clearAlert(); });
  audio.addEventListener('pause', () => { btnPp.textContent = '▶'; btnPp.title = '播放'; });

  composer.addEventListener('submit', e => {
    e.preventDefault();
    const m = input.value.trim();
    if (m) send(m);
  });

  // 启动时拉一下当前队列 / 上次会话
  bootCurrent();
}

async function bootCurrent() {
  try {
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
        audio.src = t.audioUrl;
        npBox.classList.remove('hidden');
      }
    }
    if (data.lastSay) {
      addBubble('assistant', data.lastSay, '(上次会话)');
    }
  } catch (err) {
    showAlert(`无法连接服务：${err.message}`);
  }
}
