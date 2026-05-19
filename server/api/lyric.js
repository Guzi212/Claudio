import { lyric as fetchLyric } from '../services/kugou.js';

export function mountLyricRoute(app) {
  app.get('/api/lyric', async (req, res) => {
    const hash = String(req.query?.hash || '').trim();
    if (!hash) {
      res.status(400).json({ error: 'missing hash' });
      return;
    }
    try {
      const text = await fetchLyric(hash);
      res.json({ lyric: text || null });
    } catch (err) {
      console.error('[api/lyric] failed:', err.message);
      res.json({ lyric: null });
    }
  });
}

export default { mountLyricRoute };
