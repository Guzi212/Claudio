import { describe, it, expect } from 'vitest';
import { parseDjJson } from '../server/claude.js';

describe('parseDjJson', () => {
  it('干净的 JSON 直接解析', () => {
    const r = parseDjJson(JSON.stringify({
      say: '雨天慢一点',
      play: [{ title: '雨', artist: '老王乐队', hint: 'live' }],
      reason: 'taste',
      segue: '',
    }));
    expect(r.say).toBe('雨天慢一点');
    expect(r.play).toHaveLength(1);
    expect(r.play[0]).toMatchObject({ title: '雨', artist: '老王乐队', hint: 'live' });
    expect(r._parseFailed).toBeUndefined();
  });

  it('JSON 被包在解释里也能抠出来', () => {
    const wrapped = `好的，这是我的推荐：
\`\`\`json
{"say":"早安","play":[{"title":"Morning","artist":"Beck"}],"reason":"a","segue":""}
\`\`\`
希望你喜欢。`;
    const r = parseDjJson(wrapped);
    expect(r.say).toBe('早安');
    expect(r.play).toHaveLength(1);
    expect(r.play[0].artist).toBe('Beck');
  });

  it('完全不是 JSON → 兜底为 say + 空 play', () => {
    const r = parseDjJson('今天我累了，不想推荐了');
    expect(r._parseFailed).toBe(true);
    expect(r.say).toContain('累');
    expect(r.play).toEqual([]);
  });

  it('play 里缺 title 的项被过滤', () => {
    const r = parseDjJson(JSON.stringify({
      say: 's',
      play: [
        { title: '有效', artist: '某人' },
        { artist: '没标题', title: '' },
        { title: '又一首', artist: 'X' },
      ],
      reason: '', segue: '',
    }));
    expect(r.play).toHaveLength(2);
    expect(r.play.map(p => p.title)).toEqual(['有效', '又一首']);
  });

  it('字段类型容错 · 数字 → 字符串', () => {
    const r = parseDjJson(JSON.stringify({
      say: 'hi',
      play: [{ title: 123, artist: 456 }],
      reason: null,
      segue: undefined,
    }));
    expect(r.play[0].title).toBe('123');
    expect(r.play[0].artist).toBe('456');
    expect(r.reason).toBe('');
    expect(r.segue).toBe('');
  });
});
