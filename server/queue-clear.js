import { playbackStatus } from './playback-control.js';
import { notePlaybackActivity, queueEpochOf } from './queue-source.js';

export const CLEAR_REASON_MAX = 200;

/**
 * 正式清空播放列表。
 *
 * 只清播放队列与进度；续播池、音量、收藏、播放历史和磁盘文件都不动。
 * 续播池改成 suspend：continueSuppressed=true 让 continueFromPool 直接返回 false，
 * 常驻 DJ 的 shouldRefill 也会让位。递增 queueEpoch 是在途异步写回的栅栏。
 */
export function clearQueue(runtime, { reason = '' } = {}) {
  if (!runtime || typeof runtime !== 'object') {
    return { ok: false, status: 500, error: 'runtime 不可用' };
  }

  const alreadyEmpty = !Array.isArray(runtime.queue) || runtime.queue.length === 0;

  runtime.queue = [];
  runtime.index = 0;
  runtime.queueOffset = 0;
  runtime.paused = true;
  runtime.currentTime = 0;
  runtime.duration = 0;
  runtime.trackEnded = false;
  runtime.queueSource = null;
  runtime.queuedAt = null;
  runtime.queuedSource = '';
  runtime.queueEpoch = queueEpochOf(runtime) + 1;
  runtime.continueSuppressed = true;

  const trimmed = String(reason ?? '').trim();
  if (trimmed) runtime.lastReason = Array.from(trimmed).slice(0, CLEAR_REASON_MAX).join('');

  notePlaybackActivity(runtime);

  const status = playbackStatus(runtime);
  return {
    ok: true,
    cleared: true,
    alreadyEmpty,
    queueLen: status.queue.length,
    index: status.index,
    paused: status.paused,
    currentTime: status.currentTime,
    duration: status.duration,
    nowPlaying: status.nowPlaying,
    queue: status.queue,
    queueOffset: status.queueOffset,
    queueEpoch: status.queueEpoch,
    continueSuppressed: status.continueSuppressed,
    continuePool: status.continuePool,
    volume: status.volume,
    volumeExplicit: status.volumeExplicit,
  };
}
