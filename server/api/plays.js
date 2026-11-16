import { dbApi as defaultDb } from '../db.js';

function clampLimit(value, fallback = 20) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(100, Math.trunc(n)));
}

function mapPlay(row) {
  return {
    id: row.id,
    kugouId: row.kugou_id || '',
    title: row.title,
    artist: row.artist,
    reason: row.reason || '',
    source: row.source,
    quality: row.quality || 'normal',
    ts: row.ts,
  };
}

function mapSession(row) {
  return {
    id: row.id,
    kugouId: row.kugou_id || '',
    title: row.title || '',
    artist: row.artist || '',
    source: row.source || '',
    outcome: row.outcome || '',
    listenedSec: Number(row.listened_sec) || 0,
    durationSec: Number(row.duration_sec) || 0,
    startedTs: row.started_ts,
    endedTs: row.ended_ts || null,
  };
}

function mapFeedback(row) {
  return {
    id: row.id,
    kind: row.kind,
    kugouId: row.kugou_id || '',
    title: row.title || '',
    artist: row.artist || '',
    ts: row.ts,
  };
}

export function mountPlaysRoutes(app, deps = {}) {
  const db = deps.db || defaultDb;

  app.get('/api/plays', (req, res) => {
    const limit = clampLimit(req.query?.limit ?? req.query?.n);
    const verifiedOnly = req.query?.verified === '1' || req.query?.verified === 'true';
    const rawPlays = verifiedOnly && typeof db.recentVerifiedPlays === 'function'
      ? db.recentVerifiedPlays(limit)
      : db.recentPlays(limit);
    const plays = rawPlays.map(mapPlay);
    const feedback = typeof db.recentFeedback === 'function'
      ? db.recentFeedback(limit).map(mapFeedback)
      : [];
    const sessions = typeof db.recentPlaybackSessions === 'function'
      ? db.recentPlaybackSessions({ sinceTs: 0, limit }).map(mapSession)
      : [];
    res.json({ ok: true, plays, feedback, sessions });
  });

  app.post('/api/feedback', (req, res) => {
    const kind = String(req.body?.kind || '').trim();
    if (kind !== 'like' && kind !== 'unlike' && kind !== 'skip' && kind !== 'dislike') {
      res.status(400).json({ ok: false, error: 'kind 只能是 like、unlike、skip 或 dislike' });
      return;
    }
    const title = String(req.body?.title || '').trim();
    const artist = String(req.body?.artist || '').trim();
    const kugouId = String(req.body?.kugouId || '').trim();
    if (!title && !kugouId) {
      res.status(400).json({ ok: false, error: 'title 或 kugouId 至少填一个' });
      return;
    }
    const id = db.addFeedback({ kind, kugouId, title, artist });
    res.json({ ok: true, id, kind, title, artist, kugouId });
  });
}
