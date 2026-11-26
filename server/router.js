/**
 * intent 分流（供弃用过渡期 /api/chat 解析斜杠控制命令）。
 *
 *   - 以 `/` 开头 → control（直连播放控制）
 *   - 其他一切 → chat（返回外部主持提示）
 */

const CONTROL_RE = /^\/([a-z]+)(?:\s+(.*))?$/i;

const KNOWN_COMMANDS = new Set([
  'skip', 'next',
  'prev', 'back',
  'pause',
  'play', 'resume',
  'toggle',
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
