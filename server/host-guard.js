// DNS 重绑定：浏览器可能用 evil.com 这个名字连到 127.0.0.1。
// 只看 Host（以及 WebSocket 的 Origin），不看 X-Forwarded-Host。
// 默认放行 localhost、127.0.0.1、[::1]，带不带端口都行。
// 别的写法（0x7f.0.0.1、八进制、十进制整数 IP）对不上白名单，直接拒绝。

const DEFAULT_RULES = [
  { host: 'localhost', port: '' },
  { host: '127.0.0.1', port: '' },
  { host: '::1', port: '' },
];

export function parseHostSpec(raw) {
  if (Array.isArray(raw) || raw == null) return null;
  let text = String(raw).trim().toLowerCase();
  if (!text || text.length > 255) return null;
  if (/[\s\\@%/?#]/.test(text) || text.includes('..')) return null;
  if (text.endsWith('.')) text = text.slice(0, -1);
  if (!text) return null;

  let host = '';
  let port = '';

  if (text.startsWith('[')) {
    const match = text.match(/^\[([0-9a-f:.]+)\](?::(\d+))?$/);
    if (!match) return null;
    host = match[1];
    port = match[2] || '';
  } else {
    const first = text.indexOf(':');
    const last = text.lastIndexOf(':');
    if (first !== -1 && first === last) {
      const maybeHost = text.slice(0, first);
      const maybePort = text.slice(first + 1);
      if (!maybeHost) return null;
      if (/^\d+$/.test(maybePort)) {
        if (maybePort.length > 5 || Number(maybePort) > 65535) return null;
        host = maybeHost;
        port = maybePort;
      } else if (maybePort === '') {
        return null;
      } else {
        host = text;
      }
    } else {
      // 多个冒号：裸 IPv6（::1）。不要按最后一个冒号切，否则端口会变成 1。
      host = text;
    }
  }

  if (!host) return null;
  if (isAmbiguousAddress(host)) return null;
  return { host, port };
}

function isAmbiguousAddress(host) {
  return host.split('.').some(label =>
    /^0x/i.test(label) || (label.length > 1 && /^0\d+$/.test(label)),
  );
}

export function allowedHostRules(env = process.env) {
  const extra = String(env.CLAUDIO_ALLOWED_HOSTS || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .map(parseHostSpec)
    .filter(Boolean);
  return [...DEFAULT_RULES, ...extra];
}

function ruleMatches(rule, actual) {
  if (rule.host !== actual.host) return false;
  if (!rule.port) return true;
  return rule.port === actual.port;
}

export function hostAllowed(hostHeader, env = process.env) {
  const parsed = parseHostSpec(hostHeader);
  if (!parsed) return false;
  return allowedHostRules(env).some(rule => ruleMatches(rule, parsed));
}

export function originAllowed(origin, env = process.env) {
  if (origin == null) return true;
  if (typeof origin !== 'string') return false;
  const text = origin.trim();
  if (!text) return true;
  if (text.toLowerCase() === 'null') return false;

  let url;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (!url.hostname) return false;

  const header = url.hostname.includes(':')
    ? (url.port ? `[${url.hostname}]:${url.port}` : `[${url.hostname}]`)
    : (url.port ? `${url.hostname}:${url.port}` : url.hostname);
  return hostAllowed(header, env);
}

export function hostGuard(req, res, next) {
  if (hostAllowed(req?.headers?.host)) {
    next();
    return;
  }
  res.status(403).json({ ok: false, error: 'forbidden host' });
}
