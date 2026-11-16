import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 避免 buildSystemPrompt 真去打 OpenWeather / Google Calendar
vi.mock('../server/services/weather.js', () => ({
  getCurrent: vi.fn().mockResolvedValue(null),
  getNext24h: vi.fn().mockResolvedValue(null),
}));
vi.mock('../server/services/google-calendar.js', () => ({
  getTodayEvents: vi.fn().mockResolvedValue(null),
  _resetCache: vi.fn(),
}));
vi.mock('../server/services/lark-calendar.js', () => ({
  getTodayEvents: vi.fn().mockResolvedValue(null),
  _resetCache: vi.fn(),
}));

// 测试前确保模板文件都存在（CI/clean clone 也能跑）
beforeAll(() => {
  for (const f of ['user/taste.md', 'user/routines.md', 'prompts/dj-persona.md']) {
    expect(fs.existsSync(path.join(ROOT, f))).toBe(true);
  }
  for (const f of ['claudio/identity.md', 'claudio/journal.md']) {
    expect(fs.existsSync(path.join(ROOT, f))).toBe(true);
  }
});

describe('buildSystemPrompt', () => {
  it('包含 dj-persona + taste + routines + 环境 + 历史 五大块', async () => {
    const { buildSystemPrompt } = await import('../server/context.js');
    const prompt = await buildSystemPrompt({ now: new Date('2026-05-18T09:00:00') });

    expect(prompt).toContain('① 角色与硬约束');
    expect(prompt).toContain('② 用户品味语料');
    expect(prompt).toContain('② 用户日程语料');
    expect(prompt).toContain('③ 环境');
    expect(prompt).toContain('④ 最近播放');
    expect(prompt).toContain('④ 最近对话');

    expect(prompt).toContain('Claudio'); // dj-persona 的人格名
    expect(prompt).toMatch(/2026-05-18 周一/);
    expect(prompt).toMatch(/上午|清晨/);
  });

  it('凌晨时段标识为 深夜', async () => {
    const { buildSystemPrompt } = await import('../server/context.js');
    const prompt = await buildSystemPrompt({ now: new Date('2026-05-18T03:30:00') });
    expect(prompt).toContain('深夜');
  });

  it('提醒块在最后', async () => {
    const { buildSystemPrompt } = await import('../server/context.js');
    const prompt = await buildSystemPrompt();
    expect(prompt.trim().endsWith('请只输出符合 schema 的 JSON 对象，不要任何额外说明。')).toBe(true);
  });

  it('未接入天气/日历时显示占位文案', async () => {
    const { buildSystemPrompt } = await import('../server/context.js');
    const prompt = await buildSystemPrompt({ now: new Date('2026-05-18T09:00:00') });
    expect(prompt).toContain('天气：(未接入或失败)');
    expect(prompt).toContain('今日日程：(无安排或未接入)');
  });

  it('天气和日程拿到数据时按格式注入（遵循 calendar_provider）', async () => {
    const { dbApi } = await import('../server/db.js');
    const weatherMod = await import('../server/services/weather.js');
    const calendarMod = await import('../server/services/google-calendar.js');
    const larkMod = await import('../server/services/lark-calendar.js');

    weatherMod.getCurrent.mockResolvedValueOnce({
      temp: 22, condition: '多云', humidity: 60, city: 'Shanghai',
    });
    calendarMod.getTodayEvents.mockResolvedValueOnce([
      { title: '产品评审', start: '2026-05-18T15:00:00', end: '2026-05-18T16:00:00', location: 'A301' },
    ]);

    dbApi.setPref('calendar_provider', 'google');
    try {
      const { buildSystemPrompt } = await import('../server/context.js');
      const prompt = await buildSystemPrompt({ now: new Date('2026-05-18T09:00:00') });
      expect(prompt).toContain('天气：Shanghai 22℃ 多云');
      expect(prompt).toContain('· 15:00 产品评审');

      // 切回 none 时不读取日历
      calendarMod.getTodayEvents.mockClear();
      dbApi.setPref('calendar_provider', 'none');
      const promptNone = await buildSystemPrompt({ now: new Date('2026-05-18T09:00:00') });
      expect(calendarMod.getTodayEvents).not.toHaveBeenCalled();
      expect(promptNone).toContain('今日日程：(无安排或未接入)');

      // 切到 lark 时调用飞书日历
      larkMod.getTodayEvents.mockResolvedValueOnce([
        { title: '设计站会', start: '2026-05-18T10:30:00' },
      ]);
      dbApi.setPref('calendar_provider', 'lark');
      const promptLark = await buildSystemPrompt({ now: new Date('2026-05-18T09:00:00') });
      expect(promptLark).toContain('· 10:30 设计站会');
    } finally {
      dbApi.delPref('calendar_provider');
    }
  });

  it('包含 Claudio 自我认知和关系记忆两个新 section', async () => {
    const { buildSystemPrompt } = await import('../server/context.js');
    const prompt = await buildSystemPrompt({ now: new Date('2026-05-26T20:00:00') });

    expect(prompt).toContain('① Claudio 的自我认知');
    expect(prompt).toContain('① Claudio 的关系记忆');
    expect(prompt).toContain('我叫 Claudio'); // identity.md 内容片段
  });

  it('注入常驻主持人学到的品味（taste.learned.md）', async () => {
    const { buildSystemPrompt } = await import('../server/context.js');
    const prompt = await buildSystemPrompt({ now: new Date('2026-05-26T20:00:00') });

    expect(prompt).toContain('自动学到的品味');
    // 文件不存在时也要有占位，不能让整段消失
    expect(prompt).toMatch(/自动学到的品味[\s\S]{0,200}(近 30 天|还没有足够播放数据)/);
  });

  it('传入活跃场景时在环境区注入当前场景', async () => {
    const { buildSystemPrompt } = await import('../server/context.js');
    const prompt = await buildSystemPrompt({
      now: new Date('2026-11-16T15:00:00'),
      runtime: { scene: { id: 'library', updatedAt: '2026-11-16T06:50:00.000Z' } },
    });
    expect(prompt).toContain('当前场景：图书馆专注');
  });

  it('writeSessionNote / readSessionNote / clearSessionNote 读写与清理生效', async () => {
    const os = await import('node:os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-note-'));
    const { writeSessionNote, readSessionNote, clearSessionNote } = await import('../server/context.js');
    const t = Date.parse('2026-11-16T12:00:00Z');
    writeSessionNote({ rootDir: tmp, text: '只要纯音乐', now: t });
    expect(readSessionNote({ rootDir: tmp, now: t + 60_000 })).toEqual({ text: '只要纯音乐', ageMinutes: 1 });
    expect(readSessionNote({ rootDir: tmp, now: t + 7 * 3_600_000 })).toBeNull();
    expect(clearSessionNote({ rootDir: tmp })).toBe(true);
    expect(readSessionNote({ rootDir: tmp, now: t + 60_000 })).toBeNull();
  });
});
