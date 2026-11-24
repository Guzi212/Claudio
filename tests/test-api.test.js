import { describe, it, expect, vi } from 'vitest';
import { testWeather, testTts, testAi, mountTestRoutes } from '../server/api/test.js';

function mockApp() {
  const routes = {};
  return {
    routes,
    post(p, h) { routes[`POST ${p}`] = h; },
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

describe('testWeather', () => {
  it('成功：返回 ok + data', async () => {
    const data = { temp: 22, condition: '晴', city: 'Shanghai', humidity: 60 };
    const res = await testWeather({
      clearCache: () => {},
      getWeather: async () => data,
    });
    expect(res).toEqual({ ok: true, data });
  });

  it('未配置：getWeather 返 null → ok: false', async () => {
    const res = await testWeather({
      clearCache: () => {},
      getWeather: async () => null,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/API Key/);
  });

  it('清缓存一定被调', async () => {
    const clearCache = vi.fn();
    await testWeather({ clearCache, getWeather: async () => null });
    expect(clearCache).toHaveBeenCalledOnce();
  });
});

describe('testTts', () => {
  it('成功：返回 ok + url', async () => {
    const res = await testTts({ tts: async () => ({ url: '/tts/abc.mp3', hash: 'abc' }) });
    expect(res).toEqual({ ok: true, url: '/tts/abc.mp3' });
  });

  it('未配置：synthesize 返 null → ok: false', async () => {
    const res = await testTts({ tts: async () => null });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/API Key/);
  });
});

describe('mountTestRoutes', () => {
  it('注册 /api/test/weather、tts 与 ai，不再注册日历测试接口', () => {
    const app = mockApp();
    mountTestRoutes(app);
    expect(app.routes['POST /api/test/weather']).toBeTypeOf('function');
    expect(app.routes['POST /api/test/tts']).toBeTypeOf('function');
    expect(app.routes['POST /api/test/ai']).toBeTypeOf('function');
    expect(app.routes['POST /api/test/calendar']).toBeUndefined();
  });

  it('testAi 验证模型可回复', async () => {
    const res = await testAi({ complete: async () => 'OK' });
    expect(res).toEqual({ ok: true, reply: 'OK' });
  });

  it('路由调用 testWeather 并把结果 json 返回', async () => {
    const deps = { clearCache: () => {}, getWeather: async () => ({ temp: 10, city: 'X', condition: 'c', humidity: 50 }) };
    const app = mockApp();
    mountTestRoutes(app, deps);
    const res = mockRes();
    await app.routes['POST /api/test/weather']({}, res);
    expect(res.body.ok).toBe(true);
  });

  it('testWeather 抛错时路由返 ok:false', async () => {
    const deps = { clearCache: () => {}, getWeather: async () => { throw new Error('boom'); } };
    const app = mockApp();
    mountTestRoutes(app, deps);
    const res = mockRes();
    await app.routes['POST /api/test/weather']({}, res);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('boom');
  });
});
