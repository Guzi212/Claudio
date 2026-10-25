import { describe, it, expect, vi, beforeEach } from 'vitest';

// 只做一件事：确保 kugou 服务的导出齐全，scoreCandidate 通过 resolveTrack 的行为合理。
// 上游 KuGouMusicApi 真实接口的覆盖留给手工 e2e（README 步骤 3）。

describe('services/kugou', () => {
  beforeEach(() => {
    vi.doUnmock('axios');
    vi.doUnmock('../server/db.js');
    vi.resetModules();
    delete process.env.KUGOU_PROXY;
  });

  it('导出 search / songUrl / lyric / resolveTrack', async () => {
    const mod = await import('../server/services/kugou.js');
    expect(typeof mod.search).toBe('function');
    expect(typeof mod.songUrl).toBe('function');
    expect(typeof mod.lyric).toBe('function');
    expect(typeof mod.resolveTrack).toBe('function');
    expect(typeof mod.coverUrlFromRaw).toBe('function');
  });

  it('封面地址把 {size} 换成 400，没有图就返回空字符串', async () => {
    const { coverUrlFromRaw } = await import('../server/services/kugou.js');
    expect(coverUrlFromRaw({ img: 'https://img.example/{size}/a.jpg' })).toBe('https://img.example/400/a.jpg');
    expect(coverUrlFromRaw({ albumImg: ' https://img.example/cover.jpg ' })).toBe('https://img.example/cover.jpg');
    expect(coverUrlFromRaw({})).toBe('');
    expect(coverUrlFromRaw(null)).toBe('');
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

  it('resolveTrack 跳过未点名的 DJ 版，选中原版', async () => {
    vi.doMock('../server/db.js', () => ({
      dbApi: { getPref: () => '', addUnmatched: vi.fn() },
    }));
    const get = vi.fn(async path => {
      if (String(path).includes('/search')) {
        return {
          data: {
            data: {
              lists: [
                { FileHash: 'DJ1', SongName: '晴天DJ版', SingerName: '周杰伦' },
                { FileHash: 'GOOD', OriSongName: '晴天', SingerName: '周杰伦', AlbumID: 9, MixSongID: 100 },
              ],
            },
          },
        };
      }
      return { data: { url: 'https://cdn.kugou.com/good.mp3' } };
    });
    vi.doMock('axios', () => ({ default: { create: () => ({ get, post: vi.fn() }) } }));
    const { resolveTrack } = await import('../server/services/kugou.js');
    const result = await resolveTrack({ title: '晴天', artist: '周杰伦' });
    expect(result.kugouId).toBe('GOOD');
    expect(result.albumId).toBe(9);
    expect(result.mixsongid).toBe(100);
    expect(result.upstreamUrl).toBe('https://cdn.kugou.com/good.mp3');
  });

  it('只有 DJ 版时记 unmatched 并返回 null', async () => {
    const addUnmatched = vi.fn();
    vi.doMock('../server/db.js', () => ({
      dbApi: { getPref: () => '', addUnmatched },
    }));
    vi.doMock('axios', () => ({
      default: {
        create: () => ({
          get: vi.fn(async () => ({
            data: { data: { lists: [{ FileHash: 'DJ1', SongName: '晴天DJ版', SingerName: '周杰伦' }] } },
          })),
          post: vi.fn(),
        }),
      },
    }));
    const { resolveTrack } = await import('../server/services/kugou.js');
    await expect(resolveTrack({ title: '晴天', artist: '周杰伦' })).resolves.toBeNull();
    expect(addUnmatched).toHaveBeenCalledWith(expect.objectContaining({ title: '晴天', artist: '周杰伦' }));
  });

  it('本机 KuGouMusicApi 不走 KUGOU_PROXY', async () => {
    process.env.KUGOU_PROXY = 'http://127.0.0.1:7890';
    process.env.KUGOU_API_BASE = 'http://127.0.0.1:3000';
    const create = vi.fn(() => ({
      get: vi.fn(async () => ({ data: {} })),
      post: vi.fn(),
    }));
    vi.doMock('axios', () => ({ default: { create } }));
    vi.doMock('../server/db.js', () => ({ dbApi: { getPref: () => '' } }));
    const { search } = await import('../server/services/kugou.js');
    await search({ title: '晴天' });
    expect(create.mock.calls[0][0].proxy).toBe(false);
  });

  it('playlist/add 用 type=0 新建歌单', async () => {
    const post = vi.fn(async () => ({
      data: { status: 1, data: { listid: 12, global_collection_id: 'g12' } },
    }));
    vi.doMock('axios', () => ({ default: { create: () => ({ post, get: vi.fn() }) } }));
    vi.doMock('../server/db.js', () => ({ dbApi: { getPref: () => 'token=1' } }));
    const { createUserPlaylist } = await import('../server/services/kugou.js');
    const created = await createUserPlaylist({ name: 'Claudio推荐' });
    expect(post).toHaveBeenCalledWith('/playlist/add', null, expect.objectContaining({
      params: expect.objectContaining({
        name: 'Claudio推荐',
        type: 0,
        source: 1,
        list_create_userid: 0,
        list_create_listid: 0,
      }),
    }));
    expect(created).toMatchObject({ listid: '12', globalCollectionId: 'g12', name: 'Claudio推荐' });
  });

  it('playlist/tracks/add 与 del 使用上游约定的参数', async () => {
    const post = vi.fn(async () => ({ data: { status: 1 } }));
    vi.doMock('axios', () => ({ default: { create: () => ({ post, get: vi.fn() }) } }));
    vi.doMock('../server/db.js', () => ({ dbApi: { getPref: () => '' } }));
    const { addPlaylistTracks, deletePlaylistTracks, formatPlaylistTrackData } = await import('../server/services/kugou.js');
    expect(formatPlaylistTrackData([
      { title: '晴天,DJ', kugouId: 'HASH', albumId: '9', mixsongid: '3' },
    ])).toBe('晴天 DJ|HASH|9|3');

    await addPlaylistTracks({
      listid: '12',
      tracks: [{ title: '晴天', kugouId: 'HASH' }],
    });
    expect(post).toHaveBeenCalledWith('/playlist/tracks/add', null, {
      params: { listid: '12', data: '晴天|HASH' },
    });

    await deletePlaylistTracks({ listid: '12', fileids: ['9', '10'] });
    expect(post).toHaveBeenCalledWith('/playlist/tracks/del', null, {
      params: { listid: '12', fileids: '9,10' },
    });
  });

  it('playlistFileId 读取 fileid，忽略 0', async () => {
    const { playlistFileId } = await import('../server/services/kugou.js');
    expect(playlistFileId({ fileid: 42 })).toBe('42');
    expect(playlistFileId({ file_id: '7' })).toBe('7');
    expect(playlistFileId({ fileid: 0 })).toBe('');
  });
});
