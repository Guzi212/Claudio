// 播放队列从哪来。boot / scheduler 在自动换歌前看 queueSource，
// 外部点歌（bot）还没放完时不覆盖。聊天和歌单是用户明确操作，直接换。

export const PAUSE_RESET_MS = 10 * 60_000;

// 队列版本号。clear 和每一次明确点歌都会递增，在途的异步写回带上旧值就不许再改队列。
export function queueEpochOf(runtime) {
  const n = runtime?.queueEpoch;
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

export function bumpQueueEpoch(runtime) {
  if (!runtime || typeof runtime !== 'object') return 0;
  runtime.queueEpoch = queueEpochOf(runtime) + 1;
  return runtime.queueEpoch;
}

export function newRuntimeInstanceId(random = Math.random, now = Date.now) {
  return `${now().toString(36)}-${random().toString(36).slice(2, 10)}`;
}

export function runtimeInstanceIdOf(runtime) {
  const id = runtime?.runtimeInstanceId;
  return typeof id === 'string' && id.trim() ? id.trim() : '';
}

// 写回是否过期：
// - 带 queueEpoch：必须等于当前值，否则视为过期；
// - 不带 queueEpoch：旧客户端。进程内发生过 clear（requireQueueEpoch 永久置位）之后
//   一律视为过期；没发生过 clear 时保持旧行为。
export function queueWriteIsStale(runtime, body = {}) {
  const raw = body?.queueEpoch;
  if (raw !== undefined && raw !== null && raw !== '') {
    const n = Number(raw);
    return !Number.isInteger(n) || n !== queueEpochOf(runtime);
  }
  return Boolean(runtime?.requireQueueEpoch) || Boolean(runtime?.continueSuppressed);
}

// clear 之后、下一次明确点歌之前：空队列锁定播放状态，只允许调音量。
export function queuePlaybackLocked(runtime) {
  const queue = Array.isArray(runtime?.queue) ? runtime.queue : [];
  return queue.length === 0 && Boolean(runtime?.continueSuppressed);
}

// 用户/主持人明确点歌后，允许新队列重新走正常续播逻辑。
export function clearContinueSuppression(runtime) {
  if (runtime && typeof runtime === 'object' && runtime.continueSuppressed) {
    runtime.continueSuppressed = false;
  }
}

export function queueFinished(runtime = {}) {
  const queue = Array.isArray(runtime.queue) ? runtime.queue : [];
  if (!queue.length || runtime.trackEnded !== true) return false;
  const index = Number.isFinite(runtime.index) ? runtime.index : 0;
  return index >= queue.length - 1;
}

export function notePlaybackActivity(runtime, now = Date.now()) {
  if (!runtime || typeof runtime !== 'object') return;
  const queue = Array.isArray(runtime.queue) ? runtime.queue : [];
  const playing = queue.length > 0 && !runtime.paused && !queueFinished(runtime);
  if (playing) {
    if (Number.isFinite(runtime.pausedSinceTs) && now - runtime.pausedSinceTs >= PAUSE_RESET_MS) {
      runtime.continuousSinceTs = now;
    } else if (!Number.isFinite(runtime.continuousSinceTs)) {
      runtime.continuousSinceTs = now;
    }
    runtime.pausedSinceTs = null;
    return;
  }
  if (!Number.isFinite(runtime.pausedSinceTs)) {
    runtime.pausedSinceTs = now;
  }
  if (now - runtime.pausedSinceTs >= PAUSE_RESET_MS) {
    runtime.continuousSinceTs = null;
  }
}

export function continuousListenMinutes(runtime = {}, now = Date.now()) {
  if (!Number.isFinite(runtime?.continuousSinceTs)) return 0;
  if (Number.isFinite(runtime?.pausedSinceTs)) {
    if (now - runtime.pausedSinceTs >= PAUSE_RESET_MS) return 0;
    return Math.max(0, Math.floor((runtime.pausedSinceTs - runtime.continuousSinceTs) / 60_000));
  }
  return Math.max(0, Math.floor((now - runtime.continuousSinceTs) / 60_000));
}

export function markQueueSource(runtime, source) {
  if (!runtime) return;
  runtime.queueSource = source;
  runtime.trackEnded = false;
  notePlaybackActivity(runtime);
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
  notePlaybackActivity(runtime);
  return { index: runtime.index, paused: Boolean(runtime.paused) };
}
