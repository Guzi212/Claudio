import { describe, it, expect, vi, beforeEach } from 'vitest';

// 音质选择：songUrl 传 quality、songUrlForPlayback 回落链、resolveTrack 带 audioQuality、
// settings 提供 playback_quality（默认 flac）。
// 上游 KuGouMusicApi 的坑（实测）：high/viper 档 bitRate 返回 0，判断档位只能看
// extName + bitRate + url 是否存在；魔法音质（piano 等）不在本模块处理范围。

const prefMem = vi.hoisted(() => new Map());

vi.mock('../server/db.js', () => ({
  dbApi: {
    getPref: k => (prefMem.has(k) ? prefMem.get(k) : null),
    setPref: (k, v) => { prefMem.set(k, String(v)); },
    delPref: k => { prefMem.delete(k); },
    addUnmatched: vi.fn(),
  },
}));

function upstreamPayload(quality) {
  // 模拟上游 /song/url：VIP 曲 flac 无 url；320 返回 mp3+320000；128 返回 mp3+128000
  switch (quality) {
    case 'flac':
      return { status: 1, data: { url: ['https://cdn.kugou.com/song.flac'], extName: 'flac', bitRate: 564000, fileSize: 28370747 } };
    case '320':
      return { status: 1, data: { url: ['https://cdn.kugou.com/song.mp3'], extName: 'mp3', bitRate: 320000, fileSize: 16080196 } };
    default:
      return { status: 1, data: { url: ['https://cdn.kugou.com/song.mp3'], extName: 'mp3', bitRate: 128000, fileSize: 6432235 } };
  }
}

function mockAxios({ getImpl } = {}) {
  const get = vi.fn(async (endpoint, opts = {}) => ({ data: getImpl(endpoint, opts.params || {}) }));
  vi.doMock('axios', () => ({ default: { create: () => ({ get, post: get }) } }));
  return { get };
}

beforeEach(() => {
  prefMem.clear();
  delete process.env.KUGOU_API_BASE;
  delete process.env.PLAYBACK_QUALITY;
  vi.resetModules();
  vi.doUnmock('axios');
});

describe('settings: playback_quality', () => {
  it('KEYS 含 playback_quality，默认 flac，set/get 往返', async () => {
    const { KEYS, DEFAULTS, getWithDefault, set, get } = await import('../server/services/settings.js');
    expect(KEYS).toContain('playback_quality');
    expect(DEFAULTS.playback_quality).toBe('flac');
    expect(getWithDefault('playback_quality')).toBe('flac');
    set('playback_quality', '320');
    expect(get('playback_quality')).toBe('320');
    set('playback_quality', '');
    expect(getWithDefault('playback_quality')).toBe('flac');
  });
});

describe('kugou: songUrl quality 传递', () => {
  it('songUrl(hash, quality) 把 quality 透传给上游 params', async () => {
    const { get } = mockAxios({ getImpl: (_e, params) => upstreamPayload(params.quality || '128') });
    const { songUrl } = await import('../server/services/kugou.js');
    const url = await songUrl('HASH1', '320');
    expect(url).toBe('https://cdn.kugou.com/song.mp3');
    expect(get).toHaveBeenCalledWith('/song/url', expect.objectContaining({
      params: expect.objectContaining({ hash: 'HASH1', quality: '320' }),
    }));
  });
});

describe('kugou: songUrlForPlayback 回落链', () => {
  it('目标 flac 拿到 flac → 返回 quality=flac 不回落', async () => {
    mockAxios({ getImpl: (_e, params) => upstreamPayload(params.quality) });
    const { songUrlForPlayback } = await import('../server/services/kugou.js');
    const r = await songUrlForPlayback('H', { targetQuality: 'flac' });
    expect(r).toMatchObject({ url: 'https://cdn.kugou.com/song.flac', quality: 'flac' });
  });

  it('flac 档拿不到（extName 不符）→ 自动回落 320，标实际档位', async () => {
    const { get } = mockAxios({
      getImpl: (_e, params) => {
        // flac 请求返回 mp3（歌曲没有无损档）
        if (params.quality === 'flac') {
          return { status: 1, data: { url: ['https://cdn.kugou.com/song.mp3'], extName: 'mp3', bitRate: 128000, fileSize: 6432235 } };
        }
        return upstreamPayload(params.quality);
      },
    });
    const { songUrlForPlayback } = await import('../server/services/kugou.js');
    const r = await songUrlForPlayback('H', { targetQuality: 'flac' });
    expect(r).toMatchObject({ url: 'https://cdn.kugou.com/song.mp3', quality: '320' });
    const qualities = get.mock.calls.map(c => c[1].params.quality);
    expect(qualities).toEqual(['flac', '320']);
  });

  it('flac→320 都拿不到 → 最后落到 128，最多三次尝试', async () => {
    const { get } = mockAxios({
      getImpl: (_e, params) => {
        if (params.quality === '128') return upstreamPayload('128');
        return { status: 0, data: null }; // status!=1 或无 url 视为拿不到
      },
    });
    const { songUrlForPlayback } = await import('../server/services/kugou.js');
    const r = await songUrlForPlayback('H', { targetQuality: 'flac' });
    expect(r).toMatchObject({ quality: '128' });
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('整链都失败 → null，不谎报', async () => {
    mockAxios({ getImpl: () => ({ status: 0 }) });
    const { songUrlForPlayback } = await import('../server/services/kugou.js');
    expect(await songUrlForPlayback('H', { targetQuality: 'flac' })).toBeNull();
  });

  it('目标 128：上游返回 mp3 即命中，不再多请求', async () => {
    const { get } = mockAxios({ getImpl: (_e, params) => upstreamPayload(params.quality) });
    const { songUrlForPlayback } = await import('../server/services/kugou.js');
    const r = await songUrlForPlayback('H', { targetQuality: '128' });
    expect(r).toMatchObject({ quality: '128' });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('不传 targetQuality 时读 settings.playback_quality', async () => {
    prefMem.set('playback_quality', '320');
    mockAxios({ getImpl: (_e, params) => upstreamPayload(params.quality) });
    const { songUrlForPlayback } = await import('../server/services/kugou.js');
    const r = await songUrlForPlayback('H');
    expect(r).toMatchObject({ quality: '320' });
  });

  it('目标 high：extName=flac 即命中，标 high', async () => {
    mockAxios({ getImpl: () => ({ status: 1, data: { url: ['u'], extName: 'flac', bitRate: 0, fileSize: 28931422 } }) });
    const { songUrlForPlayback } = await import('../server/services/kugou.js');
    const r = await songUrlForPlayback('H', { targetQuality: 'high' });
    expect(r).toMatchObject({ quality: 'high' });
  });

  it('目标 viper_clear：上游回 mp3（假档）→ 不当 viper_clear，回落到首个满足的档', async () => {
    const { get } = mockAxios({
      getImpl: (_e, params) => {
        // 无损族档都静默回 mp3（类似 viper_tape 的假档行为），320 档命中同一条
        if (['viper_clear', 'viper_atmos', 'high', 'flac', '320'].includes(params.quality)) {
          return { status: 1, data: { url: ['u320'], extName: 'mp3', bitRate: 320000, fileSize: 16080196 } };
        }
        return upstreamPayload(params.quality);
      },
    });
    const { songUrlForPlayback } = await import('../server/services/kugou.js');
    const r = await songUrlForPlayback('H', { targetQuality: 'viper_clear' });
    expect(r).toMatchObject({ quality: '320', url: 'u320' });
    const qualities = get.mock.calls.map(c => c[1].params.quality);
    expect(qualities).toEqual(['viper_clear', 'viper_atmos', 'high', 'flac', '320']);
  });

  it('目标 viper_atmos：上游回普通 flac（fileSize 只有 28MB）→ 不满足，继续回落到 flac', async () => {
    const { get } = mockAxios({
      getImpl: (_e, params) => {
        // viper_atmos / clear 静默回 28MB 普通 flac；真实 viper_atmos≈42MB
        if (params.quality === 'viper_clear' || params.quality === 'viper_atmos') {
          return { status: 1, data: { url: ['uPlain'], extName: 'flac', bitRate: 564000, fileSize: 28370747 } };
        }
        return upstreamPayload(params.quality);
      },
    });
    const { songUrlForPlayback } = await import('../server/services/kugou.js');
    const r = await songUrlForPlayback('H', { targetQuality: 'viper_atmos' });
    expect(r.quality).not.toBe('viper_atmos');
    expect(r.quality).toBe('flac');
  });

  it('viper_clear 真命中：flac + fileSize>80MB → 标 viper_clear', async () => {
    mockAxios({ getImpl: () => ({ status: 1, data: { url: ['uClear'], extName: 'flac', bitRate: 0, fileSize: 138_800_000 } }) });
    const { songUrlForPlayback } = await import('../server/services/kugou.js');
    const r = await songUrlForPlayback('H', { targetQuality: 'viper_clear' });
    expect(r).toMatchObject({ quality: 'viper_clear', url: 'uClear' });
  });

  it('isValidQuality 只认六档，拒绝魔法音质与假档', async () => {
    const { isValidQuality, PLAYBACK_QUALITIES } = await import('../server/services/kugou.js');
    expect(PLAYBACK_QUALITIES).toEqual(['viper_clear', 'viper_atmos', 'high', 'flac', '320', '128']);
    for (const q of PLAYBACK_QUALITIES) expect(isValidQuality(q)).toBe(true);
    for (const bad of ['super', 'viper_tape', 'piano', 'acappella', 'dj', '', 'flac24']) {
      expect(isValidQuality(bad)).toBe(false);
    }
  });
});

describe('kugou: resolveTrack 带实际档位', () => {
  it('显式 hash 解析成功 → 队列项含 audioQuality', async () => {
    mockAxios({ getImpl: (_e, params) => upstreamPayload(params.quality) });
    prefMem.set('playback_quality', 'flac');
    const { resolveTrack } = await import('../server/services/kugou.js');
    const t = await resolveTrack({ hash: 'H1' });
    expect(t).toMatchObject({ kugouId: 'H1', audioQuality: 'flac' });
  });

  it('flac 回落到 320 → audioQuality 标 320，不谎报 flac', async () => {
    mockAxios({
      getImpl: (_e, params) => {
        if (params.quality === 'flac') return { status: 0 };
        return upstreamPayload(params.quality);
      },
    });
    prefMem.set('playback_quality', 'flac');
    const { resolveTrack } = await import('../server/services/kugou.js');
    const t = await resolveTrack({ hash: 'H2' });
    expect(t.audioQuality).toBe('320');
  });
});
