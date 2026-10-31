import { describe, expect, it, vi } from 'vitest';
import { mountContinuePoolRoutes } from '../server/api/continue-pool.js';
import { mountRuntimeRoutes } from '../server/api/runtime.js';
import { mountExternalQueueRoutes } from '../server/api/external-queue.js';
import { applyControl, applyProgress, queueFinished } from '../server/playback-control.js';
import { hasActiveExternalQueue } from '../server/queue-source.js';
import { CONTINUE_POOL_KEY, readContinuePool } from '../server/continue-pool.js';
import { dbApi } from '../server/db.js';
import { isOwnEcho, planRuntimeSync } from '../pwa/runtime-sync.js';

function setup(overrides = {}) {
  const routes = {};
  const app = { routes };
  for (const method of ['get', 'put', 'post', 'delete']) {
    app[method] = (path, handler) => { routes[`${method.toUpperCase()} ${path}`] = handler; };
  }
  const prefs = new Map();
  const db = overrides.db || {
    getPref: key => prefs.get(key) ?? null,
    setPref: (key, value) => prefs.set(key, String(value)),
    delPref: key => prefs.delete(key), addPlay: vi.fn(),
  };
  const runtime = overrides.runtime || {
    queue: [{ title: '主持人选歌', artist: 'A', kugouId: 'original' }],
    index: 0, paused: false, volume: 37, queueSource: 'bot', trackEnded: false,
    continuePool: readContinuePool(db),
  };
  // 保存广播当时的快照，后续 runtime 变化不能掩盖重复广播的问题。
  const broadcast = vi.fn(event => events.push(structuredClone(event)));
  const events = [];
  const resolveTrack = overrides.resolveTrack || vi.fn(async want => want.title === '失踪' ? null : ({
    title: want.title, artist: want.artist, album: '专辑', duration: 180,
    kugouId: `hash-${want.title}`, cover: '/cover.jpg', upstreamUrl: 'https://cdn.kugou.com/a.mp3',
  }));
  const fetchUserPlaylistTracks = overrides.fetchUserPlaylistTracks || vi.fn(async () => ({
    tracks: [{ title: '歌单曲目', artist: 'B', hash: 'playlist-hash', cover: '/cover.jpg' }, { title: '无 hash' }],
  }));
  const deps = { runtime, db, broadcast, resolveTrack, fetchUserPlaylistTracks, random: overrides.random };
  mountContinuePoolRoutes(app, deps);
  mountRuntimeRoutes(app, { ...deps, statusOptions: () => ({ brain: overrides.brain || 'external', listeners: 1 }) });
  mountExternalQueueRoutes(app, deps);
  async function call(path, body = {}) {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = structuredClone(value); return this; },
    };
    await routes[path]({ body }, res);
    return res;
  }
  const set = (options = {}) => call('PUT /api/continue-pool', {
    tracks: [{ title: '池一', artist: 'B', reason: '雨天' }, { title: '池二', artist: 'C' }, { title: '池三' }],
    ...options,
  });
  const end = (body = {}) => call('POST /api/runtime/state', {
    index: runtime.index, paused: true, ended: true, clientId: 'page-a', ...body,
  });
  return { runtime, db, prefs, call, set, end, events, broadcast, resolveTrack, fetchUserPlaylistTracks };
}

describe('续播池 API', () => {
  it('按歌曲匹配，保存必要元数据和逐曲理由，报告失败但不改当前队列', async () => {
    const s = setup();
    const queue = structuredClone(s.runtime.queue);
    const res = await s.set({
      name: '夜间', source: 'claudio-host', loop: false, batchSize: 2,
      tracks: [{ title: '池一', artist: 'B', reason: '雨'.repeat(210) }, { title: '失踪' }, {}],
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, matched: [{ title: '池一', kugouId: 'hash-池一' }] });
    expect(res.body.failed).toEqual([
      { title: '失踪', artist: '', reason: 'unmatched' }, { title: '', artist: '', reason: '缺少歌名' },
    ]);
    expect(s.runtime.continuePool.tracks[0]).toEqual({
      title: '池一', artist: 'B', album: '专辑', duration: 180, kugouId: 'hash-池一',
      cover: '/cover.jpg', reason: '雨'.repeat(200),
    });
    expect(s.runtime.queue).toEqual(queue);
    expect(res.body.continuePool).toMatchObject({ name: '夜间', size: 1, cursor: 0, remaining: 1, loop: false, active: true });
    expect(res.body.continuePool).not.toHaveProperty('tracks');
  });

  it.each([{ listid: '12' }, { globalCollectionId: 'g12' }])('按酷狗歌单设置 %j，仅保留 hash', async playlist => {
    const s = setup();
    const res = await s.call('POST /api/continue-pool', { playlist });
    expect(res.statusCode).toBe(200);
    expect(res.body.continuePool.size).toBe(1);
    expect(res.body.failed).toHaveLength(1);
    expect(s.fetchUserPlaylistTracks).toHaveBeenCalledWith(expect.objectContaining({ ...playlist, pagesize: 200, maxPages: 1 }));
    expect(s.resolveTrack).not.toHaveBeenCalled();
    expect(s.runtime.continuePool.tracks[0]).toMatchObject({ kugouId: 'playlist-hash', cover: '/cover.jpg' });
  });

  it.each([
    {}, { tracks: [] }, { tracks: '歌' }, { tracks: Array(201).fill({ title: '歌' }) },
    { playlist: {} }, { playlist: [] }, { playlist: { listid: {} } },
    { tracks: [{ title: '歌' }], playlist: { listid: '12' } },
    ...[0, 51, 1.2, '5'].map(batchSize => ({ tracks: [{ title: '歌' }], batchSize })),
    { tracks: [{ title: '歌' }], shuffle: 'false' }, { tracks: [{ title: '歌' }], loop: 1 },
  ])('无效参数返回中文 400，保留原池：%j', async body => {
    const s = setup();
    await s.set();
    const pool = structuredClone(s.runtime.continuePool);
    const res = await s.call('PUT /api/continue-pool', body);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/[\u4e00-\u9fff]/);
    expect(s.runtime.continuePool).toEqual(pool);
  });

  it('没有匹配、空歌单、上游失败均不覆盖原池', async () => {
    const s = setup();
    await s.set();
    const pool = structuredClone(s.runtime.continuePool);
    expect((await s.set({ tracks: [{ title: '失踪' }] })).statusCode).toBe(400);
    expect((await s.set({ tracks: [{}] })).statusCode).toBe(400);
    s.fetchUserPlaylistTracks.mockResolvedValueOnce({ tracks: [] });
    expect((await s.call('PUT /api/continue-pool', { playlist: { listid: '12' } })).statusCode).toBe(400);
    s.resolveTrack.mockRejectedValueOnce(new Error('上游不可用'));
    expect((await s.set()).statusCode).toBe(502);
    expect(s.runtime.continuePool).toEqual(pool);
    expect(readContinuePool(s.db)).toEqual(pool);
  });

  it('200 首上限、文本按 Unicode 字符截断', async () => {
    const s = setup();
    const res = await s.set({ name: '🎵'.repeat(110), source: '源'.repeat(50), tracks: Array(200).fill({ title: '歌' }) });
    expect(res.body.continuePool.size).toBe(200);
    expect(Array.from(res.body.continuePool.name)).toHaveLength(100);
    expect(Array.from(res.body.continuePool.source)).toHaveLength(40);
  });

  it('GET 可预览歌名歌手；status / now 仅含小视图；DELETE 持久清空', async () => {
    const s = setup();
    for (const path of ['/api/status', '/api/now', '/api/continue-pool']) {
      expect((await s.call(`GET ${path}`)).body.continuePool).toBeNull();
    }
    await s.set();
    const view = (await s.call('GET /api/continue-pool')).body.continuePool;
    expect(view.tracks[0]).toEqual({ title: '池一', artist: 'B' });
    for (const path of ['/api/status', '/api/now']) {
      const status = (await s.call(`GET ${path}`)).body;
      expect(status.continuePool).toEqual({
        name: '续播池', size: 3, cursor: 0, remaining: 3, loop: true, shuffle: false,
        batchSize: 5, source: 'claudio-host', setAt: expect.any(String), lastContinuedAt: null,
        continuedCount: 0, active: true,
      });
    }
    expect((await s.call('DELETE /api/continue-pool')).body).toEqual({ ok: true, continuePool: null });
    expect(readContinuePool(s.db)).toBeNull();
    expect((await s.call('GET /api/status')).body.continuePool).toBeNull();
    expect(s.runtime.queue).toHaveLength(1);
  });
});

describe('队尾续播', () => {
  it.each(['external', 'internal'])('%s：队尾追加一批，播放第一首，保护来源且不改音量', async brain => {
    const s = setup({ brain });
    await s.set({ batchSize: 2 });
    const res = await s.end();
    expect(res.body).toMatchObject({ continued: true, index: 1, paused: false });
    expect(s.runtime).toMatchObject({ index: 1, paused: false, trackEnded: false, queueSource: 'bot', volume: 37, currentTime: 0, duration: 0 });
    expect(s.runtime.queue).toHaveLength(3);
    expect(s.runtime.queue[1]).toMatchObject({ title: '池一', audioUrl: null, kugouId: 'hash-池一', source: 'continue-pool', reason: '雨天' });
    expect(hasActiveExternalQueue(s.runtime)).toBe(true);
    expect((await s.call('GET /api/status')).body.continuePool).toMatchObject({ cursor: 2, remaining: 1, continuedCount: 2, lastContinuedAt: expect.any(String) });
  });

  it('非队尾结束、暂停、显式跳转不触发续播', async () => {
    const s = setup();
    s.runtime.queue.push({ title: '第二首' });
    await s.set();
    await s.end();
    await s.call('POST /api/runtime/state', { index: 1, paused: true, ended: false });
    await s.call('POST /api/runtime/advance', { index: 1 });
    expect(s.runtime.queue).toHaveLength(2);
    expect(s.runtime.continuePool.continuedCount).toBe(0);
  });

  it('重复/并发结束上报只续一批，旧索引不能拉回队列', async () => {
    const s = setup();
    await s.set({ batchSize: 1 });
    await Promise.all([s.end({ index: 0 }), s.end({ index: 0 }), s.end({ index: 0 })]);
    expect(s.runtime.queue).toHaveLength(2);
    expect(s.runtime.index).toBe(1);
    expect(s.runtime.trackEnded).toBe(false);
    expect(s.runtime.continuePool.continuedCount).toBe(1);
    await s.call('POST /api/runtime/state', { index: 0, ended: false, paused: true });
    expect(s.runtime).toMatchObject({ index: 1, paused: false });
    applyProgress(s.runtime, { index: 0, currentTime: 180, duration: 180, paused: true });
    expect(s.runtime).toMatchObject({ index: 1, currentTime: 0, paused: false });
    // 新曲确实开始后，下一次结束可以续播；旧曲的迟到结束仍不能重放。
    await s.call('POST /api/runtime/state', { index: 1, ended: false, paused: false });
    await s.end({ index: 0 });
    await s.end({ index: 1 });
    expect(s.runtime.queue).toHaveLength(3);
    expect(s.runtime.index).toBe(2);
  });

  it.each(['advance-first', 'state-first'])('advance 和 state 交错：%s', async order => {
    const s = setup();
    await s.set({ batchSize: 1 });
    const advance = () => s.call('POST /api/runtime/advance', { clientId: 'page-a' });
    if (order === 'advance-first') { await advance(); await s.end({ index: 0 }); }
    else { await s.end({ index: 0 }); await advance(); }
    await advance();
    expect(s.runtime.queue).toHaveLength(2);
    expect(s.runtime.index).toBe(1);
    await s.call('POST /api/runtime/state', { index: 1, ended: false, paused: false });
    await advance();
    expect(s.runtime.queue).toHaveLength(3);
  });

  it('loop 跨轮取满批次，cursor 指向下一首', async () => {
    const s = setup();
    await s.set({ batchSize: 5 });
    await s.end();
    expect(s.runtime.queue.slice(1).map(t => t.title)).toEqual(['池一', '池二', '池三', '池一', '池二']);
    expect(s.runtime.continuePool.cursor).toBe(2);
    await s.end({ index: 5 });
    expect(s.runtime.continuePool.cursor).toBe(1);
    expect(s.runtime.continuePool.continuedCount).toBe(10);
  });

  it('shuffle 设置时和每次绕回时打乱，保存下一轮顺序', async () => {
    const s = setup({ random: () => 0 });
    await s.set({ shuffle: true, batchSize: 3 });
    const first = s.runtime.continuePool.tracks.map(t => t.kugouId);
    expect(first).not.toEqual(['hash-池一', 'hash-池二', 'hash-池三']);
    // 续播自身使用默认随机数，固定它以验证整轮边界。
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try { await s.end(); } finally { random.mockRestore(); }
    expect(s.runtime.continuePool.cursor).toBe(0);
    expect(s.runtime.continuePool.tracks.map(t => t.kugouId)).not.toEqual(first);
    expect(readContinuePool(s.db)).toEqual(s.runtime.continuePool);
  });

  it('loop:false 耗尽后停播，toggle / play 仍可从第一首重播', async () => {
    const s = setup();
    await s.set({ loop: false, batchSize: 5 });
    await s.end();
    expect(s.runtime.queue).toHaveLength(4);
    expect(s.runtime.continuePool.cursor).toBe(3);
    expect((await s.call('GET /api/status')).body.continuePool).toMatchObject({ active: false, remaining: 0 });
    await s.end({ index: 3 });
    expect(queueFinished(s.runtime)).toBe(true);
    expect((await s.call('GET /api/status')).body.paused).toBe(true);
    expect(applyControl(s.runtime, { command: 'toggle' })).toMatchObject({ index: 0, paused: false });
    s.runtime.index = 3; s.runtime.trackEnded = true;
    expect(applyControl(s.runtime, { command: 'play' })).toMatchObject({ index: 0, paused: false });
  });

  it('无池保留结束与 toggle 重播；普通状态仍带 origin', async () => {
    const s = setup();
    await s.end();
    expect(s.runtime.queue).toHaveLength(1);
    expect(queueFinished(s.runtime)).toBe(true);
    expect(s.events.at(-1).origin).toBe('page-a');
    expect(applyControl(s.runtime, { command: 'toggle' })).toMatchObject({ index: 0, paused: false });
  });

  it('续播广播不被报告结束的页面忽略，现有 PWA 路径会加载新曲', async () => {
    const s = setup();
    const local = { queue: structuredClone(s.runtime.queue), index: 0, hasSrc: true, ended: true };
    await s.set({ batchSize: 2 });
    await s.end();
    const event = s.events.at(-1);
    expect(event.type).toBe('state');
    expect(event).not.toHaveProperty('origin');
    expect(isOwnEcho(event.origin, 'page-a')).toBe(false);
    expect(planRuntimeSync(local, event.runtime)).toMatchObject({ applyQueue: true, playIndex: 1, pause: false });
  });

  it('主持人替换队列不清池，下一次自然结束仍可续播', async () => {
    const s = setup();
    await s.set({ batchSize: 1 });
    await s.end();
    const pool = structuredClone(s.runtime.continuePool);
    await s.call('POST /api/queue/external', { tracks: [{ title: '新主持人选歌' }] });
    expect(s.runtime.continuePool).toEqual(pool);
    expect(s.runtime.queue).toHaveLength(1);
    expect(s.runtime.index).toBe(0);
    await s.end();
    expect(s.runtime.queue[1].title).toBe('池二');
    expect(s.runtime.continuePool.continuedCount).toBe(2);
  });
});

describe('续播池持久化', () => {
  it('真实 prefs JSON 往返：元数据、曲目顺序、cursor 均保留，DELETE 不复活', async () => {
    const s = setup({ db: dbApi });
    try {
      await s.set({ batchSize: 2 });
      await s.end();
      const restarted = setup({ db: dbApi });
      expect(restarted.runtime.continuePool).toEqual(s.runtime.continuePool);
      await restarted.end();
      expect(restarted.runtime.queue[1].title).toBe('池三');
      await restarted.call('DELETE /api/continue-pool');
      expect(setup({ db: dbApi }).runtime.continuePool).toBeNull();
    } finally { dbApi.delPref(CONTINUE_POOL_KEY); }
  });

  it('损坏或非法的存储不启用续播', () => {
    for (const value of ['{', '{}', '{"tracks":[]}', '{"tracks":[{}],"cursor":0,"batchSize":5}']) {
      expect(readContinuePool({ getPref: () => value })).toBeNull();
    }
  });
});
