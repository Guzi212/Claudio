import { dbApi as defaultDb } from '../db.js';
import { resolveTrack as defaultResolveTrack, fetchUserPlaylistTracks as defaultFetchTracks } from '../services/kugou.js';
import { continuePoolView, saveContinuePool, shuffleTracks } from '../continue-pool.js';

const clip = (value, max) => Array.from(String(value ?? '').trim()).slice(0, max).join('');

function poolTrack(track, reason = '') {
  const item = {
    title: track.title || '', artist: track.artist || '', album: track.album || '',
    duration: track.duration || 0, kugouId: track.kugouId || track.hash,
    cover: track.cover || '',
  };
  if (reason) item.reason = reason;
  return item;
}

export function mountContinuePoolRoutes(app, deps = {}) {
  const db = deps.db || defaultDb;
  const getRuntime = deps.getRuntime || (() => deps.runtime);
  const resolveTrack = deps.resolveTrack || defaultResolveTrack;
  const fetchTracks = deps.fetchUserPlaylistTracks || defaultFetchTracks;
  const broadcast = deps.broadcast || (() => {});

  app.get('/api/continue-pool', (_req, res) => {
    res.json({ ok: true, continuePool: continuePoolView(getRuntime(), { tracks: true }) });
  });

  const set = async (req, res) => {
    const body = req.body || {};
    const fail = error => res.status(400).json({ ok: false, error });
    if ((body.tracks != null) === (body.playlist != null)) return fail('tracks 和 playlist 必须且只能提供一种');
    if (body.shuffle != null && typeof body.shuffle !== 'boolean') return fail('shuffle 必须是布尔值');
    if (body.loop != null && typeof body.loop !== 'boolean') return fail('loop 必须是布尔值');
    const batchSize = body.batchSize ?? 5;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50) return fail('batchSize 必须是 1 到 50 的整数');
    if (body.tracks != null && (!Array.isArray(body.tracks) || !body.tracks.length || body.tracks.length > 200)) {
      return fail('tracks 必须是 1 到 200 首的非空数组');
    }
    const playlist = body.playlist;
    if (playlist != null && (typeof playlist !== 'object' || Array.isArray(playlist)
      || ![playlist.listid, playlist.globalCollectionId].some(id =>
        (typeof id === 'string' || typeof id === 'number') && String(id).trim()))) {
      return fail('playlist 必须提供 listid 或 globalCollectionId');
    }
    try {
      const failed = [];
      let tracks;
      if (playlist) {
        const result = await fetchTracks({
          listid: clip(playlist.listid, 200), globalCollectionId: clip(playlist.globalCollectionId, 200),
          pagesize: 200, maxPages: 1,
        });
        tracks = [];
        for (const track of (result.tracks || []).slice(0, 200)) {
          if (track.hash) tracks.push(poolTrack(track, clip(track.reason, 200)));
          else failed.push({ title: track.title || '', artist: track.artist || '', reason: '缺少歌曲 hash' });
        }
      } else {
        const resolved = await Promise.all(body.tracks.map(async raw => {
          const want = { title: clip(raw?.title, 200), artist: clip(raw?.artist, 200), reason: clip(raw?.reason, 200) };
          if (!want.title) return { want, track: null, error: '缺少歌名' };
          return { want, track: await resolveTrack(want) };
        }));
        tracks = [];
        for (const { want, track, error } of resolved) {
          if (track?.kugouId) tracks.push(poolTrack(track, want.reason));
          else failed.push({ title: want.title, artist: want.artist, reason: error || 'unmatched' });
        }
      }
      if (!tracks.length) return res.status(400).json({ ok: false, error: '没有匹配到可续播的歌曲，原续播池保留', failed });
      const pool = {
        name: clip(body.name, 100) || '续播池', source: clip(body.source, 40) || 'claudio-host',
        shuffle: body.shuffle ?? false, loop: body.loop ?? true, batchSize,
        cursor: 0, setAt: new Date().toISOString(), lastContinuedAt: null, continuedCount: 0,
        tracks,
      };
      const matched = tracks.map(({ title, artist, kugouId }) => ({ title, artist, kugouId }));
      if (pool.shuffle) shuffleTracks(pool.tracks, deps.random);
      saveContinuePool(db, pool);
      getRuntime().continuePool = pool;
      broadcast({ type: 'continue-pool', continuePool: continuePoolView(getRuntime()) });
      res.json({ ok: true, continuePool: continuePoolView(getRuntime()), matched, failed });
    } catch {
      res.status(502).json({ ok: false, error: '设置续播池失败，原续播池保留' });
    }
  };
  app.put('/api/continue-pool', set);
  app.post('/api/continue-pool', set);
  app.delete('/api/continue-pool', (_req, res) => {
    saveContinuePool(db, null);
    getRuntime().continuePool = null;
    broadcast({ type: 'continue-pool', continuePool: null });
    res.json({ ok: true, continuePool: null });
  });
}
