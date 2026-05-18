const $ = sel => document.querySelector(sel);
const chat = $('#chat');
const composer = $('#composer');
const input = $('#input');
const submitBtn = composer.querySelector('button');
const audio = $('#audio');
const npBox = $('#now-playing');
const npTitle = $('#np-title');
const npArtist = $('#np-artist');
const alertBar = $('#alert-bar');
const statusEl = $('#status');

const state = {
  queue: [],
  index: 0,
};

// ──────────────── UI helpers ────────────────
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

function showAlert(msg) {
  alertBar.textContent = msg;
  alertBar.classList.remove('hidden');
}
function clearAlert() {
  alertBar.classList.add('hidden');
}

function setStatus(text) {
  statusEl.textContent = text;
}

// ──────────────── Player ────────────────
function playIndex(i) {
  if (i < 0 || i >= state.queue.length) {
    npBox.classList.add('hidden');
    audio.removeAttribute('src');
    return;
  }
  state.index = i;
  const t = state.queue[i];
  npTitle.textContent = t.title;
  npArtist.textContent = t.artist;
  audio.src = t.audioUrl;
  audio.play().catch(err => {
    console.warn('autoplay blocked:', err.message);
  });
  npBox.classList.remove('hidden');
}

audio.addEventListener('ended', () => {
  fetch('/api/runtime/advance', { method: 'POST' }).catch(() => {});
  if (state.index < state.queue.length - 1) {
    playIndex(state.index + 1);
  } else {
    npBox.classList.add('hidden');
  }
});

$('#btn-prev').addEventListener('click', () => {
  if (state.index > 0) playIndex(state.index - 1);
});
$('#btn-next').addEventListener('click', () => {
  if (state.index < state.queue.length - 1) playIndex(state.index + 1);
});
$('#btn-pp').addEventListener('click', () => {
  if (audio.paused) audio.play(); else audio.pause();
});

// ──────────────── Chat ────────────────
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

composer.addEventListener('submit', e => {
  e.preventDefault();
  const m = input.value.trim();
  if (m) send(m);
});

// ──────────────── Boot ────────────────
async function boot() {
  try {
    const r = await fetch('/api/now');
    if (r.ok) {
      const data = await r.json();
      if (data.queue && data.queue.length) {
        state.queue = data.queue;
        state.index = data.index || 0;
        // 不自动恢复播放（浏览器策略不允许 cold-load autoplay），但展示当前曲信息
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
    }
  } catch (err) {
    showAlert(`无法连接服务：${err.message}`);
  }

  // WS 连接（MVP 阶段只用来订阅 state 推送）
  try {
    const ws = new WebSocket(`ws://${location.host}/stream`);
    ws.addEventListener('message', ev => {
      try {
        const evt = JSON.parse(ev.data);
        if (evt.type === 'state' && evt.runtime) {
          // 服务端发了新 runtime；仅当 PWA 没在本地超前播放时同步
          if (state.queue.length === 0 && evt.runtime.queue && evt.runtime.queue.length) {
            state.queue = evt.runtime.queue;
            state.index = evt.runtime.index || 0;
          }
        }
      } catch { /* ignore */ }
    });
    ws.addEventListener('close', () => setStatus('● 离线'));
    ws.addEventListener('open', () => setStatus('● 在线'));
  } catch { /* MVP: WS 不可用不挡主流程 */ }

  // 注册 service worker（壳层缓存）
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* 静默 */ });
  }
}

boot();
