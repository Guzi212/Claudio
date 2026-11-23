import { search as defaultKugouSearch } from '../services/kugou.js';
import { search as defaultMultiSearch, normalizeProviderName } from '../services/music.js';

export function mountSearchRoute(app, deps = {}) {
  const search = deps.search || defaultKugouSearch;
  const multiSearch = deps.multiSearch || defaultMultiSearch;

  app.get('/api/kugou/search', async (req, res) => {
    const q = String(req.query?.q || '').trim();
    const title = q || String(req.query?.title || '').trim();
    const artist = String(req.query?.artist || '').trim();
    const hint = String(req.query?.hint || '').trim();
    if (!title) {
      res.status(400).json({ ok: false, error: 'title 或 q 必填' });
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
        cover: item.cover || '',
        score: item.score ?? null,
      }));
      res.json({ ok: true, tracks });
    } catch (err) {
      console.error('[search] failed:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/music/search', async (req, res) => {
    const q = String(req.query?.q || '').trim();
    const title = q || String(req.query?.title || '').trim();
    const artist = String(req.query?.artist || '').trim();
    const hint = String(req.query?.hint || '').trim();
    const rawProvider = String(req.query?.provider || '').trim();
    if (rawProvider && !normalizeProviderName(rawProvider, { allowMulti: true })) {
      res.status(400).json({ ok: false, error: `未知音乐源: ${rawProvider}` });
      return;
    }
    if (!title) {
      res.status(400).json({ ok: false, error: 'title 或 q 必填' });
      return;
    }
    try {
      const result = await multiSearch({ title, artist, hint, provider: rawProvider });
      const tracks = (Array.isArray(result?.tracks) ? result.tracks : []).map(item => ({
        provider: item.provider || 'kugou',
        id: item.id || item.hash || '',
        hash: item.hash || item.id || '',
        title: item.title || '',
        artist: item.artist || '',
        album: item.album || '',
        duration: item.duration || 0,
        cover: item.cover || '',
        score: item.score ?? null,
      }));
      res.json({
        ok: true,
        provider: result?.provider || rawProvider || 'multi',
        providersUsed: Array.isArray(result?.providersUsed) ? result.providersUsed : [],
        tracks,
      });
    } catch (err) {
      console.error('[music-search] failed:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
