import { lyric as defaultFetchLyric } from '../services/music.js';

export function mountLyricRoute(app, deps = {}) {
  const fetchLyric = deps.lyric || defaultFetchLyric;

  app.get('/api/lyric', async (req, res) => {
    const idOrHash = String(req.query?.hash || req.query?.id || '').trim();
    const provider = String(req.query?.provider || '').trim();
    if (!idOrHash) {
      res.status(400).json({ error: 'missing hash' });
      return;
    }
    try {
      const text = await fetchLyric(idOrHash, provider ? { provider } : undefined);
      res.json({ lyric: text || null });
    } catch (err) {
      console.error('[api/lyric] failed:', err.message);
      res.json({ lyric: null });
    }
  });
}

export default { mountLyricRoute };
