import { describe, expect, it, vi } from 'vitest';
import { createFavoriteStore } from '../server/services/kugou-favorite.js';

function makeDeps(overrides = {}) {
  return {
    fetchUserPlaylists: vi.fn(async () => [
      { name: '通勤', listid: '1', type: 1 },
      { name: '我喜欢', listid: '2', type: 0 },
    ]),
    fetchUserPlaylistTracks: vi.fn(async () => ({
      tracks: [{ hash: 'h1', fileid: '11', title: '旧歌' }],
    })),
    addPlaylistTracks: vi.fn(async () => ({ ok: true })),
    deletePlaylistTracks: vi.fn(async () => ({ ok: true })),
    resolveTrackMeta: vi.fn(async () => ({
      album: '叶惠美',
      albumId: 'a1',
      mixsongid: 'm1',
      cover: 'http://img/c.jpg',
    })),
    ...overrides,
  };
}

describe('createFavoriteStore', () => {
  it('按名字找到「我喜欢」，并判断是否已收藏', async () => {
    const deps = makeDeps();
    const store = createFavoriteStore(deps);
    expect(await store.isFavorite('h1')).toBe(true);
    expect(await store.isFavorite('h2')).toBe(false);
    expect(deps.fetchUserPlaylistTracks).toHaveBeenCalledWith({ listid: '2', fresh: true });
  });

  it('加入新歌时补全专辑 / mixsongid，并标记 duplicate', async () => {
    const deps = makeDeps();
    const store = createFavoriteStore(deps);
    const first = await store.add({ kugouId: 'h2', title: '晴天', artist: '周杰伦' });
    expect(first.duplicate).toBe(false);
    expect(deps.resolveTrackMeta).toHaveBeenCalledWith({
      title: '晴天',
      artist: '周杰伦',
      hash: 'h2',
    });
    expect(deps.addPlaylistTracks).toHaveBeenCalledWith({
      listid: '2',
      tracks: [expect.objectContaining({
        kugouId: 'h2',
        title: '晴天',
        album: '叶惠美',
        albumId: 'a1',
        mixsongid: 'm1',
      })],
    });

    const second = await store.add({ kugouId: 'h2', title: '晴天' });
    expect(second.duplicate).toBe(true);
    expect(deps.addPlaylistTracks).toHaveBeenCalledTimes(1);
  });

  it('已有专辑字段时不再重新搜索', async () => {
    const deps = makeDeps();
    const store = createFavoriteStore(deps);
    await store.add({ kugouId: 'h3', title: '夜曲', albumId: 'a3', mixsongid: 'm3' });
    expect(deps.resolveTrackMeta).not.toHaveBeenCalled();
  });

  it('取消收藏按 fileid 删除', async () => {
    const deps = makeDeps();
    const store = createFavoriteStore(deps);
    const result = await store.remove({ kugouId: 'h1', title: '旧歌' });
    expect(result.removed).toBe(true);
    expect(deps.deletePlaylistTracks).toHaveBeenCalledWith({ listid: '2', fileids: ['11'] });
    expect(await store.isFavorite('h1')).toBe(false);
  });

  it('不在收藏里的歌取消时什么都不删', async () => {
    const deps = makeDeps();
    const store = createFavoriteStore(deps);
    const result = await store.remove({ kugouId: 'h9', title: '没有' });
    expect(result.removed).toBe(false);
    expect(deps.deletePlaylistTracks).not.toHaveBeenCalled();
  });

  it('找不到「我喜欢」时抛错', async () => {
    const deps = makeDeps({
      fetchUserPlaylists: vi.fn(async () => [{ name: '通勤', listid: '1', type: 0 }]),
    });
    const store = createFavoriteStore(deps);
    await expect(store.isFavorite('h1')).rejects.toThrow('没有找到歌单「我喜欢」');
  });
});
