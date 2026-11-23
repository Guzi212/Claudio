import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  REFRESHED_AT_PREF,
  MUSICID_PREF,
  refreshIntervalMs,
  needsRenew,
  renewToken,
  ensureLogin,
  runRefreshTick,
} from '../server/services/qq-login.js';
import {
  startQQRelogin,
  checkQQRelogin,
  mountQQReloginRoutes,
} from '../server/api/qq-relogin.js';

const HOUR = 60 * 60 * 1000;

function fakeDb(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getPref: k => (store.has(k) ? store.get(k) : null),
    setPref: vi.fn((k, v) => { store.set(k, String(v)); }),
    _store: store,
  };
}

beforeEach(() => {
  process.env.QQ_API_BASE = 'http://127.0.0.1:33402';
  delete process.env.QQ_REFRESH_INTERVAL_HOURS;
});

afterEach(() => {
  delete process.env.QQ_API_BASE;
  delete process.env.QQ_REFRESH_INTERVAL_HOURS;
});

describe('QQ 扫码接口契约与持久化', () => {
  it('startQQRelogin 支持 qq 与 wx 两种扫码类型', async () => {
    const httpPost = vi.fn(async (_url, params) => ({
      ok: true,
      key: 'qq-key-1',
      type: params.type,
      qrImg: 'data:image/png;base64,QQQR',
    }));
    const qqOut = await startQQRelogin('qq', { httpPost });
    expect(qqOut).toMatchObject({ ok: true, type: 'qq', key: 'qq-key-1' });
    const wxOut = await startQQRelogin('wx', { httpPost });
    expect(wxOut).toMatchObject({ ok: true, type: 'wx' });
  });

  it('checkQQRelogin 在 status=4 登录成功时写入刷新时间戳与 musicid，并标记 savedCookie=true', async () => {
    const db = fakeDb();
    const now = 1_760_000_000_000;
    const httpGet = vi.fn(async () => ({
      ok: true,
      status: 4,
      statusText: '成功',
      loggedIn: true,
      musicid: 123456789,
    }));

    const out = await checkQQRelogin('k1', { httpGet, db, now });
    expect(out).toMatchObject({
      ok: true,
      status: 4,
      loggedIn: true,
      savedCookie: true,
      musicid: 123456789,
    });
    expect(db._store.get(REFRESHED_AT_PREF)).toBe(String(now));
    expect(db._store.get(MUSICID_PREF)).toBe('123456789');
  });

  it('checkQQRelogin 遇到 404 过期二维码归一化为 status=0，不抛 502', async () => {
    const db = fakeDb();
    const httpGet = vi.fn(async () => {
      const err = new Error('Request failed with status code 404');
      err.response = { status: 404, data: { ok: false, error: 'expired' } };
      throw err;
    });
    const out = await checkQQRelogin('expired-key', { httpGet, db });
    expect(out).toEqual({
      ok: true,
      status: 0,
      statusText: '已过期',
      savedCookie: false,
      loggedIn: false,
    });
  });

  it('mountQQReloginRoutes 缺少 QQ_API_BASE 时返回 400', async () => {
    delete process.env.QQ_API_BASE;
    const routes = {};
    mountQQReloginRoutes({
      post: (p, h) => { routes[`POST ${p}`] = h; },
      get: (p, h) => { routes[`GET ${p}`] = h; },
    });
    const res = {
      statusCode: 200,
      body: null,
      status(c) { this.statusCode = c; return this; },
      json(o) { this.body = o; return this; },
    };
    await routes['POST /api/qq/relogin/start']({ query: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
  });
});

describe('QQ 低频续期与防风控保护', () => {
  it('refreshIntervalMs 默认 24h，可由环境变量覆盖', () => {
    expect(refreshIntervalMs()).toBe(24 * HOUR);
    process.env.QQ_REFRESH_INTERVAL_HOURS = '8';
    expect(refreshIntervalMs()).toBe(8 * HOUR);
    expect(needsRenew({ db: fakeDb() })).toBe(true);
  });

  it('未登录或无 refresh_key 时绝不调用 /login/refresh（防风控）', async () => {
    const httpPost = vi.fn();
    const unauthGet = vi.fn(async () => ({ ok: true, loggedIn: false, musicid: 0 }));
    expect(await runRefreshTick({ db: fakeDb(), httpGet: unauthGet, httpPost, log: () => {} })).toEqual({
      ok: false,
      reason: '未登录',
    });
    expect(httpPost).not.toHaveBeenCalled();

    const staticGet = vi.fn(async () => ({
      ok: true,
      loggedIn: true,
      musicid: 88888,
      canRefresh: false,
    }));
    expect(await runRefreshTick({ db: fakeDb(), httpGet: staticGet, httpPost, log: () => {} })).toEqual({
      ok: false,
      reason: '凭证不含 refresh_key，不可刷新',
    });
    expect(httpPost).not.toHaveBeenCalled();
  });

  it('刚扫码的年轻凭证（credentialAgeMs < 24h）不重复调 /login/refresh', async () => {
    const now = 1_760_000_000_000;
    const db = fakeDb();
    const httpPost = vi.fn();
    const httpGet = vi.fn(async () => ({
      ok: true,
      loggedIn: true,
      musicid: 88888,
      canRefresh: true,
      credentialAgeMs: 2 * HOUR,
      expired: false,
    }));

    const out = await runRefreshTick({ db, httpGet, httpPost, log: () => {}, now });
    expect(out).toEqual({ ok: false, reason: '未到续期时间' });
    expect(httpPost).not.toHaveBeenCalled();
    expect(Number(db._store.get(REFRESHED_AT_PREF))).toBe(now - 2 * HOUR);
  });

  it('到点且可刷新时调用一次 /login/refresh 并记录续期时间', async () => {
    const now = 1_760_000_000_000;
    const db = fakeDb({ [REFRESHED_AT_PREF]: String(now - 26 * HOUR) });
    const httpGet = vi.fn(async () => ({
      ok: true,
      loggedIn: true,
      musicid: 99999,
      canRefresh: true,
      credentialAgeMs: 26 * HOUR,
      expired: false,
    }));
    const httpPost = vi.fn(async () => ({
      ok: true,
      loggedIn: true,
      musicid: 99999,
      expiresAt: now + 72 * HOUR,
      keyExpiresIn: 259200,
    }));

    const out = await runRefreshTick({ db, httpGet, httpPost, log: () => {}, now });
    expect(out.ok).toBe(true);
    expect(httpPost).toHaveBeenCalledTimes(1);
    expect(db._store.get(REFRESHED_AT_PREF)).toBe(String(now));
    expect(db._store.get(MUSICID_PREF)).toBe('99999');
  });

  it('ensureLogin：未登录时静默降级 unauthenticated；过期时自动触发低频续期', async () => {
    const unauth = await ensureLogin({
      db: fakeDb(),
      httpGet: async () => ({ ok: true, loggedIn: false }),
      httpPost: vi.fn(),
    });
    expect(unauth).toEqual({ ok: false, source: 'unauthenticated' });

    const now = 1_760_000_000_000;
    const db = fakeDb();
    const httpPost = vi.fn(async () => ({ ok: true, musicid: 77777 }));
    const renewed = await ensureLogin({
      db,
      httpGet: async () => ({
        ok: true,
        loggedIn: true,
        musicid: 77777,
        canRefresh: true,
        credentialCreatedAt: now - 30 * HOUR,
        expired: true,
      }),
      httpPost,
      now,
    });
    expect(renewed).toEqual({ ok: true, source: 'renewed' });
    expect(httpPost).toHaveBeenCalledTimes(1);
  });

  it('renewToken 兼容旧版 wrapper 404 不抛异常', async () => {
    const httpPost = vi.fn(async () => {
      const err = new Error('Not Found');
      err.response = { status: 404 };
      throw err;
    });
    const out = await renewToken({ httpPost, db: fakeDb() });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('/login/refresh');
  });
});
