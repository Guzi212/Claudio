// Player 视图 · 外部电台播放控制与队列展示。
// 入口：initPlayer() — 在 DOM 就绪后调用一次。
// 对外：applyRuntime(runtime) — 让 app.js 把 WS 推来的 runtime 同步进来。
import { showAlert, clearAlert, toast } from './ui.js';
import { planExternalPlayback } from '../external-playback.js';
import { claimPlayLoad, isOwnEcho, planRuntimeSync } from '../runtime-sync.js';
import {
  externalUnlockPlan,
  planExternalBoot,
  planPlayCommand,
  planPlayError,
  TRACK_PROVIDER_LABELS,
  trackProviderLabel,
} from '../player-mode.js';
import { readLocalVolume, writeLocalVolume } from '../volume-memory.js';
import { getClientId } from '../client-id.js';
import { hostSprite, PIXEL_HOST_SPRITES, readPixelHostEnabled } from '../host-mood.js';

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 播放音质六档，从高到低；上游没有 viper_tape / super（假档）和魔法音质。
const QUALITY_OPTIONS = [
  { q: 'viper_clear', label: '超清',      hint: '约 130 MB/首' },
  { q: 'viper_atmos', label: '全景声',    hint: '约 42 MB/首'  },
  { q: 'high',        label: 'Hi-Res',    hint: '约 29 MB/首'  },
  { q: 'flac',        label: '无损 FLAC', hint: '约 28 MB/首'  },
  { q: '320',         label: '高品 320k', hint: '约 16 MB/首'  },
  { q: '128',         label: '标准 128k', hint: '约 6 MB/首'   },
];
const QUALITY_LABEL = Object.fromEntries(QUALITY_OPTIONS.map(o => [o.q, o.label]));

export { TRACK_PROVIDER_LABELS, trackProviderLabel };

const $ = sel => document.querySelector(sel);

const state = {
  queue: [],
  index: 0,
  offset: 0,
  continuePoolActive: false,
  isFollower: false,
  serverPaused: false,
  serverDuration: 0,
  leader: null,
};

let bootOverlay = null;
let bootBtn = null;
let activeAgent = null;
let activeSession = null;
let volumeReportTimer = null;
let appliedSay = '';
let lastReason = '';
let queuedAt = '';
let lastProgressAt = 0;
const feedbackByTrack = new Map();
const favoriteState = new Map();
let favoriteCheckToken = 0;
// 本次启动是否已套用作息建议音量；之后服务端的默认音量不该再把它盖回去。
let adaptiveVolumeApplied = false;

let hostFlash = null;
let hostFlashTimer = null;
let hostLoadingCount = 0;
let hostPlaying = false;
let lastPixelSpriteSrc = '';

function updatePixelHost() {
  const enabled = readPixelHostEnabled();
  const nextSrc = hostSprite({
    playing: hostPlaying,
    loading: hostLoadingCount > 0,
    queueEmpty: state.queue.length === 0,
    flash: hostFlash,
  });
  const spriteEl = document.getElementById('pixel-host-sprite');
  if (spriteEl && spriteEl.getAttribute('src') !== nextSrc) {
    spriteEl.setAttribute('src', nextSrc);
    if (lastPixelSpriteSrc && typeof spriteEl.animate === 'function'
      && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      spriteEl.animate(
        [
          { opacity: 0.72, transform: 'translateY(4px) scale(0.96)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 200, easing: 'cubic-bezier(.2, .8, .2, 1)' },
      );
    }
    lastPixelSpriteSrc = nextSrc;
  }
  const waitingEl = document.getElementById('pixel-host-waiting');
  if (waitingEl) {
    const waitSrc = enabled ? PIXEL_HOST_SPRITES.wave : PIXEL_HOST_SPRITES.head;
    if (waitingEl.getAttribute('src') !== waitSrc) {
      waitingEl.setAttribute('src', waitSrc);
    }
  }
}

function triggerHostFlash(kind) {
  hostFlash = kind;
  clearTimeout(hostFlashTimer);
  hostFlashTimer = setTimeout(() => {
    hostFlash = null;
    hostFlashTimer = null;
    updatePixelHost();
  }, 1200);
  updatePixelHost();
}

function setHostLoading(delta) {
  hostLoadingCount = Math.max(0, hostLoadingCount + delta);
  updatePixelHost();
}

let audio, npBox, npTitle, npArtist, consolePlayBtn, consoleFavoriteBtn, queueList, npSeek, npTimeCur, npTimeDur, npVol;

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
let renderedFollowerKey = '';
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
  if (!bootOverlay || !bootBtn) return;
  bootBtn.textContent = '▶ 点击开声';
  bootOverlay.classList.remove('hidden');
}

async function attemptPlay() {
  if (!audio || state.isFollower) return false;
  audio.muted = false;
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
  if (!audio || state.isFollower) return;
  const now = Date.now();
  if (!force && now - lastProgressAt < 1000) return;
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
  if (state.isFollower) return Promise.resolve(null);
  return fetch('/api/runtime/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index, queueOffset: state.offset, paused, ended, clientId: getClientId() }),
  }).then(res => res.ok ? res.json() : null).catch(() => null);
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
  const agentName = activeAgent?.name || 'Claudio';
  const agentNameEl = document.getElementById('host-agent-name');
  if (agentNameEl) agentNameEl.textContent = agentName;
  const roleChipEl = document.getElementById('host-role-chip');
  if (roleChipEl) {
    roleChipEl.textContent = '电台主持人';
  }
  const footerStatusEl = document.getElementById('footer-agent-status');
  if (footerStatusEl) footerStatusEl.textContent = `${agentName} 在线`;

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

function paintTrackProvider(track) {
  const el = document.getElementById('np-provider');
  if (!el) return;
  const label = trackProviderLabel(track);
  el.textContent = label;
  el.hidden = !label;
}

function paintAudioQuality(track) {
  const el = document.getElementById('np-quality');
  if (!el) return;
  // 角标显示实际拿到的档（回落时显示真实值，不显示用户想要的档）
  const q = String(track?.audioQuality || '').toLowerCase();
  const label = QUALITY_LABEL[q] || '';
  el.textContent = label;
  el.hidden = !label;
}

// ────── 播放页音质切换 ──────
function qualityMenuItems() {
  const actual = String(currentTrack()?.audioQuality || '').toLowerCase();
  return QUALITY_OPTIONS.map(o => ({
    ...o,
    current: o.q === currentQuality,
    actual: o.q === actual,
  }));
}

function renderQualityMenu() {
  const menu = document.getElementById('np-quality-menu');
  if (!menu) return;
  menu.innerHTML = '';
  for (const it of qualityMenuItems()) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quality-option' + (it.current ? ' current' : '');
    const name = document.createElement('span');
    name.className = 'q-name';
    name.textContent = `${it.current ? '✓ ' : ''}${it.label}`;
    const meta = document.createElement('span');
    meta.className = 'q-meta';
    meta.textContent = it.hint + (it.actual ? ' · 实际' : '');
    btn.append(name, meta);
    btn.addEventListener('click', () => {
      closeQualityMenu();
      switchPlaybackQuality(it.q);
    });
    li.append(btn);
    menu.appendChild(li);
  }
}

function closeQualityMenu() {
  const menu = document.getElementById('np-quality-menu');
  const btn = document.getElementById('np-quality-btn');
  if (menu) menu.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function toggleQualityMenu() {
  const menu = document.getElementById('np-quality-menu');
  const btn = document.getElementById('np-quality-btn');
  if (!menu || !btn) return;
  const opening = menu.hidden;
  if (opening) {
    renderQualityMenu();
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  } else {
    closeQualityMenu();
  }
}

// 无缝换 src：保持 currentTime，原本在播就续播。换 src 会先触发一次 pause，
// suppressPauseSync 挡住它，等 play / 超时再放开。
function seamlessSrcChange(src, resumeAt, { autoplay = true } = {}) {
  return new Promise(resolve => {
    suppressPauseSync = true;
    const cleanup = () => {
      clearTimeout(timer);
      audio.removeEventListener('canplay', onMeta);
      audio.removeEventListener('loadedmetadata', onMeta);
    };
    const done = () => {
      cleanup();
      suppressPauseSync = false;
      resolve();
    };
    let fired = false;
    const onMeta = () => {
      if (fired) return;
      fired = true;
      try { if (resumeAt > 0) audio.currentTime = resumeAt; } catch { /* 超过时长交给浏览器夹取 */ }
      if (autoplay) {
        audio.play().then(done).catch(done);
      } else {
        done();
      }
    };
    const timer = setTimeout(done, 8000); // 兜底：加载卡住也别永远压住 pause 同步
    audio.addEventListener('loadedmetadata', onMeta, { once: true });
    audio.addEventListener('canplay', onMeta, { once: true });
    audio.src = src;
    audio.load();
  });
}

// 切换音质：立刻作用于正在播的这首——重新取直链、seek 回切换前位置。
// 新档整链拿不到 → 保持原播放并报错；拿到但低于目标 → 标实际档并提示回落。
export async function switchPlaybackQuality(q, { track = null } = {}) {
  const opt = QUALITY_OPTIONS.find(o => o.q === q);
  if (!opt) return { ok: false, error: 'unknown quality' };
  const token = ++qualitySwitchToken;

  // 目标档写进设置（后续新解析沿用）。失败不阻塞本次切换。
  try {
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playback_quality: q }),
    });
    currentQuality = q;
  } catch { /* 设置写失败不挡切换 */ }

  const t = track || currentTrack();
  if (!t || !t.kugouId) {
    toast('当前没有在播曲目，新档位从下一首生效');
    return { ok: true, applied: q, deferred: true };
  }

  const resumeAt = Number.isFinite(audio?.currentTime) ? audio.currentTime : 0;
  const wasPlaying = Boolean(audio && !audio.paused && !audio.ended);
  const resolved = await resolveTrackUrl(t.kugouId, q);
  if (token !== qualitySwitchToken) return { ok: false, cancelled: true };
  if (!resolved?.url) {
    showAlert(`切到「${opt.label}」失败：所有档位都拿不到，保持原档`);
    return { ok: false, error: 'resolve failed' };
  }

  t.audioUrl = resolved.url;
  t.audioQuality = resolved.audioQuality || q;
  paintAudioQuality(t);
  const actualLabel = QUALITY_LABEL[t.audioQuality] || t.audioQuality;

  if (audio) {
    await seamlessSrcChange(resolved.url, resumeAt, { autoplay: wasPlaying });
    if (token !== qualitySwitchToken) return { ok: false, cancelled: true };
  }
  if (t.audioQuality !== q) {
    toast(`已回落到 ${actualLabel}（该曲无「${opt.label}」）`);
  }
  return { ok: true, applied: t.audioQuality, requested: q, resumedAt: resumeAt };
}

function bindQualityPicker() {
  const btn = document.getElementById('np-quality-btn');
  if (!btn) return;
  btn.addEventListener('click', e => {
    e.stopPropagation();
    toggleQualityMenu();
  });
  document.addEventListener('click', e => {
    const picker = e.target.closest?.('.quality-picker');
    if (!picker) closeQualityMenu();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeQualityMenu();
  });
  // 读当前设置档，给菜单打勾
  fetch('/api/settings').then(r => r.ok ? r.json() : null).then(s => {
    const q = String(s?.playback_quality || 'flac').toLowerCase();
    if (QUALITY_LABEL[q]) currentQuality = q;
  }).catch(() => {});
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
        paintFeedback();
        return;
      }
      feedbackByTrack.set(key, choice);
      if (choice === 'dislike') {
        postFeedback('dislike', track);
        reportDislikeTelemetry(track);
        paintFeedback();
        triggerHostFlash('dislike');
        if (state.index < state.queue.length - 1) goNext();
        return;
      }
      postFeedback('like', track);
      paintFeedback();
      triggerHostFlash('like');
    });
  });
}

function setStudioTrack(track) {
  if (!track) return;
  if (npTitle) npTitle.textContent = track.title || '';
  if (npArtist) npArtist.textContent = track.artist || '';
  const info = document.querySelector('#now-playing .track-info');
  if (info) info.classList.toggle('long-title', String(track.title || '').length > 4);
  paintTrackProvider(track);
  paintAudioQuality(track);
  paintTrackReason(track);
  paintCover(track);
  inkInTrack(track);
}

function currentTrack() {
  return state.queue[state.index] || null;
}

function paintFavorite(liked) {
  if (!consoleFavoriteBtn) return;
  consoleFavoriteBtn.setAttribute('aria-pressed', String(Boolean(liked)));
  consoleFavoriteBtn.classList.toggle('active', Boolean(liked));
}

function isKugouTrack(track) {
  if (!track || track.isTts) return false;
  const provider = String(track.provider || '').trim().toLowerCase();
  if (provider && provider !== 'kugou') return false;
  const hash = String(track.kugouId || '').trim();
  if (!hash || hash.startsWith('netease:') || hash.startsWith('qq:')) return false;
  return true;
}

async function refreshFavoriteState(track = currentTrack()) {
  if (!consoleFavoriteBtn) return;
  const token = ++favoriteCheckToken;
  const hash = String(track?.kugouId || '').trim();
  if (!isKugouTrack(track)) {
    consoleFavoriteBtn.disabled = true;
    paintFavorite(false);
    return;
  }
  consoleFavoriteBtn.disabled = false;
  const cached = favoriteState.get(hash);
  if (typeof cached === 'boolean') {
    consoleFavoriteBtn.disabled = false;
    paintFavorite(cached);
    return;
  }
  consoleFavoriteBtn.disabled = true;
  try {
    const r = await fetch(`/api/kugou/favorite?hash=${encodeURIComponent(hash)}`);
    const data = await r.json();
    if (token !== favoriteCheckToken) return;
    if (data.ok) {
      favoriteState.set(hash, Boolean(data.liked));
      paintFavorite(Boolean(data.liked));
    }
  } catch {
    // 查询失败时保持当前状态，用户仍可以点收藏。
  } finally {
    if (token === favoriteCheckToken && consoleFavoriteBtn) consoleFavoriteBtn.disabled = false;
  }
}

function resetFavoriteState() {
  if (consoleFavoriteBtn) {
    consoleFavoriteBtn.setAttribute('aria-pressed', 'false');
    consoleFavoriteBtn.classList.remove('active');
    consoleFavoriteBtn.disabled = true;
  }
  paintFeedback();
  refreshFavoriteState();
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
  hostPlaying = Boolean(isPlaying);
  updatePixelHost();
}

function dismissBootOverlay() {
  if (bootOverlay) bootOverlay.classList.add('hidden');
}

let currentQuality = 'flac';
let qualitySwitchToken = 0;

// 歌单队列只带 hash，播到这首时才向服务端换直链（避免大歌单一上来解析几百条）。
async function resolveTrackUrl(hash, quality = '') {
  if (!hash) return null;
  try {
    const q = quality ? `&quality=${encodeURIComponent(quality)}` : '';
    const r = await fetch(`/api/kugou/track-url?hash=${encodeURIComponent(hash)}${q}`);
    if (!r.ok) return null;
    const d = await r.json();
    if (!d?.url) return null;
    return { url: d.url, audioQuality: d.audioQuality || null };
  } catch {
    return null;
  }
}

async function resolveAudioSrc(track) {
  if (!track) return null;
  if (track.audioUrl) return track.audioUrl;
  const resolved = await resolveTrackUrl(track.kugouId);
  // 兼容旧后端只回 {url} 或直接 string 的情况
  const url = typeof resolved === 'string' ? resolved : resolved?.url;
  const q = typeof resolved === 'object' ? (resolved?.audioQuality || null) : null;
  if (url) {
    track.audioUrl = url;
    if (q) {
      track.audioQuality = q;
      // 懒解析档位到手晚于首屏渲染，补一次
      paintAudioQuality(track);
    }
  }
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

function shouldCountAsUserSkip() {
  if (!activeSession) return false;
  const cur = Number(audio?.currentTime) || 0;
  const dur = Number(audio?.duration) || Number(activeSession.durationSec) || 0;
  return !((dur > 0 && cur / dur >= 0.65) || cur >= 90);
}

function fallbackDurationSec(track) {
  if (Number.isFinite(state.serverDuration) && state.serverDuration > 0) return state.serverDuration;
  const raw = Number(track?.duration) || 0;
  if (raw <= 0) return 0;
  return raw > 1800 ? raw / 1000 : raw;
}

function seekAudioSafely(targetSec, expectedTrack) {
  if (!audio || !Number.isFinite(targetSec) || targetSec <= 0) return;
  const applySeek = () => {
    if (expectedTrack && !trackStillCurrent(expectedTrack)) return;
    try { audio.currentTime = targetSec; } catch { /* ignore */ }
  };
  if (audio.readyState >= 1) {
    applySeek();
    return;
  }
  try { audio.currentTime = targetSec; } catch { /* wait metadata */ }
  audio.addEventListener('loadedmetadata', () => {
    if (Math.abs((audio.currentTime || 0) - targetSec) > 0.8) {
      applySeek();
    }
  }, { once: true });
}

function silenceFollowerAudio() {
  if (!audio) return;
  audio.muted = true;
  if (!audio.paused) {
    suppressPauseSync = true;
    try { audio.pause(); } catch { /* ignore */ }
    suppressPauseSync = false;
  }
}

function syncFollowerStage({ forceTrackEvent = false } = {}) {
  if (!state.queue.length || state.index < 0 || state.index >= state.queue.length) {
    renderedFollowerKey = '';
    if (npBox) npBox.classList.add('hidden');
    paintTrackProvider(null);
    paintAudioQuality(null);
    updatePlayButtons(false);
    updateSeekBar(0, 0);
    window.dispatchEvent(new CustomEvent('claudio:trackchange', { detail: null }));
    renderQueuePanel();
    return;
  }
  const clamped = Math.max(0, Math.min(state.index, state.queue.length - 1));
  state.index = clamped;
  const t = state.queue[clamped];
  const nextKey = `${clamped + state.offset}:${trackKey(t)}`;
  const changed = forceTrackEvent || nextKey !== renderedFollowerKey;
  renderedFollowerKey = nextKey;
  if (npTitle) npTitle.textContent = t.title || '';
  if (npArtist) npArtist.textContent = t.artist || '';
  setStudioTrack(t);
  if (npBox) npBox.classList.remove('hidden');
  if (changed) {
    resetFavoriteState();
    window.dispatchEvent(new CustomEvent('claudio:trackchange', { detail: t }));
  }
  updateSeekBar(serverProgress, fallbackDurationSec(t));
  window.dispatchEvent(new CustomEvent('claudio:lyric-time', { detail: { currentTime: serverProgress } }));
  updatePlayButtons(!state.serverPaused);
  renderQueuePanel();
}

function syncFollowerRuntime(runtime) {
  silenceFollowerAudio();
  dismissBootOverlay();
  const keepAdaptiveVolume = adaptiveVolumeApplied && runtime.volumeExplicit !== true;
  if (Number.isFinite(runtime.volume) && !keepAdaptiveVolume) applyHeardVolume(runtime.volume);
  if (Array.isArray(runtime.queue)) {
    state.queue = runtime.queue;
    state.offset = runtime.queueOffset || 0;
    if (!runtime.queue.length) {
      state.index = 0;
      state.serverPaused = true;
      setConsoleDialog('等待点歌');
    } else {
      const idx = Number.isFinite(runtime.index) ? runtime.index : 0;
      state.index = Math.max(0, Math.min(idx, runtime.queue.length - 1));
    }
  }
  syncFollowerStage();
}

async function playIndex(i, { autoplay = true, startAt = 0, resume = false, restart = false, outcomeHint = 'switch' } = {}) {
  if (i < 0 || i >= state.queue.length) {
    npBox.classList.add('hidden');
    paintTrackProvider(null);
    paintAudioQuality(null);
    audio.removeAttribute('src');
    window.dispatchEvent(new CustomEvent('claudio:trackchange', { detail: null }));
    return;
  }
  if (state.isFollower) {
    state.index = i;
    if (Number.isFinite(startAt) && startAt >= 0) serverProgress = startAt;
    silenceFollowerAudio();
    syncFollowerStage();
    return;
  }
  if (resume && audio?.getAttribute('src')) {
    audio.muted = false;
    ensurePlaybackVolume();
    if (Number.isFinite(startAt) && startAt > 0) {
      seekAudioSafely(startAt, state.queue[i]);
    }
    if (autoplay) await attemptPlay();
    return;
  }
  if (!restart && alreadyPlayingIndex(i)) return;
  const claim = claimPlayLoad(playLoadIndex, i + state.offset);
  if (!claim.accept) return;
  playLoadIndex = claim.loading;
  const loadToken = i + state.offset;
  settleActiveSession(outcomeHint);
  suppressPauseSync = true;
  setHostLoading(1);
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
    }

    const src = await resolveAudioSrc(t);
    // await 期间用户可能又点了别的曲目，确认当前目标没变再写 src
    if (playLoadIndex !== loadToken || state.index + state.offset !== loadToken || !trackStillCurrent(t)) return;
    if (state.isFollower) {
      silenceFollowerAudio();
      syncFollowerStage({ forceTrackEvent: true });
      return;
    }
    if (!src) {
      if (state.index < state.queue.length - 1) {
        playLoadIndex = null;
        suppressPauseSync = false;
        return playIndex(state.index + 1, { autoplay, startAt: 0, restart: false });
      }
      showAlert(`无法取到《${t.title}》的播放地址`);
      return;
    }

    audio.muted = false;
    audio.src = src;
    const seekTo = restart ? 0 : (Number.isFinite(startAt) ? startAt : 0);
    if (seekTo > 0) {
      seekAudioSafely(seekTo, t);
    } else if (restart || audio.ended) {
      try { audio.currentTime = 0; } catch { /* 还不能 seek 时，play() 会从 0 开始 */ }
    }
    // 通知 components/lyrics.js 当前是哪首（它通过 #lyrics-panel 自动 attach）
    window.dispatchEvent(new CustomEvent('claudio:trackchange', { detail: t }));
    ensurePlaybackVolume();
    // 直接试 play()，被浏览器拒绝才盖遮罩。
    if (autoplay) await attemptPlay();
    else {
      syncToServer(state.index, { paused: true, ended: false });
      updatePlayButtons(false);
    }
    npBox.classList.remove('hidden');
    renderQueuePanel();
  } finally {
    if (playLoadIndex === loadToken) playLoadIndex = null;
    suppressPauseSync = false;
    setHostLoading(-1);
  }
}

function goPrev() {
  if (state.index > 0) {
    playIndex(state.index - 1);
    return;
  }
  showAlert('已经是第一首');
}

function goNext({ userInitiated = false } = {}) {
  const outcomeHint = userInitiated && shouldCountAsUserSkip() ? 'skipped' : 'switch';
  if (state.index < state.queue.length - 1) {
    playIndex(state.index + 1, { outcomeHint });
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

async function toggleFavorite() {
  const track = currentTrack();
  const hash = String(track?.kugouId || '').trim();
  if (!isKugouTrack(track)) {
    showAlert('当前曲目来自非酷狗音源，暂不支持酷狗红心收藏');
    return;
  }
  const current = consoleFavoriteBtn?.getAttribute('aria-pressed') === 'true';
  const next = !current;
  const stillCurrent = () => String(currentTrack()?.kugouId || '') === hash;
  paintFavorite(next);
  if (consoleFavoriteBtn) consoleFavoriteBtn.disabled = true;
  try {
    const r = await fetch('/api/kugou/favorite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: next ? 'add' : 'remove',
        track: {
          hash,
          title: track.title || '',
          artist: track.artist || '',
          album: track.album || '',
          albumId: track.albumId || '',
          mixsongid: track.mixsongid || '',
        },
      }),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || `HTTP ${r.status}`);
    favoriteState.set(hash, Boolean(data.liked));
    if (stillCurrent()) paintFavorite(Boolean(data.liked));
    const targetName = data.playlist?.name || '我喜欢';
    if (next) {
      toast(data.duplicate ? `已在「${targetName}」：${track.title}` : `已加入「${targetName}」：${track.title}`);
    } else {
      toast(`已从「${targetName}」移除：${track.title}`);
    }
  } catch (err) {
    if (stillCurrent()) paintFavorite(current);
    showAlert(`收藏失败：${err.message}`);
  } finally {
    if (consoleFavoriteBtn && stillCurrent()) consoleFavoriteBtn.disabled = false;
  }
}

function renderQueuePanel() {
  document.body?.classList.toggle('is-empty', state.queue.length === 0);
  paintHostChrome();
  updatePixelHost();
  const count = document.getElementById('queue-count');
  const dialogText = document.getElementById('console-dialog-text');
  if (!queueList) return;
  if (!state.queue.length) {
    queueList.innerHTML = '';
    if (count) count.textContent = '0 首';
    queueList.classList.add('hidden');
    if (dialogText) dialogText.classList.remove('hidden');
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
  queueList.classList.remove('hidden');
  if (dialogText) dialogText.classList.add('hidden');
  queueList.querySelectorAll('[data-idx]').forEach(btn => {
    btn.addEventListener('click', () => {
      markActivated();
      const targetIdx = Number(btn.dataset.idx);
      if (state.isFollower) {
        fetch('/api/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: 'jump', value: targetIdx }),
        }).catch(() => {});
        return;
      }
      playIndex(targetIdx, {
        outcomeHint: shouldCountAsUserSkip() ? 'skipped' : 'switch',
      });
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

function bindConsoleControls() {
  const controls = document.querySelectorAll('[data-console-control]');
  controls.forEach(btn => {
    btn.addEventListener('click', () => {
      markActivated();
      const action = btn.dataset.consoleControl;
      if (state.isFollower && (action === 'prev' || action === 'play-pause' || action === 'next')) {
        const command = action === 'play-pause' ? 'toggle' : action;
        fetch('/api/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command }),
        }).catch(() => {});
        return;
      }
      if (action === 'prev') goPrev();
      if (action === 'play-pause') togglePlayback();
      if (action === 'next') goNext({ userInitiated: true });
      if (action === 'favorite') toggleFavorite();
    });
  });
}

async function postMemoryTelemetry(payload, { keepalive = false } = {}) {
  if (location.protocol === 'file:') return null;
  try {
    const r = await fetch('/api/memory/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      ...(keepalive ? { keepalive: true } : {}),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function reportDislikeTelemetry(track) {
  if (!track || track.isTts) return;
  const sessionId = activeSession?.sessionId || null;
  activeSession = null;
  postMemoryTelemetry({
    event: 'dislike',
    sessionId,
    title: track.title || '',
    artist: track.artist || '',
    kugouId: track.kugouId || '',
    listenedSec: Math.round(Number(audio?.currentTime) || 0),
    durationSec: Math.round(Number(audio?.duration) || Number(track.duration) || 0),
    finalVolume: npVol ? Number(npVol.value) : null,
  }, { keepalive: true });
}

function settleActiveSession(outcomeHint = 'switch') {
  const session = activeSession;
  if (!session) return;
  activeSession = null;
  const listenedSec = Math.max(0, Math.round(Number(audio?.currentTime) || 0));
  const durationSec = Math.max(0, Math.round(Number(audio?.duration) || Number(session.durationSec) || 0));
  let outcome = outcomeHint;
  if (outcomeHint === 'switch') {
    if ((durationSec > 0 && listenedSec / durationSec >= 0.65) || listenedSec >= 90) {
      outcome = 'completed';
    } else if (listenedSec < 25) {
      outcome = 'skipped';
    } else {
      outcome = 'interrupted';
    }
  }
  postMemoryTelemetry({
    event: 'session_end',
    sessionId: session.sessionId,
    title: session.title,
    artist: session.artist,
    kugouId: session.kugouId,
    listenedSec,
    durationSec,
    outcome,
    finalVolume: npVol ? Number(npVol.value) : null,
  }, { keepalive: true });
}

async function startTelemetrySession(track) {
  if (!track || track.isTts) return;
  const key = trackKey(track);
  if (!key) return;
  if (activeSession && activeSession.key === key) return;
  const pendingKey = key;
  activeSession = {
    key,
    sessionId: null,
    title: track.title || '',
    artist: track.artist || '',
    kugouId: track.kugouId || '',
    durationSec: Number(track.duration) || 0,
  };
  const data = await postMemoryTelemetry({
    event: 'session_start',
    title: track.title || '',
    artist: track.artist || '',
    kugouId: track.kugouId || '',
    reason: track.reason || lastReason || '',
    source: track.source || 'external',
    agentId: activeAgent?.id || null,
    durationSec: Number(track.duration) || 0,
    initialVolume: npVol ? Number(npVol.value) : null,
  });
  if (data?.sessionId && activeSession && activeSession.key === pendingKey) {
    activeSession.sessionId = data.sessionId;
  }
}

function paintScene(scene) {
  const id = typeof scene === 'string'
    ? scene
    : String(scene?.id || 'auto');
  document.querySelectorAll('#scene-pills [data-scene]').forEach(btn => {
    const active = btn.dataset.scene === id;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

function bindScenePills() {
  const box = document.getElementById('scene-pills');
  if (!box) return;
  box.querySelectorAll('[data-scene]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const scene = btn.dataset.scene;
      if (!scene) return;
      paintScene(scene);
      try {
        const r = await fetch('/api/scene', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scene }),
        });
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data.error || `HTTP ${r.status}`);
        paintScene(data.scene);
        toast(`场景：${data.scene.label}`);
      } catch (err) {
        showAlert(`切换场景失败：${err.message}`);
      }
    });
  });
}

function syncIntentUi(text) {
  const intentInput = document.getElementById('intent-input');
  const intentClear = document.getElementById('intent-clear');
  if (intentInput && document.activeElement !== intentInput) {
    intentInput.value = text || '';
  }
  if (intentClear) {
    intentClear.classList.toggle('hidden', !String(text || '').trim());
  }
}

function bindIntentForm() {
  const form = document.getElementById('intent-form');
  const intentInput = document.getElementById('intent-input');
  const intentClear = document.getElementById('intent-clear');
  if (!form || !intentInput) return;

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const text = intentInput.value.trim();
    if (!text) return;
    try {
      const r = await fetch('/api/memory/intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, source: 'ui' }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || `HTTP ${r.status}`);
      syncIntentUi(data.intent?.text || text);
      toast('已更新当前意图');
    } catch (err) {
      showAlert(`更新意图失败：${err.message}`);
    }
  });

  intentClear?.addEventListener('click', async () => {
    try {
      const r = await fetch('/api/memory/intent', { method: 'DELETE' });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || `HTTP ${r.status}`);
      intentInput.value = '';
      syncIntentUi('');
      toast('已清除当前意图');
    } catch (err) {
      showAlert(`清除意图失败：${err.message}`);
    }
  });
}

function settingEnabled(value, fallback = true) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'on', 'yes'].includes(raw)) return true;
  if (['0', 'false', 'off', 'no'].includes(raw)) return false;
  return fallback;
}

async function hydrateMemoryContext({ hasServerVolume = false } = {}) {
  if (location.protocol === 'file:') return;
  try {
    const [briefRes, settingsRes] = await Promise.allSettled([
      fetch('/api/memory/brief').then(r => (r.ok ? r.json() : null)),
      fetch('/api/settings').then(r => (r.ok ? r.json() : null)),
    ]);
    const brief = briefRes.status === 'fulfilled' ? briefRes.value : null;
    const settings = settingsRes.status === 'fulfilled' ? settingsRes.value : null;
    if (brief) {
      syncIntentUi(brief.activeIntent?.text || '');
      if (brief.scene) paintScene(brief.scene);
      const adaptiveOn = settingEnabled(settings?.adaptive_volume_enabled, true);
      const suggested = brief.context?.suggestedVolume;
      if (!hasServerVolume && adaptiveOn && !brief.context?.coldStart && Number.isFinite(suggested)) {
        applyHeardVolume(suggested);
        adaptiveVolumeApplied = true;
      }
    }
  } catch { /* ignore */ }
}

// 服务端 WS 推 runtime 时同步进本地状态（仅当本地没有超前播放）
export function applyRuntime(runtime, { origin } = {}) {
  if (!runtime) return;
  // 自己刚 POST 出去的状态又广播回来时，不再 play / pause / playIndex。
  if (isOwnEcho(origin, getClientId())) return;
  if ('activeAgent' in runtime) activeAgent = runtime.activeAgent || null;
  if ('scene' in runtime) paintScene(runtime.scene);
  rememberQueueMeta(runtime);
  if (runtime.lastSay && runtime.lastSay !== appliedSay) {
    appliedSay = runtime.lastSay;
    setConsoleDialog(runtime.lastSay);
  }
  paintHostChrome();
  if (Number.isFinite(runtime.currentTime)) serverProgress = runtime.currentTime;
  if (typeof runtime.paused === 'boolean') state.serverPaused = runtime.paused;
  if (Number.isFinite(runtime.duration) && runtime.duration > 0) state.serverDuration = runtime.duration;
  if (state.isFollower) {
    syncFollowerRuntime(runtime);
    return;
  }
  const plan = planRuntimeSync({
    queue: state.queue,
    index: state.index,
    offset: state.offset,
    hasSrc: Boolean(audio?.getAttribute?.('src') || audio?.src),
    ended: Boolean(audio?.ended),
  }, runtime);
  const keepAdaptiveVolume = adaptiveVolumeApplied && runtime.volumeExplicit !== true;
  if (Number.isFinite(plan.volume) && !keepAdaptiveVolume) applyHeardVolume(plan.volume);
  else ensurePlaybackVolume();
  if (plan.applyQueue && plan.playIndex == null) {
    state.queue = plan.queue || [];
    state.index = plan.index;
    state.offset = plan.queueOffset;
    renderQueuePanel();
    if (!state.queue.length) {
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
  else if (plan.pause === false && audio?.paused && audio.src) {
    const command = planPlayCommand({ queueLength: state.queue.length, userActivated });
    if (!command.play || command.showOverlay) return;
    if (audio.ended) {
      try { audio.currentTime = 0; } catch { /* ended 元素有时要等 play() 自己回到开头 */ }
    }
    attemptPlay();
  }
}

// 外部 bot 推来的歌。replace 接管当前队列；append 只在没在播时开播。
export function applyExternalQueue({ mode, tracks, say, reason, queuedAt: at, agentId, agentName } = {}) {
  const list = Array.isArray(tracks) ? tracks.filter(track => track && track.title) : [];
  if (!list.length) return;
  if (agentName || agentId) {
    activeAgent = { id: agentId || null, name: agentName || agentId || null };
  }
  if (say) {
    appliedSay = say;
    setConsoleDialog(say);
  }
  if (reason) lastReason = reason;
  if (at) queuedAt = at;
  paintHostChrome();
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
    serverProgress = 0;
    state.serverPaused = false;
  }
  if (state.isFollower) {
    syncFollowerStage();
    return;
  }
  renderQueuePanel();
  if (!plan.autoplay) return;
  if (plan.resume) {
    playIndex(plan.playIndex ?? state.index, { autoplay: true, resume: true, startAt: audio?.currentTime || serverProgress });
    return;
  }
  if (plan.playIndex != null) playIndex(plan.playIndex, { autoplay: true });
}

async function resumeAsLeader() {
  if (!audio) return;
  audio.muted = false;
  ensurePlaybackVolume();
  if (!state.queue.length) {
    updatePlayButtons(false);
    return;
  }
  const idx = Math.max(0, Math.min(state.index, state.queue.length - 1));
  state.index = idx;
  const t = state.queue[idx];
  const resumeAt = Number.isFinite(serverProgress) ? Math.max(0, serverProgress) : 0;
  const autoplay = !state.serverPaused;

  if (playLoadIndex === idx + state.offset) return;

  const currentSrc = audio.getAttribute?.('src') || '';
  if (currentSrc && t?.audioUrl && currentSrc === t.audioUrl) {
    setStudioTrack(t);
    if (npBox) npBox.classList.remove('hidden');
    window.dispatchEvent(new CustomEvent('claudio:trackchange', { detail: t }));
    if (resumeAt > 0) seekAudioSafely(resumeAt, t);
    updateSeekBar(resumeAt, Number(audio.duration) || fallbackDurationSec(t));
    renderQueuePanel();
    if (autoplay) {
      const ok = await attemptPlay();
      if (!ok) updatePlayButtons(false);
    } else {
      updatePlayButtons(false);
    }
    return;
  }

  await playIndex(idx, {
    autoplay,
    startAt: resumeAt,
    restart: false,
  });
}

export function applyLeader(leader) {
  const prevFollower = Boolean(state.isFollower);
  const nextLeader = leader && leader.clientId
    ? { clientId: String(leader.clientId), kind: leader.kind === 'electron' ? 'electron' : 'pwa' }
    : null;
  state.leader = nextLeader;
  const myId = getClientId();
  const nextFollower = Boolean(nextLeader && nextLeader.clientId !== myId);
  state.isFollower = nextFollower;

  if (nextFollower) {
    activeSession = null;
    silenceFollowerAudio();
    dismissBootOverlay();
    syncFollowerStage({ forceTrackEvent: !prevFollower });
    return;
  }

  if (audio) audio.muted = false;
  if (prevFollower) {
    renderedFollowerKey = '';
    resumeAsLeader();
  }
}

export function applyRemoteProgress(evt = {}) {
  if (!evt || isOwnEcho(evt.origin, getClientId())) return;
  if (typeof evt.currentTime === 'number' && Number.isFinite(evt.currentTime)) {
    serverProgress = Math.max(0, evt.currentTime);
  }
  if (typeof evt.duration === 'number' && Number.isFinite(evt.duration) && evt.duration > 0) {
    state.serverDuration = evt.duration;
  }
  if (typeof evt.paused === 'boolean') {
    state.serverPaused = evt.paused;
  }
  if (!state.isFollower) return;
  silenceFollowerAudio();
  if (typeof evt.index === 'number' && Number.isFinite(evt.index) && state.queue.length) {
    const nextIdx = Math.max(0, Math.min(Math.trunc(evt.index), state.queue.length - 1));
    if (nextIdx !== state.index) {
      state.index = nextIdx;
      syncFollowerStage({ forceTrackEvent: true });
      return;
    }
  }
  const curTrack = currentTrack();
  updateSeekBar(serverProgress, fallbackDurationSec(curTrack));
  window.dispatchEvent(new CustomEvent('claudio:lyric-time', { detail: { currentTime: serverProgress } }));
  updatePlayButtons(state.queue.length > 0 && !state.serverPaused);
}

export function initPlayer() {
  audio     = $('#audio');
  npBox     = $('#now-playing');
  npTitle   = $('#np-title');
  npArtist  = $('#np-artist');

  document.addEventListener('click', markActivated, { capture: true, once: true });
  document.addEventListener('keydown', markActivated, { capture: true, once: true });

  audio.addEventListener('ended', async () => {
    if (state.isFollower) return;
    settleActiveSession('completed');
    if (state.index < state.queue.length - 1) {
      playIndex(state.index + 1);
    } else if (state.queue.length) {
      // 队尾先让服务端接续播池；没有续播时自然停下。
      await syncToServer(state.index, { paused: true, ended: true });
    } else {
      npBox.classList.add('hidden');
      syncToServer(state.index, { paused: true });
    }
  });

  // 歌曲加载失败（URL 过期、代理出错等）→ 跳到下一首，避免静默卡死
  audio.addEventListener('error', () => {
    if (state.isFollower) return;
    if (state.index < state.queue.length - 1) {
      playIndex(state.index + 1);
    } else {
      showAlert('音频加载失败');
    }
  });

  // 只对真实歌曲才清除 alert，避免 TTS 播放时把"酷狗搜索失败"之类的错误提示抹掉
  audio.addEventListener('play',  () => {
    if (state.isFollower) {
      silenceFollowerAudio();
      return;
    }
    state.serverPaused = false;
    syncToServer(state.index, { paused: false });
    reportProgress(true);
    updatePlayButtons(true);
    const cur = currentTrack();
    if (!cur?.isTts) {
      clearAlert();
      startTelemetrySession(cur);
    }
  });
  audio.addEventListener('pause', () => {
    if (state.isFollower) return;
    updatePlayButtons(false);
    // 换 src 会先冒出一次 pause。这次正在 playIndex 里，真正的暂停由 play 事件或显式 sync 报。
    if (suppressPauseSync) return;
    state.serverPaused = true;
    syncToServer(state.index, { paused: true, ended: Boolean(audio.ended) });
    reportProgress(true);
  });

  consolePlayBtn = $('[data-console-control="play-pause"]');
  consoleFavoriteBtn = $('[data-console-control="favorite"]');
  queueList = document.getElementById('queue-list');
  npSeek = document.getElementById('np-seek');
  npTimeCur = document.getElementById('np-time-cur');
  npTimeDur = document.getElementById('np-time-dur');
  npVol = document.getElementById('np-vol');
  applyLocalVolume();

  audio.addEventListener('timeupdate', () => {
    if (state.isFollower) return;
    updateSeekBar(audio.currentTime, audio.duration);
    reportProgress();
  });
  audio.addEventListener('durationchange', () => {
    if (state.isFollower) return;
    updateSeekBar(audio.currentTime, audio.duration);
  });
  audio.addEventListener('loadedmetadata', () => {
    if (state.isFollower) return;
    updateSeekBar(audio.currentTime, audio.duration);
  });
  audio.addEventListener('seeked', () => {
    if (state.isFollower) return;
    reportProgress(true);
  });

  if (npSeek) {
    npSeek.addEventListener('input', () => {
      if (state.isFollower) return;
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
      clearTimeout(volumeReportTimer);
      volumeReportTimer = setTimeout(() => {
        postMemoryTelemetry({ event: 'volume', volume, trigger: 'manual' });
      }, 600);
    });
  }

  bindConsoleControls();
  bindFeedback();
  bindQualityPicker();
  bindIntentForm();
  bindScenePills();
  updatePlayButtons(false);
  paintHostChrome();
  paintEdition();
  setInterval(paintEdition, 60 * 1000);

  bootOverlay = document.getElementById('boot-overlay');
  bootBtn = document.getElementById('boot-btn');
  if (bootBtn) {
    bootBtn.addEventListener('click', () => {
      markActivated();
      dismissBootOverlay();
      const plan = externalUnlockPlan({ queue: state.queue, index: state.index });
      if (plan.dialog) setConsoleDialog(plan.dialog);
      if (plan.playIndex != null) {
        const resume = Boolean(audio?.getAttribute('src')) && state.index === plan.playIndex;
        playIndex(plan.playIndex, { autoplay: true, resume, startAt: serverProgress });
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

  window.addEventListener('claudio:view-shown', e => {
    if (e.detail === 'player') hydrateMemoryContext({ hasServerVolume: true });
  });
  window.addEventListener('claudio:pixel-host', updatePixelHost);
  updatePixelHost();

  // 启动时拉一下当前队列 / 上次会话
  bootCurrent();
}

// 重连 / 回到前台时用：拉一次服务端全量状态。silent 不弹错误，keepOverlay 不关「点击开声」遮罩。
export async function syncFromServer(options = {}) {
  return bootCurrent(options);
}

async function bootCurrent({ silent = false, keepOverlay = false } = {}) {
  if (location.protocol === 'file:') return;

  try {
    const r = await fetch('/api/now');
    if (!r.ok) return;
    const data = await r.json();
    state.offset = data.queueOffset || 0;
    activeAgent = data.activeAgent || null;
    if (data.scene) paintScene(data.scene);
    paintHostChrome();
    rememberQueueMeta(data);
    if (Number.isFinite(data.volume)) applyHeardVolume(data.volume);
    else ensurePlaybackVolume();
    // 服务端 volume 总是有限数字（默认 30），只有 volumeExplicit 才代表用户真的设过。
    hydrateMemoryContext({ hasServerVolume: data.volumeExplicit === true });

    const apiProgress = Number(data.currentTime) || 0;
    if (!state.queue.length || apiProgress > serverProgress) serverProgress = apiProgress;
    if (Number.isFinite(data.duration) && data.duration > 0) state.serverDuration = data.duration;
    state.serverPaused = data.paused === true;
    const plan = planExternalBoot({ queue: data.queue, paused: data.paused === true });
    if (plan.dialog) setConsoleDialog(plan.dialog);
    if (!keepOverlay) dismissBootOverlay();
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
    if (state.isFollower) {
      syncFollowerStage();
      return;
    }
    renderQueuePanel();
    await playIndex(state.index, { autoplay: plan.play, startAt: serverProgress });
  } catch (err) {
    if (!silent) showAlert(`无法连接服务：${err.message}`);
  }
}
