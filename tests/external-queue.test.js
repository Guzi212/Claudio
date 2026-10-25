import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
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

function song(title, artist = '周杰伦') {
  return {
    kugouId: `hash-${title}`,
    title,
    artist,
    album: '',
    duration: 200,
    upstreamUrl: `https://cdn.kugou.com/${title}.mp3`,
    score: 150,
    albumId: '9',
    mixsongid: '100',
  };
}

function setup(overrides = {}) {
  const runtime = overrides.runtime || { queue: [], index: 0, paused: true, lastSay: '' };
  const broadcast = vi.fn();
  const addPlay = vi.fn();
  const addUnmatched = vi.fn();
  const writeTracks = vi.fn(async () => ({
    ok: true,
    id: '12',
    listid: '12',
    globalCollectionId: 'g12',
    name: 'Claudio推荐',
    mode: 'append',
    created: false,
    added: [],
    failed: [],
  }));
  const resolveTrack = vi.fn(async want => {
    if (want.title === '失踪') {
      addUnmatched({ title: want.title, artist: want.artist, hint: want.hint || null });
      return null;
    }
    return song(want.title, want.artist);
  });
  const app = mockApp();
  mountExternalQueueRoutes(app, {
    runtime,
    broadcast,
    resolveTrack,
    writeTracks,
    db: { addPlay },
    ...overrides,
  });
  return { app, runtime, broadcast, addPlay, addUnmatched, writeTracks, resolveTrack };
}

describe('POST /api/queue/external', () => {
  it('匹配成功：替换队列、广播、播放历史 source=bot，不写歌单', async () => {
    const { app, runtime, broadcast, addPlay, writeTracks } = setup({
      runtime: {
        queue: [{ title: '旧歌', artist: '旧人' }],
        index: 0,
        paused: true,
        lastSay: '',
      },
    });
    const res = mockRes();
    await app.routes['POST /api/queue/external']({
      body: {
        tracks: [{ title: '晴天', artist: '周杰伦' }],
        say: '放一首晴天',
        reason: 'bot',
      },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.target).toBe('queue');
    expect(res.body.matched).toHaveLength(1);
    expect(res.body.matched[0]).toMatchObject({ title: '晴天', kugouId: 'hash-晴天', score: 150 });
    expect(res.body.failed).toEqual([]);
    expect(res.body.playlist).toBeNull();
    expect(res.body.queue).toMatchObject({ mode: 'replace', added: 1, length: 1 });
    expect(runtime.queue).toHaveLength(1);
    expect(runtime.queue[0].audioUrl).toContain('/api/proxy?u=');
    expect(runtime.queue[0].source).toBe('bot');
    expect(runtime.index).toBe(0);
    expect(runtime.paused).toBe(false);
    expect(runtime.lastSay).toBe('放一首晴天');
    expect(addPlay).toHaveBeenCalledWith(expect.objectContaining({
      title: '晴天',
      artist: '周杰伦',
      source: 'bot',
      reason: 'bot',
    }));
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'external-queue',
      mode: 'replace',
    }));
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'state' }));
    expect(writeTracks).not.toHaveBeenCalled();
  });

  it('匹配失败记入 failed，replace 不清空正在播的队列', async () => {
    const { app, runtime, addUnmatched, addPlay, broadcast } = setup({
      runtime: { queue: [{ title: '旧歌', artist: '旧人' }], index: 0, paused: false, lastSay: '' },
    });
    const res = mockRes();
    await app.routes['POST /api/queue/external']({
      body: { tracks: [{ title: '失踪', artist: '无名' }, { title: '晴天', artist: '周杰伦' }], mode: 'replace' },
    }, res);

    expect(res.body.failed).toEqual([{ title: '失踪', artist: '无名', reason: 'unmatched' }]);
    expect(res.body.matched).toHaveLength(1);
    expect(addUnmatched).toHaveBeenCalledWith(expect.objectContaining({ title: '失踪', artist: '无名' }));
    expect(runtime.queue.map(item => item.title)).toEqual(['晴天']);
    expect(addPlay).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalled();
  });

  it('全部失败时不改队列、不写播放历史', async () => {
    const { app, runtime, addPlay, broadcast } = setup({
      runtime: { queue: [{ title: '旧歌', artist: '旧人' }], index: 0, paused: false, lastSay: '' },
    });
    const res = mockRes();
    await app.routes['POST /api/queue/external']({
      body: { tracks: [{ title: '失踪', artist: '无名' }], mode: 'replace' },
    }, res);

    expect(res.body.queue).toMatchObject({ added: 0, length: 1 });
    expect(runtime.queue).toHaveLength(1);
    expect(runtime.queue[0].title).toBe('旧歌');
    expect(addPlay).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('append 接到队尾且不重置正在播的索引', async () => {
    const { app, runtime } = setup({
      runtime: {
        queue: [{ title: '旧歌', artist: '旧人' }, { title: '第二首', artist: '旧人' }],
        index: 1,
        paused: false,
        lastSay: '',
      },
    });
    const res = mockRes();
    await app.routes['POST /api/queue/external']({
      body: { tracks: [{ title: '晴天', artist: '周杰伦' }], mode: 'append' },
    }, res);

    expect(runtime.queue.map(item => item.title)).toEqual(['旧歌', '第二首', '晴天']);
    expect(runtime.index).toBe(1);
    expect(runtime.paused).toBe(false);
    expect(res.body.queue).toMatchObject({ mode: 'append', added: 1, length: 3 });
  });

  it('target=kugou_playlist 不碰播放队列，默认歌单名 Claudio推荐', async () => {
    const { app, runtime, writeTracks, addPlay, broadcast } = setup({
      runtime: { queue: [{ title: '旧歌', artist: '旧人' }], index: 0, paused: false, lastSay: '' },
    });
    const res = mockRes();
    await app.routes['POST /api/queue/external']({
      body: { tracks: [{ title: '晴天', artist: '周杰伦' }], target: 'kugou_playlist' },
    }, res);

    expect(runtime.queue).toHaveLength(1);
    expect(runtime.queue[0].title).toBe('旧歌');
    expect(addPlay).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(res.body.queue).toBeNull();
    expect(writeTracks).toHaveBeenCalledWith({
      name: 'Claudio推荐',
      mode: 'append',
      tracks: [expect.objectContaining({ title: '晴天', kugouId: 'hash-晴天' })],
    });
    expect(res.body.playlist.id).toBe('12');
  });

  it('target=both 同时入队并按 playlistMode 写歌单', async () => {
    const { app, runtime, writeTracks, addPlay } = setup();
    const res = mockRes();
    await app.routes['POST /api/queue/external']({
      body: {
        tracks: [{ title: '晴天', artist: '周杰伦' }],
        target: 'both',
        playlistName: '深夜',
        playlistMode: 'rewrite',
        mode: 'append',
      },
    }, res);

    expect(runtime.queue).toHaveLength(1);
    expect(addPlay).toHaveBeenCalledTimes(1);
    expect(writeTracks).toHaveBeenCalledWith(expect.objectContaining({
      name: '深夜',
      mode: 'rewrite',
    }));
    expect(res.body.ok).toBe(true);
    expect(res.body.queue.added).toBe(1);
    expect(res.body.playlist.ok).toBe(true);
  });

  it('歌单写入失败时 ok=false，但已经入队的歌保留', async () => {
    const writeTracks = vi.fn(async () => ({ ok: false, error: '上游拒绝', added: [], failed: [] }));
    const { app, runtime } = setup({ writeTracks });
    const res = mockRes();
    await app.routes['POST /api/queue/external']({
      body: { tracks: [{ title: '晴天', artist: '周杰伦' }], target: 'both' },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.playlist.error).toBe('上游拒绝');
    expect(runtime.queue).toHaveLength(1);
  });

  it('say 能合成时插到队列第一条，合成失败就跳过', async () => {
    const synthesize = vi.fn(async () => ({ url: '/tts/abc.mp3', hash: 'abc', filePath: '/tmp/abc.mp3' }));
    const { app, runtime, addPlay } = setup({ synthesize });
    const res = mockRes();
    await app.routes['POST /api/queue/external']({
      body: { tracks: [{ title: '晴天', artist: '周杰伦' }], say: '今晚先听这轮' },
    }, res);
    expect(synthesize).toHaveBeenCalledWith('今晚先听这轮');
    expect(runtime.queue[0]).toMatchObject({ isTts: true, audioUrl: '/tts/abc.mp3' });
    expect(runtime.queue[1].title).toBe('晴天');
    expect(addPlay).toHaveBeenCalledTimes(1);
    expect(runtime.lastSay).toBe('今晚先听这轮');

    const silent = vi.fn(async () => null);
    const second = setup({
      synthesize: silent,
      runtime: { queue: [], index: 0, paused: false, lastSay: '' },
    });
    const res2 = mockRes();
    await second.app.routes['POST /api/queue/external']({
      body: { tracks: [{ title: '晴天', artist: '周杰伦' }], say: '没声音也行' },
    }, res2);
    expect(second.runtime.queue).toHaveLength(1);
    expect(second.runtime.queue[0].isTts).toBeUndefined();
  });

  it('缺 tracks 或模式非法时 400', async () => {
    const { app } = setup();
    const missing = mockRes();
    await app.routes['POST /api/queue/external']({ body: {} }, missing);
    expect(missing.statusCode).toBe(400);

    const badTarget = mockRes();
    await app.routes['POST /api/queue/external']({
      body: { tracks: [{ title: '晴天' }], target: 'play' },
    }, badTarget);
    expect(badTarget.statusCode).toBe(400);
  });
});

describe('外部歌单不经过 Claude / 候选池', () => {
  const source = fs.readFileSync(new URL('../server/api/external-queue.js', import.meta.url), 'utf8');

  it('只复用 resolveTrack', () => {
    expect(source).toContain('resolveTrack');
    expect(source).not.toContain('candidate-pool');
    expect(source).not.toContain('claude');
    expect(source).not.toContain('ensureMinimumFromPool');
  });
});
