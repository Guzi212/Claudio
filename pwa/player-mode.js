// 外部模式下，开机遮罩只负责解锁浏览器自动播放。
// 点完之后播服务器当前队列和 index；队列空着就停在「等待点歌」。

export function externalUnlockPlan({ queue, index } = {}) {
  const list = Array.isArray(queue) ? queue : [];
  if (!list.length) return { playIndex: null, dialog: '等待点歌' };
  const raw = Number.isFinite(index) ? index : 0;
  const playIndex = Math.max(0, Math.min(raw, list.length - 1));
  return { playIndex, dialog: null };
}

export function allowsAutoRefill(brain, loopMode) {
  return brain === 'internal' && loopMode === 'auto';
}

// 打开页面时要不要自己播。暂停的会话保持暂停，空队列只提示，遮罩先不盖。
export function planExternalBoot({ queue, paused } = {}) {
  const list = Array.isArray(queue) ? queue : [];
  if (!list.length) return { play: false, showOverlay: false, dialog: '等待点歌' };
  if (paused === true) return { play: false, showOverlay: false, dialog: null };
  return { play: true, showOverlay: false, dialog: null };
}

// 出过声之后的 play 命令直接调 play()。遮罩只在 play() 真的被浏览器拒绝时才出现。
export function planPlayCommand({ queueLength = 0 } = {}) {
  if (!queueLength) return { play: false, showOverlay: false };
  return { play: true, showOverlay: false };
}

export function planPlayError(error) {
  if (!error) return { ok: true, userActivated: true, showOverlay: false };
  if (error.name === 'NotAllowedError') return { ok: false, userActivated: false, showOverlay: true };
  return { ok: false, userActivated: false, showOverlay: false };
}
