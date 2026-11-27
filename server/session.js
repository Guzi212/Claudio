import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { dbApi, ensureAuthSessionsTable } from './db.js';

// cookie 里放随机会话 id，不放 CLAUDIO_API_TOKEN。
// 持久化在 SQLite auth_sessions 表：仅保存会话 id 哈希与当前令牌指纹，
// 绝不落明文令牌或明文会话 id；服务或电脑重启后有效期内仍可鉴权，
// 轮换 CLAUDIO_API_TOKEN 后旧会话自动失效。HttpOnly，页面脚本读不到。
export const SESSION_COOKIE = 'claudio_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const SESSION_ID_RE = /^[0-9a-f]{64}$/;

function resolveToken(env = process.env) {
  return String(env?.CLAUDIO_API_TOKEN || '').trim();
}

export function hashSessionId(id) {
  return createHash('sha256').update(`claudio:session:v1:${id}`).digest('hex');
}

export function hashTokenFingerprint(token) {
  const clean = String(token || '').trim();
  if (!clean) return '';
  return createHash('sha256').update(`claudio:token:v1:${clean}`).digest('hex');
}

function hashesEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  return timingSafeEqual(a, b);
}

export function createSessionStore(database) {
  ensureAuthSessionsTable(database);
  const stmts = {
    insert: database.prepare(`
      INSERT INTO auth_sessions (id_hash, token_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `),
    find: database.prepare(`
      SELECT id_hash, token_hash, created_at, expires_at
      FROM auth_sessions
      WHERE id_hash = ?
    `),
    deleteByHash: database.prepare(`DELETE FROM auth_sessions WHERE id_hash = ?`),
    deleteExpired: database.prepare(`DELETE FROM auth_sessions WHERE expires_at <= ?`),
    deleteAll: database.prepare(`DELETE FROM auth_sessions`),
  };

  function pruneExpiredSessions(now = Date.now()) {
    const ts = Number.isFinite(now) ? now : Date.now();
    return stmts.deleteExpired.run(ts).changes;
  }

  function resetSessions() {
    stmts.deleteAll.run();
  }

  function createSession(now = Date.now(), options = {}) {
    const ts = Number.isFinite(now) ? now : Date.now();
    const token = options.token !== undefined ? options.token : resolveToken(options.env);
    const id = randomBytes(32).toString('hex');
    const idHash = hashSessionId(id);
    const tokenHash = hashTokenFingerprint(token);
    stmts.deleteExpired.run(ts);
    stmts.insert.run(idHash, tokenHash, ts, ts + SESSION_TTL_MS);
    return id;
  }

  function sessionValid(id, now = Date.now(), options = {}) {
    if (!id || typeof id !== 'string' || !SESSION_ID_RE.test(id)) return false;
    const ts = Number.isFinite(now) ? now : Date.now();
    const idHash = hashSessionId(id);
    const row = stmts.find.get(idHash);
    if (!row) return false;
    if (row.expires_at <= ts) {
      stmts.deleteByHash.run(idHash);
      return false;
    }
    const token = options.token !== undefined ? options.token : resolveToken(options.env);
    const expectedTokenHash = hashTokenFingerprint(token);
    return hashesEqual(row.token_hash, expectedTokenHash);
  }

  return {
    createSession,
    sessionValid,
    resetSessions,
    pruneExpiredSessions,
  };
}

const defaultStore = createSessionStore(dbApi.raw);
defaultStore.pruneExpiredSessions();

export function resetSessions() {
  return defaultStore.resetSessions();
}

export function pruneExpiredSessions(now = Date.now()) {
  return defaultStore.pruneExpiredSessions(now);
}

export function createSession(now = Date.now(), options = {}) {
  return defaultStore.createSession(now, options);
}

export function sessionValid(id, now = Date.now(), options = {}) {
  return defaultStore.sessionValid(id, now, options);
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

export function mountSessionRoute(app, { env = process.env, store = defaultStore } = {}) {
  app.post('/api/session', (req, res) => {
    const id = store.createSession(Date.now(), { token: resolveToken(env) });
    const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    const secure = Boolean(req.socket?.encrypted) || forwardedProto === 'https';
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Set-Cookie', sessionCookieHeader(id, { secure }));
    res.json({ ok: true });
  });
}
