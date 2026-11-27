import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authMiddleware } from '../server/auth.js';
import { hostGuard } from '../server/host-guard.js';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createSession,
  createSessionStore,
  hashSessionId,
  hashTokenFingerprint,
  mountSessionRoute,
  pruneExpiredSessions,
  readSessionId,
  resetSessions,
  sessionCookieHeader,
  sessionValid,
} from '../server/session.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

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

  it('拒绝非法、空值和被篡改的会话 cookie', () => {
    const now = 1_700_000_000_000;
    const id = createSession(now, { token: 'secret-token' });
    const tampered = `${id.slice(0, -1)}${id.endsWith('0') ? '1' : '0'}`;

    expect(sessionValid('', now, { token: 'secret-token' })).toBe(false);
    expect(sessionValid(null, now, { token: 'secret-token' })).toBe(false);
    expect(sessionValid('not-a-hex-session', now, { token: 'secret-token' })).toBe(false);
    expect(sessionValid('secret-token', now, { token: 'secret-token' })).toBe(false);
    expect(sessionValid(tampered, now, { token: 'secret-token' })).toBe(false);
    expect(sessionValid(id.toUpperCase(), now, { token: 'secret-token' })).toBe(false);
  });

  it('支持持久化到 SQLite 文件、模拟服务重启后仍有效，且绝不落明文令牌或会话 id', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-session-'));
    const dbPath = path.join(tmpDir, 'state.db');
    const token = 'super-secret-api-token-for-test';
    const now = 1_700_000_000_000;
    let id;

    try {
      const db1 = new DatabaseSync(dbPath);
      db1.exec('PRAGMA journal_mode = WAL');
      const store1 = createSessionStore(db1);
      id = store1.createSession(now, { token });

      const rows = db1.prepare('SELECT id_hash, token_hash, created_at, expires_at FROM auth_sessions').all();
      expect(rows).toHaveLength(1);
      expect(rows[0].id_hash).toBe(hashSessionId(id));
      expect(rows[0].token_hash).toBe(hashTokenFingerprint(token));
      expect(rows[0].id_hash).not.toBe(id);
      expect(rows[0].token_hash).not.toBe(token);
      expect(rows[0].expires_at).toBe(now + SESSION_TTL_MS);
      db1.close();

      // 原始数据库文件内容也不得包含明文 token 或明文 session id
      const rawBytes = fs.readFileSync(dbPath).toString('utf8');
      expect(rawBytes).not.toContain(token);
      expect(rawBytes).not.toContain(id);

      // 模拟重启：全新打开同一 SQLite 文件，不依赖旧进程内存
      const db2 = new DatabaseSync(dbPath);
      const store2 = createSessionStore(db2);
      expect(store2.sessionValid(id, now + 60_000, { token })).toBe(true);
      // 轮换 CLAUDIO_API_TOKEN 后旧会话立即失效
      expect(store2.sessionValid(id, now + 60_000, { token: 'rotated-token' })).toBe(false);
      // 取消令牌后旧会话也失效
      expect(store2.sessionValid(id, now + 60_000, { token: '' })).toBe(false);
      // 过期后失效并清理记录
      expect(store2.sessionValid(id, now + SESSION_TTL_MS, { token })).toBe(false);
      const afterExpire = db2.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get();
      expect(afterExpire.n).toBe(0);
      db2.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('签发新会话与显式清理会自动删除已过期会话，resetSessions 清空全部会话', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const store = createSessionStore(db);
      const t0 = 1_700_000_000_000;
      const oldId = store.createSession(t0, { token: 'tok' });
      expect(store.sessionValid(oldId, t0 + 1000, { token: 'tok' })).toBe(true);

      // 到期后签发新会话，应自动清理过期行
      const t1 = t0 + SESSION_TTL_MS + 5_000;
      const newId = store.createSession(t1, { token: 'tok' });
      const rows = db.prepare('SELECT id_hash FROM auth_sessions').all();
      expect(rows.map(r => r.id_hash)).toEqual([hashSessionId(newId)]);

      // pruneExpiredSessions 显式清理
      expect(store.pruneExpiredSessions(t1 + SESSION_TTL_MS)).toBe(1);
      expect(store.sessionValid(newId, t1 + 1000, { token: 'tok' })).toBe(false);

      // resetSessions 清理默认持久化存储
      const defaultId = createSession(t1, { token: 'tok' });
      expect(sessionValid(defaultId, t1 + 1000, { token: 'tok' })).toBe(true);
      resetSessions();
      expect(sessionValid(defaultId, t1 + 1000, { token: 'tok' })).toBe(false);
      expect(pruneExpiredSessions(t1 + SESSION_TTL_MS)).toBe(0);
    } finally {
      db.close();
    }
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

  it('轮换 CLAUDIO_API_TOKEN 后，先前签发的 cookie 立即被拒绝，重新换取新 cookie 后恢复', async () => {
    const minted = await request({
      path: '/api/session',
      method: 'POST',
      headers: { authorization: 'Bearer secret-token' },
    });
    expect(minted.status).toBe(200);
    const setCookie = [].concat(minted.headers['set-cookie'] || []).join('; ');
    const oldId = setCookie.match(/claudio_session=([0-9a-f]{64})/)?.[1];
    expect(oldId).toBeTruthy();

    const beforeRotate = await request({
      path: '/api/health',
      headers: { cookie: `claudio_session=${oldId}` },
    });
    expect(beforeRotate.status).toBe(200);

    process.env.CLAUDIO_API_TOKEN = 'rotated-secret-token';

    const afterRotate = await request({
      path: '/api/health',
      headers: { cookie: `claudio_session=${oldId}` },
    });
    expect(afterRotate.status).toBe(401);

    const reminted = await request({
      path: '/api/session',
      method: 'POST',
      headers: { authorization: 'Bearer rotated-secret-token' },
    });
    expect(reminted.status).toBe(200);
    const nextCookie = [].concat(reminted.headers['set-cookie'] || []).join('; ');
    const newId = nextCookie.match(/claudio_session=([0-9a-f]{64})/)?.[1];
    const recovered = await request({
      path: '/api/health',
      headers: { cookie: `claudio_session=${newId}` },
    });
    expect(recovered.status).toBe(200);
  });
});
