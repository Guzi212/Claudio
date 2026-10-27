import { describe, expect, it, vi } from 'vitest';
import { mountWeatherRoute } from '../server/api/weather.js';

function mockApp() {
  const routes = {};
  return {
    routes,
    get(path, handler) { routes[`GET ${path}`] = handler; },
  };
}

function mockRes() {
  return {
    body: undefined,
    json(obj) { this.body = obj; return this; },
  };
}

describe('GET /api/weather', () => {
  it('external 不请求 OpenWeather，直接返回空对象', async () => {
    const getCurrent = vi.fn(async () => ({ temp: 20 }));
    const app = mockApp();
    mountWeatherRoute(app, { brain: () => 'external', getCurrent });
    const res = mockRes();
    await app.routes['GET /api/weather']({}, res);
    expect(res.body).toEqual({});
    expect(getCurrent).not.toHaveBeenCalled();
  });

  it('internal 仍然读取当前天气', async () => {
    const getCurrent = vi.fn(async () => ({ temp: 18, icon: '01d' }));
    const app = mockApp();
    mountWeatherRoute(app, { brain: () => 'internal', getCurrent });
    const res = mockRes();
    await app.routes['GET /api/weather']({}, res);
    expect(res.body).toEqual({ temp: 18, icon: '01d' });
    expect(getCurrent).toHaveBeenCalledOnce();
  });
});
