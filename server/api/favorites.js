// 酷狗「我喜欢」红心：查询 / 加入 / 移除。
// 加入成功后写一条待分类记录，交给外部 bot 轮询整理。
import { dbApi as defaultDb } from '../db.js';
import { favoriteStore as defaultStore } from '../services/kugou-favorite.js';

function clip(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

export function mountFavoriteRoutes(app, deps = {}) {
  const store = deps.store || defaultStore;
  const db = deps.db || defaultDb;

  app.get('/api/kugou/favorite', async (req, res) => {
    const hash = String(req.query?.hash || '').trim();
    if (!hash) {
      res.status(400).json({ ok: false, error: 'hash 必填' });
      return;
    }
    try {
      const liked = await store.isFavorite(hash);
      res.json({ ok: true, liked });
    } catch (err) {
      console.error('[favorites-api] status failed:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/kugou/favorite', async (req, res) => {
    const action = String(req.body?.action || 'add');
    if (action !== 'add' && action !== 'remove') {
      res.status(400).json({ ok: false, error: "action 只能是 add 或 remove" });
      return;
    }
    const raw = req.body?.track || {};
    const hash = String(raw.hash || raw.kugouId || '').trim();
    const title = clip(raw.title, 200);
    if (!hash || !title) {
      res.status(400).json({ ok: false, error: 'track.hash 和 track.title 必填' });
      return;
    }
    const track = {
      kugouId: hash,
      title,
      artist: clip(raw.artist, 200),
      album: clip(raw.album, 200),
      albumId: clip(raw.albumId, 40),
      mixsongid: clip(raw.mixsongid, 40),
    };

    try {
      if (action === 'add') {
        const result = await store.add(track);
        let pendingId = null;
        if (!result.duplicate) {
          pendingId = db.addLikePending({
            kugouId: hash,
            title: result.track?.title || title,
            artist: result.track?.artist || track.artist,
            album: result.track?.album || track.album,
            albumId: result.track?.albumId || track.albumId,
            mixsongid: result.track?.mixsongid || track.mixsongid,
          });
        }
        res.json({ ...result, pendingId });
        return;
      }

      const result = await store.remove(track);
      db.cancelLikePendingByHash(hash);
      res.json(result);
    } catch (err) {
      console.error(`[favorites-api] ${action} failed:`, err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}

export default { mountFavoriteRoutes };
