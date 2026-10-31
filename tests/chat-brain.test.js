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

function setup(brain) {
  const runtime = {
    queue: [{ title: '外部', artist: 'Bot', kugouId: 'h1' }, { title: '第二首', artist: 'Bot' }],
    index: 0,
    paused: false,
    lastSay: 'bot',
    queueSource: 'bot',
    trackEnded: false,
    volume: 100,
  };
  const ask = vi.fn(async () => ({
    say: '换成这首',
    queue: [{ title: '聊天歌', artist: 'AI', kugouId: 'c1' }],
    reason: 'user',
    raw: {},
  }));
  const app = mockApp();
  const db = { addMessage: vi.fn(), addPlay: vi.fn(), addFeedback: vi.fn(), recentPlays: vi.fn(() => []) };
  mountChatRoute(app, {
    runtime,
    brain: () => brain,
    ask,
    buildSystemPrompt: async () => 'SYS',
    synthesize: async () => null,
    detectSignal: () => null,
    appendJournalEntry: () => {},
    db,
    broadcast: vi.fn(),
  });
  return { app, runtime, ask, db };
}

describe('POST /api/chat · CLAUDIO_BRAIN', () => {
  it('external 普通文字不调用 Claude，也不改队列', async () => {
    const { app, runtime, ask } = setup('external');
    const res = mockRes();
    await app.routes['POST /api/chat']({ body: { message: '来点雨天的' } }, res);
    expect(ask).not.toHaveBeenCalled();
    expect(res.body.say).toBe(EXTERNAL_CHAT_HINT);
    expect(res.body.brain).toBe('external');
    expect(runtime.queue[0].title).toBe('外部');
    expect(runtime.queueSource).toBe('bot');
  });

  it('external 的 /vol 会记住音量', async () => {
    const rememberVolume = vi.fn();
    const { app, runtime, ask } = setup('external');
    mountChatRoute(app, {
      runtime,
      brain: () => 'external',
      ask,
      buildSystemPrompt: async () => 'SYS',
      synthesize: async () => null,
      detectSignal: () => null,
      appendJournalEntry: () => {},
      db: { addMessage: vi.fn(), addPlay: vi.fn(), addFeedback: vi.fn(), recentPlays: vi.fn(() => []) },
      broadcast: vi.fn(),
      rememberVolume,
    });
    const res = mockRes();
    await app.routes['POST /api/chat']({ body: { message: '/vol 36' } }, res);
    expect(ask).not.toHaveBeenCalled();
    expect(runtime.volume).toBe(36);
    expect(rememberVolume).toHaveBeenCalledWith(36, { force: true });
  });

  it('external 仍执行 /pause', async () => {
    const { app, runtime, ask } = setup('external');
    const res = mockRes();
    await app.routes['POST /api/chat']({ body: { message: '/pause' } }, res);
    expect(ask).not.toHaveBeenCalled();
    expect(runtime.paused).toBe(true);
    expect(res.body.say).toContain('暂停');
  });

  it('internal 聊天选歌会覆盖还没放完的外部队列', async () => {
    const { app, runtime, ask } = setup('internal');
    runtime.queueOffset = 12;
    const res = mockRes();
    await app.routes['POST /api/chat']({ body: { message: '换一首' } }, res);
    expect(ask).toHaveBeenCalled();
    expect(runtime.queue[0].title).toBe('聊天歌');
    expect(runtime.queueSource).toBe('claude');
    expect(runtime.queueOffset).toBe(0);
    expect(runtime.index).toBe(0);
    expect(res.body.queue[0].title).toBe('聊天歌');
  });
});
