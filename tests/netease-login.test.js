import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  COOKIE_PREF,
  REFRESHED_AT_PREF,
  refreshIntervalMs,
  parseNeteaseCookie,
  sanitizeNeteaseCookie,
  hasMusicU,
  startQrLogin,
  checkQrLogin,
  renewToken,
  needsRenew,
  ensureLogin,
  runRefreshTick,
} from '../server/services/netease-login.js';
import { mountNeteaseReloginRoutes } from '../server/api/netease-relogin.js';

const HOUR = 60 * 60 * 1000;

function fakeDb(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getPref: k => (store.has(k) ? store.get(k) : null),
    setPref: vi.fn((k, v) => { store.set(k, String(v)); }),
    delPref: vi.fn(k => { store.delete(k); }),
    _store: store,
  };
}

function fakeGet(handlers) {
  return async (url, params) => {
    const u = new URL(url);
    const h = handlers[u.pathname];
    if (!h) throw new Error(`unexpected GET ${u.pathname}`);
    return h(params);
  };
}

beforeEach(() => {
  process.env.NETEASE_API_BASE = 'http://127.0.0.1:33401';
  delete process.env.NETEASE_COOKIE;
  delete process.env.NETEASE_REFRESH_INTERVAL_HOURS;
});

afterEach(() => {
  delete process.env.NETEASE_API_BASE;
  delete process.env.NETEASE_COOKIE;
  delete process.env.NETEASE_REFRESH_INTERVAL_HOURS;
});

describe('netease cookie 清洗与持久化辅助', () => {
  it('过滤上游 Set-Cookie 混入的 Max-Age / Path / Expires / HttpOnly 属性，并在有 MUSIC_U 时剔除匿名 MUSIC_A', () => {
    const raw = 'MUSIC_U=U_SECRET_1; Max-Age=1296000; Expires=Wed, 25 Nov 2026 08:00:00 GMT; Path=/; HttpOnly; __csrf=CSRF_1; MUSIC_A=ANON_OLD';
    const parsed = parseNeteaseCookie(raw);
    expect(parsed).toEqual({
      MUSIC_U: 'U_SECRET_1',
      __csrf: 'CSRF_1',
      MUSIC_A: 'ANON_OLD',
    });

    const sanitized = sanitizeNeteaseCookie(raw);
    expect(sanitized).toEqual({
      MUSIC_U: 'U_SECRET_1',
      __csrf: 'CSRF_1',
    });
    expect(hasMusicU(sanitized)).toBe(true);
    expect(hasMusicU('MUSIC_A=anon_only')).toBe(false);
  });
});

describe('startQrLogin / checkQrLogin', () => {
  it('生成二维码 dataURL 与链接', async () => {
    const httpGet = fakeGet({
      '/login/qr/key': () => ({ data: { data: { unikey: 'UNI_123' } }, cookies: {} }),
      '/login/qr/create': params => ({
        data: {
          data: {
            qrimg: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA',
            qrurl: `https://music.163.com/login?codekey=${params.key}`,
          },
        },
        cookies: {},
      }),
    });

    const out = await startQrLogin({ httpGet });
    expect(out).toEqual({
      key: 'UNI_123',
      qrImg: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA',
      qrUrl: 'https://music.163.com/login?codekey=UNI_123',
    });
  });

  it('轮询 800/801/802 正确映射统一状态码且不写库', async () => {
    const db = fakeDb();
    for (const [code, expectedStatus] of [[800, 0], [801, 1], [802, 2]]) {
      const httpGet = fakeGet({
        '/login/qr/check': () => ({ data: { code }, cookies: {} }),
      });
      const res = await checkQrLogin('K1', { httpGet, db });
      expect(res.status).toBe(expectedStatus);
      expect(res.savedCookie).toBe(false);
    }
    expect(db.setPref).not.toHaveBeenCalled();
  });

  it('轮询 803 成功提取 MUSIC_U 写入 state.db，且响应体不回传明文 cookie', async () => {
    const db = fakeDb();
    const now = 1_760_000_000_000;
    const httpGet = fakeGet({
      '/login/qr/check': () => ({
        data: {
          code: 803,
          cookie: 'MUSIC_U=MY_MUSIC_U_VAL; Max-Age=1296000; Path=/; HttpOnly; __csrf=CSRF_99',
        },
        cookies: { NMTID: 'NM_1' },
      }),
    });

    const res = await checkQrLogin('K1', { httpGet, db, now });
    expect(res).toEqual({
      status: 4,
      code: 803,
      statusText: '成功',
      savedCookie: true,
      loggedIn: true,
    });
    expect(JSON.stringify(res)).not.toContain('MY_MUSIC_U_VAL');
    expect(db._store.get(COOKIE_PREF)).toBe('MUSIC_U=MY_MUSIC_U_VAL;__csrf=CSRF_99;NMTID=NM_1');
    expect(db._store.get(REFRESHED_AT_PREF)).toBe(String(now));
  });

  it('803 但未返回 MUSIC_U 时不写库，返回 savedCookie=false', async () => {
    const db = fakeDb();
    const httpGet = fakeGet({
      '/login/qr/check': () => ({ data: { code: 803, cookie: '__csrf=ONLY_CSRF' }, cookies: {} }),
    });
    const res = await checkQrLogin('K1', { httpGet, db });
    expect(res).toMatchObject({ status: 4, savedCookie: false, loggedIn: false });
    expect(db.setPref).not.toHaveBeenCalled();
  });
});

describe('netease 低频续期与无凭证降级', () => {
  it('refreshIntervalMs 默认 24h，可由环境变量覆盖', () => {
    expect(refreshIntervalMs()).toBe(24 * HOUR);
    process.env.NETEASE_REFRESH_INTERVAL_HOURS = '12';
    expect(refreshIntervalMs()).toBe(12 * HOUR);
  });

  it('runRefreshTick：无 cookie 或未到续期时间时不触发上游请求', async () => {
    const now = 1_760_000_000_000;
    const httpGet = vi.fn();
    expect(await runRefreshTick({ db: fakeDb(), httpGet, log: () => {}, now })).toEqual({
      ok: false,
      reason: 'cookie 缺失',
    });

    const dbRecent = fakeDb({
      [COOKIE_PREF]: 'MUSIC_U=U1;__csrf=C1',
      [REFRESHED_AT_PREF]: String(now - 2 * HOUR),
    });
    expect(await runRefreshTick({ db: dbRecent, httpGet, log: () => {}, now })).toEqual({
      ok: false,
      reason: '未到续期时间',
    });
    expect(httpGet).not.toHaveBeenCalled();
  });

  it('runRefreshTick：超过间隔时调一次 /login/refresh 并更新 cookie 与时间戳', async () => {
    const now = 1_760_000_000_000;
    const db = fakeDb({
      [COOKIE_PREF]: 'MUSIC_U=OLD_U;__csrf=OLD_C',
      [REFRESHED_AT_PREF]: String(now - 25 * HOUR),
    });
    const httpGet = fakeGet({
      '/login/refresh': () => ({
        data: { code: 200, cookie: 'MUSIC_U=NEW_U; Max-Age=1296000; Path=/' },
        cookies: { __csrf: 'NEW_C' },
      }),
    });

    const out = await runRefreshTick({
      db,
      httpGet,
      isAlive: async () => true,
      log: () => {},
      now,
    });
    expect(out.ok).toBe(true);
    expect(db._store.get(COOKIE_PREF)).toBe('MUSIC_U=NEW_U;__csrf=NEW_C');
    expect(db._store.get(REFRESHED_AT_PREF)).toBe(String(now));
  });

  it('ensureLogin：无凭证时静默降级为 anonymous，不阻断启动；旧凭证失效时尝试 /login/refresh 自愈', async () => {
    const httpGet = vi.fn();
    const anonOut = await ensureLogin({ db: fakeDb(), httpGet, isAlive: async () => false });
    expect(anonOut).toEqual({ ok: false, source: 'anonymous' });
    expect(httpGet).not.toHaveBeenCalled();

    const now = 1_760_000_000_000;
    const db = fakeDb({
      [COOKIE_PREF]: 'MUSIC_U=EXPIRED_U;__csrf=C1',
      [REFRESHED_AT_PREF]: String(now - 48 * HOUR),
    });
    let checks = 0;
    const isAlive = async () => (++checks > 1);
    const refreshHttp = fakeGet({
      '/login/refresh': () => ({
        data: { code: 200, cookie: 'MUSIC_U=RENEWED_U' },
        cookies: {},
      }),
    });

    const healed = await ensureLogin({ db, httpGet: refreshHttp, isAlive, now });
    expect(healed).toEqual({ ok: true, source: 'renewed' });
    expect(db._store.get(COOKIE_PREF)).toContain('MUSIC_U=RENEWED_U');
  });

  it('mountNeteaseReloginRoutes 在未配置 NETEASE_API_BASE 时返回 400', async () => {
    delete process.env.NETEASE_API_BASE;
    const routes = {};
    mountNeteaseReloginRoutes({
      post: (p, h) => { routes[`POST ${p}`] = h; },
      get: (p, h) => { routes[`GET ${p}`] = h; },
    });
    const res = {
      statusCode: 200,
      body: null,
      status(c) { this.statusCode = c; return this; },
      json(o) { this.body = o; return this; },
    };
    await routes['POST /api/netease/relogin/start']({}, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
  });
});
