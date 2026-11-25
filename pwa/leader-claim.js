// 「在此设备播放」的本地意图记录与发起。
// 只在本页生命周期内记住（globalThis，不进 storage）：断线重连后自动重发，
// 刷新 / 重新打开页面不抢权，回到默认选举（桌面优先）。

const WANT_KEY = '__claudioWantsPlayback';

export function wantsPlaybackHere() {
  return Boolean(globalThis[WANT_KEY]);
}

export function setWantsPlaybackHere(want) {
  globalThis[WANT_KEY] = Boolean(want);
}

// 页面侧只发 DOM 事件；app.js 的全局 WS 统一把它写进 identify 消息。
// want: true 认领 / false 归还。
export function requestPlaybackHere(want = true) {
  setWantsPlaybackHere(want);
  try {
    globalThis.dispatchEvent?.(new CustomEvent('claudio:leader-claim', {
      detail: { want: Boolean(want) },
    }));
  } catch { /* 非浏览器环境（测试）静默 */ }
}
