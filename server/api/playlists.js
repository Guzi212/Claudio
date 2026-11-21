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
import { markQueueSource, queueEpochOf, bumpQueueEpoch, clearContinueSuppression } from '../queue-source.js';
import { dbApi as defaultDb } from '../db.js';

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

function searchQueueItem(track) {
  const item = {
    title: track.title,
    artist: track.artist || '',
    album: track.album || '',
    duration: track.duration || 0,
    kugouId: track.hash || track.kugouId || '',
    audioUrl: null,
    source: 'search',
  };
  if (track.cover) item.cover = String(track.cover);
  return item;
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
      const runtime = getRuntime();
      if (!runtime) {
        res.status(500).json({ ok: false, error: 'runtime 不可用' });
        return;
      }
      // 拉歌单期间可能被 clear；写回前核对 epoch，不能把旧歌单复活。
      const startedEpoch = queueEpochOf(runtime);
      const { tracks } = await fetchUserPlaylistTracks({ listid, globalCollectionId });
      const queue = tracks.filter(t => t.hash).map(toQueueItem);
      if (!queue.length) {
        res.status(404).json({ ok: false, error: '歌单没有可播放曲目' });
        return;
      }
      // 只看请求开始后 epoch 是否变化。clear 之后才发起的整单播放捕获的是新 epoch，
      // 必须能正常开播，不能因为 continueSuppressed 被误拒。
      if (queueEpochOf(runtime) !== startedEpoch) {
        res.status(409).json({
          ok: false,
          stale: true,
          error: '队列已被清空或更换，本次整单播放已丢弃',
          queueEpoch: queueEpochOf(runtime),
        });
        return;
      }
      const db = deps.db || defaultDb;
      runtime.queue = queue;
      runtime.queueOffset = 0;
      runtime.index = 0;
      runtime.paused = false;
      markQueueSource(runtime, 'playlist');
      const nextEpoch = bumpQueueEpoch(runtime);
      clearContinueSuppression(runtime);
      runtime.lastSay = `已切到歌单《${playlist.name || '未命名'}》，共 ${queue.length} 首。`;
      try {
        db?.addPlay?.({
          kugouId: queue[0].kugouId || null,
          title: queue[0].title,
          artist: queue[0].artist,
          reason: playlist.name || '歌单选播',
          source: 'manual',
          quality: 'manual_pick',
        });
      } catch { /* 播放历史记录失败不影响切单 */ }
      broadcast({ type: 'state', runtime });
      res.json({ ok: true, count: queue.length, queue, queueEpoch: nextEpoch, runtimeInstanceId: runtime.runtimeInstanceId || null });
    } catch (err) {
      console.error('[playlists-api] play failed:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 单曲播放：按用户选中的 hash 精确进队列，不再重新搜索打分。
  app.post('/api/kugou/play', (req, res) => {
    const track = req.body?.track || {};
    const mode = req.body?.mode === 'append' ? 'append' : 'replace';
    const hash = String(track.hash || track.kugouId || '').trim();
    const title = String(track.title || '').trim();
    if (!hash || !title) {
      res.status(400).json({ ok: false, error: 'track.hash 和 track.title 必填' });
      return;
    }
    const runtime = getRuntime();
    if (!runtime) {
      res.status(500).json({ ok: false, error: 'runtime 不可用' });
      return;
    }
    const item = searchQueueItem({ ...track, hash, title });
    if (mode === 'append') {
      const wasEmpty = !Array.isArray(runtime.queue) || runtime.queue.length === 0;
      runtime.queue = [...(runtime.queue || []), item];
      if (wasEmpty) {
        runtime.index = 0;
        runtime.paused = false;
      }
    } else {
      runtime.queue = [item];
      runtime.queueOffset = 0;
      runtime.index = 0;
      runtime.paused = false;
    }
    const db = deps.db || defaultDb;
    markQueueSource(runtime, 'search');
    const nextEpoch = bumpQueueEpoch(runtime);
    clearContinueSuppression(runtime);
    runtime.lastSay = `播放《${title}》${item.artist ? ` — ${item.artist}` : ''}。`;
    try {
      db?.addPlay?.({
        kugouId: item.kugouId || null,
        title: item.title,
        artist: item.artist,
        reason: '手动搜索选播',
        source: 'search',
        quality: 'manual_pick',
      });
    } catch { /* 播放历史记录失败不影响点歌 */ }
    broadcast({ type: 'state', runtime });
    res.json({ ok: true, mode, queue: runtime.queue, index: runtime.index, queueEpoch: nextEpoch, runtimeInstanceId: runtime.runtimeInstanceId || null });
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
