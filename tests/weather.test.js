import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGet = vi.hoisted(() => vi.fn());
const prefMem = vi.hoisted(() => new Map());

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({ get: mockGet })),
  },
}));

vi.mock('../server/db.js', () => ({
  dbApi: {
    getPref: vi.fn(k => (prefMem.has(k) ? prefMem.get(k) : null)),
    setPref: vi.fn((k, v) => { prefMem.set(k, String(v)); }),
    delPref: vi.fn(k => { prefMem.delete(k); }),
  },
}));

describe('services/weather', () => {
  beforeEach(() => {
    vi.resetModules();
    mockGet.mockReset();
    prefMem.clear();
    delete process.env.OPENWEATHER_API_KEY;
    delete process.env.OPENWEATHER_CITY;
  });

  it('导出 getCurrent / getNext24h', async () => {
    const mod = await import('../server/services/weather.js');
    expect(typeof mod.getCurrent).toBe('function');
    expect(typeof mod.getNext24h).toBe('function');
  });

  it('没设 OPENWEATHER_API_KEY 时不抛、返回 null，且不打上游', async () => {
    const { getCurrent, getNext24h } = await import('../server/services/weather.js');
    expect(await getCurrent()).toBeNull();
    expect(await getNext24h()).toBeNull();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('getCurrent 成功路径返回规范化对象', async () => {
    process.env.OPENWEATHER_API_KEY = 'test-key';
    process.env.OPENWEATHER_CITY = 'Shanghai';
    mockGet.mockResolvedValueOnce({
      data: {
        main: { temp: 22.4, humidity: 65 },
        weather: [{ description: '多云', icon: '03d' }],
        name: 'Shanghai',
      },
    });
    const { getCurrent } = await import('../server/services/weather.js');
    const r = await getCurrent();
    expect(r).toEqual({ temp: 22, condition: '多云', icon: '03d', humidity: 65, city: 'Shanghai' });
  });

  it('getCurrent 城市名直查 404 时用 geocoding 解析后按经纬度重试', async () => {
    process.env.OPENWEATHER_API_KEY = 'test-key';
    process.env.OPENWEATHER_CITY = '长沙';
    const notFound = new Error('city not found');
    notFound.response = { status: 404 };
    mockGet
      .mockRejectedValueOnce(notFound)
      .mockResolvedValueOnce({ data: [{ lat: 28.23, lon: 112.94, name: 'Changsha' }] })
      .mockResolvedValueOnce({
        data: {
          main: { temp: 25.2, humidity: 58 },
          weather: [{ description: '晴', icon: '01d' }],
          name: 'Changsha',
        },
      });

    const { getCurrent } = await import('../server/services/weather.js');
    const r = await getCurrent();

    expect(r).toEqual({ temp: 25, condition: '晴', icon: '01d', humidity: 58, city: 'Changsha' });
    expect(mockGet).toHaveBeenCalledTimes(3);
    expect(mockGet.mock.calls[1]).toEqual([
      '/direct',
      { params: { q: '长沙', limit: 1, appid: 'test-key' } },
    ]);
    expect(mockGet.mock.calls[2][1].params).toMatchObject({
      lat: 28.23,
      lon: 112.94,
      appid: 'test-key',
    });
  });

  it('getCurrent 60s 内重复调用走缓存（spy 仅触发 1 次）', async () => {
    process.env.OPENWEATHER_API_KEY = 'test-key';
    mockGet.mockResolvedValue({
      data: { main: { temp: 18, humidity: 70 }, weather: [{ description: '小雨' }], name: 'Shanghai' },
    });
    const { getCurrent } = await import('../server/services/weather.js');
    const r1 = await getCurrent();
    const r2 = await getCurrent();
    expect(r1).toEqual(r2);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('getNext24h 成功路径返回最多 8 个 3h 块', async () => {
    process.env.OPENWEATHER_API_KEY = 'test-key';
    const list = Array.from({ length: 12 }, (_, i) => ({
      dt_txt: `2026-05-18 ${String(i * 3).padStart(2, '0')}:00:00`,
      main: { temp: 20 + i },
      weather: [{ description: '晴' }],
    }));
    mockGet.mockResolvedValueOnce({ data: { list } });
    const { getNext24h } = await import('../server/services/weather.js');
    const r = await getNext24h();
    expect(Array.isArray(r)).toBe(true);
    expect(r.length).toBe(8);
    expect(r[0]).toEqual({ time: '2026-05-18 00:00:00', temp: 20, condition: '晴' });
  });

  it('上游异常时 getCurrent 返回 null（不抛）', async () => {
    process.env.OPENWEATHER_API_KEY = 'test-key';
    mockGet.mockRejectedValueOnce(new Error('network down'));
    const { getCurrent } = await import('../server/services/weather.js');
    const r = await getCurrent();
    expect(r).toBeNull();
  });

  it('prefs.openweather_api_key 优先于 .env，且当 city 也在 prefs 时按 prefs 城市拉取', async () => {
    process.env.OPENWEATHER_API_KEY = 'env-key';
    prefMem.set('openweather_api_key', 'pref-key');
    prefMem.set('openweather_city', 'Beijing');
    mockGet.mockResolvedValueOnce({
      data: { main: { temp: 5, humidity: 40 }, weather: [{ description: '晴' }], name: 'Beijing' },
    });
    const { getCurrent } = await import('../server/services/weather.js');
    await getCurrent();
    expect(mockGet).toHaveBeenCalledTimes(1);
    const [, { params }] = mockGet.mock.calls[0];
    expect(params.appid).toBe('pref-key');
    expect(params.q).toBe('Beijing');
  });

  it('invalidateCache 清掉 60s 内的缓存，下次会重新打上游', async () => {
    process.env.OPENWEATHER_API_KEY = 'test-key';
    mockGet.mockResolvedValue({
      data: { main: { temp: 10, humidity: 50 }, weather: [{ description: '晴' }], name: 'Shanghai' },
    });
    const { getCurrent, invalidateCache } = await import('../server/services/weather.js');
    await getCurrent();
    expect(mockGet).toHaveBeenCalledTimes(1);
    invalidateCache();
    await getCurrent();
    expect(mockGet).toHaveBeenCalledTimes(2);
  });
});
