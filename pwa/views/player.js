// Player 视图 · 保留原 chat + audio player 全部逻辑。
// 入口：initPlayer() — 在 DOM 就绪后调用一次。
// 对外：applyRuntime(runtime) — 让 app.js 把 WS 推来的 runtime 同步进来。
import { showAlert, clearAlert, setStatus, toast } from './ui.js';
import { planExternalPlayback } from '../external-playback.js';
import { planBootPlayback } from '../boot-playback.js';
import { claimPlayLoad, isOwnEcho, planRuntimeSync } from '../runtime-sync.js';
import { externalUnlockPlan, planExternalBoot, planPlayCommand, planPlayError } from '../player-mode.js';
import { readLocalVolume, writeLocalVolume } from '../volume-memory.js';
import { getClientId } from '../client-id.js';

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const $ = sel => document.querySelector(sel);

const LOOP_MODES = ['list', 'one', 'auto'];
const LOOP_MODE_META = {
  list: { mark: '列表循环', label: '列表循环' },
  one: { mark: '单曲循环', label: '单曲循环' },
  auto: { mark: '自动推歌', label: '自动推歌' },
};
const NEXT_BATCH_PROMPT = '上一批歌已经播完了，请根据当前时间和氛围继续推荐下一批';

const state = {
  queue: [],
  index: 0,
  offset: 0,
  loopMode: 'auto',
  brain: 'external',
  continuePoolActive: false,
};

let autoRecommending = false;
let pendingPlayFrom = -1;
let autoRecommendGen = 0;

let bootOverlay = null;
let bootBtn = null;
let bootReady = false;
let bootData = null;
let bootClicked = false;
let brain = 'external';
let appliedSay = '';
let lastReason = '';
let queuedAt = '';
let lastProgressAt = 0;
let queueVisible = true;
const feedbackByTrack = new Map();

let chat, composer, input, submitBtn, audio, npBox, npTitle, npArtist, consolePlayBtn, consoleFavoriteBtn, queueBtn, loopBtn, queueList, npSeek, npTimeCur, npTimeDur, npVol;
const STUDIO_THEME_KEY = 'claudio:studio-theme';
const STUDIO_THEMES = new Set(['dark', 'poetry', 'focus']);

function fmtTime(s) {
  if (!isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = String(Math.floor(s % 60)).padStart(2, '0');
  return `${m}:${sec}`;
}

function updateSeekBar(cur, dur) {
  const pct = dur > 0 ? (cur / dur) * 100 : 0;
  if (npSeek) {
    const fill = `${pct.toFixed(2)}%`;
    npSeek.style.setProperty('--seek-pct', fill);
    npSeek.style.setProperty('--fill', fill);
    npSeek.value = pct;
  }
  if (npTimeCur) npTimeCur.textContent = fmtTime(cur);
  if (npTimeDur) npTimeDur.textContent = fmtTime(dur);
}

// 成功出过一次声之后就是 true。遮罩只在 play() 返回 NotAllowedError 时才盖上。
let userActivated = false;
let serverProgress = 0;
let playLoadIndex = null;
let suppressPauseSync = false;
function markActivated() { userActivated = true; }

function ensurePlaybackVolume() {
  if (!audio) return;
  const slider = npVol ? Number(npVol.value) : NaN;
  const volume = Number.isFinite(slider) ? slider : readLocalVolume();
  const clamped = Math.max(0, Math.min(100, Math.round(volume)));
  audio.volume = clamped / 100;
  syncVolumeChrome(clamped);
}

function showUnlockOverlay() {
  if (!bootOverlay || !bootBtn || brain === 'internal') return;
  bootBtn.textContent = '▶ 点击开声';
  bootOverlay.classList.remove('hidden');
}

async function attemptPlay() {
  if (!audio) return false;
  ensurePlaybackVolume();
  try {
    await audio.play();
    const outcome = planPlayError(null);
    if (outcome.userActivated) markActivated();
    if (!outcome.showOverlay) dismissBootOverlay();
    return true;
  } catch (err) {
    const outcome = planPlayError(err);
    if (outcome.showOverlay) showUnlockOverlay();
    else {
      console.warn('audio.play failed:', err?.message);
      showAlert(`播放失败：${err?.message || '未知错误'}`);
    }
    return false;
  }
}

function applyBrainChrome() {
  document.body?.classList.toggle('brain-internal', brain === 'internal');
  const consoleChat = document.getElementById('console-chat');
  if (consoleChat) consoleChat.hidden = brain !== 'internal';
  document.querySelectorAll('[data-internal-only]').forEach(btn => { btn.hidden = brain !== 'internal'; });
  const label = document.querySelector('.poem-panel > span');
  if (label) label.textContent = brain === 'internal' ? 'AI RADIO' : '串场';
  if (brain !== 'internal' && bootBtn && bootOverlay && !bootOverlay.classList.contains('hidden')) {
    bootBtn.textContent = '▶ 点击开声';
  }
}

function syncVolumeChrome(volume) {
  if (npVol) {
    npVol.value = String(volume);
    npVol.style.setProperty('--vol-pct', `${volume}%`);
    npVol.style.setProperty('--fill', `${volume}%`);
  }
  const out = document.getElementById('np-vol-out');
  if (out) out.textContent = String(volume);
}

function paintVolume(volume) {
  if (!npVol || !audio || !Number.isFinite(volume)) return;
  audio.volume = volume / 100;
  syncVolumeChrome(volume);
}

function applyLocalVolume() {
  paintVolume(readLocalVolume());
}

function applyHeardVolume(volume) {
  const next = writeLocalVolume(volume);
  if (next == null) return;
  paintVolume(next);
}

function reportProgress(force = false) {
  if (!audio) return;
  const now = Date.now();
  if (!force && now - lastProgressAt < 2000) return;
  lastProgressAt = now;
  window.dispatchEvent(new CustomEvent('claudio:progress', {
    detail: {
      currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
      duration: Number.isFinite(audio.duration) ? audio.duration : 0,
      volume: npVol ? Number(npVol.value) : readLocalVolume(),
      paused: Boolean(audio.paused),
      index: state.index,
      queueOffset: state.offset,
      clientId: getClientId(),
    },
  }));
}

// 把服务端的真实位置推回前端的镜像状态（避免 server / client 两边索引漂移）。
// clientId 会跟着广播回来；这份页面看到自己的 origin 就不再改播放。
function syncToServer(index, { paused = false, ended = false } = {}) {
  return fetch('/api/runtime/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index, queueOffset: state.offset, paused, ended, clientId: getClientId() }),
  }).then(res => res.ok ? res.json() : null).catch(() => null);
}

function addBubble(role, content, meta = null) {
  if (!chat) return null;
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
  // 主持人口播只认 lastSay。接下来播放 / 回到电台 这类切歌提示不写进 #host-line。
  const el = document.getElementById('console-dialog-text');
  if (!el || !text) return;
  el.textContent = text.length > 72 ? `${text.slice(0, 70)}…` : text;
}

function editionLabelFor(date = new Date()) {
  const hour = date.getHours();
  if (hour >= 5 && hour < 11) return '清晨场';
  if (hour >= 11 && hour < 14) return '午间场';
  if (hour >= 14 && hour < 17) return '下午场';
  if (hour >= 17 && hour < 21) return '傍晚场';
  return '深夜场';
}

// Ink palette follows the same hour bands as the edition label.
function daypartFor(date = new Date()) {
  const hour = date.getHours();
  if (hour >= 5 && hour < 11) return 'dawn';
  if (hour >= 11 && hour < 14) return 'noon';
  if (hour >= 14 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'dusk';
  return 'night';
}

function paintEdition() {
  const now = new Date();
  const el = document.getElementById('edition-label');
  if (el) el.textContent = editionLabelFor(now);
  const daypart = daypartFor(now);
  const root = document.documentElement;
  if (root.dataset.daypart !== daypart) root.dataset.daypart = daypart;
  const symbol = document.getElementById('edition-symbol');
  if (symbol) symbol.setAttribute('href', daypart === 'night' ? '#moon' : '#sun');
}

let inkedTrackKey = '';
// One-shot fade on track change; Web Animations keeps it on the compositor without forcing a reflow.
function inkInTrack(track) {
  const key = `${track?.title || ''}\0${track?.artist || ''}`;
  if (key === inkedTrackKey) return;
  const first = inkedTrackKey === '';
  inkedTrackKey = key;
  if (first || typeof Element.prototype.animate !== 'function') return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const timing = { duration: 300, easing: 'cubic-bezier(.2, .7, .2, 1)' };
  document.getElementById('np-cover')?.animate(
    [{ opacity: 0.35, transform: 'scale(1.015)' }, { opacity: 1, transform: 'none' }], timing);
  document.querySelector('#now-playing .track-info')?.animate(
    [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], timing);
}

function rememberQueueMeta(data) {
  if (!data || typeof data !== 'object') return;
  if ('continuePool' in data) {
    const pool = data.continuePool;
    state.continuePoolActive = Boolean(pool && (pool.active ?? (pool.loop || pool.cursor < pool.tracks?.length)));
  }
  if ('queuedAt' in data) queuedAt = data.queuedAt || '';
  const reason = data.lastReason ?? data.reason;
  if (typeof reason === 'string') lastReason = reason;
}

function paintHostChrome() {
  const line = document.getElementById('host-line');
  const time = document.getElementById('host-time');
  if (line) {
    const text = String(appliedSay || '').trim();
    if (text) line.textContent = text;
    else if (!state.queue.length) line.textContent = '我在。让我挑一首适合现在的歌。';
    else line.textContent = '';
  }
  if (!time) return;
  if (queuedAt) {
    const when = new Date(queuedAt);
    if (!Number.isNaN(when.getTime())) {
      const hh = String(when.getHours()).padStart(2, '0');
      const mm = String(when.getMinutes()).padStart(2, '0');
      time.hidden = false;
      time.textContent = `· ${hh}:${mm} 点歌`;
      return;
    }
  }
  if (!state.queue.length) {
    time.hidden = false;
    time.textContent = '· 在线';
    return;
  }
  time.hidden = true;
  time.textContent = '';
}

function paintCover(track) {
  const img = document.getElementById('np-cover-img');
  const fallback = document.getElementById('np-cover-fallback');
  const title = document.getElementById('np-cover-title');
  const artist = document.getElementById('np-cover-artist');
  if (title) title.textContent = track?.title || '';
  if (artist) artist.textContent = track?.artist || '';
  if (!img) return;
  const cover = String(track?.cover || '').trim();
  if (!cover) {
    img.hidden = true;
    img.removeAttribute('src');
    if (fallback) fallback.hidden = false;
    return;
  }
  img.alt = track?.title || '';
  img.onerror = () => {
    img.hidden = true;
    if (fallback) fallback.hidden = false;
  };
  if (img.getAttribute('src') !== cover) img.src = cover;
  img.hidden = false;
  if (fallback) fallback.hidden = true;
}

function paintTrackReason(track) {
  const el = document.getElementById('track-reason');
  if (!el) return;
  const own = String(track?.reason || '').trim();
  const text = own || (track && track === currentTrack() ? String(lastReason || '').trim() : '');
  if (!text) {
    el.textContent = '';
    el.hidden = true;
    return;
  }
  el.textContent = text;
  el.hidden = false;
}

function trackFeedbackKey(track) {
  if (!track) return '';
  if (track.kugouId) return `id:${track.kugouId}`;
  return `t:${track.title || ''}\0${track.artist || ''}`;
}

function paintFeedback() {
  const value = feedbackByTrack.get(trackFeedbackKey(currentTrack())) || null;
  document.querySelectorAll('[data-feedback]').forEach(btn => {
    btn.setAttribute('aria-pressed', String(value === btn.dataset.feedback));
  });
}

function postFeedback(kind, track) {
  fetch('/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind,
      title: track?.title || '',
      artist: track?.artist || '',
      kugouId: track?.kugouId || '',
    }),
  }).catch(() => {});
}

function bindFeedback() {
  document.querySelectorAll('[data-feedback]').forEach(btn => {
    btn.addEventListener('click', () => {
      const track = currentTrack();
      const key = trackFeedbackKey(track);
      if (!key) return;
      const choice = btn.dataset.feedback === 'dislike' ? 'dislike' : 'like';
      const current = feedbackByTrack.get(key) || null;
      if (current === choice) {
        feedbackByTrack.delete(key);
        if (choice === 'like') postFeedback('unlike', track);
      } else {
        feedbackByTrack.set(key, choice);
        postFeedback(choice === 'dislike' ? 'unlike' : 'like', track);
      }
      paintFeedback();
    });
  });
}

function setStudioTrack(track) {
  if (!track) return;
  const meta = document.getElementById('studio-track-meta');
  const comment = document.getElementById('studio-track-comment');
  if (meta) {
    meta.textContent = (track.title && track.artist)
      ? `${track.title} · ${track.artist}`
      : (track.title || 'Now Tuning');
  }
  if (comment) {
    comment.textContent = track.comment || '';
  }
  if (npTitle) npTitle.textContent = track.title || '';
  if (npArtist) npArtist.textContent = track.artist || '';
  const info = document.querySelector('#now-playing .track-info');
  if (info) info.classList.toggle('long-title', String(track.title || '').length > 4);
  paintTrackReason(track);
  paintCover(track);
  inkInTrack(track);
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
  if (consoleFavoriteBtn) {
    consoleFavoriteBtn.setAttribute('aria-pressed', 'false');
    consoleFavoriteBtn.classList.remove('active');
  }
  paintFeedback();
}

function updatePlayButtons(isPlaying) {
  const label = isPlaying ? '暂停' : '播放';
  if (consolePlayBtn) {
    consolePlayBtn.setAttribute('aria-label', label);
    const symbol = document.getElementById('play-symbol');
    if (symbol) symbol.setAttribute('href', isPlaying ? '#pause' : '#play-icon');
  }
  const playingLabel = document.getElementById('playing-label');
  if (playingLabel) playingLabel.textContent = isPlaying ? '正在播放' : '已暂停';
  document.body?.classList.toggle('paused', state.queue.length > 0 && !isPlaying);
  document.body?.classList.toggle('is-playing', isPlaying);
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

async function preFetchBoot() {
  try {
    const res = await fetch('/api/boot', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bootData = await res.json();
    bootReady = true;
    if (bootClicked) startBoot();
  } catch (err) {
    console.warn('[boot] pre-fetch failed:', err.message);
    bootReady = true;
    bootData = null;
    if (bootClicked) {
      showAlert('推歌失败，请手动输入指令');
      dismissBootOverlay();
    } else if (bootBtn) {
      bootBtn.textContent = '▶ 开始电台';
      bootBtn.disabled = false;
    }
  }
}

function startBoot() {
  dismissBootOverlay();
  const data = bootData;
  if (!data) {
    setConsoleDialog('连接失败，请手动输入指令');
    return;
  }
  const songItems = (data.queue || []).filter(q => !q.isTts);
  let metaHtml = '';
  if (songItems.length) {
    const list = songItems.map(q => `<li>${escapeHtml(q.title)} — ${escapeHtml(q.artist)}</li>`).join('');
    metaHtml += `<ol>${list}</ol>`;
  }
  if (data.reason) metaHtml += `<div>${escapeHtml(data.reason)}</div>`;
  if (data.say) {
    setConsoleDialog(data.say);
    addBubble('assistant', data.say, metaHtml || null);
  }
  if (data._resolveError) {
    showAlert('酷狗搜索失败，请检查酷狗 API 服务是否正在运行');
  } else {
    clearAlert();
  }
  const plan = planBootPlayback({
    queue: state.queue,
    index: state.index,
    hasSrc: Boolean(audio?.getAttribute?.('src') || audio?.src),
    ended: Boolean(audio?.ended),
  }, data);
  if (plan.applyQueue) {
    state.queue = data.queue;
    state.index = plan.index;
    state.offset = data.queueOffset || 0;
  }
  if (plan.playIndex != null) playIndex(plan.playIndex);
}

function dismissBootOverlay() {
  if (bootOverlay) bootOverlay.classList.add('hidden');
}

async function autoRecommend(prompt) {
  if (state.continuePoolActive || autoRecommending) return;
  autoRecommending = true;
  const myGen = ++autoRecommendGen;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: prompt }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (myGen !== autoRecommendGen || state.continuePoolActive) return;
    const newSongs = (data.queue || []).filter(q => !q.isTts);
    if (newSongs.length) {
      state.queue = [...state.queue, ...newSongs];
      if (data.say) setConsoleDialog(data.say);
      renderQueuePanel();
      if (pendingPlayFrom >= 0 && pendingPlayFrom < state.queue.length) {
        const idx = pendingPlayFrom;
        pendingPlayFrom = -1;
        playIndex(idx);
      }
    } else if (pendingPlayFrom >= 0) {
      setConsoleDialog('这次没拿到可播放歌曲，请手动输入指令');
      pendingPlayFrom = -1;
    }
  } catch (err) {
    console.warn('[autoRecommend] failed:', err.message);
    if (pendingPlayFrom >= 0) setConsoleDialog('自动推荐失败，请手动输入指令');
    pendingPlayFrom = -1;
  } finally {
    autoRecommending = false;
  }
}

function requestNextBatch({ playWhenReady = false } = {}) {
  if (!state.queue.length) return;
  if (playWhenReady) pendingPlayFrom = state.queue.length;
  if (autoRecommending) {
    setConsoleDialog('正在准备下一批曲目…');
    return;
  }
  autoRecommend(NEXT_BATCH_PROMPT);
}

// 歌单队列只带 hash，播到这首时才向服务端换直链（避免大歌单一上来解析几百条）。
async function resolveTrackUrl(hash) {
  if (!hash) return null;
  try {
    const r = await fetch(`/api/kugou/track-url?hash=${encodeURIComponent(hash)}`);
    if (!r.ok) return null;
    const d = await r.json();
    return d?.url || null;
  } catch {
    return null;
  }
}

async function resolveAudioSrc(track) {
  if (!track) return null;
  if (track.audioUrl) return track.audioUrl;
  const url = await resolveTrackUrl(track.kugouId);
  if (url) track.audioUrl = url;
  return url;
}

function trackKey(track) {
  if (!track) return '';
  if (track.kugouId) return `id:${track.kugouId}`;
  if (track.audioUrl) return `url:${track.audioUrl}`;
  return `t:${track.title || ''}\0${track.artist || ''}`;
}

function trackStillCurrent(track) {
  const current = state.queue[state.index];
  if (current === track) return true;
  return trackKey(current) !== '' && trackKey(current) === trackKey(track);
}

function alreadyPlayingIndex(i) {
  const track = state.queue[i];
  if (!track || !audio || audio.paused || audio.ended) return false;
  if (state.index !== i) return false;
  const src = audio.getAttribute('src') || '';
  return Boolean(track.audioUrl) && src === track.audioUrl;
}

async function playIndex(i, { autoplay = true, startAt = 0, resume = false, restart = false } = {}) {
  if (i < 0 || i >= state.queue.length) {
    npBox.classList.add('hidden');
    audio.removeAttribute('src');
    window.dispatchEvent(new CustomEvent('claudio:trackchange', { detail: null }));
    return;
  }
  if (resume && audio?.getAttribute('src')) {
    ensurePlaybackVolume();
    if (Number.isFinite(startAt) && startAt > 0) {
      try { audio.currentTime = startAt; } catch { /* 元数据还没到 */ }
    }
    if (autoplay) await attemptPlay();
    return;
  }
  if (!restart && alreadyPlayingIndex(i)) return;
  const claim = claimPlayLoad(playLoadIndex, i + state.offset);
  if (!claim.accept) return;
  playLoadIndex = claim.loading;
  const loadToken = i + state.offset;
  suppressPauseSync = true;
  try {
    state.index = i;
    const t = state.queue[i];
    updateSeekBar(0, 0);
    resetFavoriteState();
    npTitle.textContent = t.title;
    npArtist.textContent = t.artist;
    setStudioTrack(t);
    if (!t.isTts) {
      setConsoleDialog(`接下来播放 ${t.title} — ${t.artist}。`);
    } else {
      const comment = document.getElementById('studio-track-comment');
      if (comment) comment.textContent = t.title || '';
    }

    const src = await resolveAudioSrc(t);
    // await 期间用户可能又点了别的曲目，确认当前目标没变再写 src
    if (playLoadIndex !== loadToken || state.index + state.offset !== loadToken || !trackStillCurrent(t)) return;
    if (!src) {
      if (state.index < state.queue.length - 1) {
        playLoadIndex = null;
        suppressPauseSync = false;
        return playIndex(state.index + 1, { autoplay, startAt: 0, restart: false });
      }
      showAlert(`无法取到《${t.title}》的播放地址`);
      return;
    }

    audio.src = src;
    const seekTo = restart ? 0 : (Number.isFinite(startAt) ? startAt : 0);
    if (seekTo > 0 || restart || audio.ended) {
      try { audio.currentTime = seekTo; } catch { /* 还不能 seek 时，play() 会从 0 开始 */ }
    }
    // 通知 components/lyrics.js 当前是哪首（它通过 #lyrics-panel 自动 attach）
    window.dispatchEvent(new CustomEvent('claudio:trackchange', { detail: t }));
    ensurePlaybackVolume();
    // internal 仍等用户点「开始电台」。external 直接试 play()，被拒绝才盖遮罩。
    if (autoplay && !(brain === 'internal' && !userActivated)) await attemptPlay();
    else if (!autoplay) {
      syncToServer(state.index, { paused: true, ended: false });
      updatePlayButtons(false);
    }
    npBox.classList.remove('hidden');
    renderQueuePanel();
    if (state.brain === 'internal' && state.loopMode === 'auto' && i === state.queue.length - 1 && !autoRecommending) {
      autoRecommend(NEXT_BATCH_PROMPT);
    }
  } finally {
    if (playLoadIndex === loadToken) playLoadIndex = null;
    suppressPauseSync = false;
  }
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
  if (state.brain === 'internal' && state.loopMode === 'list' && state.queue.length) {
    playIndex(0);
    return;
  }
  if (state.brain === 'internal' && state.loopMode === 'auto' && state.queue.length) {
    requestNextBatch({ playWhenReady: true });
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
  toast(next
    ? `已收藏：${track?.title || '当前电台氛围'}`
    : `已取消收藏：${track?.title || '当前电台氛围'}`);
  fetch('/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: next ? 'like' : 'unlike',
      title: track?.title || '',
      artist: track?.artist || '',
      kugouId: track?.kugouId || '',
    }),
  }).catch(() => {});
}

function renderQueuePanel() {
  document.body?.classList.toggle('is-empty', state.queue.length === 0);
  paintHostChrome();
  const count = document.getElementById('queue-count');
  const dialogText = document.getElementById('console-dialog-text');
  if (!queueList) return;
  if (!state.queue.length) {
    queueList.innerHTML = '';
    if (count) count.textContent = '0 首';
    queueList.classList.add('hidden');
    if (dialogText) dialogText.classList.remove('hidden');
    if (queueBtn) queueBtn.setAttribute('aria-pressed', 'false');
    return;
  }
  const upcoming = [];
  for (let i = state.index + 1; i < state.queue.length; i += 1) {
    const track = state.queue[i];
    if (!track || track.isTts) continue;
    upcoming.push({ track, index: i });
  }
  if (count) count.textContent = `${upcoming.length} 首`;
  queueList.innerHTML = upcoming.map(({ track, index }, offset) => {
    const reason = String(track.reason || '').trim();
    const cover = String(track.cover || '').trim();
    const art = cover
      ? `<span class="mini-cover" aria-hidden="true"><img src="${escapeHtml(cover)}" alt=""></span>`
      : `<span class="mini-cover" aria-hidden="true"></span>`;
    const reasonHtml = reason ? `<span class="queue-reason">${escapeHtml(reason)}</span>` : '';
    const position = String(offset + 1).padStart(2, '0');
    return `<li><button type="button" class="queue-track" data-idx="${index}" aria-label="播放 ${escapeHtml(track.artist || '')}《${escapeHtml(track.title || '')}》"><span class="position">${position}</span>${art}<span class="queue-copy"><span class="queue-title-line"><span class="queue-title">${escapeHtml(track.title || '')}</span><span class="queue-artist">${escapeHtml(track.artist || '')}</span></span>${reasonHtml}</span></button></li>`;
  }).join('');
  queueList.classList.toggle('hidden', !queueVisible);
  if (dialogText) dialogText.classList.toggle('hidden', queueVisible);
  if (queueBtn) {
    queueBtn.setAttribute('aria-pressed', String(queueVisible));
    queueBtn.setAttribute('aria-expanded', String(queueVisible));
    queueBtn.textContent = queueVisible ? '收起队列' : '展开队列';
    queueBtn.setAttribute('aria-label', queueVisible ? '收起完整队列' : '展开完整队列');
  }
  queueList.querySelectorAll('[data-idx]').forEach(btn => {
    btn.addEventListener('click', () => {
      markActivated();
      playIndex(Number(btn.dataset.idx));
    });
  });
  bindQueueCoverFallbacks();
}

function bindQueueCoverFallbacks() {
  queueList.querySelectorAll('.mini-cover img').forEach(img => {
    const removeBrokenCover = () => img.remove();
    img.addEventListener('error', removeBrokenCover, { once: true });
    if (img.complete && img.naturalWidth === 0) removeBrokenCover();
  });
}

function toggleLoopMode() {
  const current = LOOP_MODES.indexOf(state.loopMode);
  state.loopMode = LOOP_MODES[(current + 1) % LOOP_MODES.length];
  updateLoopButton();
}

function updateLoopButton() {
  const meta = LOOP_MODE_META[state.loopMode] || LOOP_MODE_META.list;
  if (loopBtn) {
    loopBtn.textContent = meta.mark;
    loopBtn.setAttribute('aria-label', meta.label);
    loopBtn.setAttribute('title', meta.label);
    loopBtn.setAttribute('aria-pressed', String(state.loopMode !== 'list'));
    loopBtn.classList.toggle('active', state.loopMode !== 'list');
  }
}

function toggleQueuePanel() {
  if (!state.queue.length) {
    showAlert('队列还是空的');
    return;
  }
  queueVisible = !queueVisible;
  renderQueuePanel();
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
      if (action === 'queue') toggleQueuePanel();
      if (action === 'loop') toggleLoopMode();
    });
  });
}

async function send(message) {
  pendingPlayFrom = -1;
  autoRecommendGen++;
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

    const songItems = (data.queue || []).filter(q => !q.isTts);
    let metaHtml = '';
    if (songItems.length) {
      const items = songItems.map(q => {
        const name = `<span class="track-name">${escapeHtml(q.title)} — ${escapeHtml(q.artist)}</span>`;
        const cmt  = q.comment
          ? `<span class="track-comment">${escapeHtml(q.comment)}</span>`
          : '';
        return `<li>${name}${cmt}</li>`;
      }).join('');
      metaHtml += `<ol class="track-list">${items}</ol>`;
    }

    addBubble('assistant', data.say || '(无回应)', metaHtml || null);
    setConsoleDialog(data.say || '我已经整理好这一轮电台推荐。');

    if (data.queue && data.queue.length) {
      state.queue = data.queue;
      state.index = 0;
      state.offset = data.queueOffset || 0;
      playIndex(0);
    }
    if (data._resolveError) {
      showAlert('酷狗搜索失败，请检查酷狗 API 服务是否正在运行');
    } else {
      clearAlert();
    }
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
export function applyRuntime(runtime, { origin } = {}) {
  if (!runtime) return;
  // 自己刚 POST 出去的状态又广播回来时，不再 play / pause / playIndex。
  if (isOwnEcho(origin, getClientId())) return;
  if (runtime.brain === 'internal' || runtime.brain === 'external') {
    brain = runtime.brain;
    state.brain = brain;
    applyBrainChrome();
  }
  rememberQueueMeta(runtime);
  if (runtime.lastSay && runtime.lastSay !== appliedSay) {
    appliedSay = runtime.lastSay;
    setConsoleDialog(runtime.lastSay);
  }
  paintHostChrome();
  if (Number.isFinite(runtime.currentTime)) serverProgress = runtime.currentTime;
  const plan = planRuntimeSync({
    queue: state.queue,
    index: state.index,
    offset: state.offset,
    hasSrc: Boolean(audio?.getAttribute?.('src') || audio?.src),
    ended: Boolean(audio?.ended),
  }, runtime);
  if (Number.isFinite(plan.volume)) applyHeardVolume(plan.volume);
  else ensurePlaybackVolume();
  if (plan.applyQueue && plan.playIndex == null) {
    state.queue = plan.queue || [];
    state.index = plan.index;
    state.offset = plan.queueOffset;
    renderQueuePanel();
    if (!state.queue.length && brain !== 'internal') {
      setConsoleDialog('等待点歌');
      dismissBootOverlay();
    }
  }
  if (plan.playIndex != null) {
    if (plan.applyQueue) state.queue = plan.queue;
    state.offset = plan.queueOffset;
    const autoplay = plan.pause !== true;
    playIndex(plan.playIndex, {
      autoplay,
      restart: Boolean(plan.restart),
      startAt: plan.restart ? 0 : serverProgress,
    });
    if (!autoplay) dismissBootOverlay();
    return;
  }
  if (plan.pause === true && audio && !audio.paused) audio.pause();
  else if (plan.pause === false && audio?.paused && audio.src && !(brain === 'internal' && !userActivated)) {
    const command = planPlayCommand({ queueLength: state.queue.length, userActivated });
    if (!command.play || command.showOverlay) return;
    if (audio.ended) {
      try { audio.currentTime = 0; } catch { /* ended 元素有时要等 play() 自己回到开头 */ }
    }
    attemptPlay();
  }
}

// 外部 bot 推来的歌。replace 接管当前队列；append 只在没在播时开播。
export function applyExternalQueue({ mode, tracks, say, reason, queuedAt: at } = {}) {
  const list = Array.isArray(tracks) ? tracks.filter(track => track && track.title) : [];
  if (!list.length) return;
  if (say) {
    appliedSay = say;
    setConsoleDialog(say);
    if (chat && brain === 'internal') addBubble('assistant', say, '(外部电台)');
  }
  if (reason) lastReason = reason;
  if (at) queuedAt = at;
  const plan = planExternalPlayback({
    queueLength: state.queue.length,
    hasSrc: Boolean(audio?.getAttribute?.('src') || audio?.src),
    ended: Boolean(audio?.ended),
    paused: Boolean(audio?.paused),
    index: state.index,
  }, { mode, incoming: list.length });
  if (mode === 'append') {
    state.queue = [...state.queue, ...list];
  } else {
    state.queue = list;
    state.index = 0;
    state.offset = 0;
  }
  renderQueuePanel();
  if (!plan.autoplay) return;
  if (plan.resume) {
    playIndex(plan.playIndex ?? state.index, { autoplay: true, resume: true, startAt: audio?.currentTime || serverProgress });
    return;
  }
  if (plan.playIndex != null) playIndex(plan.playIndex, { autoplay: true });
}

// boot 后台拉完追加的歌曲，通过 WS queue-append 推进来
export function appendToQueue(tracks) {
  if (!Array.isArray(tracks) || !tracks.length) return;
  state.queue = [...state.queue, ...tracks];
  renderQueuePanel();
}

export function initPlayer() {
  chat      = $('#chat');
  composer  = $('#composer');
  input     = $('#input');
  submitBtn = composer ? composer.querySelector('button') : null;
  audio     = $('#audio');
  npBox     = $('#now-playing');
  npTitle   = $('#np-title');
  npArtist  = $('#np-artist');

  document.addEventListener('click', markActivated, { capture: true, once: true });
  document.addEventListener('keydown', markActivated, { capture: true, once: true });

  audio.addEventListener('ended', async () => {
    if (state.brain === 'internal' && state.loopMode === 'one') {
      audio.currentTime = 0;
      audio.play().catch(() => {});
    } else if (state.index < state.queue.length - 1) {
      playIndex(state.index + 1);
    } else if (state.queue.length) {
      // 队尾先让服务端接续播池；internal 的循环/推歌只在没有续播时执行。
      const endedQueue = state.queue;
      const endedIndex = state.index;
      const result = await syncToServer(endedIndex, { paused: true, ended: true });
      if (result?.continued || result?.stale || state.queue !== endedQueue || state.index !== endedIndex) return;
      if (state.brain === 'internal' && state.loopMode === 'list') playIndex(0);
      else if (state.brain === 'internal' && state.loopMode === 'auto') requestNextBatch({ playWhenReady: true });
    } else {
      npBox.classList.add('hidden');
      syncToServer(state.index, { paused: true });
    }
  });

  // 歌曲加载失败（URL 过期、代理出错等）→ 跳到下一首，避免静默卡死
  audio.addEventListener('error', () => {
    if (state.index < state.queue.length - 1) {
      playIndex(state.index + 1);
    } else {
      showAlert('音频加载失败');
    }
  });

  // 只对真实歌曲才清除 alert，避免 TTS 播放时把"酷狗搜索失败"之类的错误提示抹掉
  audio.addEventListener('play',  () => {
    syncToServer(state.index, { paused: false });
    updatePlayButtons(true);
    if (!state.queue[state.index]?.isTts) clearAlert();
  });
  audio.addEventListener('pause', () => {
    updatePlayButtons(false);
    // 换 src 会先冒出一次 pause。这次正在 playIndex 里，真正的暂停由 play 事件或显式 sync 报。
    if (suppressPauseSync) return;
    syncToServer(state.index, { paused: true, ended: Boolean(audio.ended) });
  });

  consolePlayBtn = $('[data-console-control="play-pause"]');
  consoleFavoriteBtn = $('[data-console-control="favorite"]');
  queueBtn = $('[data-console-control="queue"]');
  loopBtn = $('[data-console-control="loop"]');
  if (queueBtn) queueBtn.setAttribute('aria-pressed', 'false');
  updateLoopButton();
  queueList = document.getElementById('queue-list');
  npSeek = document.getElementById('np-seek');
  npTimeCur = document.getElementById('np-time-cur');
  npTimeDur = document.getElementById('np-time-dur');
  npVol = document.getElementById('np-vol');
  applyLocalVolume();

  audio.addEventListener('timeupdate', () => {
    updateSeekBar(audio.currentTime, audio.duration);
    reportProgress();
  });
  audio.addEventListener('durationchange', () => updateSeekBar(audio.currentTime, audio.duration));
  audio.addEventListener('loadedmetadata', () => updateSeekBar(audio.currentTime, audio.duration));
  audio.addEventListener('seeked', () => reportProgress(true));

  if (npSeek) {
    npSeek.addEventListener('input', () => {
      if (audio.duration) audio.currentTime = (npSeek.value / 100) * audio.duration;
    });
  }

  if (npVol) {
    npVol.addEventListener('input', () => {
      const volume = Number(npVol.value);
      audio.volume = volume / 100;
      syncVolumeChrome(volume);
      writeLocalVolume(volume);
      reportProgress(true);
    });
  }

  bindConsoleControls();
  bindStudioThemes();
  bindFeedback();
  setStudioTheme(savedStudioTheme() || 'focus', { persist: false });
  updatePlayButtons(false);
  paintEdition();
  setInterval(paintEdition, 60 * 1000);

  bootOverlay = document.getElementById('boot-overlay');
  bootBtn = document.getElementById('boot-btn');
  if (bootBtn) {
    bootBtn.addEventListener('click', () => {
      markActivated();
      bootClicked = true;
      if (brain !== 'internal') {
        dismissBootOverlay();
        const plan = externalUnlockPlan({ queue: state.queue, index: state.index });
        if (plan.dialog) setConsoleDialog(plan.dialog);
        if (plan.playIndex != null) {
          const resume = Boolean(audio?.getAttribute('src')) && state.index === plan.playIndex;
          playIndex(plan.playIndex, { autoplay: true, resume, startAt: serverProgress });
        }
        return;
      }
      if (bootReady) {
        startBoot();
      } else {
        bootBtn.textContent = '加载中…';
        bootBtn.disabled = true;
      }
    });
  }

  // Playlists 视图整单播放：替换本地队列并立即从第一首开始播（点击本身已解锁 autoplay）
  window.addEventListener('claudio:queue-replace', e => {
    const queue = Array.isArray(e.detail) ? e.detail : [];
    if (!queue.length) return;
    state.queue = queue;
    state.index = 0;
    state.offset = 0;
    renderQueuePanel();
    playIndex(0);
  });

  if (composer && input && submitBtn) {
    composer.addEventListener('submit', e => {
      e.preventDefault();
      const m = input.value.trim();
      if (m) send(m);
    });
  }

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
    brain = data.brain === 'internal' ? 'internal' : 'external';
    state.brain = brain;
    state.offset = data.queueOffset || 0;
    applyBrainChrome();
    rememberQueueMeta(data);
    if (Number.isFinite(data.volume)) applyHeardVolume(data.volume);
    else ensurePlaybackVolume();
    if (brain !== 'internal') {
      serverProgress = Number(data.currentTime) || 0;
      const plan = planExternalBoot({ queue: data.queue, paused: data.paused === true });
      if (plan.dialog) setConsoleDialog(plan.dialog);
      dismissBootOverlay();
      if (!data.queue?.length) {
        state.queue = [];
        if (data.lastSay) {
          appliedSay = data.lastSay;
          setConsoleDialog(data.lastSay);
        }
        renderQueuePanel();
        return;
      }
      state.queue = data.queue;
      state.index = data.index || 0;
      const t = state.queue[state.index];
      if (t) {
        npTitle.textContent = t.title;
        npArtist.textContent = t.artist;
        setStudioTrack(t);
        npBox.classList.remove('hidden');
      }
      if (data.lastSay) {
        appliedSay = data.lastSay;
        setConsoleDialog(data.lastSay);
      }
      renderQueuePanel();
      await playIndex(state.index, { autoplay: plan.play, startAt: serverProgress });
      return;
    }
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
        const src = await resolveAudioSrc(t);
        if (src) {
          audio.preload = 'metadata';
          audio.src = src;
          audio.load();
        }
        window.dispatchEvent(new CustomEvent('claudio:trackchange', { detail: t }));
        npBox.classList.remove('hidden');
      }
      renderQueuePanel();
    } else {
      state.queue = [];
      renderQueuePanel();
      if (bootOverlay) bootOverlay.classList.remove('hidden');
      preFetchBoot();
    }
    if (data.lastSay) {
      appliedSay = data.lastSay;
      addBubble('assistant', data.lastSay, '(上次会话)');
      setConsoleDialog(data.lastSay);
      paintHostChrome();
    }
  } catch (err) {
    showAlert(`无法连接服务：${err.message}`);
  }
}
