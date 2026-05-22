import { describe, it, expect, vi, beforeEach } from 'vitest';

const mem = new Map();

vi.mock('../server/db.js', () => ({
  dbApi: {
    getPref: vi.fn(k => (mem.has(k) ? mem.get(k) : null)),
    setPref: vi.fn((k, v) => { mem.set(k, String(v)); }),
    delPref: vi.fn(k => { mem.delete(k); }),
  },
}));

beforeEach(() => {
  mem.clear();
  delete process.env.OPENWEATHER_API_KEY;
  delete process.env.OPENWEATHER_CITY;
  delete process.env.FISH_API_KEY;
  delete process.env.FISH_VOICE_ID;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_MODEL;
  vi.resetModules();
});

describe('services/settings', () => {
  it('导出 KEYS / getAll / get / set', async () => {
    const mod = await import('../server/services/settings.js');
    expect(Array.isArray(mod.KEYS)).toBe(true);
    expect(mod.KEYS).toEqual([
      'openweather_api_key',
      'openweather_city',
      'fish_api_key',
      'fish_voice_id',
      'deepseek_api_key',
      'deepseek_model',
    ]);
    expect(typeof mod.getAll).toBe('function');
    expect(typeof mod.get).toBe('function');
    expect(typeof mod.set).toBe('function');
  });

  it('get 优先返回 prefs，没有则回退 .env（同名大写）', async () => {
    process.env.OPENWEATHER_CITY = 'Shanghai';
    process.env.OPENWEATHER_API_KEY = 'env-key';
    mem.set('openweather_api_key', 'pref-key');

    const { get } = await import('../server/services/settings.js');
    expect(get('openweather_api_key')).toBe('pref-key');
    expect(get('openweather_city')).toBe('Shanghai');
  });

  it('get 两边都没值返回空字符串', async () => {
    const { get } = await import('../server/services/settings.js');
    expect(get('fish_api_key')).toBe('');
  });

  it('getAll 返回六个 key 的当前值', async () => {
    process.env.OPENWEATHER_CITY = 'Beijing';
    mem.set('fish_voice_id', 'voice-x');

    const { getAll } = await import('../server/services/settings.js');
    expect(getAll()).toEqual({
      openweather_api_key: '',
      openweather_city: 'Beijing',
      fish_api_key: '',
      fish_voice_id: 'voice-x',
      deepseek_api_key: '',
      deepseek_model: '',
    });
  });

  it('set 校验 key 在白名单内，未知 key 抛错', async () => {
    const { set } = await import('../server/services/settings.js');
    expect(() => set('arbitrary_key', 'x')).toThrow();
  });

  it('set 空字符串 → 调 delPref，非空 → 调 setPref', async () => {
    const { set } = await import('../server/services/settings.js');
    const { dbApi } = await import('../server/db.js');

    set('fish_api_key', 'new-key');
    expect(dbApi.setPref).toHaveBeenCalledWith('fish_api_key', 'new-key');

    set('fish_api_key', '');
    expect(dbApi.delPref).toHaveBeenCalledWith('fish_api_key');
  });

  it('isSensitive 标记需要 mask 的字段（API key 类）', async () => {
    const { isSensitive } = await import('../server/services/settings.js');
    expect(isSensitive('openweather_api_key')).toBe(true);
    expect(isSensitive('fish_api_key')).toBe(true);
    expect(isSensitive('deepseek_api_key')).toBe(true);
    expect(isSensitive('openweather_city')).toBe(false);
    expect(isSensitive('fish_voice_id')).toBe(false);
    expect(isSensitive('deepseek_model')).toBe(false);
  });
});
