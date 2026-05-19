import { describe, it, expect } from 'vitest';
import { parseLRC } from '../pwa/components/lyrics.js';

describe('parseLRC · LRC 解析器', () => {
  it('解析标准 [mm:ss.xx] 单行', () => {
    expect(parseLRC('[00:12.50]hello world')).toEqual([
      { time: 12.5, text: 'hello world' },
    ]);
  });

  it('一行多时间戳要展开成多条', () => {
    expect(parseLRC('[00:01.00][00:05.50]chorus')).toEqual([
      { time: 1, text: 'chorus' },
      { time: 5.5, text: 'chorus' },
    ]);
  });

  it('跳过元数据行 [ti:] [ar:] [al:] [by:] [offset:]', () => {
    const input = [
      '[ti:Song Title]',
      '[ar:Artist]',
      '[al:Album]',
      '[by:LRC Maker]',
      '[offset:+200]',
      '[00:10.00]lyric',
    ].join('\n');
    expect(parseLRC(input)).toEqual([{ time: 10, text: 'lyric' }]);
  });

  it('空字符串返回空数组', () => {
    expect(parseLRC('')).toEqual([]);
  });

  it('非字符串输入安全返回空数组', () => {
    expect(parseLRC(null)).toEqual([]);
    expect(parseLRC(undefined)).toEqual([]);
    expect(parseLRC(123)).toEqual([]);
  });

  it('非法格式行被跳过，合法行保留', () => {
    const r = parseLRC('not a lrc line\n[00:05.00]ok\nrandom\n[00:08.00]two');
    expect(r).toEqual([
      { time: 5, text: 'ok' },
      { time: 8, text: 'two' },
    ]);
  });

  it('结果按时间升序排序，即使输入乱序', () => {
    const r = parseLRC('[00:30.00]later\n[00:10.00]earlier\n[00:20.00]middle');
    expect(r.map(x => x.time)).toEqual([10, 20, 30]);
  });

  it('支持 [mm:ss] 无小数格式', () => {
    expect(parseLRC('[01:23]plain')).toEqual([{ time: 83, text: 'plain' }]);
  });

  it('歌词文本前后空格被 trim', () => {
    expect(parseLRC('[00:01.00]   spaced   ')).toEqual([
      { time: 1, text: 'spaced' },
    ]);
  });
});
