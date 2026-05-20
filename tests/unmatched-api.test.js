import { describe, it, expect } from 'vitest';
import { mountUnmatchedRoute } from '../server/api/unmatched.js';

function mockApp() {
  const routes = {};
  return {
    routes,
    get(p, h) { routes[`GET ${p}`] = h; },
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

function fakeDb(items = []) {
  return { recentUnmatched: (n) => items.slice(0, n) };
}

describe('mountUnmatchedRoute', () => {
  it('注册 GET /api/unmatched', () => {
    const app = mockApp();
    mountUnmatchedRoute(app, { db: fakeDb() });
    expect(app.routes['GET /api/unmatched']).toBeTypeOf('function');
  });

  it('返回 db 里的 items', () => {
    const items = [{ id: 1, title: '歌名', artist: '歌手', hint: null, ts: 1 }];
    const app = mockApp();
    mountUnmatchedRoute(app, { db: fakeDb(items) });
    const res = mockRes();
    app.routes['GET /api/unmatched']({ query: {} }, res);
    expect(res.body).toEqual({ ok: true, items });
  });

  it('limit 上限 200', () => {
    let called;
    const db = { recentUnmatched: (n) => { called = n; return []; } };
    const app = mockApp();
    mountUnmatchedRoute(app, { db });
    const res = mockRes();
    app.routes['GET /api/unmatched']({ query: { limit: '9999' } }, res);
    expect(called).toBe(200);
  });

  it('limit 下限 1', () => {
    let called;
    const db = { recentUnmatched: (n) => { called = n; return []; } };
    const app = mockApp();
    mountUnmatchedRoute(app, { db });
    const res = mockRes();
    app.routes['GET /api/unmatched']({ query: { limit: '-5' } }, res);
    expect(called).toBe(1);
  });

  it('默认 limit 50', () => {
    let called;
    const db = { recentUnmatched: (n) => { called = n; return []; } };
    const app = mockApp();
    mountUnmatchedRoute(app, { db });
    const res = mockRes();
    app.routes['GET /api/unmatched']({ query: {} }, res);
    expect(called).toBe(50);
  });

  it('db 抛错 → 500', () => {
    const db = { recentUnmatched: () => { throw new Error('db error'); } };
    const app = mockApp();
    mountUnmatchedRoute(app, { db });
    const res = mockRes();
    app.routes['GET /api/unmatched']({ query: {} }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.ok).toBe(false);
  });
});
