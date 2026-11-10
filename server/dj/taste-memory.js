// 品味记忆：把播放记录和反馈压成一份可读的画像，再让模型写成 taste.learned.md。
//
// 两层：
//   1) computeTasteStats —— 纯统计，不花 token。次数、跳过率、时段分布。
//   2) distillTaste     —— 让模型把统计读成人话，写进 user/taste.learned.md。
//
// taste.md 是用户手写的，优先级最高；taste.learned.md 是机器总结，只做补充。
import fs from 'node:fs';
import path from 'node:path';
import { normalizeForMatch } from '../services/kugou.js';

export const LEARNED_TASTE_FILE = 'user/taste.learned.md';
export const TASTE_STATE_KEY = 'dj_taste_state';

const DAY_MS = 86_400_000;

export function trackKey(title, artist) {
  return `${normalizeForMatch(title)}|${normalizeForMatch(artist)}`;
}

// 用户上传的杂项条目歌名就是文件名（`说散就散.mp3`），统计时剔掉，免得污染画像。
const AUDIO_FILE_EXT = /\.(mp3|flac|wav|m4a|ape|ogg|aac|wma)$/i;

export function isJunkTitle(title) {
  return AUDIO_FILE_EXT.test(String(title || '').trim());
}

function hourBucket(hour) {
  if (hour < 6) return '深夜 0-6';
  if (hour < 9) return '清晨 6-9';
  if (hour < 12) return '上午 9-12';
  if (hour < 14) return '午间 12-14';
  if (hour < 18) return '下午 14-18';
  if (hour < 22) return '晚间 18-22';
  return '夜里 22-24';
}

/**
 * 纯函数：从播放和反馈记录算画像。
 * @param {object} input
 * @param {Array<{title,artist,ts,reason?,source?}>} input.plays 按时间倒序
 * @param {Array<{kind,title,artist,ts}>} input.feedback
 * @param {number} [input.now]
 * @param {number} [input.days] 统计窗口
 */
export function computeTasteStats({ plays = [], feedback = [], now = Date.now(), days = 30 } = {}) {
  const since = now - days * DAY_MS;
  const inWindow = plays.filter(p => Number(p?.ts) >= since && !isJunkTitle(p?.title));
  const fbInWindow = feedback.filter(f => Number(f?.ts) >= since && !isJunkTitle(f?.title));

  const artists = new Map();
  const tracks = new Map();
  const buckets = new Map();
  const daysSeen = new Set();

  for (const p of inWindow) {
    const artist = String(p.artist || '').trim();
    const title = String(p.title || '').trim();
    if (!title) continue;
    const ts = Number(p.ts);
    daysSeen.add(new Date(ts).toISOString().slice(0, 10));

    if (artist) {
      const a = artists.get(artist) || { artist, plays: 0, skips: 0, likes: 0 };
      a.plays += 1;
      artists.set(artist, a);
    }
    const tk = trackKey(title, artist);
    const t = tracks.get(tk) || { title, artist, plays: 0, skips: 0, likes: 0 };
    t.plays += 1;
    tracks.set(tk, t);

    const bucket = hourBucket(new Date(ts).getHours());
    const b = buckets.get(bucket) || { bucket, plays: 0, artists: new Map() };
    b.plays += 1;
    if (artist) b.artists.set(artist, (b.artists.get(artist) || 0) + 1);
    buckets.set(bucket, b);
  }

  const skips = [];
  const likes = [];
  const unlikes = [];
  for (const f of fbInWindow) {
    const kind = String(f.kind || '');
    const title = String(f.title || '').trim();
    const artist = String(f.artist || '').trim();
    if (kind === 'skip') skips.push({ title, artist, ts: f.ts });
    else if (kind === 'like') likes.push({ title, artist, ts: f.ts });
    else if (kind === 'unlike') unlikes.push({ title, artist, ts: f.ts });
  }

  // 跳过按歌名+歌手匹配；只有曲目对得上才算到歌手头上。
  for (const s of skips) {
    const tk = trackKey(s.title, s.artist);
    const t = tracks.get(tk);
    if (t) t.skips += 1;
    if (s.artist) {
      const a = artists.get(s.artist);
      if (a) a.skips += 1;
    }
  }
  for (const l of likes) {
    const tk = trackKey(l.title, l.artist);
    const t = tracks.get(tk);
    if (t) t.likes += 1;
    if (l.artist) {
      const a = artists.get(l.artist);
      if (a) a.likes += 1;
    }
  }

  const topArtists = [...artists.values()]
    .map(a => ({ ...a, skipRate: a.plays ? Number((a.skips / a.plays).toFixed(2)) : 0 }))
    .sort((a, b) => b.plays - a.plays || a.artist.localeCompare(b.artist))
    .slice(0, 15);

  const topTracks = [...tracks.values()]
    .sort((a, b) => b.plays - a.plays || a.title.localeCompare(b.title))
    .slice(0, 15);

  const byHour = [...buckets.values()]
    .map(b => {
      const top = [...b.artists.entries()].sort((x, y) => y[1] - x[1])[0];
      return { bucket: b.bucket, plays: b.plays, topArtist: top ? top[0] : '' };
    })
    .sort((a, b) => a.bucket.localeCompare(b.bucket));

  return {
    windowDays: days,
    totalPlays: inWindow.length,
    activeDays: daysSeen.size,
    topArtists,
    topTracks,
    byHour,
    liked: likes.slice(0, 20),
    unliked: unlikes.slice(0, 20),
    skipped: skips.slice(0, 20),
    recent: inWindow.slice(0, 20).map(p => ({ title: p.title, artist: p.artist, ts: p.ts })),
  };
}

/** 把统计压成给模型看的纯文本，控制长度。 */
export function formatStatsForPrompt(stats) {
  const lines = [];
  lines.push(`统计窗口：近 ${stats.windowDays} 天，共 ${stats.totalPlays} 次播放，覆盖 ${stats.activeDays} 天。`);
  if (stats.topArtists.length) {
    lines.push('');
    lines.push('歌手（次数 / 跳过率）：');
    for (const a of stats.topArtists) {
      lines.push(`  · ${a.artist}：${a.plays} 次，跳过率 ${Math.round(a.skipRate * 100)}%${a.likes ? `，红心 ${a.likes}` : ''}`);
    }
  }
  if (stats.topTracks.length) {
    lines.push('');
    lines.push('单曲（次数）：');
    for (const t of stats.topTracks) {
      lines.push(`  · ${t.title} — ${t.artist}：${t.plays} 次${t.skips ? `，跳过 ${t.skips}` : ''}`);
    }
  }
  if (stats.byHour.length) {
    lines.push('');
    lines.push('时段分布：');
    for (const b of stats.byHour) {
      lines.push(`  · ${b.bucket}：${b.plays} 次${b.topArtist ? `，最常听 ${b.topArtist}` : ''}`);
    }
  }
  if (stats.skipped.length) {
    lines.push('');
    lines.push(`被跳过：${stats.skipped.map(s => `${s.title}${s.artist ? ` — ${s.artist}` : ''}`).join('、')}`);
  }
  if (stats.liked.length) {
    lines.push(`点过喜欢：${stats.liked.map(s => `${s.title}${s.artist ? ` — ${s.artist}` : ''}`).join('、')}`);
  }
  if (stats.unliked.length) {
    lines.push(`点过不喜欢：${stats.unliked.map(s => `${s.title}${s.artist ? ` — ${s.artist}` : ''}`).join('、')}`);
  }
  if (stats.recent.length) {
    lines.push('');
    lines.push('最近播放（倒序）：');
    for (const p of stats.recent) lines.push(`  · ${p.title} — ${p.artist}`);
  }
  return lines.join('\n');
}

export const DISTILL_SYSTEM_PROMPT = `你是 Claudio 的私人电台主持人，正在整理一位听众的听歌档案，供以后选歌参考。
只输出 Markdown 正文，不要开场白、不要代码块包裹、不要编造数据里没有的歌手或歌。
结构固定为五个小标题：
## 常驻
## 在升温 / 在退潮
## 雷区
## 时段规律
## 一句话画像
每条结论都要带上数据（次数、比例），总长度 400 字以内。`;

/**
 * 让模型把统计写成 markdown。失败时抛错，由调用方决定是否保留旧文件。
 */
export async function distillTaste({ stats, complete, existingTaste = '' }) {
  const userMessage = [
    '下面是这位听众近期的播放统计：',
    '',
    formatStatsForPrompt(stats),
    '',
    existingTaste
      ? `他自己手写的品味档案（优先级更高，不要和它冲突，只做补充）：\n${existingTaste.slice(0, 2000)}`
      : '',
  ].filter(Boolean).join('\n');

  const text = await complete(DISTILL_SYSTEM_PROMPT, userMessage, { timeoutMs: 180_000 });
  return String(text || '').trim();
}

/**
 * 读库里的原始记录。优先直接查 SQL（能拿全窗口），查不了就退回 recentPlays。
 */
export function readTasteInputs(db, { days = 30, now = Date.now(), fallbackLimit = 300 } = {}) {
  const since = now - days * DAY_MS;
  let plays = null;
  let feedback = null;
  try {
    if (db?.raw?.prepare) {
      plays = db.raw.prepare(
        'SELECT id, kugou_id, title, artist, reason, source, ts FROM plays WHERE ts >= ? ORDER BY ts DESC',
      ).all(since);
      feedback = db.raw.prepare(
        'SELECT kind, kugou_id, title, artist, ts FROM feedback WHERE ts >= ? ORDER BY ts DESC',
      ).all(since);
    }
  } catch {
    plays = null;
    feedback = null;
  }
  if (!Array.isArray(plays)) plays = db.recentPlays(fallbackLimit) || [];
  if (!Array.isArray(feedback)) feedback = db.recentFeedback(200) || [];
  return { plays, feedback };
}

export function learnedTastePath(rootDir) {
  return path.join(rootDir, LEARNED_TASTE_FILE);
}

export function renderLearnedTaste({ markdown, stats, now = Date.now() }) {
  const stamp = new Date(now).toISOString().replace('T', ' ').slice(0, 16);
  return [
    `<!-- 由 Claudio 常驻主持人自动生成：${stamp}（UTC）。`,
    `     样本：近 ${stats.windowDays} 天 ${stats.totalPlays} 次播放、${stats.activeDays} 天有记录。`,
    '     手改会在下次蒸馏时被覆盖；想长期生效请写进 user/taste.md。 -->',
    '',
    `# 自动学到的品味（近 ${stats.windowDays} 天）`,
    '',
    markdown,
    '',
  ].join('\n');
}

/**
 * 跑一轮完整的品味蒸馏并落盘。返回 {ok, path, stats, error?}。
 */
export async function updateLearnedTaste({
  db, complete, rootDir, now = Date.now(), days = 30, log = () => {},
} = {}) {
  const { plays, feedback } = readTasteInputs(db, { days, now });
  const stats = computeTasteStats({ plays, feedback, now, days });
  if (stats.totalPlays < 5) {
    return { ok: false, reason: 'not-enough-data', stats };
  }

  let existingTaste = '';
  try {
    existingTaste = fs.readFileSync(path.join(rootDir, 'user', 'taste.md'), 'utf8');
  } catch { /* 没有就算了 */ }

  const markdown = await distillTaste({ stats, complete, existingTaste });
  if (!markdown) return { ok: false, reason: 'empty-output', stats };

  const target = learnedTastePath(rootDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, renderLearnedTaste({ markdown, stats, now }), 'utf8');
  log(`taste learned: ${stats.totalPlays} plays → ${LEARNED_TASTE_FILE}`);
  return { ok: true, path: target, stats };
}

export function readTasteState(db) {
  try {
    const raw = db.getPref(TASTE_STATE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function writeTasteState(db, state) {
  db.setPref(TASTE_STATE_KEY, JSON.stringify(state || {}));
}

export default {
  computeTasteStats,
  formatStatsForPrompt,
  distillTaste,
  readTasteInputs,
  updateLearnedTaste,
  readTasteState,
  writeTasteState,
  trackKey,
  LEARNED_TASTE_FILE,
  TASTE_STATE_KEY,
};
