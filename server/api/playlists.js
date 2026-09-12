// 酷狗歌单 API：列表 / 曲目 / 候选池 / 整单播放 / 直链懒解析。
// 依赖全部可注入，方便单测；默认走真实 kugou service 与 candidate-pool。
import {
  fetchUserPlaylists as defaultFetchUserPlaylists,
  fetchUserPlaylistTracks as defaultFetchUserPlaylistTracks,
  songUrl as defaultSongUrl,
} from '../services/kugou.js';
import {
  getPool as defaultGetPool,
  getPoolTracks as defaultGetPoolTracks,
  setPool as defaultSetPool,
  clearPool as defaultClearPool,
} from '../services/candidate-pool.js';

function proxyUrl(upstream) {
  return `/api/proxy?u=${encodeURIComponent(upstream)}`;
}

function toQueueItem(track) {
  return {
    title: track.title,
    artist: track.artist,
    album: track.album || '',
    duration: track.duration || 0,
    kugouId: track.hash || '',
    audioUrl: null, // 播到这首时前端再取直链，避免大歌单一次性解析 + 直链过期
    source: 'playlist',
  };
}

function playlistRef(playlist = {}) {
  const listid = String(playlist.listid || '');
  const explicitGcid = String(playlist.globalCollectionId || '');
  const globalCollectionId = explicitGcid || (listid ? '' : String(playlist.id || ''));
  return { listid, globalCollectionId };
}

export function mountPlaylistRoutes(app, deps = {}) {
  const fetchUserPlaylists = deps.fetchUserPlaylists || defaultFetchUserPlaylists;
  const fetchUserPlaylistTracks = deps.fetchUserPlaylistTracks || defaultFetchUserPlaylistTracks;
  const resolveSongUrl = deps.resolveSongUrl || defaultSongUrl;
  const getPool = deps.getPool || defaultGetPool;
  const getPoolTracks = deps.getPoolTracks || defaultGetPoolTracks;
  const setPool = deps.setPool || defaultSetPool;
  const clearPool = deps.clearPool || defaultClearPool;
  const getRuntime = typeof deps.getRuntime === 'function' ? deps.getRuntime : () => deps.runtime || {};
  const broadcast = typeof deps.broadcast === 'function' ? deps.broadcast : () => {};

  function poolView() {
    const meta = getPool();
    if (!meta) return null;
    return { ...meta, trackCount: getPoolTracks().length };
  }

  // 账号歌单列表
  app.get('/api/kugou/playlists', async (req, res) => {
    try {
      const playlists = await fetchUserPlaylists({
        page: Number(req.query?.page) || 1,
        pagesize: Number(req.query?.pagesize) || 50,
      });
      res.json({ ok: true, playlists });
    } catch (err) {
      console.error('[playlists-api] list failed:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 歌单曲目（只读预览）
  app.get('/api/kugou/playlists/tracks', async (req, res) => {
    const gcid = String(req.query?.gcid || '');
    const listid = String(req.query?.listid || '');
    if (!gcid && !listid) {
      res.status(400).json({ ok: false, error: 'gcid 或 listid 必填' });
      return;
    }
    try {
      const result = await fetchUserPlaylistTracks({
        listid,
        globalCollectionId: gcid,
        pagesize: Number(req.query?.pagesize) || 300,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error('[playlists-api] tracks failed:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 当前候选池
  app.get('/api/kugou/playlists/pool', (req, res) => {
    res.json({ ok: true, pool: poolView() });
  });

  // 设置 / 清除候选池
  app.post('/api/kugou/playlists/pool', async (req, res) => {
    const playlist = req.body?.playlist;
    if (!playlist) {
      clearPool();
      res.json({ ok: true, pool: null });
      return;
    }
    const { listid, globalCollectionId } = playlistRef(playlist);
    if (!listid && !globalCollectionId) {
      res.status(400).json({ ok: false, error: 'playlist.listid 或 playlist.globalCollectionId 必填' });
      return;
    }
    try {
      const { tracks } = await fetchUserPlaylistTracks({ listid, globalCollectionId });
      if (!tracks.length) {
        res.status(404).json({ ok: false, error: '歌单没有可用曲目' });
        return;
      }
      setPool({
        id: playlist.id || globalCollectionId || listid,
        listid,
        globalCollectionId,
        name: playlist.name || '未命名歌单',
      }, tracks);
      res.json({ ok: true, pool: poolView() });
    } catch (err) {
      console.error('[playlists-api] set pool failed:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 整单播放：拉曲目 → 替换 runtime.queue → 广播
  app.post('/api/kugou/playlists/play', async (req, res) => {
    const playlist = req.body?.playlist;
    if (!playlist) {
      res.status(400).json({ ok: false, error: 'playlist 必填' });
      return;
    }
    const { listid, globalCollectionId } = playlistRef(playlist);
    if (!listid && !globalCollectionId) {
      res.status(400).json({ ok: false, error: 'playlist.listid 或 playlist.globalCollectionId 必填' });
      return;
    }
    try {
      const { tracks } = await fetchUserPlaylistTracks({ listid, globalCollectionId });
      const queue = tracks.filter(t => t.hash).map(toQueueItem);
      if (!queue.length) {
        res.status(404).json({ ok: false, error: '歌单没有可播放曲目' });
        return;
      }
      const runtime = getRuntime();
      runtime.queue = queue;
      runtime.index = 0;
      runtime.paused = false;
      runtime.lastSay = `已切到歌单《${playlist.name || '未命名'}》，共 ${queue.length} 首。`;
      broadcast({ type: 'state', runtime });
      res.json({ ok: true, count: queue.length, queue });
    } catch (err) {
      console.error('[playlists-api] play failed:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 直链懒解析：hash → 可播放代理 URL
  app.get('/api/kugou/track-url', async (req, res) => {
    const hash = String(req.query?.hash || '');
    if (!hash) {
      res.status(400).json({ ok: false, error: 'hash 必填' });
      return;
    }
    try {
      const upstream = await resolveSongUrl(hash);
      if (!upstream) {
        res.status(404).json({ ok: false, error: '未取到直链' });
        return;
      }
      res.json({ ok: true, url: proxyUrl(upstream) });
    } catch (err) {
      console.error('[playlists-api] track-url failed:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}

export default { mountPlaylistRoutes };
