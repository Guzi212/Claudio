// 外部歌单到达浏览器后的播放决策。纯函数，方便单测。
//
// replace：从第 0 首开始播，哪怕刚才暂停着。
// append：正在播就只接到队尾。暂停着、队列是空的、还没有音源、或上一首已经
// 播完时，直接接着放。遮罩不在这里决定，play() 被拒绝才盖。

function quiet() {
  return { playIndex: null, autoplay: false, showOverlay: false, resume: false };
}

export function planExternalPlayback(player = {}, event = {}) {
  const incoming = Number(event.incoming) || 0;
  if (incoming <= 0) return quiet();

  if (event.mode === 'append') {
    const queueLength = Number(player.queueLength) || 0;
    const playing = queueLength > 0 && player.hasSrc && !player.ended && !player.paused;
    if (playing) return quiet();
    const resume = queueLength > 0 && player.hasSrc && !player.ended && Boolean(player.paused);
    if (resume) {
      const index = Number.isFinite(player.index) ? player.index : 0;
      return {
        playIndex: Math.max(0, Math.min(index, queueLength - 1)),
        autoplay: true,
        showOverlay: false,
        resume: true,
      };
    }
    return { playIndex: queueLength, autoplay: true, showOverlay: false, resume: false };
  }

  return { playIndex: 0, autoplay: true, showOverlay: false, resume: false };
}
