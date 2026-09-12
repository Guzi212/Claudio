import { dbApi as defaultDb } from '../db.js';

export function mountUnmatchedRoute(app, { db = defaultDb } = {}) {
  app.get('/api/unmatched', (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    try {
      const items = db.recentUnmatched(limit);
      res.json({ ok: true, items });
    } catch (err) {
      console.error('[api/unmatched] failed:', err.message);
      res.status(500).json({ ok: false, error: '读取失败' });
    }
  });
}
