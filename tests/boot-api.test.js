import { describe, expect, it, vi } from 'vitest';
import { mountBootRoute } from '../server/api/boot.js';
import { mountExternalQueueRoutes } from '../server/api/external-queue.js';

function mockApp() {
  const routes = {};
  return {
    routes,
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

function dbMock() {
  return { addMessage: vi.fn(), addPlay: vi.fn(), recentPlays: vi.fn(() => []) };
}

describe('POST /api/boot', () => {
  it('external 模式不调用 Claude，原样返回当前队列', async () => {
    const runtime = {
      queue: [{ title: '外部', artist: 'Bot', kugouId: 'h1' }],
      index: 1,
      queueOffset: 12,
      paused: false,
      lastSay: 'bot 说',
      lastReason: '雨',
      queueSource: 'bot',
      trackEnded: false,
    };
    const ask = vi.fn();
    const app = mockApp();
    mountBootRoute(app, {
      runtime,
      brain: () => 'external',
      ask,
      buildSystemPrompt: vi.fn(),
      db: dbMock(),
      broadcast: vi.fn(),
    });
    const res = mockRes();
    await app.routes['POST /api/boot']({ body: {} }, res);
    expect(ask).not.toHaveBeenCalled();
    expect(res.body.brain).toBe('external');
    expect(res.body.skipped).toBe(true);
    expect(res.body.queue).toEqual(runtime.queue);
    expect(res.body.index).toBe(1);
    expect(res.body.queueOffset).toBe(12);
    expect(runtime.queueOffset).toBe(12);
    expect(runtime.queue[0].title).toBe('外部');
  });

  it('internal：boot 进行中外部写入后，回来不覆盖队列', async () => {
    const runtime = { queue: [], index: 0, paused: false, lastSay: '', queueSource: null, trackEnded: false };
    let release;
    const started = new Promise(resolve => { release = resolve; });
    const ask = vi.fn(() => new Promise(resolve => {
      release();
      ask._resolve = resolve;
    }));
    const app = mockApp();
    const db = dbMock();
    mountBootRoute(app, {
      runtime,
      brain: () => 'internal',
      ask,
      buildSystemPrompt: async () => 'SYS',
      db,
      broadcast: vi.fn(),
    });
    mountExternalQueueRoutes(app, {
      runtime,
      broadcast: vi.fn(),
      db,
      synthesize: async () => null,
      resolveTrack: async want => ({
        kugouId: 'hash-晴天',
        title: want.title,
        artist: want.artist,
        upstreamUrl: 'https://cdn.example/a.mp3',
        score: 150,
      }),
      writeTracks: async () => ({ ok: true, skipped: true }),
    });

    const bootRes = mockRes();
    const pending = app.routes['POST /api/boot']({ body: {} }, bootRes);
    await started;
    const extRes = mockRes();
    await app.routes['POST /api/queue/external']({
      body: {
        tracks: [
          { title: '晴天', artist: '周杰伦' },
          { title: '夜曲', artist: '周杰伦' },
        ],
        mode: 'replace',
      },
    }, extRes);
    runtime.index = 1;
    ask._resolve({
      say: '开播推荐',
      queue: [{ title: 'AI歌', artist: 'AI', kugouId: 'ai' }],
      reason: 'mood',
      raw: {},
    });
    await pending;

    expect(runtime.queue.map(item => item.title)).toEqual(['晴天', '夜曲']);
    expect(runtime.index).toBe(1);
    expect(runtime.queueSource).toBe('bot');
    expect(bootRes.body.skipped).toBe(true);
    expect(bootRes.body.preserved).toBe('external');
    expect(bootRes.body.index).toBe(1);
    expect(bootRes.body.queue.map(item => item.title)).toEqual(['晴天', '夜曲']);
    expect(db.addPlay).not.toHaveBeenCalledWith(expect.objectContaining({ source: 'boot' }));
  });

  it('internal：外部队列放完后 boot 正常换上开播曲目', async () => {
    const runtime = {
      queue: [{ title: '外部', artist: 'Bot' }],
      index: 0,
      queueOffset: 12,
      paused: true,
      lastSay: '',
      queueSource: 'bot',
      trackEnded: true,
    };
    const ask = vi.fn(async () => ({
      say: '换一批',
      queue: [{ title: '开播', artist: 'AI', kugouId: 'b1' }],
      reason: 'morning',
      raw: {},
    }));
    const app = mockApp();
    mountBootRoute(app, {
      runtime,
      brain: () => 'internal',
      ask,
      buildSystemPrompt: async () => '',
      db: dbMock(),
      broadcast: vi.fn(),
    });
    const res = mockRes();
    await app.routes['POST /api/boot']({ body: {} }, res);
    expect(ask).toHaveBeenCalled();
    expect(runtime.queue[0].title).toBe('开播');
    expect(runtime.queueSource).toBe('boot');
    expect(runtime.queueOffset).toBe(0);
    expect(res.body.queueOffset).toBe(0);
    expect(runtime.index).toBe(0);
    expect(res.body.skipped).toBeUndefined();
  });
});
