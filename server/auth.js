import { timingSafeEqual } from 'node:crypto';
import { isLoopbackHostname } from './outbound-proxy.js';
import { hostAllowed, originAllowed } from './host-guard.js';
import { readSessionId, sessionValid } from './session.js';

// 默认：本机浏览器里的 PWA 不带 token。回环 TCP 来源直接放行，这样
// fetch、<audio>、WebSocket 都不用把密钥写进页面。
// CLAUDIO_REQUIRE_TOKEN 打开后，回环也要凭证（反代 / 内网穿透转到 127.0.0.1 时）。
// 凭证可以是令牌，或 POST /api/session 换来的会话 cookie。cookie 不是令牌本身。
// 请求里带了令牌但不对时，即使 cookie 有效也拒绝。
// 非回环来源（局域网、公网、另一台机器上的 bot）始终要凭证。
// 只看 socket.remoteAddress，不信 X-Forwarded-For。
// 令牌为空时，需要凭证的请求一律拒绝。

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

export function loopbackRequiresToken(env = process.env) {
  const raw = String(env.CLAUDIO_REQUIRE_TOKEN ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function remoteAddress(req) {
  return req?.socket?.remoteAddress || req?.connection?.remoteAddress || '';
}

export function authorizeRequest(req, env = process.env) {
  const loopback = isLoopbackHostname(remoteAddress(req));
  if (loopback && !loopbackRequiresToken(env)) {
    return { ok: true, via: 'loopback' };
  }

  const expected = configuredToken(env);
  const provided = tokenFromRequest(req);
  if (provided) {
    if (expected && tokensEqual(provided, expected)) {
      return { ok: true, via: 'token' };
    }
    // 带了错误令牌就拒绝，不回落到 cookie。
    return { ok: false, via: expected ? 'rejected' : 'no-token-configured' };
  }
  if (sessionValid(readSessionId(req))) {
    return { ok: true, via: 'cookie' };
  }
  return { ok: false, via: expected ? 'rejected' : 'no-token-configured' };
}

export function authorizeUpgrade(req, env = process.env) {
  if (!hostAllowed(req?.headers?.host, env)) {
    return { ok: false, reason: 'forbidden-host', status: 403 };
  }
  const pathname = requestPathname(req);
  if (pathname !== '/stream') return { ok: false, reason: 'not-stream' };
  if (!originAllowed(req?.headers?.origin, env)) {
    return { ok: false, reason: 'forbidden-origin', status: 403 };
  }
  const decision = authorizeRequest(req, env);
  if (!decision.ok) return { ok: false, reason: decision.via, status: 401 };
  return { ok: true, via: decision.via };
}

// 签发会话必须出示令牌本身。回环免检和已有 cookie 都不能用来换新 cookie，
// 否则开关还关着时就可以先种一张，等 CLAUDIO_REQUIRE_TOKEN 打开后拿来用。
export function authorizeSessionMint(req, env = process.env) {
  const expected = configuredToken(env);
  const provided = tokenFromRequest(req);
  if (expected && provided && tokensEqual(provided, expected)) {
    return { ok: true, via: 'token' };
  }
  return { ok: false, via: expected ? 'rejected' : 'no-token-configured' };
}

export function authMiddleware(req, res, next) {
  const pathname = req.path || requestPathname(req);
  if (!requiresCredential(pathname)) {
    next();
    return;
  }
  const decision = pathname === '/api/session'
    ? authorizeSessionMint(req)
    : authorizeRequest(req);
  if (decision.ok) {
    next();
    return;
  }
  res.status(401).json({ ok: false, error: 'unauthorized' });
}
