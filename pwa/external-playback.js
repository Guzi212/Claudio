// 外部歌单到达浏览器后的播放决策。纯函数，方便单测。
//
// replace：bot 在接管这一轮，从第 0 首开始播。
// append：已经在播就只把新歌接到队尾；队列是空的、还没有音源、或上一首已经
// 播完时，才从新歌的第一首开始。中途暂停不自动开播。

export function planExternalPlayback(player = {}, event = {}) {
  const incoming = Number(event.incoming) || 0;
  if (incoming <= 0) return { playIndex: null };

  if (event.mode === 'append') {
    const queueLength = Number(player.queueLength) || 0;
    const shouldPlay = queueLength === 0 || !player.hasSrc || Boolean(player.ended);
    return { playIndex: shouldPlay ? queueLength : null };
  }

  return { playIndex: 0 };
}
