// 酷狗相关出站请求的代理。
//
// Claudio 自己只在「目标不是本机」时使用 KUGOU_PROXY：/api/proxy 拉 CDN、
// 直接请求 kugou.com 的短链等。本机 KuGouMusicApi（localhost:3000）以及
// 任何 127.0.0.0/8、localhost、::1 永远直连。
//
// 不填 KUGOU_PROXY 就直连，并且显式 proxy:false，避免进程里残留的
// HTTP_PROXY / HTTPS_PROXY 把本机或酷狗流量拐走。
//
// 上游 KuGouMusicApi 的 axios 不读 HTTP(S)_PROXY。它在 util/runtime.js 的
// resolveProxy() 里只认 KUGOU_API_PROXY（或启动参数 --proxy）。scripts/dev.js
// 拉起上游时会把 KUGOU_PROXY 抄进那个变量。

export function isLoopbackHostname(hostname) {
  let host = String(hostname || '').trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.startsWith('::ffff:')) host = host.slice('::ffff:'.length);
  if (host === 'localhost' || host === '::1') return true;
  const parts = host.split('.');
  if (parts.length !== 4 || parts[0] !== '127') return false;
  return parts.every(part => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

export function parseAxiosProxy(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  const proxy = {
    protocol: parsed.protocol.slice(0, -1),
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80),
  };
  if (parsed.username || parsed.password) {
    proxy.auth = {
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    };
  }
  return proxy;
}

/**
 * 给 axios 用的 proxy 字段。
 * 回环地址、未配置、或代理 URL 无效时返回 false（强制直连）。
 */
export function proxyForTarget(targetUrl, env = process.env) {
  let hostname = '';
  try {
    hostname = new URL(targetUrl).hostname;
  } catch {
    return false;
  }
  if (isLoopbackHostname(hostname)) return false;
  const parsed = parseAxiosProxy(env.KUGOU_PROXY);
  return parsed || false;
}

export function axiosProxyOptions(targetUrl, env = process.env) {
  return { proxy: proxyForTarget(targetUrl, env) };
}
