// 服务端广播的 runtime 怎么落到本地播放器。同一首正在播就别打断。

function trackKey(track) {
  if (!track || typeof track !== 'object') return '';
  if (track.kugouId) return `id:${track.kugouId}`;
  if (track.audioUrl) return `url:${track.audioUrl}`;
  return `t:${track.title || ''}\0${track.artist || ''}`;
}

function sameQueue(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (trackKey(left[i]) !== trackKey(right[i])) return false;
  }
  return true;
}

export function planRuntimeSync(local = {}, remote = {}) {
  const volume = Number.isFinite(remote.volume) ? remote.volume : null;
  if (!Array.isArray(remote.queue)) {
    return { volume, applyQueue: false, queue: null, playIndex: null, pause: null };
  }
  const pause = typeof remote.paused === 'boolean' ? remote.paused : null;
  const index = Number.isFinite(remote.index) ? remote.index : 0;
  if (!remote.queue.length) {
    return { volume, applyQueue: local.queue?.length > 0, queue: [], playIndex: null, pause: true };
  }
  const clamped = Math.max(0, Math.min(index, remote.queue.length - 1));
  const same = sameQueue(local.queue, remote.queue)
    && local.index === clamped
    && Boolean(local.hasSrc)
    && !local.ended;
  if (same) {
    return { volume, applyQueue: false, queue: remote.queue, playIndex: null, pause };
  }
  return { volume, applyQueue: true, queue: remote.queue, playIndex: clamped, pause };
}
