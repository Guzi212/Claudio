import axios from 'axios';
import 'dotenv/config';
import { dbApi } from '../db.js';

const BASE = process.env.KUGOU_API_BASE || 'http://localhost:3000';

// KuGouMusicApi 社区版常见接口路径。不同 fork 略有差异，按需在这里改。
const ENDPOINTS = {
  search:         '/search',            // ?keywords=
  songUrl:        '/song/url',           // ?hash=
  searchLyric:    '/search/lyric',       // ?hash= → candidates[].{id, accesskey}
  lyric:          '/lyric',              // ?id=&accesskey=&fmt=lrc&decode=true → decodeContent
  playlistTracks: '/playlist/track/all', // ?id=<global_collection_id>&page=&pagesize=
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

// DJ 版硬排除标记：目标没有指定时直接返回 0 分
const DJ_MARKERS = ['dj', 'dj版', 'dj mix', 'djmix'];

// 非原版变体标记：目标没有指定时扣分
const VERSION_MARKERS = ['现场', '演唱会', 'concert', 'live', 'remix', '混音', '钢琴', 'piano', 'cover', '翻唱', '演奏版', '纯音乐', 'instrumental', 'acoustic', 'unplugged', '清唱', '无伴奏', '伴奏版'];

function hasDjMarker(normalizedTitle) {
  return DJ_MARKERS.some(kw => normalizedTitle.includes(kw));
}

function hasVersionMarker(normalizedTitle) {
  return VERSION_MARKERS.some(kw => normalizedTitle.includes(kw));
}

function scoreCandidate(target, cand) {
  const t = normalizeForMatch(target.title);
  const a = normalizeForMatch(target.artist || '');
  const ct = normalizeForMatch(cand.title);
  const ca = normalizeForMatch(cand.artist);

  // 目标没有指定 DJ 版，候选是 DJ 版 → 直接 0 分
  if (!hasDjMarker(t) && hasDjMarker(ct)) return 0;

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

  // 目标没有指定版本类型，但候选是非原版变体 → 扣分，让原版优先
  if (!hasVersionMarker(t) && hasVersionMarker(ct)) {
    score -= 40;
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
    const candidates = list.slice(0, 15).map(item => ({
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
    const c = client();
    // step 1: search/lyric → candidate with id + accesskey
    const sr = await c.get(ENDPOINTS.searchLyric, { params: { hash } });
    const candidates = sr.data?.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    const { id, accesskey } = candidates[0];
    if (!id || !accesskey) return null;

    // step 2: fetch actual LRC
    const res = await c.get(ENDPOINTS.lyric, {
      params: { id, accesskey, fmt: 'lrc', decode: true },
    });
    return res.data?.decodeContent || res.data?.content || null;
  } catch (err) {
    console.error('[kugou] lyric failed:', err.message);
    return null;
  }
}

// 给一首 Claude 想推的歌 → 解析为可播放队列项；失败返回 null 并记 unmatched
export async function resolveTrack({ title, artist, hint = '' }) {
  const candidates = await search({ title, artist, hint });
  const SCORE_THRESHOLD = 60;

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

// KuGouMusicApi 在歌单接口返回的 name 形如 "Artist - Title"（与现有 OCR 解析的 "Title - Artist"
// 相反）。差异留在 service 层修正，downstream 拿到的就是已经摆正的 {title, artist}。
function parseNameField(name) {
  if (!name) return { title: '', artist: '' };
  const str = String(name).trim();
  const idx = str.indexOf(' - ');
  if (idx === -1) return { title: str, artist: '' };
  return {
    artist: str.slice(0, idx).trim(),
    title: str.slice(idx + 3).trim(),
  };
}

export { parseNameField };

export async function fetchSharedPlaylist({
  globalCollectionId,
  pagesize = 300,
  maxPages = 50,
  retries = 2,
} = {}) {
  if (!globalCollectionId) {
    throw new Error('fetchSharedPlaylist: 必须提供 globalCollectionId');
  }

  const tracks = [];
  let totalCount = 0;
  let lastError = null;
  const httpClient = client();

  for (let page = 1; page <= maxPages; page += 1) {
    let response = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        response = await httpClient.get(ENDPOINTS.playlistTracks, {
          params: { id: globalCollectionId, page, pagesize },
        });
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        response = null;
      }
    }
    if (!response) {
      console.error(`[kugou] fetchSharedPlaylist page ${page} 失败：`, lastError?.message);
      break;
    }

    const data = response.data?.data || response.data || {};
    if (page === 1) totalCount = Number(data.count || data.total || 0);
    const songs = Array.isArray(data.songs) ? data.songs
      : Array.isArray(data.info) ? data.info
      : Array.isArray(data.list) ? data.list
      : [];
    if (!songs.length) break;

    for (const song of songs) {
      const { title, artist } = parseNameField(song.name || song.filename || song.OriSongName);
      tracks.push({
        title,
        artist,
        album: song.album_name || song.AlbumName || '',
        hash: song.hash || song.FileHash || '',
        audioId: song.audio_id || song.audio_info?.audio_id || null,
        duration: song.timelen || song.duration || song.time_length || 0,
        publishDate: song.publish_date || '',
        language: song.language || '',
        bpm: song.bpm || null,
      });
    }

    if (totalCount && tracks.length >= totalCount) break;
  }

  return {
    tracks,
    totalCount,
    fetchedCount: tracks.length,
    truncated: Boolean(totalCount) && tracks.length < totalCount,
  };
}

export default { search, songUrl, lyric, resolveTrack, fetchSharedPlaylist, parseNameField };
