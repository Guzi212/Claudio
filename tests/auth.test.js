import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  authMiddleware,
  authorizeRequest,
  authorizeUpgrade,
  requiresCredential,
  tokenFromRequest,
} from '../server/auth.js';

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

describe('authorizeUpgrade', () => {
  const env = { CLAUDIO_API_TOKEN: 'secret-token' };

  it('非 /stream 拒绝', () => {
    expect(authorizeUpgrade(req({ url: '/other' }), env)).toMatchObject({ ok: false, reason: 'not-stream' });
  });

  it('回环 /stream 放行，外网没 token 拒绝，带 query token 放行', () => {
    expect(authorizeUpgrade(req({ url: '/stream' }), env).ok).toBe(true);
    expect(authorizeUpgrade(req({ ip: '10.1.1.1', url: '/stream' }), env).ok).toBe(false);
    expect(authorizeUpgrade(req({ ip: '10.1.1.1', url: '/stream?token=secret-token' }), env).ok).toBe(true);
  });
});

describe('app 接线', () => {
  const source = fs.readFileSync(new URL('../server/app.js', import.meta.url), 'utf8');

  it('HTTP 使用鉴权中间件，并按 CLAUDIO_HOST 监听', () => {
    expect(source).toContain('authMiddleware');
    expect(source).toContain('resolveListenHost');
    expect(source).toMatch(/server\.listen\(PORT,\s*HOST/);
    expect(source).toContain('authorizeUpgrade');
  });
});
