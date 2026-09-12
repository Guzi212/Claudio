import { describe, it, expect } from 'vitest';
import {
  poolKey,
  countInPool,
  sampleTracks,
  ensureMinimumFromPool,
} from '../server/services/candidate-pool.js';

const track = (title, artist) => ({ title, artist });

describe('candidate-pool · poolKey / countInPool', () => {
  it('归一化大小写与空格后判等', () => {
    expect(poolKey('Taylor Swift', 'Love Story')).toBe(poolKey('taylor swift', 'love   story'));
  });

  it('countInPool 只数池内的曲目', () => {
    const pool = [track('A', 'X'), track('B', 'Y')];
    const play = [track('A', 'X'), track('C', 'Z'), track('B', 'Y')];
    expect(countInPool(play, pool)).toBe(2);
  });

  it('空入参安全返回 0', () => {
    expect(countInPool([], [])).toBe(0);
    expect(countInPool(null, [track('A', 'X')])).toBe(0);
    expect(countInPool([track('A', 'X')], null)).toBe(0);
  });
});

describe('candidate-pool · sampleTracks', () => {
  it('数量不超过上限时原样返回', () => {
    const tracks = [track('A', 'X'), track('B', 'Y')];
    expect(sampleTracks(tracks, 5)).toBe(tracks);
  });

  it('超出上限时等距采样，数量精确', () => {
    const tracks = Array.from({ length: 100 }, (_, i) => track(`T${i}`, 'A'));
    const out = sampleTracks(tracks, 10);
    expect(out).toHaveLength(10);
    expect(out[0]).toBe(tracks[0]);
  });
});

describe('candidate-pool · ensureMinimumFromPool', () => {
  const pool = [track('P1', 'X'), track('P2', 'X'), track('P3', 'X'), track('P4', 'X')];

  it('池为空 → 仅按 max 截断，不注入', () => {
    const play = [track('A', 'X'), track('B', 'X')];
    expect(ensureMinimumFromPool(play, [], { min: 3 })).toEqual(play);
  });

  it('已达标 → 原样返回', () => {
    const play = [track('P1', 'X'), track('P2', 'X'), track('P3', 'X'), track('C', 'Z')];
    expect(ensureMinimumFromPool(play, pool, { min: 3 })).toEqual(play);
  });

  it('未达标 → 从尾部替换非池条目，且不改变长度', () => {
    const play = [track('P1', 'X'), track('C', 'Z'), track('D', 'W'), track('E', 'V'), track('F', 'U')];
    const out = ensureMinimumFromPool(play, pool, { min: 3 });
    expect(out).toHaveLength(play.length);
    expect(countInPool(out, pool)).toBeGreaterThanOrEqual(3);
    // 已有的池内曲目保留原位
    expect(out[0]).toEqual(track('P1', 'X'));
  });

  it('play 短于 min → 视为用户明确点歌，原样返回', () => {
    const play = [track('A', 'X'), track('B', 'X')];
    expect(ensureMinimumFromPool(play, pool, { min: 3 })).toEqual(play);
  });

  it('不重复注入已在列表中的池曲目', () => {
    const play = [track('P1', 'X'), track('B', 'X'), track('C', 'X'), track('D', 'X'), track('E', 'X')];
    const out = ensureMinimumFromPool(play, pool, { min: 3 });
    const titles = out.map(t => t.title);
    expect(new Set(titles).size).toBe(titles.length);
  });
});
