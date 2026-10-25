import { search as defaultSearch } from '../services/kugou.js';

export function mountSearchRoute(app, deps = {}) {
  const search = deps.search || defaultSearch;

  app.get('/api/kugou/search', async (req, res) => {
    const title = String(req.query?.title || '').trim();
    const artist = String(req.query?.artist || '').trim();
    const hint = String(req.query?.hint || '').trim();
    if (!title) {
      res.status(400).json({ ok: false, error: 'title 必填' });
      return;
    }
    try {
      const rows = await search({ title, artist, hint });
      const tracks = (Array.isArray(rows) ? rows : []).map(item => ({
        hash: item.hash || '',
        title: item.title || '',
        artist: item.artist || '',
        album: item.album || '',
        duration: item.duration || 0,
        score: item.score ?? null,
      }));
      res.json({ ok: true, tracks });
    } catch (err) {
      console.error('[search] failed:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
