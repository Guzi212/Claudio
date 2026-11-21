import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountQueueClearRoutes } from '../server/api/queue-clear.js';
import { mountRuntimeRoutes } from '../server/api/runtime.js';
import { mountExternalQueueRoutes } from '../server/api/external-queue.js';
import { mountContinuePoolRoutes } from '../server/api/continue-pool.js';
import { mountControlRoute } from '../server/api/control.js';
import { clearQueue } from '../server/queue-clear.js';
import { applyProgress, playbackStatus } from '../server/playback-control.js';
import { continueFromPool } from '../server/continue-pool.js';
import { queueEpochOf, queueWriteIsStale } from '../server/queue-source.js';
import { shouldRefill, startResidentDj, DJ_SOURCE } from '../server/dj/resident.js';
import { authMiddleware } from '../server/auth.js';
import { planRuntimeSync } from '../pwa/runtime-sync.js';
import { stopAudioForEmptyQueue } from '../pwa/player-mode.js';

const playerJs = fs.readFileSync('./pwa/views/player.js', 'utf8');

function song(title, artist = '周杰伦') {
  return {
    kugouId: `hash-${title}`,
    title,
    artist,
    album: '',
    duration: 200,
    upstreamUrl: `https://cdn.kugou.com/${title}.mp3`,
    score: 150,
  };
}

function pool() {
  return {
    name: '续播池',
    source: 'claudio-host',
    shuffle: false,
    loop: true,
    batchSize: 2,
    cursor: 0,
    setAt: '2026-11-20T10:00:00.000Z',
    lastContinuedAt: null,
    continuedCount: 0,
    tracks: [
      { title: '池一', artist: 'B', kugouId: 'pool-1' },
      { title: '池二', artist: 'C', kugouId: 'pool-2' },
      { title: '池三', artist: 'D', kugouId: 'pool-3' },
    ],
  };
}

function makeRuntime(overrides = {}) {
  const continuePool = overrides.continuePool === undefined ? pool() : overrides.continuePool;
  return {
    queue: [
      { title: '第一首', artist: 'A', kugouId: 'a' },
      { title: '第二首', artist: 'B', kugouId: 'b' },
      { title: '第三首', artist: 'C', kugouId: 'c' },
    ],
    index: 1,
    queueOffset: 0,
    paused: false,
    trackEnded: false,
    currentTime: 42,
    duration: 200,
    volume: 37,
    volumeExplicit: true,
    active: true,
    queueSource: 'bot',
    queuedAt: '2026-11-20T10:00:00.000Z',
    queuedSource: 'bot',
    lastSay: '上一段口播',
    lastReason: '雨天',
    continuePool,
    queueEpoch: 5,
    continueSuppressed: false,
    ...overrides,
  };
}

function setup(overrides = {}) {
  const routes = {};
  const app = { routes };
  for (const method of ['get', 'put', 'post', 'delete']) {
    app[method] = (path, handler) => { routes[`${method.toUpperCase()} ${path}`] = handler; };
  }

  const prefs = new Map();
  const db = overrides.db || {
    getPref: key => prefs.get(key) ?? null,
    setPref: vi.fn((key, value) => prefs.set(key, String(value))),
    delPref: vi.fn(key => prefs.delete(key)),
    addPlay: vi.fn(),
  };
  const runtime = overrides.runtime || makeRuntime();
  const events = [];
  const broadcast = vi.fn(event => events.push(structuredClone(event)));

  const resolveTrack = overrides.resolveTrack || vi.fn(async want => song(want.title, want.artist));
  const deps = {
    runtime,
    db,
    broadcast,
    resolveTrack,
    writeTracks: vi.fn(async () => ({ ok: true, skipped: true })),
    synthesize: async () => null,
    random: () => 0,
    statusOptions: () => ({ brain: 'external', listeners: 0 }),
  };
  mountQueueClearRoutes(app, deps);
  mountRuntimeRoutes(app, deps);
  mountExternalQueueRoutes(app, deps);
  mountContinuePoolRoutes(app, deps);
  mountControlRoute(app, deps);

  async function call(methodAndPath, body) {
    const key = methodAndPath.includes(' ') ? methodAndPath : `POST ${methodAndPath}`;
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = structuredClone(value); return this; },
    };
    await routes[key]({ body }, res);
    return res;
  }

  return { app, routes, runtime, db, prefs, broadcast, events, resolveTrack, call };
}

afterEach(() => vi.unstubAllEnvs());

describe('POST /api/queue/clear · 正式清空', () => {
  it('非空队列：队列与进度复位、epoch 递增、续播抑制、池和音量保持', async () => {
    const s = setup();
    const beforePool = structuredClone(s.runtime.continuePool);

    const res = await s.call('POST /api/queue/clear', {
      reason: 'host-clear',
      clientId: 'should-not-echo',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      cleared: true,
      alreadyEmpty: false,
      queueLen: 0,
      index: 0,
      paused: true,
      currentTime: 0,
      duration: 0,
      nowPlaying: null,
      queue: [],
      queueEpoch: 6,
      continueSuppressed: true,
      volume: 37,
    });
    expect(res.body.continuePool).toMatchObject({ name: '续播池', size: 3, active: true });

    expect(s.runtime).toMatchObject({
      queue: [],
      index: 0,
      paused: true,
      currentTime: 0,
      duration: 0,
      trackEnded: false,
      queueEpoch: 6,
      continueSuppressed: true,
      volume: 37,
      volumeExplicit: true,
    });
    expect(s.runtime.continuePool).toEqual(beforePool);
    expect(s.runtime.lastSay).toBe('上一段口播');

    // 清空广播必须让所有客户端停声，不带 origin 回声。
    const stateEvents = s.events.filter(e => e.type === 'state');
    expect(stateEvents).toHaveLength(1);
    expect(stateEvents[0].origin).toBeUndefined();
    expect(stateEvents[0].runtime.queue).toEqual([]);
    expect(stateEvents[0].runtime.queueEpoch).toBe(6);

    // 不写 prefs、不写播放历史、不删续播池。
    expect(s.db.setPref).not.toHaveBeenCalled();
    expect(s.db.delPref).not.toHaveBeenCalled();
    expect(s.db.addPlay).not.toHaveBeenCalled();
  });

  it('DELETE /api/queue 与 POST 语义一致', async () => {
    const s = setup();
    const res = await s.call('DELETE /api/queue');
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, cleared: true, queueLen: 0, queueEpoch: 6 });
    expect(s.runtime.queue).toEqual([]);
    expect(s.events.at(-1)).toMatchObject({ type: 'state' });
    expect(s.events.at(-1).origin).toBeUndefined();
  });

  it('已空队列：幂等成功，alreadyEmpty=true，epoch 仍递增', async () => {
    const s = setup({ runtime: makeRuntime({ queue: [], index: 0, currentTime: 0, duration: 0 }) });
    const first = await s.call('POST /api/queue/clear');
    expect(first.statusCode).toBe(200);
    expect(first.body).toMatchObject({ ok: true, alreadyEmpty: true, queueEpoch: 6, continueSuppressed: true });

    const second = await s.call('POST /api/queue/clear');
    expect(second.statusCode).toBe(200);
    expect(second.body).toMatchObject({ ok: true, alreadyEmpty: true, queueEpoch: 7, continueSuppressed: true });
    expect(s.runtime.continueSuppressed).toBe(true);
    expect(s.db.addPlay).not.toHaveBeenCalled();
  });

  it('清空不改音量、收藏、历史与窗口设置类 prefs', async () => {
    const s = setup();
    const setPref = s.db.setPref;
    await s.call('POST /api/queue/clear', { reason: 'ui-clear' });
    expect(s.runtime.volume).toBe(37);
    expect(s.runtime.volumeExplicit).toBe(true);
    expect(setPref).not.toHaveBeenCalled();
  });

  it('未授权请求不改队列（沿用现有 /api 鉴权）', async () => {
    const s = setup();
    const req = {
      path: '/api/queue/clear',
      url: '/api/queue/clear',
      headers: {},
      query: {},
      socket: { remoteAddress: '8.8.8.8' },
    };
    const res = {
      statusCode: 200,
      body: undefined,
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; },
    };
    let nextCalled = false;
    authMiddleware(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'unauthorized' });
    expect(s.runtime.queue).toHaveLength(3);
    expect(s.runtime.queueEpoch).toBe(5);
  });
});

describe('clearQueue 纯函数 · 语义边界', () => {
  it('续播池保留但 suspend，continueFromPool 直接返回 false', () => {
    const runtime = makeRuntime();
    const db = { setPref: vi.fn(), delPref: vi.fn() };
    clearQueue(runtime, { reason: 'host-clear' });
    expect(continueFromPool(runtime, { db })).toBe(false);
    expect(runtime.queue).toEqual([]);
    expect(runtime.continuePool).toBeTruthy();
    expect(db.setPref).not.toHaveBeenCalled();
    expect(db.delPref).not.toHaveBeenCalled();
  });

  it('DELETE /api/continue-pool 仍只删池，不清队列', async () => {
    const s = setup();
    const res = await s.call('DELETE /api/continue-pool');
    expect(res.statusCode).toBe(200);
    expect(s.runtime.continuePool).toBeNull();
    expect(s.runtime.queue).toHaveLength(3);
    expect(s.runtime.queueEpoch).toBe(5);
  });

  it('空 tracks 的 external-queue 仍被拒绝，不能冒充清空', async () => {
    const s = setup();
    const res = await s.call('POST /api/queue/external', { tracks: [], mode: 'replace' });
    expect(res.statusCode).toBe(400);
    expect(s.runtime.queue).toHaveLength(3);
    expect(s.runtime.queueEpoch).toBe(5);
  });

  it('control 不支持 clear（未知命令仍 400），清空后 play 也不会解除暂停', async () => {
    const s = setup();
    const unsupported = await s.call('POST /api/control', { command: 'clear' });
    expect(unsupported.statusCode).toBe(400);
    expect(s.runtime.queue).toHaveLength(3);

    await s.call('POST /api/queue/clear');
    const play = await s.call('POST /api/control', { command: 'play' });
    expect(play.statusCode).toBe(200);
    expect(play.body.say).toBe('队列是空的');
    expect(s.runtime.paused).toBe(true);
    expect(s.runtime.queue).toEqual([]);
  });

  it('GET /api/status 与 /api/now 增加只读 epoch / 抑制字段', async () => {
    const s = setup();
    await s.call('POST /api/queue/clear');
    for (const path of ['GET /api/status', 'GET /api/now']) {
      const res = await s.call(path);
      expect(res.body).toMatchObject({
        queueEpoch: 6,
        continueSuppressed: true,
        queue: [],
        paused: true,
      });
    }
  });
});

describe('队列 epoch · 在途与过期写回', () => {
  it('带旧 epoch 的 state / advance / progress 全部视为 stale', async () => {
    const s = setup();
    await s.call('POST /api/queue/clear');

    const state = await s.call('POST /api/runtime/state', {
      index: 1, queueOffset: 0, paused: false, ended: false, queueEpoch: 5,
    });
    expect(state.body.stale).toBe(true);
    expect(s.runtime).toMatchObject({ queue: [], index: 0, paused: true, currentTime: 0 });

    const advance = await s.call('POST /api/runtime/advance', { queueEpoch: 5 });
    expect(advance.body.stale).toBe(true);
    expect(s.runtime.queue).toEqual([]);

    applyProgress(s.runtime, {
      index: 1, queueOffset: 0, currentTime: 99, duration: 200, paused: false, queueEpoch: 5,
    });
    expect(s.runtime).toMatchObject({ currentTime: 0, duration: 0, index: 0, paused: true });
  });

  it('旧客户端不带 epoch：抑制期忽略播放写回，但不能把歌复活', async () => {
    const s = setup();
    await s.call('POST /api/queue/clear');

    const state = await s.call('POST /api/runtime/state', {
      index: 0, paused: false, ended: false,
    });
    expect(state.body.stale).toBe(true);
    expect(s.runtime).toMatchObject({ queue: [], paused: true, index: 0 });

    applyProgress(s.runtime, { currentTime: 77, paused: false, volume: 51 });
    expect(s.runtime.currentTime).toBe(0);
    expect(s.runtime.paused).toBe(true);
    // 音量不是播放进度，仍按显式上报更新。
    expect(s.runtime.volume).toBe(51);

    expect(queueWriteIsStale(s.runtime, {})).toBe(true);
    expect(queueWriteIsStale(s.runtime, { queueEpoch: 6 })).toBe(false);
  });

  it('队列为空、未抑制时，不带 epoch 的进度仍被接受', () => {
    const runtime = makeRuntime({ queue: [], index: 0, paused: true, continueSuppressed: false });
    expect(queueWriteIsStale(runtime, {})).toBe(false);
    applyProgress(runtime, { currentTime: 12, paused: false });
    expect(runtime.currentTime).toBe(12);
  });

  it('尾部自动续播在 clear 之后不会回填队列', async () => {
    const s = setup();
    await s.call('POST /api/queue/clear');

    const state = await s.call('POST /api/runtime/state', {
      index: 0, queueOffset: 0, paused: true, ended: true, queueEpoch: 6,
    });
    expect(state.body.continued).toBe(false);
    expect(state.body.stale).toBe(false);
    expect(s.runtime.queue).toEqual([]);
    expect(s.runtime.continuePool).toBeTruthy();

    const advance = await s.call('POST /api/runtime/advance', { queueEpoch: 6 });
    expect(advance.body.continued).toBe(false);
    expect(s.runtime.queue).toEqual([]);
  });

  it('clear 之后的新显式点歌正常开播并解除续播抑制，后续续播恢复', async () => {
    const s = setup();
    await s.call('POST /api/queue/clear');
    expect(s.runtime.queueEpoch).toBe(6);

    const queued = await s.call('POST /api/queue/external', {
      tracks: [{ title: '晴天', artist: '周杰伦' }],
      mode: 'replace',
    });
    expect(queued.statusCode).toBe(200);
    expect(s.runtime.queue).toHaveLength(1);
    expect(s.runtime.paused).toBe(false);
    expect(s.runtime.continueSuppressed).toBe(false);
    expect(s.runtime.queueEpoch).toBe(6);

    // 旧 epoch 的写回仍然被拒绝。
    const stale = await s.call('POST /api/runtime/state', {
      index: 0, paused: false, ended: false, queueEpoch: 5,
    });
    expect(stale.body.stale).toBe(true);

    // 新队列播完后，续播池照常接上。
    s.runtime.trackEnded = true;
    const ended = await s.call('POST /api/runtime/state', {
      index: 0, queueOffset: 0, paused: true, ended: true, queueEpoch: 6,
    });
    expect(ended.body.continued).toBe(true);
    expect(s.runtime.queue.some(t => t.source === 'continue-pool')).toBe(true);
    expect(s.runtime.continueSuppressed).toBe(false);
  });

  it('external-queue 在 resolve 前被 clear，结果必须丢弃', async () => {
    let deferred = true;
    const releases = [];
    const resolveTrack = vi.fn(want => {
      if (!deferred) return Promise.resolve(song(want.title, want.artist));
      return new Promise(resolve => { releases.push(() => resolve(song(want.title, want.artist))); });
    });
    const s = setup({ resolveTrack });

    const pending = s.call('POST /api/queue/external', {
      tracks: [{ title: '晴天', artist: '周杰伦' }],
      mode: 'replace',
    });
    await Promise.resolve();
    expect(resolveTrack).toHaveBeenCalled();

    const cleared = await s.call('POST /api/queue/clear');
    expect(cleared.statusCode).toBe(200);
    releases.forEach(release => release());

    const late = await pending;
    expect(late.statusCode).toBe(409);
    expect(late.body).toMatchObject({ ok: false, stale: true });
    expect(s.runtime.queue).toEqual([]);
    expect(s.runtime.paused).toBe(true);
    expect(s.db.addPlay).not.toHaveBeenCalled();

    // 清空后的新显式点歌捕获的是新 epoch，能正常开播。
    deferred = false;
    const fresh = await s.call('POST /api/queue/external', {
      tracks: [{ title: '七里香', artist: '周杰伦' }],
      mode: 'replace',
    });
    expect(fresh.statusCode).toBe(200);
    expect(s.runtime.queue.map(t => t.title)).toEqual(['七里香']);
    expect(s.runtime.paused).toBe(false);
    expect(s.runtime.continueSuppressed).toBe(false);
  });
});

describe('常驻 DJ 与 clear', () => {
  it('shouldRefill 在抑制期返回 cleared', () => {
    const runtime = makeRuntime({ queue: [], index: 0, paused: false, active: true });
    clearQueue(runtime);
    expect(shouldRefill(runtime, { now: Date.now() })).toEqual({ ok: false, reason: 'cleared' });
  });

  it('doRefill 在 await 期间被 clear，结果按 stale 丢弃', async () => {
    const runtime = makeRuntime({
      queue: [{ title: '旧歌', artist: 'B', duration: 300, kugouId: 'old' }],
      index: 0,
      currentTime: 100,
      queueEpoch: 3,
    });
    let release;
    const ask = vi.fn(() => new Promise(resolve => {
      release = () => resolve({
        say: '',
        reason: '夜间续播',
        queue: [song('新歌一'), song('新歌二'), song('新歌三')],
      });
    }));
    const db = {
      getPref: () => null,
      setPref: vi.fn(),
      delPref: vi.fn(),
      recentPlays: () => [],
      addPlay: vi.fn(),
    };
    const dj = startResidentDj({
      runtime,
      ask,
      db,
      broadcast: vi.fn(),
      buildSystemPrompt: async () => 'SYS',
      synthesize: async () => null,
      options: { tickMs: 1e9, cooldownMs: 0, batchSize: 3 },
    });

    const pending = dj.refill({ trigger: 'manual' });
    await Promise.resolve();
    expect(ask).toHaveBeenCalled();

    clearQueue(runtime);
    release();
    const result = await pending;

    expect(result).toMatchObject({ ok: false, reason: 'stale' });
    expect(runtime.queue).toEqual([]);
    expect(runtime.paused).toBe(true);
    expect(db.addPlay).not.toHaveBeenCalled();
    dj.stop();
  });
});

describe('PWA · 清空后的本地停止', () => {
  const songTrack = { title: '晴天', artist: '周杰伦', kugouId: 'h1' };

  it('planRuntimeSync 对空队列给出 unload，即使本地队列已经空了但还有 src', () => {
    const remote = { queue: [], index: 0, paused: true, queueOffset: 0, volume: 30 };
    expect(planRuntimeSync(
      { queue: [songTrack], index: 0, hasSrc: true, ended: false },
      remote,
    )).toMatchObject({ applyQueue: true, pause: true, playIndex: null, unload: true, queue: [] });

    expect(planRuntimeSync(
      { queue: [], index: 0, hasSrc: true, ended: false },
      remote,
    )).toMatchObject({ unload: true });
  });

  it('stopAudioForEmptyQueue 真正 pause、卸载 src 并 load', () => {
    const audio = {
      paused: false,
      pause: vi.fn(),
      removeAttribute: vi.fn(),
      load: vi.fn(),
    };
    stopAudioForEmptyQueue(audio);
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.removeAttribute).toHaveBeenCalledWith('src');
    expect(audio.load).toHaveBeenCalledOnce();
  });

  it('applyRuntime 走 unload 分支时清进度并隐藏播放区', () => {
    expect(playerJs).toContain('plan.unload');
    expect(playerJs).toMatch(/stopAudioForEmptyQueue\(audio\)/);
    expect(playerJs).toMatch(/updateSeekBar\(0, 0\)/);
    expect(playerJs).toMatch(/serverProgress = 0/);
  });

  it('清空入口存在，确认取消不发请求，失败不本地清空', async () => {
    const html = fs.readFileSync('./pwa/index.html', 'utf8');
    expect(html).toContain('id="queue-clear"');
    expect(html).toContain('清空播放列表');

    const start = playerJs.indexOf('async function clearQueueFromUi(');
    const end = playerJs.indexOf('\nfunction bindQueueClearButton', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(playerJs.slice(start, end)).toContain("fetch('/api/queue/clear'");
    expect(playerJs.slice(start, end)).toContain('window.confirm');
    expect(playerJs.indexOf('window.confirm', start)).toBeLessThan(playerJs.indexOf("fetch('/api/queue/clear'", start));

    const build = () => {
      const state = { queue: [{ title: '晴天' }], index: 0 };
      const applyRuntime = vi.fn();
      const toast = vi.fn();
      const showAlert = vi.fn();
      const fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'boom' }) }));
      const confirm = vi.fn(() => true);
      const getClientId = () => 'page-a';
      const fn = new Function(
        'state', 'window', 'fetch', 'applyRuntime', 'toast', 'showAlert', 'getClientId',
        `${playerJs.slice(start, end)}\nreturn clearQueueFromUi;`,
      )(state, { confirm }, fetch, applyRuntime, toast, showAlert, getClientId);
      return { state, fn, applyRuntime, toast, showAlert, fetch, confirm };
    };

    const cancelled = build();
    cancelled.confirm.mockReturnValue(false);
    await cancelled.fn();
    expect(cancelled.fetch).not.toHaveBeenCalled();
    expect(cancelled.applyRuntime).not.toHaveBeenCalled();
    expect(cancelled.state.queue).toHaveLength(1);

    const failed = build();
    const failResult = await failed.fn();
    expect(failed.fetch).toHaveBeenCalledWith('/api/queue/clear', expect.objectContaining({ method: 'POST' }));
    expect(failed.applyRuntime).not.toHaveBeenCalled();
    expect(failed.state.queue).toHaveLength(1);
    expect(failed.showAlert).toHaveBeenCalledWith(expect.stringContaining('清空失败'));
    expect(failResult).toMatchObject({ ok: false });

    const ok = build();
    ok.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true, cleared: true, queue: [], index: 0, paused: true,
        queueEpoch: 6, continueSuppressed: true, volume: 37,
      }),
    });
    const okResult = await ok.fn();
    expect(ok.applyRuntime).toHaveBeenCalledWith(expect.objectContaining({
      ok: true, queue: [], queueEpoch: 6, continueSuppressed: true,
    }));
    expect(ok.toast).toHaveBeenCalled();
    expect(okResult).toMatchObject({ ok: true });
  });
});

describe('队列序号工具', () => {
  it('缺省 epoch 视为 0，非法值视为 stale', () => {
    expect(queueEpochOf({})).toBe(0);
    expect(queueEpochOf({ queueEpoch: 4 })).toBe(4);
    expect(queueWriteIsStale({ queueEpoch: 4 }, { queueEpoch: 4 })).toBe(false);
    expect(queueWriteIsStale({ queueEpoch: 4 }, { queueEpoch: 3 })).toBe(true);
    expect(queueWriteIsStale({ queueEpoch: 4 }, { queueEpoch: 'abc' })).toBe(true);
    expect(queueWriteIsStale({ queueEpoch: 4 }, { queueEpoch: 4.5 })).toBe(true);
  });

  it('playbackStatus 只读暴露 epoch 与抑制状态', () => {
    expect(playbackStatus({ queue: [], queueEpoch: 2, continueSuppressed: true })).toMatchObject({
      queueEpoch: 2,
      continueSuppressed: true,
    });
  });
});

describe('外部点歌写入的是 bot 来源', () => {
  it('清空后的新点歌仍标 bot', async () => {
    const s = setup();
    await s.call('POST /api/queue/clear');
    await s.call('POST /api/queue/external', {
      tracks: [{ title: '晴天', artist: '周杰伦' }],
      mode: 'replace',
    });
    expect(s.runtime.queueSource).toBe('bot');
    expect(s.runtime.queuedSource).toBe('bot');
    expect(s.runtime.queue[0].source).toBe('bot');
    expect(DJ_SOURCE).toBe('resident-dj');
  });
});
