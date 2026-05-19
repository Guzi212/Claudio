import { describe, it, expect, vi, beforeEach } from 'vitest';

const prefMem = vi.hoisted(() => new Map());
const mockExec = vi.hoisted(() => vi.fn());

vi.mock('../server/db.js', () => ({
  dbApi: {
    getPref: k => (prefMem.has(k) ? prefMem.get(k) : null),
    setPref: (k, v) => { prefMem.set(k, String(v)); },
    delPref: k => { prefMem.delete(k); },
  },
}));

vi.mock('node:child_process', () => ({ exec: mockExec }));

beforeEach(() => {
  prefMem.clear();
  mockExec.mockReset();
  delete process.env.KUGOU_COOKIE;
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
    for (const k of ['kugou', 'weather', 'tts', 'lark']) {
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

  it('weather / tts key 配置后 ok true，未配置 ok false', async () => {
    mockExec.mockImplementation((cmd, opts, cb) => cb(new Error('not installed')));

    // 先：都没配
    const m1 = await import('../server/api/health.js');
    const app1 = mockApp();
    m1.mountHealthRoute(app1);
    const r1 = mockRes();
    await app1.routes['GET /api/health/integrations']({}, r1);
    expect(r1.body.weather.ok).toBe(false);
    expect(r1.body.tts.ok).toBe(false);

    // 再：都配上（用 prefs）
    prefMem.set('openweather_api_key', 'k1');
    prefMem.set('fish_api_key', 'k2');
    vi.resetModules();
    const m2 = await import('../server/api/health.js');
    const app2 = mockApp();
    m2.mountHealthRoute(app2);
    const r2 = mockRes();
    await app2.routes['GET /api/health/integrations']({}, r2);
    expect(r2.body.weather.ok).toBe(true);
    expect(r2.body.tts.ok).toBe(true);
  });

  it('lark-cli 不存在（ENOENT 类）→ not installed', async () => {
    mockExec.mockImplementation((cmd, opts, cb) => {
      const err = new Error("'lark-cli' is not recognized");
      err.code = 'ENOENT';
      cb(err);
    });
    const { mountHealthRoute } = await import('../server/api/health.js');
    const app = mockApp();
    mountHealthRoute(app);

    const r = mockRes();
    await app.routes['GET /api/health/integrations']({}, r);
    expect(r.body.lark.ok).toBe(false);
    expect(r.body.lark.detail).toMatch(/not installed/i);
  });

  it('lark-cli 跑起来 → ok true / lark-cli ok', async () => {
    mockExec.mockImplementation((cmd, opts, cb) => cb(null, { stdout: 'lark-cli 1.2.3', stderr: '' }));
    const { mountHealthRoute } = await import('../server/api/health.js');
    const app = mockApp();
    mountHealthRoute(app);

    const r = mockRes();
    await app.routes['GET /api/health/integrations']({}, r);
    expect(r.body.lark.ok).toBe(true);
    expect(r.body.lark.detail).toMatch(/ok/i);
  });

  it('不会触发真实 OpenWeather / Fish 调用（健康检查仅检本地状态）', async () => {
    mockExec.mockImplementation((cmd, opts, cb) => cb(new Error('not installed')));
    prefMem.set('openweather_api_key', 'k1');
    prefMem.set('fish_api_key', 'k2');

    const { mountHealthRoute } = await import('../server/api/health.js');
    const app = mockApp();
    mountHealthRoute(app);

    const r = mockRes();
    await app.routes['GET /api/health/integrations']({}, r);

    // 仅 lark 用到了 exec，weather/tts 不应该有任何外部调用
    expect(mockExec).toHaveBeenCalledTimes(1);
  });
});
