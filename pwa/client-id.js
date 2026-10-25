// 每个页面一份，不进 localStorage。别的标签页不是「自己」，不能共用这份 id。

export function getClientId() {
  const root = globalThis;
  if (!root.__claudioClientId) {
    const randomUUID = root.crypto?.randomUUID?.bind(root.crypto);
    root.__claudioClientId = randomUUID
      ? randomUUID()
      : `claudio-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  return root.__claudioClientId;
}
