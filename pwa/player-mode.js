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
