import axios from 'axios';
import 'dotenv/config';
import { dbApi } from '../db.js';

const BASE = process.env.KUGOU_API_BASE || 'http://localhost:3000';

// KuGouMusicApi 社区版常见接口路径。不同 fork 略有差异，按需在这里改。
const ENDPOINTS = {
  search:    '/search',           // ?keywords=
  songUrl:   '/song/url',          // ?hash=
  lyric:     '/lyric',             // ?hash=
};

function getCookie() {
  return process.env.KUGOU_COOKIE || dbApi.getPref('kugou_cookie') || '';
}

function client() {
  return axios.create({
    baseURL: BASE,
    timeout: 10_000,
    headers: {
      Cookie: getCookie(),
    },
  });
}

function normalizeForMatch(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[【】\[\]()（）·・\-_,，.。!！?？'"]/g, '');
}

function scoreCandidate(target, cand) {
  const t = normalizeForMatch(target.title);
  const a = normalizeForMatch(target.artist || '');
  const ct = normalizeForMatch(cand.title);
  const ca = normalizeForMatch(cand.artist);

  let score = 0;
  if (ct === t) score += 100;
  else if (ct.includes(t) || t.includes(ct)) score += 60;
  else if ([...t].filter(c => ct.includes(c)).length / Math.max(t.length, 1) > 0.7) score += 30;

  if (a) {
    if (ca === a) score += 50;
    else if (ca.includes(a) || a.includes(ca)) score += 30;
  } else {
    score += 10;
  }
  return score;
}

// search: 返回候选列表，按匹配分降序，已带 hash 字段
export async function search({ title, artist = '', hint = '' }) {
  const keyword = [title, artist, hint].filter(Boolean).join(' ');
  try {
    const res = await client().get(ENDPOINTS.search, { params: { keywords: keyword } });
    // KuGouMusicApi 返回结构通常是 res.data.data.lists 或 res.data.data.info，不同 fork 略有差异
    const raw = res.data?.data?.lists
      || res.data?.data?.info
      || res.data?.data
      || res.data?.lists
      || [];

    const list = Array.isArray(raw) ? raw : [];
    const candidates = list.slice(0, 8).map(item => ({
      hash: item.FileHash || item.hash || item.SongHash || item.songhash || '',
      title: item.OriSongName || item.SongName || item.songname || item.name || item.title || item.FileName?.split(' - ').slice(-1)[0] || '',
      artist: item.SingerName || item.singername || item.artist || item.author_name || '',
      album: item.AlbumName || item.albumname || '',
      duration: item.Duration || item.duration || 0,
      raw: item,
    })).filter(c => c.hash && c.title);

    const scored = candidates
      .map(c => ({ ...c, score: scoreCandidate({ title, artist }, c) }))
      .sort((a, b) => b.score - a.score);

    return scored;
  } catch (err) {
    console.error('[kugou] search failed:', err.message);
    return [];
  }
}

// songUrl: 拿到可播放的直链
function firstUrl(field) {
  if (!field) return null;
  if (Array.isArray(field)) return field.find(x => typeof x === 'string' && x.length > 0) || null;
  if (typeof field === 'string' && field.length > 0) return field;
  return null;
}

export async function songUrl(hash) {
  if (!hash) return null;
  try {
    const res = await client().get(ENDPOINTS.songUrl, { params: { hash } });
    const data = res.data;
    const url = firstUrl(data?.url)
      || firstUrl(data?.backupUrl)
      || firstUrl(data?.data?.url)
      || firstUrl(data?.play_url)
      || null;
    if (!url) {
      console.warn('[kugou] songUrl empty for hash', hash, '· raw:', JSON.stringify(data).slice(0, 200));
    }
    return url;
  } catch (err) {
    console.error('[kugou] songUrl failed:', err.message);
    return null;
  }
}

export async function lyric(hash) {
  if (!hash) return null;
  try {
    const res = await client().get(ENDPOINTS.lyric, { params: { hash } });
    return res.data?.lyric || res.data?.data?.lyric || null;
  } catch (err) {
    console.error('[kugou] lyric failed:', err.message);
    return null;
  }
}

// 给一首 Claude 想推的歌 → 解析为可播放队列项；失败返回 null 并记 unmatched
export async function resolveTrack({ title, artist, hint = '' }) {
  const candidates = await search({ title, artist, hint });
  const SCORE_THRESHOLD = 50;

  for (const c of candidates) {
    if (c.score < SCORE_THRESHOLD) break;
    const url = await songUrl(c.hash);
    if (url) {
      return {
        kugouId: c.hash,
        title: c.title,
        artist: c.artist,
        album: c.album,
        duration: c.duration,
        upstreamUrl: url,
        score: c.score,
      };
    }
  }

  dbApi.addUnmatched({ title, artist, hint });
  return null;
}

export default { search, songUrl, lyric, resolveTrack };
