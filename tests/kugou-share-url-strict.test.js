import { afterEach, describe, expect, it } from 'vitest';
import { parseShareUrl } from '../server/music/kugou-share-url.js';

afterEach(() => {
  delete process.env.KUGOU_PROXY;
});

function makeAxiosClient(responseUrl) {
  return {
    async get() {
      return {
        request: { res: { responseUrl } },
        config: { url: responseUrl },
        data: '',
      };
    },
  };
}

describe('music/kugou-share-url · 域名严格匹配', () => {
  it('evil-kugou.com 被拒，且不发 HTTP 请求', async () => {
    let called = false;
    const axiosClient = {
      get: async () => { called = true; return {}; },
    };

    await expect(parseShareUrl('https://evil-kugou.com/share/zlist.html?listid=2', { axiosClient }))
      .rejects.toThrow(/不是酷狗域名/);
    expect(called).toBe(false);
  });

  it('kugou.com.evil.net 被拒', async () => {
    await expect(parseShareUrl('https://kugou.com.evil.net/x?listid=2', { axiosClient: makeAxiosClient(null) }))
      .rejects.toThrow(/不是酷狗域名/);
  });

  it('kugou.com.cn 这类后缀不算酷狗', async () => {
    await expect(parseShareUrl('https://kugou.com.cn/x?listid=2', { axiosClient: makeAxiosClient(null) }))
      .rejects.toThrow(/不是酷狗域名/);
  });

  it('短链重定向到非酷狗域名被拒', async () => {
    const axiosClient = makeAxiosClient('https://evil.example/list?global_collection_id=collection_3_1_2_0&listid=2');

    await expect(parseShareUrl('https://t1.kugou.com/abc', { axiosClient }))
      .rejects.toThrow(/重定向到了非酷狗域名/);
  });

  it('短链重定向到近似域名（kugou.com.evil.net）被拒', async () => {
    const axiosClient = makeAxiosClient('https://kugou.com.evil.net/list?global_collection_id=collection_3_1_2_0');

    await expect(parseShareUrl('https://t1.kugou.com/abc', { axiosClient }))
      .rejects.toThrow(/重定向到了非酷狗域名/);
  });

  it('kugou.com 根域和子域照样能用', async () => {
    const direct = 'https://kugou.com/share/zlist.html?global_collection_id=collection_3_1_2_0&listid=2';
    const info = await parseShareUrl(direct, { axiosClient: makeAxiosClient(null) });
    expect(info.globalCollectionId).toBe('collection_3_1_2_0');

    const finalUrl = 'https://wwwapi.kugou.com/share/zlist.html?global_collection_id=collection_3_9_2_0&listid=2';
    const followed = await parseShareUrl('https://t1.kugou.com/xyz', { axiosClient: makeAxiosClient(finalUrl) });
    expect(followed.resolvedUrl).toBe(finalUrl);
    expect(followed.globalCollectionId).toBe('collection_3_9_2_0');
  });
});
