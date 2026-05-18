import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGet = vi.hoisted(() => vi.fn());

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({ get: mockGet })),
  },
}));

describe('services/weather', () => {
  beforeEach(() => {
    vi.resetModules();
    mockGet.mockReset();
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
        weather: [{ description: '多云' }],
        name: 'Shanghai',
      },
    });
    const { getCurrent } = await import('../server/services/weather.js');
    const r = await getCurrent();
    expect(r).toEqual({ temp: 22, condition: '多云', humidity: 65, city: 'Shanghai' });
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
});
