// 页面自己报上来的状态，广播时带上 origin，方便页面认出回声。
// 控制接口、外部点歌、歌单播放这些来源不带 clientId，广播里就没有 origin。

export function stateBroadcast(runtime, clientId) {
  const event = { type: 'state', runtime };
  if (typeof clientId === 'string' && clientId.trim()) event.origin = clientId.trim();
  return event;
}
