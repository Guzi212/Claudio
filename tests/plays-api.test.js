import { describe, expect, it } from 'vitest';
import { dbApi } from '../server/db.js';
import { mountPlaysRoutes } from '../server/api/plays.js';

function mockApp() {
  const routes = {};
  return {
    routes,
    get(path, handler) { routes[`GET ${path}`] = handler; },
    post(path, handler) { routes[`POST ${path}`] = handler; },
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

describe('播放历史和反馈', () => {
  it('GET /api/plays 带 source、reason、时间和 skip', async () => {
    const stamp = `hist-${Date.now()}`;
    dbApi.addPlay({
      kugouId: `h-${stamp}`,
      title: stamp,
      artist: '周杰伦',
      reason: '雨天',
      source: 'bot',
    });
    dbApi.addFeedback({ kind: 'skip', kugouId: `h-${stamp}`, title: stamp, artist: '周杰伦' });

    const app = mockApp();
    mountPlaysRoutes(app, { db: dbApi });
    const res = mockRes();
    await app.routes['GET /api/plays']({ query: { limit: '20' } }, res);

    const play = res.body.plays.find(item => item.title === stamp);
    expect(play).toMatchObject({
      kugouId: `h-${stamp}`,
      artist: '周杰伦',
      reason: '雨天',
      source: 'bot',
    });
    expect(typeof play.ts).toBe('number');
    const feedback = res.body.feedback.find(item => item.title === stamp);
    expect(feedback).toMatchObject({ kind: 'skip', kugouId: `h-${stamp}` });
  });

  it('POST /api/feedback 接受 like', async () => {
    const app = mockApp();
    mountPlaysRoutes(app, { db: dbApi });
    const res = mockRes();
    await app.routes['POST /api/feedback']({
      body: { kind: 'like', title: `like-${Date.now()}`, artist: '周杰伦' },
    }, res);
    expect(res.body.ok).toBe(true);
    expect(res.body.kind).toBe('like');
  });

  it('非法 kind 返回 400', async () => {
    const app = mockApp();
    mountPlaysRoutes(app, { db: dbApi });
    const res = mockRes();
    await app.routes['POST /api/feedback']({ body: { kind: 'love', title: '晴天' } }, res);
    expect(res.statusCode).toBe(400);
  });
});
