import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  authMiddleware,
  authorizeRequest,
  authorizeSessionMint,
  authorizeUpgrade,
  loopbackRequiresToken,
  requiresCredential,
  tokenFromRequest,
} from '../server/auth.js';
import { createSession, resetSessions, SESSION_COOKIE } from '../server/session.js';

function req({ ip = '127.0.0.1', path = '/api/health', headers = {}, query = {}, url } = {}) {
  return {
    path,
    url: url || path,
    headers,
    query,
    socket: { remoteAddress: ip },
  };
}

function res() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

describe('requiresCredential', () => {
  it('保护 /api/*、/tts/* 和 /stream，静态页不保护', () => {
    expect(requiresCredential('/api/health')).toBe(true);
    expect(requiresCredential('/api/proxy')).toBe(true);
    expect(requiresCredential('/tts/0123456789abcdef0123456789abcdef01234567.mp3')).toBe(true);
    expect(requiresCredential('/stream')).toBe(true);
    expect(requiresCredential('/')).toBe(false);
    expect(requiresCredential('/index.html')).toBe(false);
    expect(requiresCredential('/app.js')).toBe(false);
  });
});

describe('authorizeRequest', () => {
  const env = { CLAUDIO_API_TOKEN: 'secret-token' };

  it('回环来源不带 token 也放行', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(authorizeRequest(req({ ip }), env).ok).toBe(true);
    }
  });

  it('非回环没有 token → 拒绝', () => {
    expect(authorizeRequest(req({ ip: '192.168.1.20' }), env)).toMatchObject({ ok: false });
  });

  it('非回环 Bearer token 放行，错误 token 拒绝', () => {
    const ok = authorizeRequest(req({
      ip: '10.0.0.8',
      headers: { authorization: 'Bearer secret-token' },
    }), env);
    expect(ok).toMatchObject({ ok: true, via: 'token' });

    const bad = authorizeRequest(req({
      ip: '10.0.0.8',
      headers: { authorization: 'Bearer nope' },
    }), env);
    expect(bad.ok).toBe(false);
  });

  it('接受 X-Claudio-Token 和 query token', () => {
    expect(authorizeRequest(req({
      ip: '10.0.0.8',
      headers: { 'x-claudio-token': 'secret-token' },
    }), env).ok).toBe(true);

    expect(tokenFromRequest(req({
      ip: '10.0.0.8',
      url: '/api/proxy?u=abc&token=secret-token',
    }))).toBe('secret-token');
    expect(authorizeRequest(req({
      ip: '10.0.0.8',
      url: '/stream?token=secret-token',
    }), env).ok).toBe(true);
  });

  it('未配置 token 时非回环一律拒绝', () => {
    expect(authorizeRequest(req({ ip: '10.0.0.8' }), {}).ok).toBe(false);
    expect(authorizeRequest(req({ ip: '10.0.0.8', headers: { authorization: 'Bearer anything' } }), {}).ok).toBe(false);
    expect(authorizeRequest(req({ ip: '127.0.0.1' }), {}).ok).toBe(true);
  });

  it('不把 X-Forwarded-For 当成回环', () => {
    const decision = authorizeRequest(req({
      ip: '10.0.0.8',
      headers: { 'x-forwarded-for': '127.0.0.1' },
    }), env);
    expect(decision.ok).toBe(false);
  });
});

describe('authMiddleware', () => {
  it('静态路径直接 next', () => {
    let called = false;
    authMiddleware(req({ path: '/styles.css' }), res(), () => { called = true; });
    expect(called).toBe(true);
  });

  it('非回环打 /api/proxy 返回 401', () => {
    const response = res();
    let called = false;
    authMiddleware(
      req({ ip: '8.8.8.8', path: '/api/proxy', url: '/api/proxy?u=https%3A%2F%2Fcdn.example%2Fa.mp3' }),
      response,
      () => { called = true; },
    );
    expect(called).toBe(false);
    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('回环打 /tts 放行', () => {
    let called = false;
    authMiddleware(
      req({ path: '/tts/0123456789abcdef0123456789abcdef01234567.mp3' }),
      res(),
      () => { called = true; },
    );
    expect(called).toBe(true);
  });
});

describe('CLAUDIO_REQUIRE_TOKEN', () => {
  const env = { CLAUDIO_API_TOKEN: 'secret-token', CLAUDIO_REQUIRE_TOKEN: '1' };

  afterEach(() => {
    resetSessions();
    delete process.env.CLAUDIO_REQUIRE_TOKEN;
    delete process.env.CLAUDIO_API_TOKEN;
  });

  it('只有 1 / true / yes / on 算打开', () => {
    for (const value of ['1', 'true', 'TRUE', ' yes ', 'on']) {
      expect(loopbackRequiresToken({ CLAUDIO_REQUIRE_TOKEN: value })).toBe(true);
    }
    for (const value of ['', '0', 'false', 'no', 'off', 'maybe', undefined]) {
      expect(loopbackRequiresToken({ CLAUDIO_REQUIRE_TOKEN: value })).toBe(false);
    }
  });

  it('打开后回环没有凭证会拒绝；正确令牌放行', () => {
    expect(authorizeRequest(req({ ip: '127.0.0.1' }), env)).toMatchObject({ ok: false, via: 'rejected' });
    expect(authorizeRequest(req({
      ip: '::1',
      headers: { authorization: 'Bearer secret-token' },
    }), env)).toMatchObject({ ok: true, via: 'token' });
  });

  it('令牌还没配置就打开开关时，回环也拒绝', () => {
    expect(authorizeRequest(req({ ip: '127.0.0.1' }), { CLAUDIO_REQUIRE_TOKEN: 'on' }))
      .toMatchObject({ ok: false, via: 'no-token-configured' });
  });

  it('会话 cookie 可以过，但 cookie 值不能是原始令牌', () => {
    const id = createSession();
    expect(id).not.toBe('secret-token');
    expect(authorizeRequest(req({
      ip: '127.0.0.1',
      headers: { cookie: `${SESSION_COOKIE}=${id}` },
    }), env)).toMatchObject({ ok: true, via: 'cookie' });

    expect(authorizeRequest(req({
      ip: '127.0.0.1',
      headers: { cookie: `${SESSION_COOKIE}=secret-token` },
    }), env).ok).toBe(false);
  });

  it('带了错误令牌时，即使 cookie 有效也拒绝', () => {
    const id = createSession();
    expect(authorizeRequest(req({
      ip: '127.0.0.1',
      headers: {
        authorization: 'Bearer nope',
        cookie: `${SESSION_COOKIE}=${id}`,
      },
    }), env).ok).toBe(false);
  });

  it('开关关闭时非回环仍可用会话 cookie', () => {
    const id = createSession();
    const open = { CLAUDIO_API_TOKEN: 'secret-token' };
    expect(authorizeRequest(req({
      ip: '10.0.0.8',
      headers: { cookie: `${SESSION_COOKIE}=${id}` },
    }), open)).toMatchObject({ ok: true, via: 'cookie' });
    expect(authorizeRequest(req({
      ip: '10.0.0.8',
      headers: {
        authorization: 'Bearer nope',
        cookie: `${SESSION_COOKIE}=${id}`,
      },
    }), open).ok).toBe(false);
  });

  it('换 cookie 必须带对令牌，回环免检和旧 cookie 都不行', () => {
    const id = createSession();
    const off = { CLAUDIO_API_TOKEN: 'secret-token' };
    expect(authorizeSessionMint(req({ ip: '127.0.0.1' }), off).ok).toBe(false);
    expect(authorizeSessionMint(req({
      ip: '127.0.0.1',
      headers: { cookie: `${SESSION_COOKIE}=${id}` },
    }), off).ok).toBe(false);
    expect(authorizeSessionMint(req({
      ip: '127.0.0.1',
      headers: { authorization: 'Bearer secret-token' },
    }), off)).toMatchObject({ ok: true, via: 'token' });
    expect(authorizeSessionMint(req({ ip: '127.0.0.1' }), { CLAUDIO_REQUIRE_TOKEN: '1' }).ok).toBe(false);
  });

  it('中间件在开关打开时对回环返回 401', () => {
    process.env.CLAUDIO_REQUIRE_TOKEN = '1';
    process.env.CLAUDIO_API_TOKEN = 'secret-token';
    const response = res();
    let called = false;
    authMiddleware(req({ path: '/api/now' }), response, () => { called = true; });
    expect(called).toBe(false);
    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({ ok: false, error: 'unauthorized' });
  });
});

describe('authorizeUpgrade', () => {
  const env = { CLAUDIO_API_TOKEN: 'secret-token' };
  const host = { host: '127.0.0.1' };

  it('非 /stream 拒绝', () => {
    expect(authorizeUpgrade(req({ url: '/other', headers: host }), env)).toMatchObject({ ok: false, reason: 'not-stream' });
  });

  it('回环 /stream 放行，外网没 token 拒绝，带 query token 放行', () => {
    expect(authorizeUpgrade(req({ url: '/stream', headers: host }), env).ok).toBe(true);
    expect(authorizeUpgrade(req({ ip: '10.1.1.1', url: '/stream', headers: host }), env)).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(authorizeUpgrade(req({
      ip: '10.1.1.1',
      url: '/stream?token=secret-token',
      headers: host,
    }), env).ok).toBe(true);
  });

  it('缺少或对不上的 Host 返回 403，默认放行带端口的回环名', () => {
    expect(authorizeUpgrade(req({ url: '/stream' }), env)).toMatchObject({
      ok: false,
      reason: 'forbidden-host',
      status: 403,
    });
    expect(authorizeUpgrade(req({
      url: '/stream',
      headers: { host: 'evil.com' },
    }), env)).toMatchObject({ ok: false, reason: 'forbidden-host', status: 403 });
    expect(authorizeUpgrade(req({
      url: '/stream',
      headers: { host: 'localhost:8080' },
    }), env).ok).toBe(true);
    expect(authorizeUpgrade(req({
      url: '/stream',
      headers: { host: '[::1]:8080' },
    }), env).ok).toBe(true);
  });

  it('WebSocket 校验 Origin：evil.com 拒绝，缺省放行，白名单域名放行', () => {
    expect(authorizeUpgrade(req({
      url: '/stream',
      headers: { host: '127.0.0.1', origin: 'http://evil.com' },
    }), env)).toMatchObject({ ok: false, reason: 'forbidden-origin', status: 403 });
    expect(authorizeUpgrade(req({
      url: '/stream',
      headers: { host: '127.0.0.1', origin: 'null' },
    }), env)).toMatchObject({ ok: false, reason: 'forbidden-origin', status: 403 });
    expect(authorizeUpgrade(req({
      url: '/stream',
      headers: { host: '127.0.0.1', origin: 'http://127.0.0.1:8080' },
    }), env).ok).toBe(true);

    const allowed = {
      CLAUDIO_API_TOKEN: 'secret-token',
      CLAUDIO_ALLOWED_HOSTS: 'radio.example.com',
    };
    expect(authorizeUpgrade(req({
      ip: '10.1.1.1',
      url: '/stream?token=secret-token',
      headers: { host: 'radio.example.com', origin: 'https://radio.example.com' },
    }), allowed).ok).toBe(true);
    expect(authorizeUpgrade(req({
      ip: '10.1.1.1',
      url: '/stream?token=secret-token',
      headers: { host: 'radio.example.com', origin: 'https://evil.com' },
    }), allowed)).toMatchObject({ ok: false, reason: 'forbidden-origin', status: 403 });
  });
});

describe('app 接线', () => {
  const source = fs.readFileSync(new URL('../server/app.js', import.meta.url), 'utf8');

  it('HTTP 使用鉴权中间件，并按 CLAUDIO_HOST 监听', () => {
    expect(source).toContain('authMiddleware');
    expect(source).toContain('resolveListenHost');
    expect(source).toMatch(/server\.listen\(PORT,\s*HOST/);
    expect(source).toContain('authorizeUpgrade');
    expect(source).toContain('hostGuard');
    expect(source).toContain('mountSessionRoute');
    expect(source).toContain('403');
    expect(source).toContain('Forbidden');
    const hostAt = source.indexOf('app.use(hostGuard)');
    const staticAt = source.indexOf('express.static');
    const authAt = source.indexOf('app.use(authMiddleware)');
    const sessionAt = source.indexOf('mountSessionRoute(app)');
    expect(hostAt).toBeGreaterThan(-1);
    expect(hostAt).toBeLessThan(staticAt);
    expect(staticAt).toBeLessThan(authAt);
    expect(authAt).toBeLessThan(sessionAt);
  });
});
