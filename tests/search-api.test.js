import { describe, expect, it, vi } from 'vitest';
import { mountSearchRoute } from '../server/api/search.js';

function mockApp() {
  const routes = {};
  return { routes, get(path, handler) { routes[`GET ${path}`] = handler; } };
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

describe('GET /api/kugou/search', () => {
  it('复用搜索结果，不把 raw 透出去', async () => {
    const search = vi.fn(async () => [{
      hash: 'HASH',
      title: '晴天',
      artist: '周杰伦',
      album: '叶惠美',
      duration: 269,
      score: 150,
      raw: { secret: true },
    }]);
    const app = mockApp();
    mountSearchRoute(app, { search });
    const res = mockRes();
    await app.routes['GET /api/kugou/search']({ query: { title: '晴天', artist: '周杰伦' } }, res);
    expect(search).toHaveBeenCalledWith({ title: '晴天', artist: '周杰伦', hint: '' });
    expect(res.body.ok).toBe(true);
    expect(res.body.tracks).toEqual([{
      hash: 'HASH',
      title: '晴天',
      artist: '周杰伦',
      album: '叶惠美',
      duration: 269,
      score: 150,
    }]);
  });

  it('缺 title 返回 400', async () => {
    const app = mockApp();
    mountSearchRoute(app, { search: vi.fn() });
    const res = mockRes();
    await app.routes['GET /api/kugou/search']({ query: {} }, res);
    expect(res.statusCode).toBe(400);
  });
});
