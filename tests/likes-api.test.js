import { describe, expect, it, vi } from 'vitest';
import { mountLikeRoutes } from '../server/api/likes.js';

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

function row(overrides = {}) {
  return {
    id: 1,
    kugou_id: 'h1',
    title: '晴天',
    artist: '周杰伦',
    album: '叶惠美',
    album_id: 'a1',
    mixsongid: 'm1',
    status: 'pending',
    target_playlist: null,
    target_listid: null,
    note: null,
    created_ts: 100,
    resolved_ts: null,
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  const db = {
    pendingLikes: vi.fn(() => [row()]),
    getLikePending: vi.fn(() => row()),
    resolveLikePending: vi.fn(),
    skipLikePending: vi.fn(),
  };
  return {
    db,
    findPlaylist: vi.fn(async () => ({ name: '学习', listid: '49', type: 0 })),
    appendTrack: vi.fn(async () => ({ ok: true, duplicate: false, added: 1 })),
    ...overrides,
  };
}

describe('GET /api/likes/pending', () => {
  it('返回待分类列表', async () => {
    const app = mockApp();
    mountLikeRoutes(app, makeDeps());
    const res = mockRes();
    await app.routes['GET /api/likes/pending']({ query: {} }, res);
    expect(res.body.ok).toBe(true);
    expect(res.body.items[0]).toMatchObject({
      id: 1,
      kugouId: 'h1',
      title: '晴天',
      status: 'pending',
    });
  });
});

describe('POST /api/likes/:id/classify', () => {
  it('id 非法 → 400', async () => {
    const app = mockApp();
    mountLikeRoutes(app, makeDeps());
    const res = mockRes();
    await app.routes['POST /api/likes/:id/classify']({ params: { id: 'x' }, body: {} }, res);
    expect(res.statusCode).toBe(400);
  });

  it('记录不存在 → 404', async () => {
    const deps = makeDeps();
    deps.db.getLikePending = vi.fn(() => null);
    const app = mockApp();
    mountLikeRoutes(app, deps);
    const res = mockRes();
    await app.routes['POST /api/likes/:id/classify']({ params: { id: '9' }, body: {} }, res);
    expect(res.statusCode).toBe(404);
  });

  it('已完成的记录幂等返回', async () => {
    const deps = makeDeps();
    deps.db.getLikePending = vi.fn(() => row({ status: 'done' }));
    const app = mockApp();
    mountLikeRoutes(app, deps);
    const res = mockRes();
    await app.routes['POST /api/likes/:id/classify']({ params: { id: '1' }, body: {} }, res);
    expect(res.body.already).toBe(true);
    expect(deps.appendTrack).not.toHaveBeenCalled();
  });

  it('缺目标歌单 → 400', async () => {
    const app = mockApp();
    mountLikeRoutes(app, makeDeps());
    const res = mockRes();
    await app.routes['POST /api/likes/:id/classify']({ params: { id: '1' }, body: {} }, res);
    expect(res.statusCode).toBe(400);
  });

  it('收藏别人的只读歌单 → 400', async () => {
    const deps = makeDeps({
      findPlaylist: vi.fn(async () => ({ name: '别人的歌单', listid: '25', type: 1 })),
    });
    const app = mockApp();
    mountLikeRoutes(app, deps);
    const res = mockRes();
    await app.routes['POST /api/likes/:id/classify']({
      params: { id: '1' },
      body: { playlist: { listid: '25' } },
    }, res);
    expect(res.statusCode).toBe(400);
    expect(deps.appendTrack).not.toHaveBeenCalled();
  });

  it('成功追加并标记完成', async () => {
    const deps = makeDeps();
    const app = mockApp();
    mountLikeRoutes(app, deps);
    const res = mockRes();
    await app.routes['POST /api/likes/:id/classify']({
      params: { id: '1' },
      body: { playlist: { listid: '49' } },
    }, res);
    expect(res.body.ok).toBe(true);
    expect(res.body.playlist).toEqual({ name: '学习', listid: '49' });
    expect(deps.appendTrack).toHaveBeenCalledWith({
      listid: '49',
      track: {
        kugouId: 'h1',
        title: '晴天',
        artist: '周杰伦',
        album: '叶惠美',
        albumId: 'a1',
        mixsongid: 'm1',
      },
    });
    expect(deps.db.resolveLikePending).toHaveBeenCalledWith(1, {
      targetPlaylist: '学习',
      targetListid: '49',
    });
  });

  it('目标歌单已有这首时也标记完成', async () => {
    const deps = makeDeps({
      appendTrack: vi.fn(async () => ({ ok: true, duplicate: true, added: 0 })),
    });
    const app = mockApp();
    mountLikeRoutes(app, deps);
    const res = mockRes();
    await app.routes['POST /api/likes/:id/classify']({
      params: { id: '1' },
      body: { playlist: { listid: '49' } },
    }, res);
    expect(res.body.duplicate).toBe(true);
    expect(deps.db.resolveLikePending).toHaveBeenCalled();
  });
});

describe('POST /api/likes/:id/skip', () => {
  it('标记跳过', async () => {
    const deps = makeDeps();
    const app = mockApp();
    mountLikeRoutes(app, deps);
    const res = mockRes();
    await app.routes['POST /api/likes/:id/skip']({ params: { id: '1' }, body: { note: '没有合适分类' } }, res);
    expect(deps.db.skipLikePending).toHaveBeenCalledWith(1, { note: '没有合适分类' });
    expect(res.body.ok).toBe(true);
  });

  it('记录不存在 → 404', async () => {
    const deps = makeDeps();
    deps.db.getLikePending = vi.fn(() => null);
    const app = mockApp();
    mountLikeRoutes(app, deps);
    const res = mockRes();
    await app.routes['POST /api/likes/:id/skip']({ params: { id: '9' }, body: {} }, res);
    expect(res.statusCode).toBe(404);
  });
});
