import { describe, expect, it, vi } from 'vitest';
import { mountControlRoute } from '../server/api/control.js';
import { playbackStatus, applyProgress } from '../server/playback-control.js';

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

function setup() {
  const runtime = {
    queue: [
      { title: '第一首', artist: 'A', kugouId: 'a' },
      { title: '第二首', artist: 'B', kugouId: 'b' },
    ],
    index: 0,
    paused: false,
    volume: 100,
    currentTime: 12,
    duration: 200,
    active: true,
    lastSay: '串场',
    lastReason: '雨',
  };
  const broadcast = vi.fn();
  const db = { addFeedback: vi.fn(() => 7) };
  const app = mockApp();
  mountControlRoute(app, { runtime, broadcast, db });
  return { app, runtime, broadcast, db };
}

describe('POST /api/control', () => {
  it('next 切到下一首、广播，并记下 skip', async () => {
    const { app, runtime, broadcast, db } = setup();
    const res = mockRes();
    await app.routes['POST /api/control']({ body: { command: 'next' } }, res);
    expect(res.body.ok).toBe(true);
    expect(res.body.index).toBe(1);
    expect(res.body.nowPlaying.title).toBe('第二首');
    expect(runtime.paused).toBe(false);
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'state' }));
    expect(db.addFeedback).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'skip',
      title: '第一首',
      kugouId: 'a',
    }));
  });

  it('pause / play / volume / jump', async () => {
    const { app, runtime } = setup();
    const pause = mockRes();
    await app.routes['POST /api/control']({ body: { command: 'pause' } }, pause);
    expect(runtime.paused).toBe(true);

    const play = mockRes();
    await app.routes['POST /api/control']({ body: { command: 'play' } }, play);
    expect(runtime.paused).toBe(false);

    const volume = mockRes();
    await app.routes['POST /api/control']({ body: { command: 'volume', value: 40 } }, volume);
    expect(runtime.volume).toBe(40);
    expect(volume.body.volume).toBe(40);

    const jump = mockRes();
    await app.routes['POST /api/control']({ body: { command: 'jump', value: 1 } }, jump);
    expect(runtime.index).toBe(1);
    expect(jump.body.nowPlaying.title).toBe('第二首');
  });

  it('坏音量返回 400', async () => {
    const { app } = setup();
    const res = mockRes();
    await app.routes['POST /api/control']({ body: { command: 'volume', value: 'loud' } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
  });
});

describe('播放进度', () => {
  it('applyProgress 写入秒数、时长和音量', () => {
    const runtime = { queue: [{ title: 'A' }], index: 0, paused: false, volume: 100 };
    applyProgress(runtime, { type: 'progress', currentTime: 3.5, duration: 180, volume: 25, paused: true, index: 0 });
    expect(runtime.currentTime).toBe(3.5);
    expect(runtime.duration).toBe(180);
    expect(runtime.volume).toBe(25);
    expect(runtime.paused).toBe(true);
  });

  it('status 带上进度、音量和在线人数', () => {
    const body = playbackStatus({
      queue: [{ title: '晴天', artist: '周杰伦' }],
      index: 0,
      paused: false,
      volume: 40,
      currentTime: 8,
      duration: 240,
      active: true,
      lastSay: '今晚',
      lastReason: '雨',
    }, { listeners: 1, brain: 'external' });
    expect(body).toMatchObject({
      ok: true,
      brain: 'external',
      index: 0,
      paused: false,
      volume: 40,
      currentTime: 8,
      duration: 240,
      active: true,
      listeners: 1,
      lastSay: '今晚',
      reason: '雨',
    });
    expect(body.nowPlaying.title).toBe('晴天');
  });
});
