import http from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authMiddleware } from '../server/auth.js';
import { hostGuard } from '../server/host-guard.js';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createSession,
  mountSessionRoute,
  readSessionId,
  resetSessions,
  sessionCookieHeader,
  sessionValid,
} from '../server/session.js';

describe('session cookie', () => {
  beforeEach(() => resetSessions());

  it('Set-Cookie 是 HttpOnly、SameSite=Strict，值不是令牌', () => {
    const id = createSession();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toBe('secret-token');
    expect(sessionCookieHeader(id)).toBe(
      `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
    );
    expect(sessionCookieHeader(id, { secure: true })).toBe(
      `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000; Secure`,
    );
    expect(sessionCookieHeader(id)).not.toContain('secret-token');
  });

  it('到期后会话失效', () => {
    const now = 1_700_000_000_000;
    const id = createSession(now);
    expect(sessionValid(id, now + SESSION_TTL_MS - 1)).toBe(true);
    expect(sessionValid(id, now + SESSION_TTL_MS)).toBe(false);
    expect(sessionValid(id, now + SESSION_TTL_MS + 1)).toBe(false);
  });

  it('只读取 claudio_session 这一张 cookie', () => {
    expect(readSessionId({
      headers: { cookie: 'a=1; claudio_session=abc; b=2' },
    })).toBe('abc');
    expect(readSessionId({
      headers: { cookie: 'claudio_session_extra=nope' },
    })).toBe('');
  });
});

describe('POST /api/session', () => {
  let server;
  let port;
  const keys = ['CLAUDIO_API_TOKEN', 'CLAUDIO_REQUIRE_TOKEN', 'CLAUDIO_ALLOWED_HOSTS'];
  const saved = {};

  beforeAll(async () => {
    for (const key of keys) saved[key] = process.env[key];
    const app = express();
    app.use(hostGuard);
    app.use(authMiddleware);
    mountSessionRoute(app);
    app.get('/api/health', (_req, res) => res.json({ ok: true }));
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetSessions();
  });

  beforeEach(() => {
    resetSessions();
    process.env.CLAUDIO_API_TOKEN = 'secret-token';
    process.env.CLAUDIO_REQUIRE_TOKEN = '1';
    delete process.env.CLAUDIO_ALLOWED_HOSTS;
  });

  function request({ path, method = 'GET', headers = {} }) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: { host: `127.0.0.1:${port}`, ...headers },
      }, (response) => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body = text;
          try { body = JSON.parse(text); } catch { /* 保持原文 */ }
          resolve({ status: response.statusCode, headers: response.headers, body });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('Host 不在白名单时 403', async () => {
    const response = await request({ path: '/api/health', headers: { host: 'evil.com' } });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ ok: false, error: 'forbidden host' });
    expect(JSON.stringify(response.body)).not.toContain('evil.com');
  });

  it('开关打开时，回环要先换 cookie，错误令牌不能靠 cookie 混过去', async () => {
    const denied = await request({ path: '/api/health' });
    expect(denied.status).toBe(401);

    const minted = await request({
      path: '/api/session',
      method: 'POST',
      headers: { authorization: 'Bearer secret-token' },
    });
    expect(minted.status).toBe(200);
    expect(minted.body).toEqual({ ok: true });
    const setCookie = [].concat(minted.headers['set-cookie'] || []).join('; ');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).not.toContain('Secure');
    expect(setCookie).not.toContain('secret-token');
    const id = setCookie.match(/claudio_session=([0-9a-f]{64})/)?.[1];
    expect(id).toBeTruthy();

    const authed = await request({
      path: '/api/health',
      headers: { cookie: `claudio_session=${id}` },
    });
    expect(authed.status).toBe(200);

    const mixed = await request({
      path: '/api/health',
      headers: {
        cookie: `claudio_session=${id}`,
        authorization: 'Bearer nope',
      },
    });
    expect(mixed.status).toBe(401);

    const cookieOnly = await request({
      path: '/api/session',
      method: 'POST',
      headers: { cookie: `claudio_session=${id}` },
    });
    expect(cookieOnly.status).toBe(401);
  });

  it('开关关闭时，回环也不能不带令牌换 cookie', async () => {
    delete process.env.CLAUDIO_REQUIRE_TOKEN;
    const open = await request({ path: '/api/health' });
    expect(open.status).toBe(200);

    const denied = await request({ path: '/api/session', method: 'POST' });
    expect(denied.status).toBe(401);

    const minted = await request({
      path: '/api/session',
      method: 'POST',
      headers: { authorization: 'Bearer secret-token' },
    });
    expect(minted.status).toBe(200);
    const setCookie = [].concat(minted.headers['set-cookie'] || []).join('; ');
    expect(setCookie).toMatch(/claudio_session=[0-9a-f]{64}/);
    expect(setCookie).not.toContain('secret-token');
  });
});
