// Bot 点歌入口。不调用 Claude，也不读账号歌单候选池。
// 每首歌走 kugou.resolveTrack：搜索、打分、DJ/现场版降权、阈值、失败记 unmatched。
import { dbApi as defaultDb } from '../db.js';
import { resolveTrack as defaultResolveTrack } from '../services/kugou.js';
import { writeTracksToPlaylist as defaultWriteTracks } from '../services/kugou-playlist-write.js';

export const DEFAULT_PLAYLIST_NAME = 'Claudio推荐';
const MAX_TRACKS = 100;
const TARGETS = new Set(['queue', 'kugou_playlist', 'both']);
const QUEUE_MODES = new Set(['replace', 'append']);
const PLAYLIST_MODES = new Set(['append', 'rewrite']);

function toQueueItem(track) {
  return {
    title: track.title,
    artist: track.artist,
    album: track.album || '',
    duration: track.duration || 0,
    kugouId: track.kugouId,
    audioUrl: track.upstreamUrl
      ? `/api/proxy?u=${encodeURIComponent(track.upstreamUrl)}`
      : null,
    comment: '',
    source: 'bot',
  };
}

function matchedView(want, track) {
  return {
    title: track.title,
    artist: track.artist,
    kugouId: track.kugouId,
    score: track.score ?? null,
    requested: {
      title: want.title,
      artist: want.artist || '',
    },
  };
}

export function mountExternalQueueRoutes(app, deps = {}) {
  const resolveTrack = deps.resolveTrack || defaultResolveTrack;
  const writeTracks = deps.writeTracks || defaultWriteTracks;
  const db = deps.db || defaultDb;
  const getRuntime = typeof deps.getRuntime === 'function'
    ? deps.getRuntime
    : () => deps.runtime;
  const broadcast = typeof deps.broadcast === 'function' ? deps.broadcast : () => {};

  app.post('/api/queue/external', async (req, res) => {
    const body = req.body || {};
    const target = body.target == null || body.target === '' ? 'queue' : String(body.target);
    const mode = body.mode == null || body.mode === '' ? 'replace' : String(body.mode);
    const playlistMode = body.playlistMode == null || body.playlistMode === ''
      ? 'append'
      : String(body.playlistMode);
    const playlistName = String(body.playlistName == null || body.playlistName === ''
      ? DEFAULT_PLAYLIST_NAME
      : body.playlistName).trim() || DEFAULT_PLAYLIST_NAME;
    const say = String(body.say || '').trim();
    const reason = String(body.reason || '').trim();

    if (!TARGETS.has(target)) {
      res.status(400).json({ ok: false, error: "target 只能是 queue、kugou_playlist 或 both" });
      return;
    }
    if (!QUEUE_MODES.has(mode)) {
      res.status(400).json({ ok: false, error: "mode 只能是 replace 或 append" });
      return;
    }
    if (!PLAYLIST_MODES.has(playlistMode)) {
      res.status(400).json({ ok: false, error: "playlistMode 只能是 append 或 rewrite" });
      return;
    }
    if (!Array.isArray(body.tracks) || body.tracks.length === 0) {
      res.status(400).json({ ok: false, error: 'tracks 必须是非空数组' });
      return;
    }
    if (body.tracks.length > MAX_TRACKS) {
      res.status(400).json({ ok: false, error: `tracks 最多 ${MAX_TRACKS} 首` });
      return;
    }

    const wants = [];
    const failed = [];
    for (const raw of body.tracks) {
      const title = String(raw?.title || '').trim();
      const artist = String(raw?.artist || '').trim();
      const hint = String(raw?.hint || '').trim();
      if (!title) {
        failed.push({ title: '', artist, reason: 'title required' });
        continue;
      }
      wants.push({ title, artist, hint });
    }
    if (!wants.length) {
      res.status(400).json({ ok: false, error: 'tracks 里至少要有一首带 title 的歌', failed });
      return;
    }

    const resolved = await Promise.all(wants.map(async want => {
      const track = await resolveTrack(want);
      return { want, track };
    }));

    const matched = [];
    const queueItems = [];
    for (const { want, track } of resolved) {
      if (!track) {
        // resolveTrack 已经把失败写进 unmatched。
        failed.push({ title: want.title, artist: want.artist, reason: 'unmatched' });
        continue;
      }
      matched.push(matchedView(want, track));
      queueItems.push(toQueueItem(track));
    }

    const touchQueue = target === 'queue' || target === 'both';
    const touchPlaylist = target === 'kugou_playlist' || target === 'both';
    let queueResult = null;
    let playlistResult = null;

    if (touchQueue && queueItems.length) {
      const runtime = getRuntime();
      if (!runtime) {
        res.status(500).json({ ok: false, error: 'runtime 不可用' });
        return;
      }
      if (mode === 'replace') {
        runtime.queue = queueItems;
        runtime.index = 0;
        runtime.paused = false;
      } else {
        const wasEmpty = !Array.isArray(runtime.queue) || runtime.queue.length === 0;
        runtime.queue = [...(runtime.queue || []), ...queueItems];
        if (wasEmpty) {
          runtime.index = 0;
          runtime.paused = false;
        }
      }
      if (say) runtime.lastSay = say;
      for (const item of queueItems) {
        db.addPlay({
          kugouId: item.kugouId,
          title: item.title,
          artist: item.artist,
          reason: reason || null,
          source: 'bot',
        });
      }
      broadcast({ type: 'external-queue', mode, tracks: queueItems, say });
      broadcast({ type: 'state', runtime });
      queueResult = { mode, added: queueItems.length, length: runtime.queue.length };
    } else if (touchQueue) {
      queueResult = { mode, added: 0, length: getRuntime()?.queue?.length || 0 };
    }

    if (touchPlaylist) {
      const playlistTracks = resolved
        .filter(item => item.track)
        .map(item => item.track);
      playlistResult = await writeTracks({
        name: playlistName,
        mode: playlistMode,
        tracks: playlistTracks,
      });
    }

    const playlistFailed = Boolean(
      touchPlaylist && playlistResult && playlistResult.ok === false && !playlistResult.skipped,
    );
    // 歌单写入失败也返回 200，让 bot 看 body 里的 playlist.ok / failed，
    // 避免 HTTP 客户端自动重试把已经写进酷狗的歌再写一遍。
    res.status(200).json({
      ok: !playlistFailed,
      target,
      say,
      reason,
      matched,
      failed,
      queue: queueResult,
      playlist: playlistResult,
    });
  });
}
