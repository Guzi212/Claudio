// 服务端广播的 runtime 怎么落到本地播放器。同一首正在播就别打断。
// 自然结束不等于换歌：队列和 index 都没变时，不要因为 ended 再 load 一次。

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

export function isOwnEcho(origin, clientId) {
  return typeof origin === 'string' && origin.length > 0 && origin === clientId;
}

// 同一首还在等直链或等 play() 时，后来的同 index 调用直接丢掉。
export function claimPlayLoad(loading, index) {
  if (loading === index) return { accept: false, loading };
  return { accept: true, loading: index };
}

export function planRuntimeSync(local = {}, remote = {}) {
  const volume = Number.isFinite(remote.volume) ? remote.volume : null;
  if (!Array.isArray(remote.queue)) {
    return { volume, applyQueue: false, queue: null, playIndex: null, pause: null, restart: false };
  }
  const pause = typeof remote.paused === 'boolean' ? remote.paused : null;
  const index = Number.isFinite(remote.index) ? remote.index : 0;
  if (!remote.queue.length) {
    return { volume, applyQueue: local.queue?.length > 0, queue: [], playIndex: null, pause: true, restart: false };
  }
  const clamped = Math.max(0, Math.min(index, remote.queue.length - 1));
  const sameTrack = local.index === clamped
    && trackKey(local.queue?.[local.index]) === trackKey(remote.queue[clamped])
    && Boolean(local.hasSrc);
  if (sameTrack) {
    const queueChanged = !sameQueue(local.queue, remote.queue);
    // 这首已经播完，外部又发了 play：从头再播一次。暂停广播不能借 ended 再 load。
    if (local.ended && pause === false) {
      return {
        volume,
        applyQueue: queueChanged,
        queue: remote.queue,
        playIndex: clamped,
        pause: false,
        restart: true,
      };
    }
    return {
      volume,
      applyQueue: queueChanged,
      queue: remote.queue,
      playIndex: null,
      pause,
      restart: false,
    };
  }
  return { volume, applyQueue: true, queue: remote.queue, playIndex: clamped, pause, restart: false };
}
