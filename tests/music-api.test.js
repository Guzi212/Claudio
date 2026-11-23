import { describe, expect, it, vi } from 'vitest';
import { mountSearchRoute } from '../server/api/search.js';
import { mountExternalQueueRoutes } from '../server/api/external-queue.js';
import { mountPlaylistRoutes } from '../server/api/playlists.js';
import { mountLyricRoute } from '../server/api/lyric.js';
import { playbackStatus } from '../server/playback-control.js';

function mockApp() {
  const routes = {};
  return {
    routes,
    get(p, h) { routes[`GET ${p}`] = h; },
    post(p, h) { routes[`POST ${p}`] = h; },
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

describe('GET /api/music/search', () => {
  it('返回 provider、providersUsed 和带平台标签的 tracks（不透出 raw）', async () => {
    const multiSearch = vi.fn(async () => ({
      provider: 'multi',
      providersUsed: ['kugou', 'netease', 'qq'],
      tracks: [
        { provider: 'netease', id: '133', hash: 'netease:133', title: '起风了', artist: '买辣椒也用券', album: '起风了', duration: 325, cover: 'http://p3.music.126.net/a.jpg', score: 150, raw: { secret: 1 } },
      ],
    }));
    const app = mockApp();
    mountSearchRoute(app, { multiSearch });
    const res = mockRes();
    await app.routes['GET /api/music/search']({ query: { q: '起风了', provider: 'multi' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      provider: 'multi',
      providersUsed: ['kugou', 'netease', 'qq'],
      tracks: [{
        provider: 'netease',
        id: '133',
        hash: 'netease:133',
        title: '起风了',
        artist: '买辣椒也用券',
        album: '起风了',
        duration: 325,
        cover: 'http://p3.music.126.net/a.jpg',
        score: 150,
      }],
    });
  });

  it('非法 provider 返回 400', async () => {
    const app = mockApp();
    mountSearchRoute(app, { multiSearch: vi.fn() });
    const res = mockRes();
    await app.routes['GET /api/music/search']({ query: { q: '晴天', provider: 'spotify' } }, res);
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/queue/external 多音乐源支持', () => {
  it('tracks[].provider 透传至 resolveTrack，matched 和 queue[] 保留 provider，writeTracks 只写酷狗曲目', async () => {
    const runtime = { queue: [], index: 0, paused: true, lastSay: '' };
    const resolveTrack = vi.fn(async want => {
      if (want.provider === 'netease') {
        return {
          provider: 'netease',
          providerTrackId: '133',
          kugouId: 'netease:133',
          title: want.title,
          artist: want.artist,
          upstreamUrl: 'http://m801.music.126.net/a.mp3',
          score: 150,
        };
      }
      return {
        provider: 'kugou',
        providerTrackId: 'KG1',
        kugouId: 'KG1',
        title: want.title,
        artist: want.artist,
        upstreamUrl: 'https://fs.kugou.com/a.mp3',
        score: 150,
      };
    });
    const writeTracks = vi.fn(async () => ({ ok: true, id: '1', listid: '1', added: [], failed: [] }));
    const app = mockApp();
    mountExternalQueueRoutes(app, {
      runtime,
      broadcast: vi.fn(),
      resolveTrack,
      writeTracks,
      db: { addPlay: vi.fn() },
    });

    const res = mockRes();
    await app.routes['POST /api/queue/external']({
      body: {
        target: 'both',
        tracks: [
          { title: '起风了', artist: '买辣椒也用券', provider: 'netease' },
          { title: '晴天', artist: '周杰伦', provider: 'kugou' },
        ],
      },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.matched.map(m => ({ provider: m.provider, id: m.id }))).toEqual([
      { provider: 'netease', id: '133' },
      { provider: 'kugou', id: 'KG1' },
    ]);
    expect(runtime.queue[0]).toMatchObject({ provider: 'netease', id: '133', kugouId: 'netease:133' });
    expect(writeTracks).toHaveBeenCalledWith(expect.objectContaining({
      tracks: [expect.objectContaining({ provider: 'kugou', kugouId: 'KG1' })],
    }));
  });

  it('非法 batch provider 返回 400', async () => {
    const app = mockApp();
    mountExternalQueueRoutes(app, { runtime: { queue: [] }, resolveTrack: vi.fn(), db: { addPlay: vi.fn() } });
    const res = mockRes();
    await app.routes['POST /api/queue/external']({
      body: { provider: 'bad_source', tracks: [{ title: '晴天' }] },
    }, res);
    expect(res.statusCode).toBe(400);
  });
});

describe('playbackStatus / /api/music/track-url / /api/lyric 多源路由', () => {
  it('playbackStatus 返回当前曲目 provider、musicProvider 和 providers 列表', () => {
    const idle = playbackStatus({ queue: [] }, { provider: 'multi', providers: ['kugou', 'netease', 'qq'] });
    expect(idle.provider).toBe('multi');
    expect(idle.musicProvider).toBe('multi');
    expect(idle.providers).toEqual(['kugou', 'netease', 'qq']);

    const playing = playbackStatus({
      queue: [{ title: '起风了', provider: 'netease', kugouId: 'netease:133' }],
      index: 0,
      paused: false,
    }, { provider: 'multi', providers: ['kugou', 'netease'] });
    expect(playing.provider).toBe('netease');
    expect(playing.musicProvider).toBe('multi');
  });

  it('/api/music/track-url 分流网易云与 QQ 到多源解析器，并同步队列', async () => {
    const runtime = {
      queue: [{ title: '起风了', provider: 'netease', id: '133', kugouId: 'netease:133', audioUrl: null }],
      index: 0,
    };
    const resolveMusicTrackUrl = vi.fn(async () => ({ url: 'http://m801.music.126.net/song.mp3', quality: '320' }));
    const app = mockApp();
    mountPlaylistRoutes(app, {
      runtime,
      broadcast: vi.fn(),
      resolveMusicTrackUrl,
      resolveSongUrl: vi.fn(),
    });
    const res = mockRes();
    await app.routes['GET /api/music/track-url']({ query: { hash: 'netease:133', quality: '320' } }, res);
    expect(res.statusCode).toBe(200);
    expect(resolveMusicTrackUrl).toHaveBeenCalledWith('133', { provider: 'netease', targetQuality: '320' });
    expect(res.body).toMatchObject({
      ok: true,
      provider: 'netease',
      audioQuality: '320',
      url: '/api/proxy?u=http%3A%2F%2Fm801.music.126.net%2Fsong.mp3',
    });
    expect(runtime.queue[0].audioUrl).toBe(res.body.url);
  });

  it('/api/lyric 透传 provider 参数', async () => {
    const lyric = vi.fn(async () => '[00:01]歌词');
    const app = mockApp();
    mountLyricRoute(app, { lyric });
    const res = mockRes();
    await app.routes['GET /api/lyric']({ query: { id: '003hKob536i6FA', provider: 'qq' } }, res);
    expect(lyric).toHaveBeenCalledWith('003hKob536i6FA', { provider: 'qq' });
    expect(res.body).toEqual({ lyric: '[00:01]歌词' });
  });
});
