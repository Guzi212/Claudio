// 页面自己记一份音量。/api/now 和 WebSocket 状态到达之前先用它，避免滑块先停在很大的值。
export const VOLUME_STORAGE_KEY = 'claudio:volume';
export const DEFAULT_VOLUME = 30;

function clampVolume(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function readLocalVolume(storage = globalThis.localStorage) {
  try {
    const volume = clampVolume(storage?.getItem?.(VOLUME_STORAGE_KEY));
    return volume == null ? DEFAULT_VOLUME : volume;
  } catch {
    return DEFAULT_VOLUME;
  }
}

export function writeLocalVolume(value, storage = globalThis.localStorage) {
  const volume = clampVolume(value);
  if (volume == null) return null;
  try {
    storage?.setItem?.(VOLUME_STORAGE_KEY, String(volume));
  } catch { /* 隐私模式写不进去时，这次播放仍用内存里的音量 */ }
  return volume;
}
