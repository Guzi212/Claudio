import { describe, expect, it } from 'vitest';
import { parseShareUrl } from '../server/music/kugou-share-url.js';

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

describe('music/kugou-share-url', () => {
  it('extracts global_collection_id directly when URL already carries query params', async () => {
    const url = 'http://wwwapi.kugou.com/share/zlist.html?chain=6xvtZ34G1V2'
      + '&global_collection_id=collection_3_854483130_2_0&listid=2'
      + '&share_type=collect&uid=854483130';

    const info = await parseShareUrl(url, { axiosClient: makeAxiosClient(null) });

    expect(info).toMatchObject({
      globalCollectionId: 'collection_3_854483130_2_0',
      chain: '6xvtZ34G1V2',
      uid: '854483130',
      listid: '2',
    });
  });

  it('follows t1.kugou short link via axios redirect to extract params', async () => {
    const finalUrl = 'http://wwwapi.kugou.com/share/zlist.html?'
      + 'chain=abcDEF&global_collection_id=collection_3_999_2_0&uid=999&listid=2';
    const axiosClient = makeAxiosClient(finalUrl);

    const info = await parseShareUrl('https://t1.kugou.com/abcDEF', { axiosClient });

    expect(info).toMatchObject({
      source: 'https://t1.kugou.com/abcDEF',
      resolvedUrl: finalUrl,
      globalCollectionId: 'collection_3_999_2_0',
      chain: 'abcDEF',
      uid: '999',
    });
  });

  it('preserves chain from short link path even when query lacks chain', async () => {
    const finalUrl = 'http://wwwapi.kugou.com/share/zlist.html?'
      + 'global_collection_id=collection_3_111_2_0&uid=111&listid=2';
    const axiosClient = makeAxiosClient(finalUrl);

    const info = await parseShareUrl('https://t1.kugou.com/shortcode-1', { axiosClient });

    expect(info.chain).toBe('shortcode-1');
    expect(info.globalCollectionId).toBe('collection_3_111_2_0');
  });

  it('rejects non-kugou domains immediately without HTTP call', async () => {
    let called = false;
    const axiosClient = {
      get: async () => { called = true; return {}; },
    };

    await expect(parseShareUrl('https://example.com/list/123', { axiosClient }))
      .rejects.toThrow(/不是酷狗域名/);
    expect(called).toBe(false);
  });

  it('throws a clear error when redirect target has no playlist params', async () => {
    const axiosClient = makeAxiosClient('http://wwwapi.kugou.com/song.html?hash=abc');

    await expect(parseShareUrl('https://t1.kugou.com/songcode', { axiosClient }))
      .rejects.toThrow(/global_collection_id|listid|不是歌单/);
  });

  it('rejects empty / non-string input', async () => {
    await expect(parseShareUrl('', {})).rejects.toThrow();
    await expect(parseShareUrl(null, {})).rejects.toThrow();
    await expect(parseShareUrl('not a url', {})).rejects.toThrow(/无效的 URL/);
  });
});
