import { randomBytes } from 'node:crypto';

// cookie 里放随机会话 id，不放 CLAUDIO_API_TOKEN。
// 进程内存，重启即失效。HttpOnly，页面脚本读不到。
export const SESSION_COOKIE = 'claudio_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const sessions = new Map();

export function resetSessions() {
  sessions.clear();
}

export function createSession(now = Date.now()) {
  const id = randomBytes(32).toString('hex');
  sessions.set(id, now + SESSION_TTL_MS);
  return id;
}

export function sessionValid(id, now = Date.now()) {
  if (!id || typeof id !== 'string') return false;
  const expiresAt = sessions.get(id);
  if (!expiresAt) return false;
  if (expiresAt <= now) {
    sessions.delete(id);
    return false;
  }
  return true;
}

export function readSessionId(req) {
  const raw = req?.headers?.cookie || '';
  if (typeof raw !== 'string' || !raw) return '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (name !== SESSION_COOKIE) continue;
    return part.slice(idx + 1).trim();
  }
  return '';
}

export function sessionCookieHeader(id, { secure = false } = {}) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const parts = [
    `${SESSION_COOKIE}=${id}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function mountSessionRoute(app) {
  app.post('/api/session', (req, res) => {
    const id = createSession();
    const secure = Boolean(req.socket?.encrypted);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Set-Cookie', sessionCookieHeader(id, { secure }));
    res.json({ ok: true });
  });
}
