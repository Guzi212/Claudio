import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { dbApi } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const HISTORY_N = Number(process.env.CONTEXT_HISTORY_N) || 20;

function readSafe(relPath, fallback = '') {
  try {
    return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  } catch {
    return fallback;
  }
}

function formatNow(date = new Date()) {
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const HH = String(date.getHours()).padStart(2, '0');
  const MM = String(date.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${weekdays[date.getDay()]} ${HH}:${MM}`;
}

function bucketOfDay(hour) {
  if (hour < 6)  return '深夜';
  if (hour < 9)  return '清晨';
  if (hour < 12) return '上午';
  if (hour < 14) return '午间';
  if (hour < 18) return '下午';
  if (hour < 22) return '晚间';
  return '夜里';
}

/**
 * 把 6 片粘成一个 system prompt 字符串。
 * 顺序对应施工图第 3 层的 "运行时聚合 · 组装盒子"。
 */
export function buildSystemPrompt({ now = new Date() } = {}) {
  // ① 系统提示词
  const persona = readSafe('prompts/dj-persona.md').trim();

  // ② 用户语料
  const taste = readSafe('user/taste.md').trim();
  const routines = readSafe('user/routines.md').trim();

  // ③ 环境注入（MVP：只有时间）
  const env = [
    `当前时间：${formatNow(now)}（${bucketOfDay(now.getHours())}）`,
    `天气：(MVP 未接入)`,
    `日历：(MVP 未接入)`,
  ].join('\n');

  // ④ 已检索记忆：最近播放 + 最近对话
  const recentPlays = dbApi.recentPlays(10);
  const playsLines = recentPlays.length
    ? recentPlays.map(p => `  · ${p.title} — ${p.artist}`).join('\n')
    : '  (还没听过任何歌)';

  const recentMsgs = dbApi.recentMessages(HISTORY_N).filter(m => m.role !== 'system');
  const msgLines = recentMsgs.length
    ? recentMsgs.map(m => `  [${m.role}] ${m.content.slice(0, 200)}`).join('\n')
    : '  (无)';

  // ⑤ ⑥ 在调用方拼，这里只到第 4 片

  return [
    '=== ① 角色与硬约束 ===',
    persona,
    '',
    '=== ② 用户品味语料 (taste.md) ===',
    taste || '(用户还没填 taste.md)',
    '',
    '=== ② 用户日程语料 (routines.md) ===',
    routines || '(用户还没填 routines.md)',
    '',
    '=== ③ 环境 ===',
    env,
    '',
    '=== ④ 最近播放（按时间倒序）===',
    playsLines,
    '',
    '=== ④ 最近对话（按时间正序）===',
    msgLines,
    '',
    '=== 提醒 ===',
    '请只输出符合 schema 的 JSON 对象，不要任何额外说明。',
  ].join('\n');
}

export default { buildSystemPrompt };
