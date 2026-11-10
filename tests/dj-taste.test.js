import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeTasteStats,
  formatStatsForPrompt,
  updateLearnedTaste,
  readTasteInputs,
  renderLearnedTaste,
  trackKey,
} from '../server/dj/taste-memory.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-09T21:00:00+08:00');

function play(title, artist, daysAgo = 0, hour = 21) {
  const d = new Date(NOW - daysAgo * DAY);
  d.setHours(hour, 0, 0, 0);
  return { title, artist, ts: d.getTime(), reason: '', source: 'bot' };
}

describe('taste · computeTasteStats', () => {
  const plays = [
    play('晴天', '周杰伦', 0, 21),
    play('七里香', '周杰伦', 0, 22),
    play('晴天', '周杰伦', 1, 21),
    play('Weightless', 'Marconi Union', 2, 10),
    play('晴れ', '坂本龍一', 40, 10), // 窗口外
  ];
  const feedback = [
    { kind: 'skip', title: '七里香', artist: '周杰伦', ts: NOW - DAY },
    { kind: 'like', title: '晴天', artist: '周杰伦', ts: NOW - DAY },
    { kind: 'unlike', title: 'Weightless', artist: 'Marconi Union', ts: NOW - DAY },
  ];

  it('只统计窗口内的播放', () => {
    const stats = computeTasteStats({ plays, feedback, now: NOW, days: 30 });
    expect(stats.totalPlays).toBe(4);
    expect(stats.activeDays).toBe(3);
  });

  it('歌手按次数排序，跳过率按曲目对得上才算', () => {
    const stats = computeTasteStats({ plays, feedback, now: NOW, days: 30 });
    expect(stats.topArtists[0].artist).toBe('周杰伦');
    expect(stats.topArtists[0].plays).toBe(3);
    expect(stats.topArtists[0].skips).toBe(1);
    expect(stats.topArtists[0].skipRate).toBeCloseTo(0.33, 2);
  });

  it('单曲统计带跳过和喜欢', () => {
    const stats = computeTasteStats({ plays, feedback, now: NOW, days: 30 });
    const qingtian = stats.topTracks.find(t => t.title === '晴天');
    expect(qingtian.plays).toBe(2);
    expect(qingtian.likes).toBe(1);
  });

  it('时段分桶', () => {
    const stats = computeTasteStats({ plays, feedback, now: NOW, days: 30 });
    const night = stats.byHour.find(b => b.bucket.startsWith('夜里'));
    const evening = stats.byHour.find(b => b.bucket.startsWith('晚间'));
    const morning = stats.byHour.find(b => b.bucket.startsWith('上午'));
    expect(night.plays).toBe(1);
    expect(evening.plays).toBe(2);
    expect(morning.plays).toBe(1);
    expect(night.topArtist).toBe('周杰' + '伦');
  });

  it('喜欢 / 不喜欢 / 跳过分开列', () => {
    const stats = computeTasteStats({ plays, feedback, now: NOW, days: 30 });
    expect(stats.liked.map(x => x.title)).toEqual(['晴天']);
    expect(stats.unliked.map(x => x.title)).toEqual(['Weightless']);
    expect(stats.skipped.map(x => x.title)).toEqual(['七里香']);
  });

  it('没有数据也不炸', () => {
    const stats = computeTasteStats({ plays: [], feedback: [], now: NOW });
    expect(stats.totalPlays).toBe(0);
    expect(stats.topArtists).toEqual([]);
    expect(formatStatsForPrompt(stats)).toContain('共 0 次播放');
  });

  it('歌名是文件名的杂项不进统计', () => {
    const stats = computeTasteStats({
      plays: [play('说散就散.mp3', '袁娅维', 0, 21), play('晴天', '周杰' + '伦', 0, 21)],
      feedback: [{ kind: 'skip', title: '一万次悲伤.mp3', artist: '逃跑计划', ts: NOW }],
      now: NOW,
    });
    expect(stats.totalPlays).toBe(1);
    expect(stats.topArtists.map(a => a.artist)).toEqual(['周杰' + '伦']);
    expect(stats.skipped).toEqual([]);
  });
});

describe('taste · formatStatsForPrompt', () => {
  it('把歌手、时段、跳过都写进去', () => {
    const stats = computeTasteStats({
      plays: [play('晴天', '周杰伦', 0, 21), play('七里香', '周杰伦', 1, 22)],
      feedback: [{ kind: 'skip', title: '七里香', artist: '周杰伦', ts: NOW }],
      now: NOW,
    });
    const text = formatStatsForPrompt(stats);
    expect(text).toContain('周杰伦：2 次');
    expect(text).toContain('跳过率 50%');
    expect(text).toContain('夜里 22-24');
    expect(text).toContain('被跳过：七里香');
  });
});

describe('taste · trackKey', () => {
  it('繁简 / 空格 / 大小写不同的同一首歌 key 相同', () => {
    expect(trackKey('晴天', '周杰伦')).toBe(trackKey('晴天 ', '周杰伦'));
    expect(trackKey('Hello', 'Adele')).toBe(trackKey('hello', 'adele'));
  });
});

describe('taste · readTasteInputs', () => {
  it('没有 raw 时退回 recentPlays / recentFeedback', () => {
    const db = {
      recentPlays: vi.fn(() => [{ title: 'a', artist: 'A', ts: NOW }]),
      recentFeedback: vi.fn(() => [{ kind: 'like', title: 'a', artist: 'A', ts: NOW }]),
    };
    const out = readTasteInputs(db, { now: NOW });
    expect(out.plays).toHaveLength(1);
    expect(out.feedback).toHaveLength(1);
  });
});

describe('taste · updateLearnedTaste', () => {
  function tmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-taste-'));
  }

  function dbWith(plays, feedback = []) {
    return {
      recentPlays: n => plays.slice(0, n),
      recentFeedback: n => feedback.slice(0, n),
      getPref: () => null,
      setPref: () => {},
    };
  }

  it('数据够就写 user/taste.learned.md', async () => {
    const root = tmpRoot();
    const complete = vi.fn(async () => '## 常驻\n周杰伦，3 次。\n\n## 一句话画像\n夜里听周杰伦的人。');
    const result = await updateLearnedTaste({
      db: dbWith([play('晴天', '周杰伦'), play('七里香', '周杰伦'), play('a', 'B'), play('b', 'C'), play('c', 'D')]),
      complete,
      rootDir: root,
      now: NOW,
    });

    expect(result.ok).toBe(true);
    const text = fs.readFileSync(path.join(root, 'user', 'taste.learned.md'), 'utf8');
    expect(text).toContain('自动生成');
    expect(text).toContain('周杰伦，3 次');
    expect(text).toContain('近 30 天 5 次播放');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('播放太少不写文件', async () => {
    const root = tmpRoot();
    const result = await updateLearnedTaste({
      db: dbWith([play('晴天', '周杰伦')]),
      complete: vi.fn(),
      rootDir: root,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not-enough-data');
    expect(fs.existsSync(path.join(root, 'user', 'taste.learned.md'))).toBe(false);
  });

  it('模型返回空就不覆盖旧文件', async () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'user'), { recursive: true });
    const target = path.join(root, 'user', 'taste.learned.md');
    fs.writeFileSync(target, '旧内容', 'utf8');

    const result = await updateLearnedTaste({
      db: dbWith([play('a', 'A'), play('b', 'B'), play('c', 'C'), play('d', 'D'), play('e', 'E')]),
      complete: async () => '   ',
      rootDir: root,
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty-output');
    expect(fs.readFileSync(target, 'utf8')).toBe('旧内容');
  });
});

describe('taste · renderLearnedTaste', () => {
  it('头部写明生成时间和样本量', () => {
    const text = renderLearnedTaste({
      markdown: '## 常驻\n无',
      stats: { windowDays: 30, totalPlays: 12, activeDays: 4 },
      now: NOW,
    });
    expect(text).toContain('样本：近 30 天 12 次播放、4 天有记录');
    expect(text).toContain('## 常驻');
  });
});
