/**
 * intent 分流。
 *
 * MVP 阶段：
 *   - 以 `/` 开头 → control（跳过 Claude，直连播放器）
 *   - 其他一切 → chat（走 Claude 子进程）
 *
 * "搜索直连"（例如 "放周杰伦的晴天" 不进 Claude）现阶段不做：
 * 让 Claude 处理一切自然语言，反正它在 dj-persona.md 里已经被教会"用户明确指定单曲时只返回 1 条 play"。
 */

const CONTROL_RE = /^\/([a-z]+)(?:\s+(.*))?$/i;

const KNOWN_COMMANDS = new Set([
  'skip', 'next',
  'prev', 'back',
  'pause',
  'play', 'resume',
  'stop',
  'vol', 'volume',
  'mute',
  'queue',
  'now',
  'help',
]);

export function route(message) {
  const text = String(message || '').trim();
  if (!text) return { intent: 'noop', raw: text };

  const m = text.match(CONTROL_RE);
  if (m) {
    const cmd = m[1].toLowerCase();
    const arg = (m[2] || '').trim();
    if (KNOWN_COMMANDS.has(cmd)) {
      return { intent: 'control', command: cmd, arg, raw: text };
    }
    return { intent: 'unknown-command', command: cmd, raw: text };
  }

  return { intent: 'chat', raw: text };
}

export default { route };
