import { describe, expect, it, vi } from 'vitest';
import { writeTracksToPlaylist } from '../server/services/kugou-playlist-write.js';

function deps(overrides = {}) {
  return {
    fetchUserPlaylists: vi.fn(async () => [
      { name: '通勤', listid: '1', id: '1', globalCollectionId: 'g1' },
    ]),
    createUserPlaylist: vi.fn(async ({ name }) => ({
      name,
      listid: '12',
      globalCollectionId: 'g12',
    })),
    addPlaylistTracks: vi.fn(async () => ({ ok: true })),
    deletePlaylistTracks: vi.fn(async () => ({ ok: true })),
    listPlaylistFileIds: vi.fn(async () => ['9', '10']),
    ...overrides,
  };
}

const track = { title: '晴天', artist: '周杰伦', kugouId: 'HASH' };

describe('writeTracksToPlaylist', () => {
  it('同名歌单存在时追加，不新建、不清空', async () => {
    const api = deps({
      fetchUserPlaylists: vi.fn(async () => [
        { name: 'Claudio推荐', listid: '7', id: '7', globalCollectionId: 'g7' },
      ]),
    });
    const result = await writeTracksToPlaylist({
      name: 'Claudio推荐',
      mode: 'append',
      tracks: [track],
    }, api);

    expect(api.createUserPlaylist).not.toHaveBeenCalled();
    expect(api.deletePlaylistTracks).not.toHaveBeenCalled();
    expect(api.addPlaylistTracks).toHaveBeenCalledWith({ listid: '7', tracks: [track] });
    expect(result).toMatchObject({
      ok: true,
      id: '7',
      listid: '7',
      globalCollectionId: 'g7',
      created: false,
      mode: 'append',
    });
    expect(result.added).toEqual([{ title: '晴天', artist: '周杰伦', kugouId: 'HASH' }]);
  });

  it('没有同名歌单就 playlist_add 新建', async () => {
    const api = deps();
    const result = await writeTracksToPlaylist({
      name: 'Claudio推荐',
      tracks: [track],
    }, api);

    expect(api.createUserPlaylist).toHaveBeenCalledWith({ name: 'Claudio推荐' });
    expect(api.deletePlaylistTracks).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, id: '12', created: true });
  });

  it('翻页查找同名歌单', async () => {
    const page = vi.fn()
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => ({ name: `其他${i}`, listid: String(i + 1), id: String(i + 1) })))
      .mockResolvedValueOnce([{ name: 'Claudio推荐', listid: '88', id: '88' }]);
    const api = deps({ fetchUserPlaylists: page });
    const result = await writeTracksToPlaylist({ name: 'Claudio推荐', tracks: [track] }, api);
    expect(page).toHaveBeenCalledTimes(2);
    expect(result.id).toBe('88');
    expect(api.createUserPlaylist).not.toHaveBeenCalled();
  });

  it('rewrite 先按 fileid 删除再添加', async () => {
    const api = deps({
      fetchUserPlaylists: vi.fn(async () => [
        { name: 'Claudio推荐', listid: '7', id: '7' },
      ]),
    });
    const result = await writeTracksToPlaylist({
      name: 'Claudio推荐',
      mode: 'rewrite',
      tracks: [track],
    }, api);

    expect(api.listPlaylistFileIds).toHaveBeenCalledWith({ listid: '7' });
    expect(api.deletePlaylistTracks).toHaveBeenCalledWith({ listid: '7', fileids: ['9', '10'] });
    expect(api.addPlaylistTracks).toHaveBeenCalled();
    expect(result.mode).toBe('rewrite');
    expect(result.ok).toBe(true);
  });

  it('新建歌单的 rewrite 不调用删除', async () => {
    const api = deps();
    await writeTracksToPlaylist({
      name: 'Claudio推荐',
      mode: 'rewrite',
      tracks: [track],
    }, api);
    expect(api.listPlaylistFileIds).not.toHaveBeenCalled();
    expect(api.deletePlaylistTracks).not.toHaveBeenCalled();
  });

  it('批量添加失败时逐首重试，并标出失败的歌', async () => {
    const addPlaylistTracks = vi.fn(async ({ tracks }) => {
      if (tracks.length > 1) throw new Error('batch failed');
      if (tracks[0].title === '坏歌') throw new Error('单首失败');
      return { ok: true };
    });
    const api = deps({
      fetchUserPlaylists: vi.fn(async () => [{ name: 'Claudio推荐', listid: '7', id: '7' }]),
      addPlaylistTracks,
    });
    const result = await writeTracksToPlaylist({
      name: 'Claudio推荐',
      tracks: [track, { title: '坏歌', artist: '某人', kugouId: 'BAD' }],
    }, api);

    expect(result.ok).toBe(false);
    expect(result.added).toEqual([{ title: '晴天', artist: '周杰伦', kugouId: 'HASH' }]);
    expect(result.failed).toEqual([
      { title: '坏歌', artist: '某人', kugouId: 'BAD', reason: '单首失败' },
    ]);
  });

  it('列表接口失败时不新建歌单', async () => {
    const api = deps({
      fetchUserPlaylists: vi.fn(async () => { throw new Error('user/playlist down'); }),
    });
    const result = await writeTracksToPlaylist({ name: 'Claudio推荐', tracks: [track] }, api);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/user\/playlist down/);
    expect(api.createUserPlaylist).not.toHaveBeenCalled();
    expect(api.addPlaylistTracks).not.toHaveBeenCalled();
  });

  it('没有可写歌曲时不打上游', async () => {
    const api = deps();
    const result = await writeTracksToPlaylist({ name: 'Claudio推荐', tracks: [] }, api);
    expect(result).toMatchObject({ ok: true, skipped: true });
    expect(api.fetchUserPlaylists).not.toHaveBeenCalled();
  });
});
