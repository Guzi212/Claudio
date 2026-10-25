import { timingSafeEqual } from 'node:crypto';
import { isLoopbackHostname } from './outbound-proxy.js';

// 本机浏览器里的 PWA 不带 token。回环 TCP 来源直接放行，这样：
//   · fetch('/api/...') 不用改
//   · <audio src="/api/proxy?..."> 和 <audio src="/tts/..."> 不能加 Header，也能播
//   · WebSocket /stream 不用把密钥写进页面
// 非回环来源（局域网、公网、另一台机器上的 bot）必须带 CLAUDIO_API_TOKEN。
// 只看 socket.remoteAddress，不信 X-Forwarded-For，避免客户端伪造回环。
// token 为空时，非回环请求一律拒绝。

export function configuredToken(env = process.env) {
  return String(env.CLAUDIO_API_TOKEN || '').trim();
}

export function requestPathname(req) {
  const raw = req?.url || req?.path || '/';
  try {
    return new URL(raw, 'http://127.0.0.1').pathname || '/';
  } catch {
    return '/';
  }
}

export function requiresCredential(pathname) {
  const path = pathname || '/';
  return path === '/stream' || path.startsWith('/api/') || path.startsWith('/tts/');
}

function headerValue(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

export function tokenFromRequest(req) {
  const authorization = headerValue(req?.headers?.authorization || req?.headers?.Authorization);
  const bearer = authorization.match(/^Bearer\s+(\S+)\s*$/i);
  if (bearer) return bearer[1];

  const headerToken = headerValue(req?.headers?.['x-claudio-token']);
  if (headerToken) return headerToken;

  const queryToken = req?.query?.token;
  if (typeof queryToken === 'string' && queryToken.trim()) return queryToken.trim();

  try {
    const url = new URL(req?.url || '/', 'http://127.0.0.1');
    const fromUrl = url.searchParams.get('token');
    if (fromUrl && fromUrl.trim()) return fromUrl.trim();
  } catch { /* ignore */ }

  return '';
}

export function tokensEqual(provided, expected) {
  const left = Buffer.from(String(provided));
  const right = Buffer.from(String(expected));
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function remoteAddress(req) {
  return req?.socket?.remoteAddress || req?.connection?.remoteAddress || '';
}

export function authorizeRequest(req, env = process.env) {
  if (isLoopbackHostname(remoteAddress(req))) {
    return { ok: true, via: 'loopback' };
  }
  const expected = configuredToken(env);
  const provided = tokenFromRequest(req);
  if (expected && provided && tokensEqual(provided, expected)) {
    return { ok: true, via: 'token' };
  }
  return { ok: false, via: expected ? 'rejected' : 'no-token-configured' };
}

export function authorizeUpgrade(req, env = process.env) {
  const pathname = requestPathname(req);
  if (pathname !== '/stream') return { ok: false, reason: 'not-stream' };
  const decision = authorizeRequest(req, env);
  if (!decision.ok) return { ok: false, reason: decision.via };
  return { ok: true, via: decision.via };
}

export function authMiddleware(req, res, next) {
  const pathname = req.path || requestPathname(req);
  if (!requiresCredential(pathname)) {
    next();
    return;
  }
  const decision = authorizeRequest(req);
  if (decision.ok) {
    next();
    return;
  }
  res.status(401).json({ ok: false, error: 'unauthorized' });
}
