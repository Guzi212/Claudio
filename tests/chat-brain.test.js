import { describe, expect, it, vi } from 'vitest';
import { EXTERNAL_CHAT_HINT } from '../server/playback-control.js';
import { mountChatRoute } from '../server/api/chat.js';

function mockApp() {
  const routes = {};
  return { routes, post(path, handler) { routes[`POST ${path}`] = handler; } };
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

function setup(extra = {}) {
  const runtime = {
    queue: [{ title: '外部', artist: 'Bot', kugouId: 'h1' }, { title: '第二首', artist: 'Bot' }],
    index: 0,
    paused: false,
    lastSay: 'bot',
    queueSource: 'bot',
    trackEnded: false,
    volume: 100,
  };
  const app = mockApp();
  const db = { addMessage: vi.fn(), addPlay: vi.fn(), addFeedback: vi.fn(), recentPlays: vi.fn(() => []) };
  mountChatRoute(app, {
    runtime,
    db,
    broadcast: vi.fn(),
    ...extra,
  });
  return { app, runtime, db };
}

describe('POST /api/chat（弃用过渡期：仅控制命令与 external 提示）', () => {
  it('普通文字返回外部主持提示，不改队列', async () => {
    const { app, runtime } = setup();
    const res = mockRes();
    await app.routes['POST /api/chat']({ body: { message: '来点雨天的' } }, res);
    expect(res.body.say).toBe(EXTERNAL_CHAT_HINT);
    expect(res.body.brain).toBe('external');
    expect(runtime.queue[0].title).toBe('外部');
    expect(runtime.queueSource).toBe('bot');
  });

  it('/vol 会记住音量', async () => {
    const rememberVolume = vi.fn();
    const { app, runtime } = setup({ rememberVolume });
    const res = mockRes();
    await app.routes['POST /api/chat']({ body: { message: '/vol 36' } }, res);
    expect(runtime.volume).toBe(36);
    expect(rememberVolume).toHaveBeenCalledWith(36, { force: true });
  });

  it('仍执行 /pause', async () => {
    const { app, runtime } = setup();
    const res = mockRes();
    await app.routes['POST /api/chat']({ body: { message: '/pause' } }, res);
    expect(runtime.paused).toBe(true);
    expect(res.body.say).toContain('暂停');
  });
});
