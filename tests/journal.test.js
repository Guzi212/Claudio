import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpDir, tmpJournal;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-journal-'));
  tmpJournal = path.join(tmpDir, 'journal.md');
  fs.writeFileSync(tmpJournal, `# 关系记忆\n\n<!-- journal:entries:start -->\n<!-- journal:entries:end -->\n`);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true });
});

describe('detectSignal', () => {
  it('深夜 23:00 返回深夜信号', async () => {
    const { detectSignal } = await import('../server/services/journal.js');
    const signal = detectSignal('来首歌', [], new Date('2026-05-26T23:15:00'));
    expect(signal).toMatch(/深夜/);
  });

  it('凌晨 02:00 返回深夜信号', async () => {
    const { detectSignal } = await import('../server/services/journal.js');
    const signal = detectSignal('', [], new Date('2026-05-26T02:30:00'));
    expect(signal).toMatch(/深夜/);
  });

  it('普通下午 15:00 返回 null', async () => {
    const { detectSignal } = await import('../server/services/journal.js');
    const signal = detectSignal('来首歌', [], new Date('2026-05-26T15:00:00'));
    expect(signal).toBeNull();
  });

  it('同一首歌出现 3 次触发循环信号', async () => {
    const { detectSignal } = await import('../server/services/journal.js');
    const plays = [
      { title: 'Serene Awakening', artist: '安涛' },
      { title: 'Serene Awakening', artist: '安涛' },
      { title: 'Serene Awakening', artist: '安涛' },
      { title: '晴天', artist: '周杰伦' },
    ];
    const signal = detectSignal('', plays, new Date('2026-05-26T15:00:00'));
    expect(signal).toMatch(/Serene Awakening/);
    expect(signal).toMatch(/循环/);
  });

  it('同一首歌只出现 2 次不触发', async () => {
    const { detectSignal } = await import('../server/services/journal.js');
    const plays = [
      { title: 'Serene Awakening', artist: '安涛' },
      { title: 'Serene Awakening', artist: '安涛' },
      { title: '晴天', artist: '周杰伦' },
    ];
    const signal = detectSignal('', plays, new Date('2026-05-26T15:00:00'));
    expect(signal).toBeNull();
  });

  it('重复歌曲不在 index 0 时也触发循环信号', async () => {
    const { detectSignal } = await import('../server/services/journal.js');
    const plays = [
      { title: '晴天', artist: '周杰伦' },       // index 0，只出现 1 次
      { title: 'Serene Awakening', artist: '安涛' }, // 出现 3 次
      { title: 'Serene Awakening', artist: '安涛' },
      { title: 'Serene Awakening', artist: '安涛' },
    ];
    const signal = detectSignal('', plays, new Date('2026-05-26T15:00:00'));
    expect(signal).not.toBeNull();
    expect(signal).toMatch(/Serene Awakening/);
    expect(signal).toMatch(/循环/);
  });

  it('情绪关键词"压力很大"触发信号', async () => {
    const { detectSignal } = await import('../server/services/journal.js');
    const signal = detectSignal('最近压力很大，来首舒缓的', [], new Date('2026-05-26T15:00:00'));
    expect(signal).not.toBeNull();
    expect(signal).toContain('压力很大');
  });

  it('生命事件关键词"答辩过了"触发信号', async () => {
    const { detectSignal } = await import('../server/services/journal.js');
    const signal = detectSignal('今天答辩过了，放首庆祝的歌', [], new Date('2026-05-26T15:00:00'));
    expect(signal).not.toBeNull();
    expect(signal).toContain('答辩过了');
  });
});

describe('appendJournalEntry', () => {
  it('追加一条日志到 entries 区域', async () => {
    const { appendJournalEntry } = await import('../server/services/journal.js');
    appendJournalEntry('深夜 23:15 在听歌', new Date('2026-05-26T23:15:00'), tmpJournal);

    const content = fs.readFileSync(tmpJournal, 'utf8');
    expect(content).toContain('2026-05-26 23:15');
    expect(content).toContain('深夜 23:15 在听歌');
  });

  it('新条目在 entries:start 之后（最新在前）', async () => {
    const { appendJournalEntry } = await import('../server/services/journal.js');
    appendJournalEntry('第一条', new Date('2026-05-26T23:00:00'), tmpJournal);
    appendJournalEntry('第二条', new Date('2026-05-26T23:30:00'), tmpJournal);

    const content = fs.readFileSync(tmpJournal, 'utf8');
    expect(content.indexOf('第二条')).toBeLessThan(content.indexOf('第一条'));
  });

  it('超过 30 条时修剪最旧的，保持不超过 30 条', async () => {
    const { appendJournalEntry } = await import('../server/services/journal.js');
    for (let i = 0; i < 32; i++) {
      appendJournalEntry(`第${i}条`, new Date('2026-05-26T23:00:00'), tmpJournal);
    }
    const content = fs.readFileSync(tmpJournal, 'utf8');
    const matches = [...content.matchAll(/^- /gm)];
    expect(matches.length).toBeLessThanOrEqual(30);
  });

  it('文件不存在时静默跳过（不抛出错误）', async () => {
    const { appendJournalEntry } = await import('../server/services/journal.js');
    expect(() => {
      appendJournalEntry('test', new Date(), '/nonexistent/path/journal.md');
    }).not.toThrow();
  });

  it('entries 区域标记不存在时静默跳过', async () => {
    const { appendJournalEntry } = await import('../server/services/journal.js');
    const noMarkerFile = path.join(tmpDir, 'no-marker.md');
    fs.writeFileSync(noMarkerFile, '# 无标记文件\n');
    expect(() => {
      appendJournalEntry('test', new Date(), noMarkerFile);
    }).not.toThrow();
    expect(fs.readFileSync(noMarkerFile, 'utf8')).toBe('# 无标记文件\n');
  });
});
