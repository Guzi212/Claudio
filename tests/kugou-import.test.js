import { describe, expect, it } from 'vitest';
import {
  buildRawMarkdown,
  buildTasteSummary,
  parseKugouInput,
} from '../server/music/kugou-import.js';

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

  it('builds raw markdown with audit-friendly song rows', () => {
    const markdown = buildRawMarkdown([
      { title: '晴天', artist: '周杰伦', album: '叶惠美', bucket: 'long_term', likeLevel: 3, source: '我的喜欢' },
    ]);

    expect(markdown).toContain('| 长期喜欢 | 晴天 | 周杰伦 | 叶惠美 | 3 | 我的喜欢 |');
    expect(markdown).toContain('## 原始来源');
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
});
