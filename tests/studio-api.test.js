import { describe, it, expect } from 'vitest';
import { buildStudioState, mountStudioRoutes } from '../server/api/studio.js';

function mockApp() {
  const routes = {};
  return {
    routes,
    get(path, handler) { routes[`GET ${path}`] = handler; },
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

describe('buildStudioState', () => {
  it('空 runtime 返回电台控制台默认状态', () => {
    const state = buildStudioState({
      runtime: { queue: [], index: 0, paused: false, lastSay: '', active: false },
      now: new Date('2026-05-20T16:57:00+08:00'),
    });

    expect(state.brand).toBe('Claudio');
    expect(state.modes).toEqual(['DARK', 'POETRY', 'FOCUS']);
    expect(state.clock).toMatchObject({
      hhmm: '16:57',
      weekday: 'Wednesday',
      date: '20 · May · 2026',
    });
    expect(state.onAir).toBe(true);
    expect(state.nowPlaying).toBe(null);
    expect(state.dialog).toMatch(/准备好/);
    expect(state.queue).toEqual({ size: 0, index: 0, paused: false });
  });

  it('从 runtime 派生当前曲目、台词和队列状态', () => {
    const runtime = {
      queue: [
        { title: 'Cruel Summer', artist: 'Taylor Swift', audioUrl: '/a.mp3' },
        { title: 'What a Wonderful World', artist: 'Louis Armstrong', audioUrl: '/b.mp3' },
      ],
      index: 1,
      paused: true,
      active: true,
      lastSay: '绿树与红玫低语，天空蓝得透明，彩虹在雨后轻悬。',
    };

    const state = buildStudioState({ runtime, now: new Date('2026-05-20T09:01:00+08:00') });

    expect(state.onAir).toBe(false);
    expect(state.nowPlaying).toMatchObject({
      title: 'What a Wonderful World',
      artist: 'Louis Armstrong',
    });
    expect(state.dialog).toBe(runtime.lastSay);
    expect(state.queue).toEqual({ size: 2, index: 1, paused: true });
  });

  it('限制控制台台词长度，避免撑破前端布局', () => {
    const state = buildStudioState({
      runtime: {
        queue: [{ title: 'A', artist: 'B' }],
        index: 0,
        paused: false,
        lastSay: 'x'.repeat(120),
      },
      now: new Date('2026-05-20T09:01:00+08:00'),
    });

    expect(state.dialog).toHaveLength(73);
    expect(state.dialog.endsWith('…')).toBe(true);
  });
});

describe('mountStudioRoutes', () => {
  it('注册 GET /api/studio/state', () => {
    const app = mockApp();
    mountStudioRoutes(app, { runtime: { queue: [] } });
    expect(app.routes['GET /api/studio/state']).toBeTypeOf('function');
  });

  it('路由返回 ok + studio 状态', () => {
    const app = mockApp();
    mountStudioRoutes(app, {
      runtime: {
        queue: [{ title: 'Song', artist: 'Artist' }],
        index: 0,
        paused: false,
        lastSay: '正在调频。',
      },
      now: () => new Date('2026-05-20T16:57:00+08:00'),
    });

    const res = mockRes();
    app.routes['GET /api/studio/state']({}, res);

    expect(res.body.ok).toBe(true);
    expect(res.body.studio.nowPlaying).toMatchObject({ title: 'Song', artist: 'Artist' });
  });
});
