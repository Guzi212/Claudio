import { describe, it, expect, vi, beforeEach } from 'vitest';

const prefMem = vi.hoisted(() => new Map());
const invalidateCacheMock = vi.hoisted(() => vi.fn());
const invalidateFavoriteMock = vi.hoisted(() => vi.fn());

vi.mock('../server/db.js', () => ({
  dbApi: {
    getPref: k => (prefMem.has(k) ? prefMem.get(k) : null),
    setPref: (k, v) => { prefMem.set(k, String(v)); },
    delPref: k => { prefMem.delete(k); },
  },
}));

vi.mock('../server/services/weather.js', () => ({
  invalidateCache: invalidateCacheMock,
}));

vi.mock('../server/services/kugou-favorite.js', () => ({
  favoriteStore: { invalidate: invalidateFavoriteMock },
}));

beforeEach(() => {
  prefMem.clear();
  invalidateCacheMock.mockReset();
  invalidateFavoriteMock.mockReset();
  delete process.env.OPENWEATHER_API_KEY;
  delete process.env.OPENWEATHER_CITY;
  delete process.env.FISH_API_KEY;
  delete process.env.FISH_VOICE_ID;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_MODEL;
  vi.resetModules();
});

function mockApp() {
  const routes = {};
  return {
    routes,
    get(p, h) { routes[`GET ${p}`] = h; },
    put(p, h) { routes[`PUT ${p}`] = h; },
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

describe('mountSettingsRoutes', () => {
  it('注册 GET 和 PUT /api/settings', async () => {
    const { mountSettingsRoutes } = await import('../server/api/settings.js');
    const app = mockApp();
    mountSettingsRoutes(app);
    expect(app.routes['GET /api/settings']).toBeTypeOf('function');
    expect(app.routes['PUT /api/settings']).toBeTypeOf('function');
  });

  it('GET 对敏感字段已配置时返 ****已配置，未配置时返空字符串；非敏感字段返真值', async () => {
    prefMem.set('openweather_api_key', 'real-key');
    prefMem.set('openweather_city', 'Shanghai');
    // fish_api_key 未设
    prefMem.set('fish_voice_id', 'voice-x');

    const { mountSettingsRoutes } = await import('../server/api/settings.js');
    const app = mockApp();
    mountSettingsRoutes(app);

    const r = mockRes();
    await app.routes['GET /api/settings']({}, r);

    expect(r.body).toMatchObject({
      openweather_api_key: '****已配置',
      openweather_city: 'Shanghai',
      fish_api_key: '',
      fish_voice_id: 'voice-x',
      deepseek_api_key: '',
      deepseek_model: '',
      calendar_provider: '',
      ui_theme: '',
    });
  });

  it('PUT 写入新字段并返回 applied 列表', async () => {
    const { mountSettingsRoutes } = await import('../server/api/settings.js');
    const app = mockApp();
    mountSettingsRoutes(app);

    const r = mockRes();
    await app.routes['PUT /api/settings']({
      body: { openweather_api_key: 'new-key', openweather_city: 'Beijing' },
    }, r);

    expect(r.statusCode).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.applied.sort()).toEqual(['openweather_api_key', 'openweather_city']);
    expect(prefMem.get('openweather_api_key')).toBe('new-key');
    expect(prefMem.get('openweather_city')).toBe('Beijing');
  });

  it('PUT 字段值为 ****已配置 时跳过该字段，不计入 applied', async () => {
    prefMem.set('fish_api_key', 'existing');

    const { mountSettingsRoutes } = await import('../server/api/settings.js');
    const app = mockApp();
    mountSettingsRoutes(app);

    const r = mockRes();
    await app.routes['PUT /api/settings']({
      body: { fish_api_key: '****已配置', fish_voice_id: 'new-voice' },
    }, r);

    expect(r.body.applied).toEqual(['fish_voice_id']);
    expect(prefMem.get('fish_api_key')).toBe('existing'); // 没动
    expect(prefMem.get('fish_voice_id')).toBe('new-voice');
  });

  it('PUT 空字符串清除字段', async () => {
    prefMem.set('openweather_api_key', 'to-be-cleared');

    const { mountSettingsRoutes } = await import('../server/api/settings.js');
    const app = mockApp();
    mountSettingsRoutes(app);

    const r = mockRes();
    await app.routes['PUT /api/settings']({
      body: { openweather_api_key: '' },
    }, r);

    expect(r.body.applied).toEqual(['openweather_api_key']);
    expect(prefMem.has('openweather_api_key')).toBe(false);
  });

  it('PUT 改了 openweather_* 或 weather_enabled 时调 weather.invalidateCache', async () => {
    const { mountSettingsRoutes } = await import('../server/api/settings.js');
    const app = mockApp();
    const onSettingsSaved = vi.fn();
    mountSettingsRoutes(app, { onSettingsSaved });

    const r = mockRes();
    await app.routes['PUT /api/settings']({
      body: { openweather_city: 'Chengdu', brain_mode: 'internal', calendar_provider: 'lark' },
    }, r);

    expect(invalidateCacheMock).toHaveBeenCalledTimes(1);
    expect(onSettingsSaved).toHaveBeenCalledWith(
      expect.arrayContaining(['openweather_city', 'brain_mode', 'calendar_provider']),
      expect.any(Object),
    );
  });

  it('PUT 改了 like_target_* 时让红心歌单缓存失效', async () => {
    const { mountSettingsRoutes } = await import('../server/api/settings.js');
    const app = mockApp();
    mountSettingsRoutes(app);

    const r = mockRes();
    await app.routes['PUT /api/settings']({
      body: { like_target_listid: '99', like_target_name: '我的收藏' },
    }, r);

    expect(invalidateFavoriteMock).toHaveBeenCalledTimes(1);
  });

  it('PUT 只动其他字段时不失效红心歌单缓存', async () => {
    const { mountSettingsRoutes } = await import('../server/api/settings.js');
    const app = mockApp();
    mountSettingsRoutes(app);

    const r = mockRes();
    await app.routes['PUT /api/settings']({
      body: { fish_voice_id: 'v' },
    }, r);

    expect(invalidateFavoriteMock).not.toHaveBeenCalled();
  });

  it('PUT 只动了非 weather 字段时不调 invalidateCache', async () => {
    const { mountSettingsRoutes } = await import('../server/api/settings.js');
    const app = mockApp();
    mountSettingsRoutes(app);

    const r = mockRes();
    await app.routes['PUT /api/settings']({
      body: { fish_voice_id: 'v' },
    }, r);

    expect(invalidateCacheMock).not.toHaveBeenCalled();
  });

  it('play_window_mode 未配置时 GET 返回空串且不落库，GET 不会把默认值写进 prefs', async () => {
    const { mountSettingsRoutes } = await import('../server/api/settings.js');
    const app = mockApp();
    mountSettingsRoutes(app);

    const r = mockRes();
    await app.routes['GET /api/settings']({}, r);

    expect(r.body.play_window_mode).toBe('');
    expect(prefMem.has('play_window_mode')).toBe(false);
  });

  it('存量 play_window_mode=popup 原样返回；PUT 不带该 key 时不动存量', async () => {
    prefMem.set('play_window_mode', 'popup');

    const { mountSettingsRoutes } = await import('../server/api/settings.js');
    const app = mockApp();
    mountSettingsRoutes(app);

    const getRes = mockRes();
    await app.routes['GET /api/settings']({}, getRes);
    expect(getRes.body.play_window_mode).toBe('popup');

    const putRes = mockRes();
    await app.routes['PUT /api/settings']({ body: { fish_voice_id: 'v' } }, putRes);
    expect(putRes.body.applied).toEqual(['fish_voice_id']);
    expect(prefMem.get('play_window_mode')).toBe('popup');
  });

  it('PUT play_window_mode 只写用户选择的值', async () => {
    const { mountSettingsRoutes } = await import('../server/api/settings.js');
    const app = mockApp();
    mountSettingsRoutes(app);

    const r = mockRes();
    await app.routes['PUT /api/settings']({ body: { play_window_mode: 'popup' } }, r);

    expect(r.body.applied).toEqual(['play_window_mode']);
    expect(prefMem.get('play_window_mode')).toBe('popup');
  });

  it('PUT 未知 key 忽略，不写 prefs 也不出现在 applied', async () => {
    const { mountSettingsRoutes } = await import('../server/api/settings.js');
    const app = mockApp();
    mountSettingsRoutes(app);

    const r = mockRes();
    await app.routes['PUT /api/settings']({
      body: { not_a_setting: 'x', openweather_city: 'Tokyo' },
    }, r);

    expect(r.statusCode).toBe(200);
    expect(r.body.applied).toEqual(['openweather_city']);
    expect(prefMem.has('not_a_setting')).toBe(false);
  });
});
