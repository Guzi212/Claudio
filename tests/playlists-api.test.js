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
  const runtime = overrides.runtime || { queue: [], index: 0, paused: false, lastSay: '' };
  const broadcast = vi.fn();

  return {
    runtime,
    broadcast,
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
    resolveSongUrl: vi.fn(async () => ({ url: 'http://upstream/a.mp3', quality: 'flac' })),
    ...overrides,
  };
}

describe('mountPlaylistRoutes · 注册', () => {
  it('注册全部歌单路由且不再注册候选池路由', () => {
    const app = mockApp();
    mountPlaylistRoutes(app, makeDeps());
    expect(app.routes['GET /api/kugou/playlists']).toBeTypeOf('function');
    expect(app.routes['GET /api/kugou/playlists/tracks']).toBeTypeOf('function');
    expect(app.routes['GET /api/kugou/playlists/pool']).toBeUndefined();
    expect(app.routes['POST /api/kugou/playlists/pool']).toBeUndefined();
    expect(app.routes['POST /api/kugou/playlists/play']).toBeTypeOf('function');
    expect(app.routes['POST /api/kugou/play']).toBeTypeOf('function');
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
    deps.runtime.queueOffset = 12;
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
    expect(deps.runtime.queueOffset).toBe(0);
    expect(deps.runtime.queue[0]).toMatchObject({ title: 'A', kugouId: 'h1', audioUrl: null, source: 'playlist' });
    expect(deps.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'state' }));
  });
});

describe('POST /api/kugou/play', () => {
  it('缺 hash 或 title → 400', async () => {
    const app = mockApp();
    mountPlaylistRoutes(app, makeDeps());
    const res = mockRes();
    await app.routes['POST /api/kugou/play']({ body: { track: { hash: 'h1' } } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('replace 用选中的 hash 精确替换队列', async () => {
    const deps = makeDeps({ runtime: { queue: [{ title: '旧歌' }], index: 0, paused: true, lastSay: '' } });
    const app = mockApp();
    mountPlaylistRoutes(app, deps);
    const res = mockRes();
    await app.routes['POST /api/kugou/play']({
      body: {
        track: { hash: 'HASH', title: '晴天', artist: '周杰伦', album: '叶惠美', duration: 269000, cover: 'http://img/c.jpg' },
        mode: 'replace',
      },
    }, res);
    expect(res.body.ok).toBe(true);
    expect(deps.runtime.queue).toHaveLength(1);
    expect(deps.runtime.queue[0]).toMatchObject({
      title: '晴天',
      artist: '周杰伦',
      album: '叶惠美',
      kugouId: 'HASH',
      audioUrl: null,
      source: 'search',
      cover: 'http://img/c.jpg',
    });
    expect(deps.runtime.index).toBe(0);
    expect(deps.runtime.paused).toBe(false);
    expect(deps.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'state' }));
  });

  it('append 接到队尾且不打断当前曲目', async () => {
    const deps = makeDeps({ runtime: { queue: [{ title: '旧歌' }], index: 0, paused: false, lastSay: '' } });
    const app = mockApp();
    mountPlaylistRoutes(app, deps);
    const res = mockRes();
    await app.routes['POST /api/kugou/play']({
      body: { track: { hash: 'HASH', title: '晴天' }, mode: 'append' },
    }, res);
    expect(res.body.ok).toBe(true);
    expect(deps.runtime.queue.map(item => item.title)).toEqual(['旧歌', '晴天']);
    expect(deps.runtime.index).toBe(0);
  });

  it('title/artist/album 含 U+FFFD 乱码 → 400（GBK 模拟体）', async () => {
    const deps = makeDeps({ runtime: { queue: [], index: 0, paused: true, lastSay: '' } });
    const app = mockApp();
    mountPlaylistRoutes(app, deps);
    // Windows curl --data 以 GBK 发送中文时，服务端按 UTF-8 解析会产出
    // U+FFFD（�）。模拟这种已烂掉的 body（相当于旧 bug 下服务端实际收到的）。
    const mojibake = '晴天'.split('').map(c => '\uFFFD').join(''); // 全烂
    for (const field of ['title', 'artist', 'album']) {
      const res = mockRes();
      await app.routes['POST /api/kugou/play']({
        body: { track: { hash: 'HASH', title: '晴天', [field]: mojibake } },
      }, res);
      expect(res.statusCode).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch('UTF-8');
      expect(deps.runtime.queue).toHaveLength(0);
    }
  });

  it('track.cover 缺失不拦但响应返回 warning', async () => {
    const deps = makeDeps({ runtime: { queue: [], index: 0, paused: true, lastSay: '' } });
    const app = mockApp();
    mountPlaylistRoutes(app, deps);
    const res = mockRes();
    await app.routes['POST /api/kugou/play']({
      body: { track: { hash: 'HASH', title: '晴天', artist: 'X' } },
    }, res);
    expect(res.body.ok).toBe(true);
    expect(res.body.warning).toBeDefined();
    expect(res.body.warning).toMatch('cover');
    const res2 = mockRes();
    await app.routes['POST /api/kugou/play']({
      body: { track: { hash: 'HASH', title: '晴天', cover: 'http://img/c.jpg' } },
    }, res2);
    expect(res2.body.ok).toBe(true);
    expect(res2.body.warning).toBeUndefined();
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

  it('有 hash → 返回代理 URL + 实际档位', async () => {
    const app = mockApp();
    mountPlaylistRoutes(app, makeDeps());
    const res = mockRes();
    await app.routes['GET /api/kugou/track-url']({ query: { hash: 'h1' } }, res);
    expect(res.body.ok).toBe(true);
    expect(res.body.url).toContain('/api/proxy?u=');
    expect(res.body.url).toContain(encodeURIComponent('http://upstream/a.mp3'));
    expect(res.body.audioQuality).toBe('flac');
  });

  it('quality 参数透传给解析器，非法值 400', async () => {
    const app = mockApp();
    const deps = makeDeps();
    mountPlaylistRoutes(app, deps);
    const res = mockRes();
    await app.routes['GET /api/kugou/track-url']({ query: { hash: 'h1', quality: '320' } }, res);
    expect(res.statusCode).toBe(200);
    expect(deps.resolveSongUrl).toHaveBeenCalledWith('h1', { targetQuality: '320' });

    const bad = mockRes();
    await app.routes['GET /api/kugou/track-url']({ query: { hash: 'h1', quality: 'piano' } }, bad);
    expect(bad.statusCode).toBe(400);
  });

  it('取到直链时同步运行中队列项的 audioQuality/audioUrl', async () => {
    const runtime = { queue: [{ title: 'A', kugouId: 'h1', audioUrl: null, audioQuality: null }], index: 0 };
    const app = mockApp();
    mountPlaylistRoutes(app, makeDeps({ runtime }));
    const res = mockRes();
    await app.routes['GET /api/kugou/track-url']({ query: { hash: 'h1', quality: '320' } }, res);
    expect(res.body.ok).toBe(true);
    expect(runtime.queue[0].audioQuality).toBe('flac'); // 实际档按解析器返回值
    expect(runtime.queue[0].audioUrl).toContain('/api/proxy?u=');
  });

  it('传 sync=0 时只返回本端直链，不覆盖共享队列项', async () => {
    const runtime = { queue: [{ title: 'A', kugouId: 'h1', audioUrl: '/api/proxy?u=orig.flac', audioQuality: 'flac' }], index: 0 };
    const app = mockApp();
    mountPlaylistRoutes(app, makeDeps({ runtime, resolveSongUrl: vi.fn(async () => ({ url: 'http://upstream/a.mp3', quality: '128' })) }));
    const res = mockRes();
    await app.routes['GET /api/music/track-url']({ query: { hash: 'h1', quality: '128', sync: '0' } }, res);
    expect(res.body.ok).toBe(true);
    expect(res.body.audioQuality).toBe('128');
    expect(runtime.queue[0].audioQuality).toBe('flac');
    expect(runtime.queue[0].audioUrl).toBe('/api/proxy?u=orig.flac');
  });

  it('取不到直链 → 404', async () => {
    const app = mockApp();
    mountPlaylistRoutes(app, makeDeps({ resolveSongUrl: vi.fn(async () => null) }));
    const res = mockRes();
    await app.routes['GET /api/kugou/track-url']({ query: { hash: 'h1' } }, res);
    expect(res.statusCode).toBe(404);
  });
});
