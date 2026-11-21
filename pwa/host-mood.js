// 像素主题数码小人主持人状态映射与开关存储（纯函数 + 最小 DOM 副作用）
export const PIXEL_HOST_KEY = 'claudio:pixel-host';

export const PIXEL_HOST_SPRITES = {
  listen: 'assets/pixel/host-listen.webp',
  overwhelmed: 'assets/pixel/host-overwhelmed.webp',
  conductor: 'assets/pixel/host-conductor.webp',
  thumbsup: 'assets/pixel/host-thumbsup.webp',
  wave: 'assets/pixel/host-wave.webp',
  head: 'assets/pixel/host-head.webp',
};

/**
 * 根据播放态与短暂反馈返回像素小人素材路径。
 * 优先级：flash ('like'|'dislike') > queueEmpty > loading > playing > paused
 */
export function hostSprite({ playing = false, loading = false, queueEmpty = false, flash = null } = {}) {
  if (flash === 'like') return PIXEL_HOST_SPRITES.thumbsup;
  if (flash === 'dislike') return PIXEL_HOST_SPRITES.overwhelmed;
  if (queueEmpty) return PIXEL_HOST_SPRITES.wave;
  if (loading) return PIXEL_HOST_SPRITES.conductor;
  if (playing) return PIXEL_HOST_SPRITES.listen;
  return PIXEL_HOST_SPRITES.wave;
}

export function readPixelHostEnabled() {
  try {
    const raw = localStorage.getItem(PIXEL_HOST_KEY);
    if (raw === 'false' || raw === '0' || raw === 'off') return false;
    return true;
  } catch {
    return true;
  }
}

export function applyPixelHostSetting(enabled = true, { persist = true } = {}) {
  const on = Boolean(enabled);
  if (globalThis.document?.documentElement?.dataset) {
    document.documentElement.dataset.pixelHost = on ? 'on' : 'off';
  }
  if (persist) {
    try {
      localStorage.setItem(PIXEL_HOST_KEY, on ? 'true' : 'false');
    } catch { /* ignore storage errors */ }
  }
  try {
    if (typeof globalThis.window?.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('claudio:pixel-host', { detail: { enabled: on } }));
    }
  } catch { /* ignore in test env */ }
  return on;
}
