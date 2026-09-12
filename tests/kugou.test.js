import { describe, it, expect, vi, beforeEach } from 'vitest';

// 只做一件事：确保 kugou 服务的导出齐全，scoreCandidate 通过 resolveTrack 的行为合理。
// 上游 KuGouMusicApi 真实接口的覆盖留给手工 e2e（README 步骤 3）。

describe('services/kugou', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('导出 search / songUrl / lyric / resolveTrack', async () => {
    const mod = await import('../server/services/kugou.js');
    expect(typeof mod.search).toBe('function');
    expect(typeof mod.songUrl).toBe('function');
    expect(typeof mod.lyric).toBe('function');
    expect(typeof mod.resolveTrack).toBe('function');
  });

  it('lyric 两步走：先 search/lyric 拿 id+accesskey，再拿 LRC', async () => {
    let callCount = 0;
    const axiosMock = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ data: { candidates: [{ id: 144545941, accesskey: 'TESTKEY' }] } });
      }
      return Promise.resolve({ data: { decodeContent: '[00:01.00]测试歌词\n[00:04.00]第二行' } });
    });
    vi.doMock('axios', () => ({ default: { create: () => ({ get: axiosMock }) } }));
    const { lyric } = await import('../server/services/kugou.js');
    const result = await lyric('abc123');
    expect(callCount).toBe(2);
    expect(result).toBe('[00:01.00]测试歌词\n[00:04.00]第二行');
  });

  it('lyric search/lyric 无候选时返回 null', async () => {
    const axiosMock = vi.fn().mockResolvedValue({ data: { candidates: [] } });
    vi.doMock('axios', () => ({ default: { create: () => ({ get: axiosMock }) } }));
    const { lyric } = await import('../server/services/kugou.js');
    const result = await lyric('no-such-hash');
    expect(result).toBeNull();
  });

  it('导出歌单相关函数（fetchUserPlaylists / fetchUserPlaylistTracks / fetchSharedPlaylist）', async () => {
    const mod = await import('../server/services/kugou.js');
    expect(typeof mod.fetchSharedPlaylist).toBe('function');
    expect(typeof mod.fetchUserPlaylists).toBe('function');
    expect(typeof mod.fetchUserPlaylistTracks).toBe('function');
  });

  it('导出 normalizeForMatch / parseNameField 供下游复用', async () => {
    const mod = await import('../server/services/kugou.js');
    expect(typeof mod.normalizeForMatch).toBe('function');
    expect(typeof mod.parseNameField).toBe('function');
  });

  it('normalizeForMatch 去掉空格 / 大小写 / 标点', async () => {
    const { normalizeForMatch } = await import('../server/services/kugou.js');
    expect(normalizeForMatch('Love Story')).toBe('lovestory');
    expect(normalizeForMatch('周杰伦 - 晴天')).toBe('周杰伦晴天');
  });

  it('parseNameField 把 "Artist - Title" 摆正为 {title, artist}', async () => {
    const { parseNameField } = await import('../server/services/kugou.js');
    expect(parseNameField('周杰伦 - 晴天')).toEqual({ title: '晴天', artist: '周杰伦' });
    expect(parseNameField('无分隔')).toEqual({ title: '无分隔', artist: '' });
    expect(parseNameField('')).toEqual({ title: '', artist: '' });
  });

  it('fetchUserPlaylistTracks 缺 id 时抛错', async () => {
    const { fetchUserPlaylistTracks } = await import('../server/services/kugou.js');
    await expect(fetchUserPlaylistTracks({})).rejects.toThrow();
  });

  it('search 上游断开时不抛、返回空数组', async () => {
    // 临时把 KUGOU_API_BASE 指向一个肯定连不上的端口
    const orig = process.env.KUGOU_API_BASE;
    process.env.KUGOU_API_BASE = 'http://127.0.0.1:1';

    const { search } = await import('../server/services/kugou.js');
    const r = await search({ title: '晴天', artist: '周杰伦' });
    expect(Array.isArray(r)).toBe(true);
    expect(r.length).toBe(0);

    process.env.KUGOU_API_BASE = orig;
  });
});
