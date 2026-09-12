import { describe, it, expect, vi } from 'vitest';
import { mountPlaylistRoutes } from '../server/api/playlists.js';

function mockApp() {
  const routes = {};
  return {
    routes,
    get(p, h) { routes[`GET ${p}`] = h; },
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

function makeDeps(overrides = {}) {
  let pool = null;
  let poolTracks = [];
  const runtime = overrides.runtime || { queue: [], index: 0, paused: false, lastSay: '' };
  const broadcast = vi.fn();
  const setPool = vi.fn((meta, tracks) => { pool = meta; poolTracks = tracks || []; });
  const clearPool = vi.fn(() => { pool = null; poolTracks = []; });

  return {
    runtime,
    broadcast,
    setPool,
    clearPool,
    fetchUserPlaylists: vi.fn(async () => [
      { id: 'g1', listid: 'l1', globalCollectionId: 'g1', name: '通勤', songCount: 2, isPrivate: false },
    ]),
    fetchUserPlaylistTracks: vi.fn(async () => ({
      tracks: [
        { title: 'A', artist: 'X', hash: 'h1' },
        { title: 'B', artist: 'Y', hash: 'h2' },
      ],
      totalCount: 2,
      fetchedCount: 2,
      truncated: false,
    })),
    resolveSongUrl: vi.fn(async () => 'http://upstream/a.mp3'),
    getPool: () => pool,
    getPoolTracks: () => poolTracks,
    ...overrides,
  };
}

describe('mountPlaylistRoutes · 注册', () => {
  it('注册全部歌单路由', () => {
    const app = mockApp();
    mountPlaylistRoutes(app, makeDeps());
    expect(app.routes['GET /api/kugou/playlists']).toBeTypeOf('function');
    expect(app.routes['GET /api/kugou/playlists/tracks']).toBeTypeOf('function');
    expect(app.routes['GET /api/kugou/playlists/pool']).toBeTypeOf('function');
    expect(app.routes['POST /api/kugou/playlists/pool']).toBeTypeOf('function');
    expect(app.routes['POST /api/kugou/playlists/play']).toBeTypeOf('function');
    expect(app.routes['GET /api/kugou/track-url']).toBeTypeOf('function');
  });
});

describe('GET /api/kugou/playlists', () => {
  it('返回账号歌单列表', async () => {
    const app = mockApp();
    mountPlaylistRoutes(app, makeDeps());
    const res = mockRes();
    await app.routes['GET /api/kugou/playlists']({ query: {} }, res);
    expect(res.body.ok).toBe(true);
    expect(res.body.playlists).toHaveLength(1);
    expect(res.body.playlists[0].name).toBe('通勤');
  });
});

describe('GET /api/kugou/playlists/tracks', () => {
  it('缺 gcid 与 listid → 400', async () => {
    const app = mockApp();
    mountPlaylistRoutes(app, makeDeps());
    const res = mockRes();
    await app.routes['GET /api/kugou/playlists/tracks']({ query: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('带 gcid → 透传拉取结果', async () => {
    const app = mockApp();
    mountPlaylistRoutes(app, makeDeps());
    const res = mockRes();
    await app.routes['GET /api/kugou/playlists/tracks']({ query: { gcid: 'g1' } }, res);
    expect(res.body.ok).toBe(true);
    expect(res.body.tracks).toHaveLength(2);
  });
});

describe('POST /api/kugou/playlists/pool', () => {
  it('无 playlist → 清除候选池', async () => {
    const deps = makeDeps();
    const app = mockApp();
    mountPlaylistRoutes(app, deps);
    const res = mockRes();
    await app.routes['POST /api/kugou/playlists/pool']({ body: {} }, res);
    expect(deps.clearPool).toHaveBeenCalled();
    expect(res.body).toEqual({ ok: true, pool: null });
  });

  it('带 playlist → 拉曲目并写入候选池', async () => {
    const deps = makeDeps();
    const app = mockApp();
    mountPlaylistRoutes(app, deps);
    const res = mockRes();
    await app.routes['POST /api/kugou/playlists/pool'](
      { body: { playlist: { id: 'g1', listid: 'l1', globalCollectionId: 'g1', name: '通勤' } } },
      res,
    );
    expect(deps.setPool).toHaveBeenCalled();
    const [meta, tracks] = deps.setPool.mock.calls[0];
    expect(meta.name).toBe('通勤');
    expect(tracks).toHaveLength(2);
    expect(res.body.ok).toBe(true);
    expect(res.body.pool.trackCount).toBe(2);
  });

  it('歌单无曲目 → 404，不写池', async () => {
    const deps = makeDeps({
      fetchUserPlaylistTracks: vi.fn(async () => ({ tracks: [], totalCount: 0, fetchedCount: 0, truncated: false })),
    });
    const app = mockApp();
    mountPlaylistRoutes(app, deps);
    const res = mockRes();
    await app.routes['POST /api/kugou/playlists/pool'](
      { body: { playlist: { listid: 'l1', name: '空单' } } },
      res,
    );
    expect(res.statusCode).toBe(404);
    expect(deps.setPool).not.toHaveBeenCalled();
  });
});

describe('POST /api/kugou/playlists/play', () => {
  it('缺 playlist → 400', async () => {
    const app = mockApp();
    mountPlaylistRoutes(app, makeDeps());
    const res = mockRes();
    await app.routes['POST /api/kugou/playlists/play']({ body: {} }, res);
    expect(res.statusCode).toBe(400);
  });

  it('整单替换 runtime.queue 并广播', async () => {
    const deps = makeDeps();
    const app = mockApp();
    mountPlaylistRoutes(app, deps);
    const res = mockRes();
    await app.routes['POST /api/kugou/playlists/play'](
      { body: { playlist: { listid: 'l1', globalCollectionId: 'g1', name: '通勤' } } },
      res,
    );
    expect(res.body.ok).toBe(true);
    expect(res.body.count).toBe(2);
    expect(deps.runtime.queue).toHaveLength(2);
    expect(deps.runtime.index).toBe(0);
    expect(deps.runtime.queue[0]).toMatchObject({ title: 'A', kugouId: 'h1', audioUrl: null, source: 'playlist' });
    expect(deps.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'state' }));
  });
});

describe('GET /api/kugou/track-url', () => {
  it('缺 hash → 400', async () => {
    const app = mockApp();
    mountPlaylistRoutes(app, makeDeps());
    const res = mockRes();
    await app.routes['GET /api/kugou/track-url']({ query: {} }, res);
    expect(res.statusCode).toBe(400);
  });

  it('有 hash → 返回代理 URL', async () => {
    const app = mockApp();
    mountPlaylistRoutes(app, makeDeps());
    const res = mockRes();
    await app.routes['GET /api/kugou/track-url']({ query: { hash: 'h1' } }, res);
    expect(res.body.ok).toBe(true);
    expect(res.body.url).toContain('/api/proxy?u=');
    expect(res.body.url).toContain(encodeURIComponent('http://upstream/a.mp3'));
  });

  it('取不到直链 → 404', async () => {
    const app = mockApp();
    mountPlaylistRoutes(app, makeDeps({ resolveSongUrl: vi.fn(async () => null) }));
    const res = mockRes();
    await app.routes['GET /api/kugou/track-url']({ query: { hash: 'h1' } }, res);
    expect(res.statusCode).toBe(404);
  });
});
