import { describe, expect, it, vi } from 'vitest';
import { mountBootRoute } from '../server/api/boot.js';
import { warnRemovedInternalBrain } from '../server/app.js';

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

describe('POST /api/boot（弃用过渡期：固定 external）', () => {
  it('原样返回当前队列、index、brain: external 与 skipped: true', async () => {
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
    const app = mockApp();
    mountBootRoute(app, { runtime });
    const res = mockRes();
    await app.routes['POST /api/boot']({ body: {} }, res);
    expect(res.body.brain).toBe('external');
    expect(res.body.skipped).toBe(true);
    expect(res.body.say).toBe('bot 说');
    expect(res.body.queue).toEqual(runtime.queue);
    expect(res.body.index).toBe(1);
    expect(res.body.queueOffset).toBe(12);
    expect(runtime.queueOffset).toBe(12);
    expect(runtime.queue[0].title).toBe('外部');
  });

  it('空队列时提示等待点歌且 brain 为 external', async () => {
    const runtime = { queue: [], index: 0, queueOffset: 0, lastSay: '', lastReason: '' };
    const app = mockApp();
    mountBootRoute(app, { runtime });
    const res = mockRes();
    await app.routes['POST /api/boot']({ body: {} }, res);
    expect(res.body).toEqual({
      say: '等待点歌',
      queue: [],
      index: 0,
      queueOffset: 0,
      reason: '',
      intent: 'boot',
      brain: 'external',
      skipped: true,
      _resolveError: false,
    });
  });
});

describe('warnRemovedInternalBrain', () => {
  it('环境或旧设置仍为 internal 时打一行 warn，不抛错', () => {
    const warn = vi.fn();
    expect(warnRemovedInternalBrain({ env: { CLAUDIO_BRAIN: 'internal' }, db: { getPref: () => null }, warn })).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('internal 模式已移除，按 external 运行'));

    warn.mockClear();
    expect(warnRemovedInternalBrain({ env: { BRAIN_MODE: ' Internal ' }, db: { getPref: () => null }, warn })).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockClear();
    expect(warnRemovedInternalBrain({ env: {}, db: { getPref: k => (k === 'brain_mode' ? 'internal' : null) }, warn })).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('未设置 internal 时静默', () => {
    const warn = vi.fn();
    expect(warnRemovedInternalBrain({ env: { CLAUDIO_BRAIN: 'external' }, db: { getPref: () => null }, warn })).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
