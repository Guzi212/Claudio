// 系统媒体键和前台空格。挂在播放运行时这一层，不进具体视图。
// 动作只 POST /api/control，不带 clientId。服务端广播没有 origin，
// 页面会把它当成外部命令，走原来的播放、回声和音量记忆。
import { getClientId } from './client-id.js';
import { isOwnEcho } from './runtime-sync.js';

export const MEDIA_ACTIONS = {
  play: 'play',
  pause: 'pause',
  previoustrack: 'prev',
  nexttrack: 'next',
};

const COVER_KEYS = ['cover', 'pic', 'image', 'artwork', 'img', 'albumCover', 'coverUrl'];
const TYPING_ROLES = new Set(['textbox', 'searchbox', 'combobox']);
const ARTWORK_SIZES = ['96x96', '128x128', '192x192', '256x256', '512x512'];

export function currentTrack(runtime) {
  const queue = Array.isArray(runtime?.queue) ? runtime.queue : [];
  if (!queue.length) return null;
  const index = Number.isFinite(runtime.index) ? runtime.index : 0;
  const safe = Math.max(0, Math.min(Math.trunc(index), queue.length - 1));
  return queue[safe] || null;
}

export function coverField(track) {
  if (!track || typeof track !== 'object') return '';
  for (const key of COVER_KEYS) {
    const value = track[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function artworkType(src) {
  const path = String(src || '').split(/[?#]/)[0].toLowerCase();
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

export function artworkEntries(src) {
  if (!src) return [];
  const type = artworkType(src);
  return ARTWORK_SIZES.map(sizes => ({ src, sizes, type }));
}

export function resolveArtworkUrl(track, { fallback = '', base = '' } = {}) {
  const chosen = coverField(track) || fallback;
  if (!chosen) return '';
  try {
    return new URL(chosen, base || undefined).href;
  } catch {
    return chosen;
  }
}

export function metadataFields(track, { iconUrl = '', base = '' } = {}) {
  if (!track || (!track.title && !track.artist)) return null;
  const src = resolveArtworkUrl(track, { fallback: iconUrl, base: base || iconUrl });
  return {
    title: String(track.title || ''),
    artist: String(track.artist || ''),
    album: String(track.album || ''),
    artwork: artworkEntries(src),
  };
}

export function playbackStateFor(runtime) {
  if (!currentTrack(runtime)) return 'none';
  return runtime?.paused ? 'paused' : 'playing';
}

export function shouldApplyPlaybackState(origin, clientId) {
  return !isOwnEcho(origin, clientId);
}

export function isTypingTarget(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable === true) return true;
  const role = String(el.getAttribute?.('role') || '').toLowerCase();
  return TYPING_ROLES.has(role);
}

export function shouldToggleOnSpace(event, doc) {
  if (!event || event.repeat || event.isComposing) return false;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  if (event.key !== ' ' && event.key !== 'Spacebar') return false;
  if (doc?.visibilityState && doc.visibilityState !== 'visible') return false;
  if (typeof doc?.hasFocus === 'function' && !doc.hasFocus()) return false;
  const nodes = [];
  if (typeof event.composedPath === 'function') nodes.push(...event.composedPath());
  else if (event.target) nodes.push(event.target);
  if (doc?.activeElement) nodes.push(doc.activeElement);
  if (nodes.some(node => isTypingTarget(node))) return false;
  return true;
}

export function postControl(command, { fetchImpl = globalThis.fetch, base = '' } = {}) {
  const root = String(base || '').replace(/\/$/, '');
  return fetchImpl(`${root}/api/control`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command }),
  });
}

function assignMetadata(session, fields, Metadata) {
  if (!session) return;
  if (!fields) {
    session.metadata = null;
    return;
  }
  const Ctor = Metadata || globalThis.MediaMetadata;
  if (typeof Ctor === 'function') {
    try {
      session.metadata = new Ctor(fields);
      return;
    } catch { /* 构造失败时退回普通对象，测试和旧浏览器仍能读到字段 */ }
  }
  session.metadata = fields;
}

function setPlaybackState(session, state) {
  if (!session) return;
  session.playbackState = state;
}

function publishMetadata(session, track, env) {
  assignMetadata(session, metadataFields(track, {
    iconUrl: env.artworkFallback || '',
    base: env.base || env.artworkFallback || '',
  }), env.MediaMetadata);
}

export function bindMediaSession(env = {}) {
  const session = env.navigator?.mediaSession || null;
  const post = env.postControl;
  if (session && typeof session.setActionHandler === 'function' && typeof post === 'function') {
    for (const [action, command] of Object.entries(MEDIA_ACTIONS)) {
      try {
        session.setActionHandler(action, () => post(command));
      } catch { /* 这个浏览器不支持该动作 */ }
    }
  }

  const doc = env.document;
  const onKey = (event) => {
    if (typeof post !== 'function') return;
    if (!shouldToggleOnSpace(event, doc)) return;
    event.preventDefault?.();
    post('toggle');
  };
  doc?.addEventListener?.('keydown', onKey, true);

  const onTrack = (event) => {
    publishMetadata(session, event?.detail || null, env);
    if (!event?.detail) setPlaybackState(session, 'none');
  };
  env.window?.addEventListener?.('claudio:trackchange', onTrack);

  const onMedia = (event) => {
    if (String(event?.target?.tagName || '').toUpperCase() !== 'AUDIO') return;
    setPlaybackState(session, event.type === 'play' ? 'playing' : 'paused');
  };
  doc?.addEventListener?.('play', onMedia, true);
  doc?.addEventListener?.('pause', onMedia, true);

  return {
    noteRuntime(runtime, meta = {}) {
      publishMetadata(session, currentTrack(runtime), env);
      if (meta.metadataOnly) return;
      const clientId = meta.clientId || getClientId();
      if (shouldApplyPlaybackState(meta.origin, clientId)) {
        setPlaybackState(session, playbackStateFor(runtime));
      }
    },
  };
}

export function installMediaSession(overrides = {}) {
  const doc = overrides.document || globalThis.document;
  const win = overrides.window || globalThis.window;
  const nav = overrides.navigator || globalThis.navigator;
  const fetchImpl = overrides.fetch || globalThis.fetch;
  const loc = overrides.location || globalThis.location;
  const origin = loc?.origin || '';
  const fallback = overrides.artworkFallback || (origin ? new URL('/icon.svg', origin).href : '/icon.svg');
  const send = (command) => Promise.resolve(
    postControl(command, { fetchImpl, base: '' }),
  ).catch(() => {});
  const api = bindMediaSession({
    document: doc,
    window: win,
    navigator: nav,
    artworkFallback: fallback,
    base: origin,
    MediaMetadata: overrides.MediaMetadata,
    postControl: send,
  });
  if (typeof fetchImpl === 'function' && loc?.protocol !== 'file:') {
    Promise.resolve(fetchImpl('/api/now', { credentials: 'same-origin' }))
      .then(res => (res && res.ok && typeof res.json === 'function' ? res.json() : null))
      .then(data => { if (data) api.noteRuntime(data); })
      .catch(() => {});
  }
  return api;
}
