// /api/proxy 的目标白名单：替受信任音乐源音频和图片域名转发，挡掉 SSRF。
//
// 只按域名判断，不做 DNS 解析后再按 IP 拦：开着 Clash fake-IP 时域名会解析到
// 198.18.x.x，按 IP 拦会把正常播放拦掉。这里只额外排除「主机名本身就是 IP」的情况。
//
// 白名单默认包含酷狗、网易云、QQ 音乐实测 CDN 域及其子域，可用 CLAUDIO_PROXY_ALLOWED_HOSTS
// （逗号分隔）追加。漏了某个 CDN 域名时在 .env 里补一行就能恢复播放。

export const DEFAULT_ALLOWED_HOSTS = [
  'kugou.com',
  'kgimg.com',
  'music.126.net',
  'music.163.com',
  'qqmusic.qq.com',
  'tc.qq.com',
  'y.qq.com',
  'y.gtimg.cn',
];

// 被拒目标统一带这个 code，路由层据此返回 403 而不是 502。
export const BLOCKED_CODE = 'CLAUDIO_PROXY_BLOCKED';

export function normalizeHost(raw) {
  let host = String(raw ?? '').trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  while (host.startsWith('.')) host = host.slice(1);
  while (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

/**
 * 主机名是不是 IP 字面量。
 * 覆盖 IPv6（含 ::ffff:127.0.0.1 这类映射写法）、点分十进制、整数十进制、
 * 以及 0x7f000001 / 0x7f.0.0.1 这类十六进制写法。
 * WHATWG URL 会先把十进制 / 十六进制写法归一成点分十进制，这里多一层是为了
 * 直接拿裸主机名调用时也不会漏。
 */
export function isIpLiteralHost(rawHost) {
  const host = normalizeHost(rawHost);
  if (!host) return false;
  if (host.includes(':')) return true;

  const parts = host.split('.');
  if (parts.some(part => part === '')) return false;
  const decimal = /^\d{1,3}$/;
  const hex = /^0x[0-9a-f]{1,8}$/i;

  if (parts.length === 4 && parts.every(part => decimal.test(part) && Number(part) <= 255)) return true;
  if (parts.length === 1 && /^\d+$/.test(host)) return true;
  if (parts.every(part => hex.test(part) || decimal.test(part)) && parts.some(part => hex.test(part))) return true;
  return false;
}

/** 默认白名单 + CLAUDIO_PROXY_ALLOWED_HOSTS / PROXY_ALLOWED_HOSTS 追加项（已归一化、去重）。 */
export function allowedHosts(env = process.env) {
  const hosts = new Set(DEFAULT_ALLOWED_HOSTS);
  const rawList = [
    env?.CLAUDIO_PROXY_ALLOWED_HOSTS,
    env?.PROXY_ALLOWED_HOSTS,
  ].filter(Boolean).join(',');
  for (const raw of rawList.split(',')) {
    const host = normalizeHost(raw);
    // 只接受纯域名，避免把带端口 / 路径 / 协议的东西塞进来
    if (!host || host.includes(':') || host.includes('/')) continue;
    hosts.add(host);
  }
  return [...hosts];
}

/**
 * 判定一个地址能不能转发。
 * 返回 { ok, reason, hostname }；hostname 已归一化，日志只用它，不打完整 URL。
 */
export function checkProxyUrl(rawUrl, env = process.env) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl ?? ''));
  } catch {
    return { ok: false, reason: 'invalid-url', hostname: '' };
  }

  const hostname = normalizeHost(parsed.hostname);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'protocol', hostname };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'credentials', hostname };
  }
  if (!hostname) return { ok: false, reason: 'no-host', hostname };
  if (isIpLiteralHost(hostname)) return { ok: false, reason: 'ip-literal', hostname };

  const allowed = allowedHosts(env).some(
    entry => hostname === entry || hostname.endsWith(`.${entry}`),
  );
  return { ok: allowed, reason: allowed ? '' : 'not-allowed', hostname };
}

export function isAllowedProxyUrl(rawUrl, env = process.env) {
  return checkProxyUrl(rawUrl, env).ok;
}

function hostMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function refererForProxyUrl(rawUrl) {
  let hostname = '';
  try {
    hostname = normalizeHost(new URL(String(rawUrl ?? '')).hostname);
  } catch {
    return 'https://www.kugou.com';
  }
  if (!hostname) return 'https://www.kugou.com';
  if (hostMatches(hostname, 'music.126.net') || hostMatches(hostname, 'music.163.com')) {
    return 'https://music.163.com/';
  }
  if (
    hostMatches(hostname, 'qqmusic.qq.com')
    || hostMatches(hostname, 'tc.qq.com')
    || hostMatches(hostname, 'y.qq.com')
    || hostMatches(hostname, 'y.gtimg.cn')
  ) {
    return 'https://y.qq.com/';
  }
  return 'https://www.kugou.com';
}

const AUDIO_EXT_MIME = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.opus': 'audio/opus',
  '.webm': 'audio/webm',
};

/**
 * 修正上游 CDN 返回 application/octet-stream 或非标准 audio/x-flac 的情况：
 * /api/proxy 路径不含扩展名，iOS Safari CoreMedia 依赖标准 audio/* Content-Type 才能稳定做分段流式播放。
 */
export function inferProxyContentType(targetUrl, upstreamContentType = '') {
  const raw = String(upstreamContentType || '').trim();
  const base = raw.split(';')[0].trim().toLowerCase();
  const needsInfer = !base
    || base === 'application/octet-stream'
    || base === 'binary/octet-stream'
    || base === 'audio/x-flac';
  if (!needsInfer) return raw;
  try {
    const pathname = new URL(String(targetUrl || '')).pathname.toLowerCase();
    const dot = pathname.lastIndexOf('.');
    const ext = dot >= 0 ? pathname.slice(dot) : '';
    if (AUDIO_EXT_MIME[ext]) return AUDIO_EXT_MIME[ext];
  } catch { /* ignore */ }
  return raw;
}

function proxyBlockedError(reason, hostname) {
  const err = new Error(`proxy target blocked: ${reason}`);
  err.code = BLOCKED_CODE;
  err.reason = reason;
  err.hostname = hostname;
  return err;
}

/** 从 axios 在 Node 下传给 beforeRedirect 的 options 里取下一跳地址。 */
export function redirectTargetOf(options) {
  if (!options) return '';
  if (typeof options.href === 'string' && options.href) return options.href;
  if (typeof options.url === 'string' && options.url) return options.url;

  const protocol = String(options.protocol || 'http:');
  const host = options.host || options.hostname || '';
  if (!host) return '';
  const path = options.path || options.pathname || '/';
  return `${protocol.endsWith(':') ? protocol : `${protocol}:`}//${host}${path}`;
}

/**
 * axios 的 beforeRedirect 回调：重定向的每一跳都重新判定，不通过就抛。
 * 取不到目标时也抛（失败关闭），宁可放不出歌也不替未知地址转发。
 */
export function createRedirectGuard(env = process.env) {
  return function beforeRedirect(options) {
    const target = redirectTargetOf(options);
    const check = checkProxyUrl(target, env);
    if (!check.ok) {
      const reason = check.reason === 'invalid-url' ? 'redirect-target' : check.reason;
      throw proxyBlockedError(reason, check.hostname);
    }
  };
}

/**
 * 在错误链里找被白名单拦下的那一条。
 * follow-redirects 会把回调里抛的错包成 RedirectionError（cause 指回原错），
 * 所以这里沿 cause 往上找。
 */
export function findProxyBlock(err, depth = 0) {
  if (!err || depth > 5) return null;
  if (err.code === BLOCKED_CODE) return err;
  return findProxyBlock(err.cause, depth + 1);
}

export default {
  DEFAULT_ALLOWED_HOSTS,
  BLOCKED_CODE,
  normalizeHost,
  isIpLiteralHost,
  allowedHosts,
  checkProxyUrl,
  isAllowedProxyUrl,
  refererForProxyUrl,
  inferProxyContentType,
  redirectTargetOf,
  createRedirectGuard,
  findProxyBlock,
};
