import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  PROVIDER_NAMES,
  MUSIC_PROVIDER_MODES,
  normalizeProviderName,
  encodeTrackId,
  decodeTrackId,
  normalizeDurationSeconds,
  msToSeconds,
} from '../server/services/providers/base.js';
import { createMusicService } from '../server/services/music.js';

const prefMem = vi.hoisted(() => new Map());

vi.mock('../server/db.js', () => ({
  dbApi: {
    getPref: k => (prefMem.has(k) ? prefMem.get(k) : null),
    setPref: (k, v) => { prefMem.set(k, String(v)); },
    delPref: k => { prefMem.delete(k); },
    addUnmatched: vi.fn(),
  },
}));

beforeEach(() => {
  prefMem.clear();
  delete process.env.NETEASE_API_BASE;
  delete process.env.NETEASE_COOKIE;
  delete process.env.QQ_API_BASE;
  delete process.env.MUSIC_PROVIDER;
  vi.resetModules();
  vi.doUnmock('axios');
});

afterEach(() => {
  delete process.env.NETEASE_API_BASE;
  delete process.env.NETEASE_COOKIE;
  delete process.env.QQ_API_BASE;
  delete process.env.MUSIC_PROVIDER;
  vi.doUnmock('axios');
});

describe('providers/base helpers', () => {
  it('PROVIDER_NAMES 与 MUSIC_PROVIDER_MODES 正确导出', () => {
    expect(PROVIDER_NAMES).toEqual(['kugou', 'netease', 'qq']);
    expect(MUSIC_PROVIDER_MODES).toEqual(['multi', 'kugou', 'netease', 'qq']);
  });

  it('normalizeProviderName 支持常见别名并拦截非法值', () => {
    expect(normalizeProviderName('KuGou')).toBe('kugou');
    expect(normalizeProviderName('wy')).toBe('netease');
    expect(normalizeProviderName('qqmusic')).toBe('qq');
    expect(normalizeProviderName('multi')).toBe('');
    expect(normalizeProviderName('multi', { allowMulti: true })).toBe('multi');
    expect(normalizeProviderName('spotify', { allowMulti: true })).toBe('');
  });

  it('encodeTrackId / decodeTrackId 保持酷狗兼容性且区分网易云与 QQ', () => {
    expect(encodeTrackId('kugou', 'H123')).toBe('H123');
    expect(encodeTrackId('netease', '1330348068')).toBe('netease:1330348068');
    expect(encodeTrackId('qq', '003hKob536i6FA')).toBe('qq:003hKob536i6FA');

    expect(decodeTrackId('H123')).toEqual({ provider: 'kugou', rawId: 'H123' });
    expect(decodeTrackId('netease:1330348068')).toEqual({ provider: 'netease', rawId: '1330348068' });
    expect(decodeTrackId('qq:003hKob536i6FA')).toEqual({ provider: 'qq', rawId: '003hKob536i6FA' });
    // 前缀优先于显式 provider
    expect(decodeTrackId('netease:99', 'kugou')).toEqual({ provider: 'netease', rawId: '99' });
    expect(decodeTrackId('99', 'netease')).toEqual({ provider: 'netease', rawId: '99' });
  });

  it('normalizeDurationSeconds / msToSeconds 正确归一时长为秒', () => {
    expect(normalizeDurationSeconds(269)).toBe(269);
    expect(normalizeDurationSeconds(269000)).toBe(269);
    expect(msToSeconds(238608)).toBe(239);
    expect(msToSeconds(0)).toBe(0);
  });
});

describe('NeteaseProvider', () => {
  it('未填 NETEASE_API_BASE 时自动跳过（isEnabled=false）', async () => {
    const { NeteaseProvider } = await import('../server/services/providers/netease.js');
    const p = new NeteaseProvider();
    expect(p.isEnabled()).toBe(false);
    expect(await p.search({ title: '晴天' })).toEqual([]);
    expect(await p.trackUrl('123')).toBeNull();
    expect(await p.resolveTrack({ title: '晴天' })).toBeNull();
    expect(await p.healthCheck()).toMatchObject({ ok: false, configured: false });
  });

  it('搜索转换毫秒时长、过滤 VIP 试听片段，选中完整可用直链', async () => {
    process.env.NETEASE_API_BASE = 'http://localhost:33401';
    const get = vi.fn(async (url, opts = {}) => {
      if (url === '/register/anonimous') {
        return { data: { code: 200, cookie: 'MUSIC_A=anon123' } };
      }
      if (url === '/cloudsearch') {
        return {
          data: {
            result: {
              songs: [
                { id: 111, name: '起风了', ar: [{ name: '买辣椒也用券' }], al: { name: '起风了', picUrl: 'http://p3.music.126.net/a.jpg' }, dt: 325000 },
                { id: 222, name: '起风了 (DJ版)', ar: [{ name: 'DJ某' }], al: { name: 'DJ' }, dt: 200000 },
              ],
            },
          },
        };
      }
      if (url === '/song/url/v1') {
        if (opts.params?.id === '111' && opts.params?.level === 'lossless') {
          return { data: { data: [{ id: 111, url: 'http://m701.music.126.net/trial.mp3', level: 'standard', freeTrialInfo: { start: 0, end: 30 } }] } };
        }
        return { data: { data: [{ id: 111, url: 'http://m801.music.126.net/full.mp3', level: 'exhigh', br: 320000, freeTrialInfo: null }] } };
      }
      if (url === '/lyric') {
        return { data: { lrc: { lyric: '[00:01.00]这一路上走走停停' } } };
      }
      return { data: {} };
    });
    vi.doMock('axios', () => ({ default: { create: () => ({ get }) } }));

    const { NeteaseProvider } = await import('../server/services/providers/netease.js');
    const p = new NeteaseProvider();
    expect(p.isEnabled()).toBe(true);

    const hits = await p.search({ title: '起风了', artist: '买辣椒也用券' });
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      provider: 'netease',
      id: '111',
      hash: 'netease:111',
      duration: 325,
      score: 150,
    });
    expect(hits[1].score).toBe(0); // DJ 版 0 分

    const resolved = await p.resolveTrack({ title: '起风了', artist: '买辣椒也用券' });
    expect(resolved).toMatchObject({
      provider: 'netease',
      providerTrackId: '111',
      kugouId: 'netease:111',
      upstreamUrl: 'http://m801.music.126.net/full.mp3',
      audioQuality: '320',
    });
    expect(await p.lyric('netease:111')).toBe('[00:01.00]这一路上走走停停');
  });

  it('/register/anonimous 返回 400 失败后进入冷却，不阻断搜歌且不高频重刷', async () => {
    process.env.NETEASE_API_BASE = 'http://localhost:33401';
    const get = vi.fn(async url => {
      if (url === '/register/anonimous') {
        const err = new Error('Request failed with status code 400');
        err.response = { status: 400 };
        throw err;
      }
      if (url === '/cloudsearch') {
        return {
          data: {
            result: {
              songs: [{ id: 1973665667, name: '海屿你', ar: [{ name: '歌手' }], al: { name: '专辑' }, dt: 240000 }],
            },
          },
        };
      }
      return { data: {} };
    });
    vi.doMock('axios', () => ({ default: { create: () => ({ get }) } }));

    const { NeteaseProvider } = await import('../server/services/providers/netease.js');
    const p = new NeteaseProvider();
    const first = await p.search({ title: '海屿你' });
    const second = await p.search({ title: '海屿你' });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    const anonCalls = get.mock.calls.filter(c => c[0] === '/register/anonimous');
    expect(anonCalls).toHaveLength(1);
  });

  it('state.db 存有 netease_cookie 时优先携带清洗后的 MUSIC_U 发请求，不走匿名注册', async () => {
    process.env.NETEASE_API_BASE = 'http://localhost:33401';
    prefMem.set('netease_cookie', 'MUSIC_U=SAVED_U; Max-Age=1296000; Path=/; __csrf=SAVED_CSRF');
    const get = vi.fn(async url => {
      if (url === '/cloudsearch') {
        return {
          data: {
            result: {
              songs: [{ id: 101, name: '晴天', ar: [{ name: '周杰伦' }], al: { name: '叶惠美' }, dt: 269000 }],
            },
          },
        };
      }
      return { data: {} };
    });
    vi.doMock('axios', () => ({ default: { create: () => ({ get }) } }));

    const { NeteaseProvider } = await import('../server/services/providers/netease.js');
    const p = new NeteaseProvider();
    await p.search({ title: '晴天', artist: '周杰伦' });

    expect(get.mock.calls.some(c => c[0] === '/register/anonimous')).toBe(false);
    const searchCall = get.mock.calls.find(c => c[0] === '/cloudsearch');
    expect(searchCall?.[1]?.params?.cookie).toBe('MUSIC_U=SAVED_U;__csrf=SAVED_CSRF');
  });
});

describe('QQMusicProvider', () => {
  it('未填 QQ_API_BASE 时自动跳过（isEnabled=false）', async () => {
    const { QQMusicProvider } = await import('../server/services/providers/qq.js');
    const p = new QQMusicProvider();
    expect(p.isEnabled()).toBe(false);
    expect(await p.search({ title: '晴天' })).toEqual([]);
    expect(await p.trackUrl('003')).toBeNull();
    expect(await p.healthCheck()).toMatchObject({ ok: false, configured: false });
  });

  it('未登录时降级只搜不放，拿不到直链迅速返回 null 不卡顿', async () => {
    process.env.QQ_API_BASE = 'http://localhost:33402';
    const get = vi.fn(async url => {
      if (url === '/search') {
        return {
          data: {
            ok: true,
            tracks: [{ id: '97773', mid: '0039MnYb0qxYhV', title: '晴天', artist: '周杰伦', album: '叶惠美', duration: 269, cover: 'https://y.gtimg.cn/a.jpg', payPlay: 1 }],
          },
        };
      }
      if (url === '/song/url') {
        return { data: { ok: true, url: null, quality: null, loggedIn: false, reason: 'login_required' } };
      }
      if (url === '/health') {
        return { data: { ok: true, loggedIn: false, musicid: 0, detail: 'unauthenticated' } };
      }
      return { data: {} };
    });
    vi.doMock('axios', () => ({ default: { create: () => ({ get }) } }));

    const { QQMusicProvider } = await import('../server/services/providers/qq.js');
    const p = new QQMusicProvider();
    const hits = await p.search({ title: '晴天', artist: '周杰伦' });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ provider: 'qq', id: '0039MnYb0qxYhV', hash: 'qq:0039MnYb0qxYhV', score: 150 });
    expect(await p.resolveTrack({ title: '晴天', artist: '周杰伦' })).toBeNull();
    expect(await p.healthCheck()).toMatchObject({ ok: true, configured: true, loggedIn: false });
  });
});

describe('services/music 多源编排', () => {
  function fakeProvider(name, overrides = {}) {
    return {
      name,
      isEnabled: () => true,
      healthCheck: vi.fn(async () => ({ ok: true, configured: true, detail: 'ok' })),
      search: vi.fn(async () => []),
      trackUrl: vi.fn(async () => null),
      lyric: vi.fn(async () => null),
      playlist: vi.fn(async () => ({ tracks: [], totalCount: 0, fetchedCount: 0, truncated: false })),
      resolveTrack: vi.fn(async () => null),
      ...overrides,
    };
  }

  it('multi 搜索三家并行并按分数降序（同分按酷狗→网易云→QQ）', async () => {
    const db = { addUnmatched: vi.fn() };
    const kugou = fakeProvider('kugou', {
      search: vi.fn(async () => [{ provider: 'kugou', id: 'k1', hash: 'k1', title: '晴天', artist: '周杰伦', score: 150 }]),
    });
    const netease = fakeProvider('netease', {
      search: vi.fn(async () => [{ provider: 'netease', id: 'n1', hash: 'netease:n1', title: '晴天', artist: '周杰伦', score: 150 }]),
    });
    const qq = fakeProvider('qq', {
      search: vi.fn(async () => [{ provider: 'qq', id: 'q1', hash: 'qq:q1', title: '晴天(高分)', artist: '周杰伦', score: 160 }]),
    });

    const music = createMusicService({
      providers: { kugou, netease, qq },
      db,
      getSetting: () => 'multi',
    });

    const result = await music.search({ title: '晴天', artist: '周杰伦' });
    expect(result.provider).toBe('multi');
    expect(result.providersUsed).toEqual(['kugou', 'netease', 'qq']);
    expect(result.tracks.map(t => `${t.provider}:${t.id}`)).toEqual(['qq:q1', 'kugou:k1', 'netease:n1']);
  });

  it('multi 点歌依次回落：酷狗 unmatched → 网易云 → QQ，全败才写 unmatched', async () => {
    const db = { addUnmatched: vi.fn() };
    const kugou = fakeProvider('kugou', { resolveTrack: vi.fn(async () => null) });
    const netease = fakeProvider('netease', {
      resolveTrack: vi.fn(async () => ({
        provider: 'netease',
        providerTrackId: '1330348068',
        kugouId: 'netease:1330348068',
        title: '起风了',
        artist: '买辣椒也用券',
        upstreamUrl: 'http://m801.music.126.net/a.mp3',
        score: 150,
      })),
    });
    const qq = fakeProvider('qq');

    const music = createMusicService({
      providers: { kugou, netease, qq },
      db,
      getSetting: () => 'multi',
    });

    const hit = await music.resolveTrack({ title: '起风了', artist: '买辣椒也用券' });
    expect(hit).toMatchObject({ provider: 'netease', kugouId: 'netease:1330348068' });
    expect(kugou.resolveTrack).toHaveBeenCalledTimes(1);
    expect(netease.resolveTrack).toHaveBeenCalledTimes(1);
    expect(qq.resolveTrack).not.toHaveBeenCalled();
    expect(db.addUnmatched).not.toHaveBeenCalled();

    // 网易云也失败时继续回落到 QQ，若全部失败则记一次 unmatched
    netease.resolveTrack.mockResolvedValueOnce(null);
    const miss = await music.resolveTrack({ title: '不存在的歌', artist: '未知' });
    expect(miss).toBeNull();
    expect(qq.resolveTrack).toHaveBeenCalledTimes(1);
    expect(db.addUnmatched).toHaveBeenCalledTimes(1);
  });

  it('带前缀 ID（netease:/qq:）精确路由到对应 provider 拿直链与歌词', async () => {
    const kugou = fakeProvider('kugou');
    const netease = fakeProvider('netease', {
      trackUrl: vi.fn(async id => ({ url: `http://m701.music.126.net/${id}.mp3`, quality: '320' })),
      lyric: vi.fn(async id => `[00:00]${id}`),
    });
    const qq = fakeProvider('qq', {
      trackUrl: vi.fn(async id => ({ url: `https://isure.stream.qqmusic.qq.com/${id}.mp3`, quality: '128' })),
      lyric: vi.fn(async id => `[00:00]qq-${id}`),
    });

    const music = createMusicService({
      providers: { kugou, netease, qq },
      db: { addUnmatched: vi.fn() },
      getSetting: () => 'multi',
    });

    expect(await music.trackUrl('netease:555')).toEqual({ url: 'http://m701.music.126.net/555.mp3', quality: '320' });
    expect(await music.lyric('qq:003abc')).toBe('[00:00]qq-003abc');
    expect(netease.trackUrl).toHaveBeenCalledWith('555', { targetQuality: '' });
    expect(qq.lyric).toHaveBeenCalledWith('003abc');
  });
});
