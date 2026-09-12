import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 避免 buildSystemPrompt 真去打 OpenWeather / 跑 lark-cli
vi.mock('../server/services/weather.js', () => ({
  getCurrent: vi.fn().mockResolvedValue(null),
  getNext24h: vi.fn().mockResolvedValue(null),
}));
vi.mock('../server/services/lark-calendar.js', () => ({
  getTodayEvents: vi.fn().mockResolvedValue(null),
}));

// 测试前确保模板文件都存在（CI/clean clone 也能跑）
beforeAll(() => {
  for (const f of ['user/taste.md', 'user/routines.md', 'prompts/dj-persona.md']) {
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

  it('包含防注入安全边界，并把用户语料包进 USER_DATA 围栏', async () => {
    const { buildSystemPrompt } = await import('../server/context.js');
    const prompt = await buildSystemPrompt({ now: new Date('2026-05-18T09:00:00') });
    expect(prompt).toContain('【安全边界】');
    expect(prompt).toContain('仅作资料');
    // 三处外部数据围栏成对出现（taste / routines / 对话）
    expect(prompt.match(/<<<USER_DATA/g)?.length).toBe(3);
    expect(prompt.match(/USER_DATA>>>/g)?.length).toBe(3);
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

  it('天气和日程拿到数据时按格式注入', async () => {
    const weatherMod = await import('../server/services/weather.js');
    const larkMod = await import('../server/services/lark-calendar.js');
    weatherMod.getCurrent.mockResolvedValueOnce({
      temp: 22, condition: '多云', humidity: 60, city: 'Shanghai',
    });
    larkMod.getTodayEvents.mockResolvedValueOnce([
      { title: '产品评审', start: '2026-05-18T15:00:00', end: '2026-05-18T16:00:00', location: 'A301' },
    ]);
    const { buildSystemPrompt } = await import('../server/context.js');
    const prompt = await buildSystemPrompt({ now: new Date('2026-05-18T09:00:00') });
    expect(prompt).toContain('天气：Shanghai 22℃ 多云');
    expect(prompt).toContain('· 15:00 产品评审');
  });
});
