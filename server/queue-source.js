// 播放队列从哪来。boot / scheduler 在自动换歌前看 queueSource，
// 外部点歌（bot）还没放完时不覆盖。聊天和歌单是用户明确操作，直接换。

export function markQueueSource(runtime, source) {
  if (!runtime) return;
  runtime.queueSource = source;
  runtime.trackEnded = false;
}

// 裁剪只换数组，不移动曲目的绝对位置；调用方决定何时回收历史。
export function trimPlayedHistory(runtime, keep) {
  const removed = Math.max(0, Math.min(runtime.index - keep, runtime.queue.length));
  runtime.queue = runtime.queue.slice(removed);
  runtime.index -= removed;
  runtime.queueOffset = (runtime.queueOffset || 0) + removed;
  return removed;
}

// 旧客户端不带 offset 时沿用当前队列；负索引表示曲目已经被裁掉。
export function reportedQueueIndex(runtime, { index, queueOffset } = {}) {
  if (typeof index !== 'number' || !Number.isFinite(index)) return undefined;
  const currentOffset = runtime.queueOffset || 0;
  const reportedOffset = Number.isSafeInteger(queueOffset) && queueOffset >= 0 ? queueOffset : currentOffset;
  return index + reportedOffset - currentOffset;
}

/**
 * 外部点歌写入的队列是否还没放完。
 * 放完 = 来源仍是 bot，但 index 已经在最后一首，且这一首已经自然结束。
 * 被聊天或歌单换掉之后 queueSource 不再是 bot，这里也会返回 false。
 */
export function hasActiveExternalQueue(runtime) {
  if (!runtime || runtime.queueSource !== 'bot') return false;
  const queue = runtime.queue;
  if (!Array.isArray(queue) || queue.length === 0) return false;
  const index = Number.isFinite(runtime.index) ? runtime.index : 0;
  if (index < queue.length - 1) return true;
  if (index > queue.length - 1) return false;
  return runtime.trackEnded !== true;
}

// 前端把播放位置镜像回服务端。index 变化说明换了一首，上一首的结束标记作废。
export function applyRuntimePlayback(runtime, { index, paused, ended } = {}) {
  if (!runtime) return { index: 0, paused: false };
  const queue = Array.isArray(runtime.queue) ? runtime.queue : [];
  if (typeof index === 'number' && Number.isFinite(index)) {
    const max = Math.max(queue.length - 1, 0);
    const next = Math.max(0, Math.min(index, max));
    if (next !== runtime.index) runtime.trackEnded = false;
    runtime.index = next;
  }
  if (typeof paused === 'boolean') runtime.paused = paused;
  if (typeof ended === 'boolean') runtime.trackEnded = ended;
  return { index: runtime.index, paused: Boolean(runtime.paused) };
}
