import { describe, expect, it } from 'vitest';
import {
  buildRawMarkdown,
  buildTasteSummary,
  importFromShareUrl,
  parseKugouInput,
} from '../server/music/kugou-import.js';
import { parseNameField } from '../server/services/kugou.js';

describe('music/kugou-import', () => {
  it('parses tracks from OCR-like text and keeps source buckets', () => {
    const tracks = parseKugouInput(`
      # 红心 3
      晴天 - 周杰伦
      夜曲 周杰伦 《十一月的萧邦》

      # 最近循环
      Sweet Soul Revue - Pizzicato Five

      # 雷区
      土嗨电音 - 某某DJ
    `);

    expect(tracks).toEqual([
      expect.objectContaining({ title: '晴天', artist: '周杰伦', bucket: 'long_term', likeLevel: 3 }),
      expect.objectContaining({ title: '夜曲', artist: '周杰伦', album: '十一月的萧邦', bucket: 'long_term' }),
      expect.objectContaining({ title: 'Sweet Soul Revue', artist: 'Pizzicato Five', bucket: 'recent_mood' }),
      expect.objectContaining({ title: '土嗨电音', artist: '某某DJ', bucket: 'avoid' }),
    ]);
  });

  it('preserves Kugou share links as source notes without pretending to parse them', () => {
    const tracks = parseKugouInput(`
      https://www.kugou.com/playlist/example
      蜉蝣 - 落日飞车
    `);

    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      title: '蜉蝣',
      artist: '落日飞车',
      source: 'https://www.kugou.com/playlist/example',
    });
  });

  it('does not treat years in headings as like levels', () => {
    const tracks = parseKugouInput(`
      # 年度报告 / 2023 年度歌曲
      我期待的不是雪 (是有你的春夏秋冬) - 吞吞纯音社
    `);

    expect(tracks[0]).toMatchObject({
      title: '我期待的不是雪 (是有你的春夏秋冬)',
      artist: '吞吞纯音社',
      likeLevel: null,
    });
  });

  it('builds raw markdown with audit-friendly song rows', () => {
    const markdown = buildRawMarkdown([
      { title: '晴天', artist: '周杰伦', album: '叶惠美', bucket: 'long_term', likeLevel: 3, source: '我的喜欢' },
    ]);

    expect(markdown).toContain('| 长期喜欢 | 晴天 | 周杰伦 | 叶惠美 | 3 | 我的喜欢 |');
    expect(markdown).toContain('## 原始来源');
  });

  it('flips KuGouMusicApi "Artist - Title" into the parser-canonical {title, artist}', () => {
    expect(parseNameField('Marconi Union - Weightless (失重)')).toEqual({
      artist: 'Marconi Union',
      title: 'Weightless (失重)',
    });
    expect(parseNameField('周杰伦 - 晴天')).toEqual({ artist: '周杰伦', title: '晴天' });
    // 多个 ' - ' 时只切第一处，剩下保留在 title 里
    expect(parseNameField('Foo - Bar - Baz')).toEqual({ artist: 'Foo', title: 'Bar - Baz' });
    // 无分隔符
    expect(parseNameField('SoloTitle')).toEqual({ artist: '', title: 'SoloTitle' });
    expect(parseNameField('')).toEqual({ artist: '', title: '' });
  });

  it('importFromShareUrl turns API songs into tracks the distiller can consume', async () => {
    const fakeShareUrl = 'https://t1.kugou.com/fakecode';
    const parseShareUrl = async () => ({
      source: fakeShareUrl,
      resolvedUrl: 'http://wwwapi.kugou.com/share/zlist.html?global_collection_id=collection_X&chain=fakecode',
      chain: 'fakecode',
      globalCollectionId: 'collection_X',
      uid: '111',
      listid: '2',
    });
    const fetchSharedPlaylist = async () => ({
      tracks: [
        { title: 'Weightless (失重)', artist: 'Marconi Union', album: '', hash: 'h1' },
        { title: '晴天', artist: '周杰伦', album: '叶惠美', hash: 'h2' },
      ],
      totalCount: 2,
      fetchedCount: 2,
      truncated: false,
    });

    const result = await importFromShareUrl(
      fakeShareUrl,
      { bucket: 'long_term', likeLevel: 3, playlistName: '长期红心' },
      { parseShareUrl, fetchSharedPlaylist },
    );

    expect(result.fetchedCount).toBe(2);
    expect(result.playlistName).toBe('长期红心');
    expect(result.tracks).toEqual([
      expect.objectContaining({ title: 'Weightless (失重)', artist: 'Marconi Union', bucket: 'long_term', likeLevel: 3, source: fakeShareUrl }),
      expect.objectContaining({ title: '晴天', artist: '周杰伦', album: '叶惠美', bucket: 'long_term', likeLevel: 3 }),
    ]);

    // 蒸馏链路与现有 parser 输出零差异
    const summary = buildTasteSummary(result.tracks);
    expect(summary).toContain('Marconi Union');
    expect(summary).toContain('周杰伦');
  });

  it('importFromShareUrl falls back to chain-based playlistName when --name not given', async () => {
    const parseShareUrl = async () => ({
      source: 'x', resolvedUrl: 'x', chain: 'abc', globalCollectionId: 'collection_Y', uid: '', listid: '',
    });
    const fetchSharedPlaylist = async () => ({ tracks: [], totalCount: 0, fetchedCount: 0, truncated: false });

    const result = await importFromShareUrl('x', {}, { parseShareUrl, fetchSharedPlaylist });
    expect(result.playlistName).toBe('kugou_share_abc');
  });

  it('distills repeated artists and buckets into taste.md-ready summary', () => {
    const summary = buildTasteSummary([
      { title: '晴天', artist: '周杰伦', bucket: 'long_term', likeLevel: 3 },
      { title: '夜曲', artist: '周杰伦', bucket: 'long_term', likeLevel: 2 },
      { title: '蜉蝣', artist: '落日飞车', bucket: 'recent_mood' },
      { title: '土嗨电音', artist: '某某DJ', bucket: 'avoid' },
    ]);

    expect(summary).toContain('周杰伦');
    expect(summary).toContain('最近在循环');
    expect(summary).toContain('不要主动推荐');
    expect(summary).toContain('同一个艺人不要连续 3 首以上');
  });

  it('summary includes language / decade / bpm distribution when metadata present', () => {
    const summary = buildTasteSummary([
      { title: 'A', artist: 'X', bucket: 'long_term', language: '华语', publishDate: '2010-05-01', bpm: 70 },
      { title: 'B', artist: 'X', bucket: 'long_term', language: '华语', publishDate: '2012-01-01', bpm: 75 },
      { title: 'C', artist: 'Y', bucket: 'long_term', language: '英语', publishDate: '2018-06-01', bpm: 120 },
      { title: 'D', artist: 'Z', bucket: 'long_term', language: '纯音乐', publishDate: '2014-09-22', bpm: 60 },
    ]);

    expect(summary).toContain('### 听音指纹');
    expect(summary).toContain('华语');
    expect(summary).toContain('10s');
    expect(summary).toContain('抒情慢');
    expect(summary).toContain('### 核心歌手');
    expect(summary).toContain('### 代表曲目');
  });

  it('TL;DR surfaces minority language as a distinct preference hook', () => {
    // 90% 华语 + 5% 纯音乐（应该被识别为"独立偏好"）
    const tracks = [];
    for (let i = 0; i < 18; i += 1) {
      tracks.push({ title: `c${i}`, artist: `华语歌手${i % 3}`, bucket: 'long_term', language: '华语' });
    }
    tracks.push({ title: 'Weightless', artist: 'Marconi Union', bucket: 'long_term', language: '纯音乐' });
    tracks.push({ title: 'River Flows', artist: 'Yiruma', bucket: 'long_term', language: '纯音乐' });

    const summary = buildTasteSummary(tracks);
    expect(summary).toMatch(/纯音乐/);
    expect(summary).toMatch(/TL;DR|你是什么样的听众/);
  });

  it('long-tail section highlights 1-2 occurrence non-Chinese artists', () => {
    const tracks = [];
    // 主力华语
    for (let i = 0; i < 20; i += 1) {
      tracks.push({ title: `t${i}`, artist: '周杰伦', bucket: 'long_term', language: '华语' });
    }
    // 长尾 - 纯音乐小众
    tracks.push({ title: 'Weightless', artist: 'Marconi Union', bucket: 'long_term', language: '纯音乐' });
    tracks.push({ title: 'River Flows', artist: 'Yiruma', bucket: 'long_term', language: '纯音乐' });
    // 长尾 - 英语小众
    tracks.push({ title: 'Someone You Loved', artist: 'Lewis Capaldi', bucket: 'long_term', language: '英语' });

    const summary = buildTasteSummary(tracks);
    expect(summary).toContain('### 长尾标签');
    expect(summary).toContain('Marconi Union');
    expect(summary).toContain('Yiruma');
    expect(summary).toContain('Lewis Capaldi');
  });

  it('importFromShareUrl preserves API metadata so the distiller has signals', async () => {
    const parseShareUrl = async () => ({
      source: 'x', resolvedUrl: 'x', chain: 'c', globalCollectionId: 'g', uid: '', listid: '',
    });
    const fetchSharedPlaylist = async () => ({
      tracks: [
        {
          title: 'Weightless (失重)', artist: 'Marconi Union', album: '',
          hash: 'h1', publishDate: '2014-09-22', language: '纯音乐', bpm: 60,
        },
      ],
      totalCount: 1, fetchedCount: 1, truncated: false,
    });

    const result = await importFromShareUrl('x', {}, { parseShareUrl, fetchSharedPlaylist });
    expect(result.tracks[0]).toMatchObject({
      language: '纯音乐',
      publishDate: '2014-09-22',
      bpm: 60,
      hash: 'h1',
    });
  });
});
