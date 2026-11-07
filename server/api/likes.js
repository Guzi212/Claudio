// 待分类队列：红心新歌 → bot 轮询 → 选一个自建歌单 → 追加。
import { dbApi as defaultDb } from '../db.js';
import {
  findPlaylist as defaultFindPlaylist,
  appendTrackToPlaylist as defaultAppendTrack,
  playlistWritable,
} from '../services/kugou-classify.js';

function mapPending(row) {
  if (!row) return null;
  return {
    id: row.id,
    kugouId: row.kugou_id || '',
    title: row.title || '',
    artist: row.artist || '',
    album: row.album || '',
    albumId: row.album_id || '',
    mixsongid: row.mixsongid || '',
    status: row.status,
    targetPlaylist: row.target_playlist || '',
    targetListid: row.target_listid || '',
    note: row.note || '',
    createdAt: row.created_ts,
    resolvedAt: row.resolved_ts || null,
  };
}

export function mountLikeRoutes(app, deps = {}) {
  const db = deps.db || defaultDb;
  const findPlaylist = deps.findPlaylist || defaultFindPlaylist;
  const appendTrack = deps.appendTrack || defaultAppendTrack;

  app.get('/api/likes/pending', (req, res) => {
    const raw = Number(req.query?.limit);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.trunc(raw), 200) : 100;
    res.json({ ok: true, items: db.pendingLikes(limit).map(mapPending) });
  });

  app.post('/api/likes/:id/classify', async (req, res) => {
    const id = Number(req.params?.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ ok: false, error: 'id 必须是正整数' });
      return;
    }
    const item = db.getLikePending(id);
    if (!item) {
      res.status(404).json({ ok: false, error: '待分类记录不存在' });
      return;
    }
    if (item.status !== 'pending') {
      res.json({ ok: true, item: mapPending(item), already: true });
      return;
    }

    const playlistRef = req.body?.playlist || {};
    const listid = String(playlistRef.listid || req.body?.listid || '').trim();
    const name = String(playlistRef.name || req.body?.name || '').trim();
    if (!listid && !name) {
      res.status(400).json({ ok: false, error: 'playlist.listid 或 playlist.name 必填' });
      return;
    }

    try {
      const playlist = await findPlaylist({ listid, name });
      if (!playlist) {
        res.status(404).json({ ok: false, error: '目标歌单不存在' });
        return;
      }
      if (!playlistWritable(playlist)) {
        res.status(400).json({ ok: false, error: '只能写入自建歌单（type=0）' });
        return;
      }
      const targetListid = String(playlist.listid || '').trim();
      const result = await appendTrack({
        listid: targetListid,
        track: {
          kugouId: item.kugou_id,
          title: item.title,
          artist: item.artist,
          album: item.album,
          albumId: item.album_id,
          mixsongid: item.mixsongid,
        },
      });
      db.resolveLikePending(id, {
        targetPlaylist: playlist.name || '',
        targetListid,
      });
      res.json({
        ok: true,
        item: mapPending(db.getLikePending(id)),
        playlist: { name: playlist.name || '', listid: targetListid },
        duplicate: Boolean(result.duplicate),
      });
    } catch (err) {
      console.error('[likes-api] classify failed:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/likes/:id/skip', (req, res) => {
    const id = Number(req.params?.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ ok: false, error: 'id 必须是正整数' });
      return;
    }
    const item = db.getLikePending(id);
    if (!item) {
      res.status(404).json({ ok: false, error: '待分类记录不存在' });
      return;
    }
    db.skipLikePending(id, { note: String(req.body?.note || '').slice(0, 200) });
    res.json({ ok: true, item: mapPending(db.getLikePending(id)) });
  });
}

export default { mountLikeRoutes };
