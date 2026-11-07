import { describe, expect, it, vi } from 'vitest';
import { mountFavoriteRoutes } from '../server/api/favorites.js';

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
  const store = {
    isFavorite: vi.fn(async () => true),
    add: vi.fn(async () => ({
      ok: true,
      liked: true,
      duplicate: false,
      playlist: { name: '我喜欢', listid: '2' },
      track: {
        title: '晴天',
        artist: '周杰伦',
        album: '叶惠美',
        albumId: 'a1',
        mixsongid: 'm1',
      },
    })),
    remove: vi.fn(async () => ({
      ok: true,
      liked: false,
      removed: true,
      playlist: { name: '我喜欢', listid: '2' },
    })),
  };
  const db = {
    addLikePending: vi.fn(() => 7),
    cancelLikePendingByHash: vi.fn(),
  };
  return { store, db, ...overrides };
}

describe('GET /api/kugou/favorite', () => {
  it('缺 hash → 400', async () => {
    const app = mockApp();
    mountFavoriteRoutes(app, makeDeps());
    const res = mockRes();
    await app.routes['GET /api/kugou/favorite']({ query: {} }, res);
    expect(res.statusCode).toBe(400);
  });

  it('返回是否已收藏', async () => {
    const app = mockApp();
    mountFavoriteRoutes(app, makeDeps());
    const res = mockRes();
    await app.routes['GET /api/kugou/favorite']({ query: { hash: 'h1' } }, res);
    expect(res.body).toEqual({ ok: true, liked: true });
  });
});

describe('POST /api/kugou/favorite', () => {
  it('加入成功后写一条待分类记录', async () => {
    const deps = makeDeps();
    const app = mockApp();
    mountFavoriteRoutes(app, deps);
    const res = mockRes();
    await app.routes['POST /api/kugou/favorite']({
      body: { action: 'add', track: { hash: 'h1', title: '晴天', artist: '周杰伦' } },
    }, res);
    expect(res.body.ok).toBe(true);
    expect(res.body.pendingId).toBe(7);
    expect(deps.db.addLikePending).toHaveBeenCalledWith({
      kugouId: 'h1',
      title: '晴天',
      artist: '周杰伦',
      album: '叶惠美',
      albumId: 'a1',
      mixsongid: 'm1',
    });
  });

  it('重复收藏不写待分类记录', async () => {
    const deps = makeDeps();
    deps.store.add = vi.fn(async () => ({
      ok: true,
      liked: true,
      duplicate: true,
      playlist: { name: '我喜欢', listid: '2' },
    }));
    const app = mockApp();
    mountFavoriteRoutes(app, deps);
    const res = mockRes();
    await app.routes['POST /api/kugou/favorite']({
      body: { action: 'add', track: { hash: 'h1', title: '晴天' } },
    }, res);
    expect(res.body.duplicate).toBe(true);
    expect(res.body.pendingId).toBeNull();
    expect(deps.db.addLikePending).not.toHaveBeenCalled();
  });

  it('取消收藏时关闭待分类记录', async () => {
    const deps = makeDeps();
    const app = mockApp();
    mountFavoriteRoutes(app, deps);
    const res = mockRes();
    await app.routes['POST /api/kugou/favorite']({
      body: { action: 'remove', track: { hash: 'h1', title: '晴天' } },
    }, res);
    expect(res.body.removed).toBe(true);
    expect(deps.db.cancelLikePendingByHash).toHaveBeenCalledWith('h1');
  });

  it('action 非法 → 400', async () => {
    const app = mockApp();
    mountFavoriteRoutes(app, makeDeps());
    const res = mockRes();
    await app.routes['POST /api/kugou/favorite']({ body: { action: 'toggle' } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('缺 title → 400', async () => {
    const app = mockApp();
    mountFavoriteRoutes(app, makeDeps());
    const res = mockRes();
    await app.routes['POST /api/kugou/favorite']({ body: { action: 'add', track: { hash: 'h1' } } }, res);
    expect(res.statusCode).toBe(400);
  });
});
