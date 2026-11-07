import { describe, expect, it } from 'vitest';
import { dbApi } from '../server/db.js';

describe('like_pending', () => {
  it('插入、去重、完成，再次收藏会新建一条', () => {
    const id = Number(dbApi.addLikePending({
      kugouId: 'db-h1',
      title: '晴天',
      artist: '周杰伦',
      album: '叶惠美',
      albumId: 'a1',
      mixsongid: 'm1',
    }));
    expect(id).toBeGreaterThan(0);
    expect(Number(dbApi.addLikePending({ kugouId: 'db-h1', title: '晴天' }))).toBe(id);
    expect(dbApi.pendingLikes(20).some(row => row.kugou_id === 'db-h1')).toBe(true);

    dbApi.resolveLikePending(id, { targetPlaylist: '学习', targetListid: '49' });
    const done = dbApi.getLikePending(id);
    expect(done.status).toBe('done');
    expect(done.target_playlist).toBe('学习');
    expect(done.target_listid).toBe('49');
    expect(dbApi.pendingLikes(20).some(row => row.id === id)).toBe(false);

    const again = Number(dbApi.addLikePending({ kugouId: 'db-h1', title: '晴天' }));
    expect(again).not.toBe(id);
    dbApi.cancelLikePendingByHash('db-h1');
    expect(dbApi.getLikePending(again).status).toBe('skipped');
  });

  it('skip 记录原因', () => {
    const id = Number(dbApi.addLikePending({ kugouId: 'db-h2', title: '夜曲' }));
    dbApi.skipLikePending(id, { note: '没有合适分类' });
    const row = dbApi.getLikePending(id);
    expect(row.status).toBe('skipped');
    expect(row.note).toBe('没有合适分类');
  });
});
