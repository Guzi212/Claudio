import { describe, it, expect, vi, beforeEach } from 'vitest';

const prefMem = vi.hoisted(() => new Map());
const mockExec = vi.hoisted(() => vi.fn());
const mockAxiosGet = vi.hoisted(() => vi.fn());

vi.mock('../server/db.js', () => ({
  dbApi: {
    getPref: k => (prefMem.has(k) ? prefMem.get(k) : null),
    setPref: (k, v) => { prefMem.set(k, String(v)); },
    delPref: k => { prefMem.delete(k); },
  },
}));

vi.mock('node:child_process', () => ({ exec: mockExec }));

vi.mock('axios', () => ({
  default: {
    get: mockAxiosGet,
    create: (cfg = {}) => ({
      get: (url, opts) => mockAxiosGet(cfg.baseURL ? `${cfg.baseURL}${url}` : url, opts),
    }),
  },
}));

beforeEach(() => {
  prefMem.clear();
  mockExec.mockReset();
  // 默认：kugou user/detail 返回有效用户（测试可按需覆盖）
  mockAxiosGet.mockResolvedValue({ data: { status: 1, userid: 'u1' } });
  delete process.env.KUGOU_COOKIE;
  delete process.env.NETEASE_API_BASE;
  delete process.env.NETEASE_COOKIE;
  delete process.env.QQ_API_BASE;
  delete process.env.OPENWEATHER_API_KEY;
  delete process.env.FISH_API_KEY;
  vi.resetModules();
});

function mockApp() {
  const routes = {};
  return {
    routes,
    get(p, h) { routes[`GET ${p}`] = h; },
  };
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

describe('mountHealthRoute', () => {
  it('注册 GET /api/health/integrations', async () => {
    mockExec.mockImplementation((cmd, opts, cb) => cb(new Error('not installed')));
    const { mountHealthRoute } = await import('../server/api/health.js');
    const app = mockApp();
    mountHealthRoute(app);
    expect(app.routes['GET /api/health/integrations']).toBeTypeOf('function');
  });

  it('响应体含 kugou / weather / tts / lark 四个 key，每个有 ok / detail', async () => {
    mockExec.mockImplementation((cmd, opts, cb) => cb(new Error('not installed')));
    const { mountHealthRoute } = await import('../server/api/health.js');
    const app = mockApp();
    mountHealthRoute(app);

    const r = mockRes();
    await app.routes['GET /api/health/integrations']({}, r);

    expect(r.statusCode).toBe(200);
    expect(r.body).toHaveProperty('kugou');
    expect(r.body).toHaveProperty('weather');
    expect(r.body).toHaveProperty('tts');
    expect(r.body).toHaveProperty('lark');
    expect(r.body).toHaveProperty('calendar');
    expect(r.body).toHaveProperty('dj');
    for (const k of ['kugou', 'weather', 'tts', 'ai', 'lark', 'calendar', 'dj']) {
      expect(typeof r.body[k].ok).toBe('boolean');
      expect(typeof r.body[k].detail).toBe('string');
    }
  });

  it('kugou cookie 已配置 (prefs) → ok true', async () => {
    prefMem.set('kugou_cookie', 'KUGOU-XYZ=1');
    mockExec.mockImplementation((cmd, opts, cb) => cb(new Error('not installed')));

    const { mountHealthRoute } = await import('../server/api/health.js');
    const app = mockApp();
    mountHealthRoute(app);

    const r = mockRes();
    await app.routes['GET /api/health/integrations']({}, r);
    expect(r.body.kugou.ok).toBe(true);
  });

  it('kugou cookie 完全缺失 → ok false / cookie missing', async () => {
    mockExec.mockImplementation((cmd, opts, cb) => cb(new Error('not installed')));
    const { mountHealthRoute } = await import('../server/api/health.js');
    const app = mockApp();
    mountHealthRoute(app);

    const r = mockRes();
    await app.routes['GET /api/health/integrations']({}, r);
    expect(r.body.kugou.ok).toBe(false);
    expect(r.body.kugou.detail).toMatch(/missing|缺|no/i);
  });

  it('weather 无 OpenWeather key 时走免 key Open-Meteo，关闭 weather_enabled 才返回 false', async () => {
    mockExec.mockImplementation((cmd, opts, cb) => cb(new Error('not installed')));

    // 先：没配 OpenWeather key，但默认开启天气感知
    const m1 = await import('../server/api/health.js');
    const app1 = mockApp();
    m1.mountHealthRoute(app1);
    const r1 = mockRes();
    await app1.routes['GET /api/health/integrations']({}, r1);
    expect(r1.body.weather).toEqual({ ok: true, detail: 'Open-Meteo (keyless)' });
    expect(r1.body.tts.ok).toBe(false);

    // 再：配好 key
    prefMem.set('openweather_api_key', 'k1');
    prefMem.set('fish_api_key', 'k2');
    vi.resetModules();
    const m2 = await import('../server/api/health.js');
    const app2 = mockApp();
    m2.mountHealthRoute(app2);
    const r2 = mockRes();
    await app2.routes['GET /api/health/integrations']({}, r2);
    expect(r2.body.weather).toEqual({ ok: true, detail: 'OpenWeather + Open-Meteo' });
    expect(r2.body.tts.ok).toBe(true);

    // 显式关闭 weather_enabled
    prefMem.set('weather_enabled', 'false');
    vi.resetModules();
    const m3 = await import('../server/api/health.js');
    const app3 = mockApp();
    m3.mountHealthRoute(app3);
    const r3 = mockRes();
    await app3.routes['GET /api/health/integrations']({}, r3);
    expect(r3.body.weather).toEqual({ ok: false, detail: 'disabled' });
  });

  it('lark 与 calendar 保留兼容桩，固定返回 removed 且不调用外部 CLI', async () => {
    const { mountHealthRoute } = await import('../server/api/health.js');
    const app = mockApp();
    mountHealthRoute(app);

    const r = mockRes();
    await app.routes['GET /api/health/integrations']({}, r);
    expect(r.body.lark).toEqual({ ok: false, detail: 'removed' });
    expect(r.body.calendar).toEqual({ ok: false, detail: 'removed' });
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('不会触发真实 OpenWeather / Fish 或外部子进程调用（健康检查仅检本地状态）', async () => {
    prefMem.set('openweather_api_key', 'k1');
    prefMem.set('fish_api_key', 'k2');

    const { mountHealthRoute } = await import('../server/api/health.js');
    const app = mockApp();
    mountHealthRoute(app);

    const r = mockRes();
    await app.routes['GET /api/health/integrations']({}, r);

    expect(mockExec).not.toHaveBeenCalled();
  });

  it('三源（酷狗 / 网易云 / QQ）均统一输出 loggedIn、账号标识与凭证年龄，且不泄露任何 token/cookie 明文', async () => {
    const now = Date.now();
    process.env.NETEASE_API_BASE = 'http://127.0.0.1:33401';
    process.env.QQ_API_BASE = 'http://127.0.0.1:33402';

    prefMem.set('kugou_cookie', 'token=KG_SECRET_TOK;userid=10086');
    prefMem.set('kugou_token_refreshed_at', String(now - 2 * 3_600_000));
    prefMem.set('netease_cookie', 'MUSIC_U=NE_SECRET_U;__csrf=NE_CSRF');
    prefMem.set('netease_token_refreshed_at', String(now - 5 * 3_600_000));

    mockExec.mockImplementation((cmd, opts, cb) => cb(new Error('not installed')));
    mockAxiosGet.mockImplementation(async url => {
      if (url.includes('/user/detail')) {
        return { data: { status: 1, data: { userid: '10086', nickname: 'LoicKG', vip_type: 1 } } };
      }
      if (url.includes('/login/status')) {
        return {
          data: {
            data: {
              code: 200,
              account: { id: 20086, anonimousUser: false },
              profile: { userId: 20086, nickname: 'LoicNE' },
            },
          },
        };
      }
      if (url.includes('/health')) {
        return {
          data: {
            ok: true,
            loggedIn: true,
            musicid: 30086,
            canRefresh: true,
            credentialCreatedAt: now - 3 * 3_600_000,
            keyExpiresIn: 259200,
            expiresAt: now + 69 * 3_600_000,
          },
        };
      }
      return { data: {} };
    });

    const { mountHealthRoute } = await import('../server/api/health.js');
    const app = mockApp();
    mountHealthRoute(app);
    const r = mockRes();
    await app.routes['GET /api/health/integrations']({}, r);

    expect(r.body.kugou).toMatchObject({
      ok: true,
      loggedIn: true,
      userid: '10086',
      account: 'LoicKG (10086)',
      credentialAgeHours: 2,
    });
    expect(r.body.netease).toMatchObject({
      ok: true,
      loggedIn: true,
      userId: 20086,
      account: 'LoicNE (20086)',
      credentialAgeHours: 5,
    });
    expect(r.body.qq).toMatchObject({
      ok: true,
      loggedIn: true,
      musicid: 30086,
      account: '30086',
      canRefresh: true,
      keyExpiresIn: 259200,
      credentialAgeHours: 3,
      expiresInHours: 69,
    });

    const rawJson = JSON.stringify(r.body);
    expect(rawJson).not.toContain('KG_SECRET_TOK');
    expect(rawJson).not.toContain('NE_SECRET_U');
    expect(rawJson).not.toContain('NE_CSRF');
  });

  it('三源无凭证或降级匿名时：loggedIn 均为 false，凭证年龄为 null', async () => {
    process.env.NETEASE_API_BASE = 'http://127.0.0.1:33401';
    process.env.QQ_API_BASE = 'http://127.0.0.1:33402';

    mockExec.mockImplementation((cmd, opts, cb) => cb(new Error('not installed')));
    mockAxiosGet.mockImplementation(async url => {
      if (url.includes('/register/anonimous')) {
        return { data: { cookie: 'MUSIC_A=anon_1' } };
      }
      if (url.includes('/login/status')) {
        return { data: { data: { code: 200, account: { anonimousUser: true }, profile: null } } };
      }
      if (url.includes('/health')) {
        return { data: { ok: true, loggedIn: false, musicid: 0, detail: 'unauthenticated' } };
      }
      return { data: {} };
    });

    const { mountHealthRoute } = await import('../server/api/health.js');
    const app = mockApp();
    mountHealthRoute(app);
    const r = mockRes();
    await app.routes['GET /api/health/integrations']({}, r);

    expect(r.body.kugou).toMatchObject({
      ok: false,
      loggedIn: false,
      account: null,
      credentialAgeMs: null,
    });
    expect(r.body.netease).toMatchObject({
      ok: true,
      loggedIn: false,
      anonymous: true,
      account: null,
      credentialAgeMs: null,
    });
    expect(r.body.qq).toMatchObject({
      ok: true,
      loggedIn: false,
      musicid: 0,
      account: null,
      credentialAgeMs: null,
    });
  });
});
