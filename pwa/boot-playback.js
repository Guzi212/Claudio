// 开机响应落到播放器时怎么处理。纯函数，方便单测。
//
// 普通开机：换成响应里的队列，从第 0 首开始。
// 服务端保住了外部点歌（skipped / preserved=external）：采用它返回的队列和 index。
// 本地已经在播同一轮、同一首，就不要再 play 一次把歌打断。

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

export function planBootPlayback(player = {}, data = {}) {
  const queue = Array.isArray(data.queue) ? data.queue : [];
  if (!queue.length) return { applyQueue: false, playIndex: null, index: player.index ?? 0 };

  const preserved = data.skipped === true || data.preserved === 'external';
  if (!preserved) return { applyQueue: true, playIndex: 0, index: 0 };

  const rawIndex = Number.isFinite(data.index) ? data.index : 0;
  const index = Math.max(0, Math.min(rawIndex, queue.length - 1));
  const alreadyPlaying = sameQueue(player.queue, queue)
    && player.index === index
    && Boolean(player.hasSrc)
    && !player.ended;
  if (alreadyPlaying) return { applyQueue: false, playIndex: null, index };
  return { applyQueue: true, playIndex: index, index };
}
