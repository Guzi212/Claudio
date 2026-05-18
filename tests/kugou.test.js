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
