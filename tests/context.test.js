import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 测试前确保模板文件都存在（CI/clean clone 也能跑）
beforeAll(() => {
  for (const f of ['user/taste.md', 'user/routines.md', 'prompts/dj-persona.md']) {
    expect(fs.existsSync(path.join(ROOT, f))).toBe(true);
  }
});

describe('buildSystemPrompt', () => {
  it('包含 dj-persona + taste + routines + 环境 + 历史 五大块', async () => {
    const { buildSystemPrompt } = await import('../server/context.js');
    const prompt = buildSystemPrompt({ now: new Date('2026-05-18T09:00:00') });

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
    const prompt = buildSystemPrompt({ now: new Date('2026-05-18T03:30:00') });
    expect(prompt).toContain('深夜');
  });

  it('提醒块在最后', async () => {
    const { buildSystemPrompt } = await import('../server/context.js');
    const prompt = buildSystemPrompt();
    expect(prompt.trim().endsWith('请只输出符合 schema 的 JSON 对象，不要任何额外说明。')).toBe(true);
  });
});
