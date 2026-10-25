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
    ts: row.ts,
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
    const plays = db.recentPlays(limit).map(mapPlay);
    const feedback = typeof db.recentFeedback === 'function'
      ? db.recentFeedback(limit).map(mapFeedback)
      : [];
    res.json({ ok: true, plays, feedback });
  });

  app.post('/api/feedback', (req, res) => {
    const kind = String(req.body?.kind || '').trim();
    if (kind !== 'like' && kind !== 'unlike' && kind !== 'skip') {
      res.status(400).json({ ok: false, error: 'kind 只能是 like、unlike 或 skip' });
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
