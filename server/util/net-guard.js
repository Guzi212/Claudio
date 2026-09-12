// 统一的主机 / IP 安全校验，供 /api/proxy（SSRF）与酷狗分享链接解析（域名欺骗）共用。
//
// 设计目标：
//   1. 只允许 http/https；
//   2. /api/proxy 默认只放行酷狗系域名（可用 PROXY_ALLOWED_HOSTS 追加，PROXY_ALLOW_ANY_HOST=1 关闭白名单）；
//   3. 永远拦截指向内网 / 保留地址的请求，包括 DNS 解析后再校验（防 DNS rebinding）。
import net from 'node:net';
import dns from 'node:dns';

// 酷狗音频 / 歌单常见的直链域名后缀。用户可通过 env 追加。
const DEFAULT_ALLOWED_SUFFIXES = Object.freeze([
  'kugou.com',
  'kglink.com',
  'kugou.net',
  'kgcdn.com',
]);

// 只针对酷狗分享链接的域名规则（比代理白名单更窄）。
const KUGOU_SUFFIXES = Object.freeze(['kugou.com']);

function normalizeHost(host) {
  return String(host || '').trim().toLowerCase().replace(/\.$/, '');
}

// 后缀匹配：evil-kugou.com 不会匹配 kugou.com（避免 endsWith 绕过）。
export function hostMatches(host, suffixes = DEFAULT_ALLOWED_SUFFIXES) {
  const h = normalizeHost(host);
  if (!h) return false;
  return suffixes.some(raw => {
    const s = normalizeHost(raw);
    return Boolean(s) && (h === s || h.endsWith(`.${s}`));
  });
}

function ipv4IsPrivate(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;          // 本机 / 私网 / "this host"
  if (a === 169 && b === 254) return true;                    // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16/12
  if (a === 192 && b === 168) return true;                    // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT
  if (a === 192 && b === 0) return true;                      // 192.0.0.0/24, 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true;       // benchmarking
  if (a >= 224) return true;                                  // multicast + reserved
  return false;
}

// 未知 / 非法 IP 一律视为不安全。
export function isPrivateIp(ip) {
  const value = String(ip || '').trim();
  if (!value) return true;
  if (net.isIPv4(value)) return ipv4IsPrivate(value);
  if (net.isIPv6(value)) {
    const v = value.toLowerCase();
    if (v === '::' || v === '::1') return true;
    if (v.startsWith('fe80')) return true;                    // link-local
    if (v.startsWith('fc') || v.startsWith('fd')) return true; // ULA
    if (v.startsWith('::ffff:')) {
      const mapped = v.slice('::ffff:'.length);
      return net.isIPv4(mapped) ? ipv4IsPrivate(mapped) : true;
    }
    return false;
  }
  return true;
}

function resolveAllowedSuffixes(opts) {
  if (Array.isArray(opts?.allowedSuffixes)) return opts.allowedSuffixes;
  const extra = String(process.env.PROXY_ALLOWED_HOSTS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return extra.length ? [...DEFAULT_ALLOWED_SUFFIXES, ...extra] : [...DEFAULT_ALLOWED_SUFFIXES];
}

// 校验代理目标主机：先看是不是内网 / 保留 IP，再看白名单。返回归一化后的 host。
export function assertProxyHost(hostname, opts = {}) {
  const allowAny = opts.allowAny ?? process.env.PROXY_ALLOW_ANY_HOST === '1';
  const host = normalizeHost(hostname);
  if (!host) throw new Error('目标主机为空');
  if (net.isIP(host) && isPrivateIp(host)) {
    throw new Error(`目标地址不允许（内网 / 保留地址）：${host}`);
  }
  if (!allowAny && !hostMatches(host, resolveAllowedSuffixes(opts))) {
    throw new Error(`目标域名不在白名单内：${host}`);
  }
  return host;
}

// 校验完整 URL：协议 + 主机。返回 URL 对象。
export function validateProxyUrl(rawUrl, opts = {}) {
  let urlObj;
  try {
    urlObj = new URL(String(rawUrl));
  } catch {
    throw new Error('无效的 URL');
  }
  if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
    throw new Error('仅允许 http/https 协议');
  }
  assertProxyHost(urlObj.hostname, opts);
  return urlObj;
}

// 是否酷狗系域名（用于分享链接解析）。
export function isKugouHost(host) {
  return hostMatches(host, KUGOU_SUFFIXES);
}

export function assertKugouHost(host) {
  if (!isKugouHost(host)) {
    throw new Error(`不是酷狗域名：${normalizeHost(host)}`);
  }
  return normalizeHost(host);
}

// 传给 http / axios 的 lookup 选项：DNS 解析后再拦一次内网 IP，防 rebinding。
export function safeLookup(hostname, options, callback) {
  const isCallbackForm = typeof options === 'function';
  const cb = isCallbackForm ? options : callback;
  const opts = isCallbackForm ? {} : (options || {});
  dns.lookup(hostname, { ...opts, all: false }, (err, address, family) => {
    if (err) return cb(err);
    if (isPrivateIp(address)) {
      const blocked = new Error(`DNS 解析到内网地址，已拦截：${hostname} → ${address}`);
      blocked.code = 'ESSRFBLOCKED';
      return cb(blocked);
    }
    return cb(null, address, family);
  });
}

export { DEFAULT_ALLOWED_SUFFIXES, KUGOU_SUFFIXES };
export default {
  hostMatches,
  isPrivateIp,
  assertProxyHost,
  validateProxyUrl,
  isKugouHost,
  assertKugouHost,
  safeLookup,
  DEFAULT_ALLOWED_SUFFIXES,
  KUGOU_SUFFIXES,
};
