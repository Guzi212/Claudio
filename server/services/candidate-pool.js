// 候选歌单池：把用户选中的酷狗歌单缓存到 prefs，供
//   1) context.js 注入 system prompt（Claudio 优先从池里选歌）
//   2) claude.js 兜底保证 play 里至少 N 首来自池
//   3) API 层设置 / 清除
// 存储用 prefs（TEXT），避免 schema 迁移。
import { dbApi } from '../db.js';
import { normalizeForMatch } from './kugou.js';

const META_KEY = 'playlist_pool';
const TRACKS_KEY = 'playlist_pool_tracks';

function readJson(key, fallback) {
  const raw = dbApi.getPref(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function getPool() {
  const meta = readJson(META_KEY, null);
  return meta && typeof meta === 'object' ? meta : null;
}

export function getPoolTracks() {
  const tracks = readJson(TRACKS_KEY, []);
  return Array.isArray(tracks) ? tracks : [];
}

export function setPool(meta, tracks = []) {
  dbApi.setPref(META_KEY, JSON.stringify(meta || {}));
  dbApi.setPref(TRACKS_KEY, JSON.stringify(Array.isArray(tracks) ? tracks : []));
  return getPool();
}

export function clearPool() {
  dbApi.delPref(META_KEY);
  dbApi.delPref(TRACKS_KEY);
}

// 曲目身份 key：歌名 + 艺人归一化后拼起来，容忍繁简 / 空格 / 标点差异。
export function poolKey(title, artist) {
  return `${normalizeForMatch(title)}|${normalizeForMatch(artist)}`;
}

export function countInPool(play = [], tracks = []) {
  if (!Array.isArray(play) || !play.length || !Array.isArray(tracks) || !tracks.length) return 0;
  const keys = new Set(tracks.map(t => poolKey(t.title, t.artist)));
  return play.filter(p => keys.has(poolKey(p.title, p.artist))).length;
}

// 等距采样（确定性，便于测试）：大歌单只把 ≤n 首喂给 prompt。
export function sampleTracks(tracks = [], n = 60) {
  if (!Array.isArray(tracks)) return [];
  if (n <= 0 || tracks.length <= n) return tracks;
  const step = tracks.length / n;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(tracks[Math.floor(i * step)]);
  }
  return out;
}

// 保证 play 里至少有 min 首来自候选池：
// - 池为空 / play 本来就短于 min（被视为"用户明确点歌"）→ 原样返回
// - 已达标 → 原样返回
// - 未达标 → 从尾部替换掉非池条目（不删池内条目、不改变列表长度）
export function ensureMinimumFromPool(play = [], tracks = [], { min = 3, max = 5 } = {}) {
  const list = Array.isArray(play) ? play.slice(0, max) : [];
  if (!Array.isArray(tracks) || tracks.length === 0) return list;
  if (list.length < min) return list;

  const poolKeys = new Set(tracks.map(t => poolKey(t.title, t.artist)));
  const need = min - countInPool(list, tracks);
  if (need <= 0) return list;

  const usedKeys = new Set(list.map(p => poolKey(p.title, p.artist)));
  const candidates = [];
  const seen = new Set();
  for (const t of tracks) {
    const k = poolKey(t.title, t.artist);
    if (usedKeys.has(k) || seen.has(k)) continue;
    seen.add(k);
    candidates.push({ title: t.title, artist: t.artist, hint: t.hint || '' });
  }

  const result = list.slice();
  let added = 0;
  for (let i = result.length - 1; i >= 0 && added < need; i -= 1) {
    if (poolKeys.has(poolKey(result[i].title, result[i].artist))) continue;
    const cand = candidates[added];
    if (!cand) break;
    result[i] = cand;
    added += 1;
  }
  return result;
}

export function formatPoolForPrompt(tracks = [], { limit = 60 } = {}) {
  return sampleTracks(tracks, limit)
    .map(t => `  · ${t.title} - ${t.artist}`)
    .join('\n');
}

export default {
  getPool,
  getPoolTracks,
  setPool,
  clearPool,
  poolKey,
  countInPool,
  sampleTracks,
  ensureMinimumFromPool,
  formatPoolForPrompt,
};
