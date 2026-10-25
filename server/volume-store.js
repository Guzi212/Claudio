// 播放音量存在 prefs，避免重启后又回到很大的默认值。
// 不在这里 import db.js，测试可以塞一个内存 prefs。

export const VOLUME_PREF_KEY = 'player_volume';
export const DEFAULT_VOLUME = 30;

function clampVolume(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function defaultVolume(env = process.env) {
  const raw = env?.CLAUDIO_DEFAULT_VOLUME;
  if (raw == null || String(raw).trim() === '') return DEFAULT_VOLUME;
  return clampVolume(raw) ?? DEFAULT_VOLUME;
}

export function readSavedVolume(db, env = process.env) {
  const fallback = defaultVolume(env);
  if (!db || typeof db.getPref !== 'function') return fallback;
  const saved = db.getPref(VOLUME_PREF_KEY);
  if (saved == null || String(saved).trim() === '') return fallback;
  return clampVolume(saved) ?? fallback;
}

// 第一次变化马上写。相同值跳过。间隔内的后续变化先挂着，到点写最后一次，避免拖动滑块时每次都打 prefs。
export function createVolumeSaver({
  db,
  now = () => Date.now(),
  minIntervalMs = 2000,
  schedule = (fn, delay) => setTimeout(fn, delay),
  initial = null,
} = {}) {
  let lastWritten = clampVolume(initial);
  let lastWriteAt = 0;
  let pending = null;
  let ticket = 0;
  let armedTicket = 0;

  function invalidateTimer() {
    armedTicket = 0;
  }

  function write(volume) {
    invalidateTimer();
    db.setPref(VOLUME_PREF_KEY, String(volume));
    lastWritten = volume;
    lastWriteAt = now();
    pending = null;
  }

  function flush() {
    if (pending == null) return;
    const volume = pending;
    pending = null;
    if (volume === lastWritten) return;
    write(volume);
  }

  function scheduleFlush(delay) {
    if (armedTicket !== 0) return;
    const token = ++ticket;
    armedTicket = token;
    schedule(() => {
      if (armedTicket !== token) return;
      armedTicket = 0;
      flush();
    }, Math.max(0, delay));
  }

  function remember(value, { force = false } = {}) {
    const volume = clampVolume(value);
    if (volume == null) return null;
    if (volume === lastWritten && pending == null) return volume;
    if (!force && volume === pending) return volume;

    const elapsed = lastWriteAt === 0 ? minIntervalMs : now() - lastWriteAt;
    if (force || elapsed >= minIntervalMs) {
      write(volume);
      return volume;
    }
    pending = volume;
    scheduleFlush(minIntervalMs - elapsed);
    return volume;
  }

  return { remember, flush };
}
