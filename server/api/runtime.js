import { playbackStatus, queueFinished } from '../playback-control.js';
import { applyRuntimePlayback, reportedQueueIndex } from '../queue-source.js';
import { stateBroadcast } from '../runtime-events.js';
import { continueFromPool } from '../continue-pool.js';

export function mountRuntimeRoutes(app, { runtime, broadcast, db, statusOptions = () => ({}) }) {
  for (const path of ['/api/status', '/api/now']) {
    app.get(path, (_req, res) => res.json(playbackStatus(runtime, statusOptions())));
  }
  // 用绝对位置和曲目引用识别同一轮队列，裁剪/追加换数组不会丢掉边界。
  let boundary = null;
  const guard = () => boundary && runtime.queue[boundary.index - (runtime.queueOffset || 0)] === boundary.track
    ? boundary : null;

  function finish(req, res, stale = false) {
    const continued = queueFinished(runtime) && continueFromPool(runtime, { db });
    if (continued) boundary = {
      track: runtime.queue[runtime.index],
      index: runtime.index + (runtime.queueOffset || 0),
      awaitingPlayback: true,
    };
    // 续播是服务端的新播放指令，不能让报告 ended 的页面把它当作自己的回声。
    broadcast(stateBroadcast(runtime, continued ? undefined : req.body?.clientId));
    res.json({ ok: true, index: runtime.index, queueOffset: runtime.queueOffset || 0, paused: playbackStatus(runtime).paused, continued, stale });
  }

  app.post('/api/runtime/state', (req, res) => {
    const { paused, ended } = req.body || {};
    const index = reportedQueueIndex(runtime, req.body);
    const absolute = index + (runtime.queueOffset || 0);
    const edge = guard();
    const stale = index < 0 || (edge && ((ended === true && (!Number.isInteger(index) || absolute < edge.index))
      || (edge.awaitingPlayback && typeof index === 'number' && absolute < edge.index)));
    if (!stale) {
      applyRuntimePlayback(runtime, { index, paused, ended });
      if (edge && ended === false && paused === false && index === runtime.index) edge.awaitingPlayback = false;
    }
    finish(req, res, Boolean(stale));
  });

  app.post('/api/runtime/advance', (req, res) => {
    const explicit = reportedQueueIndex(runtime, req.body);
    const edge = guard();
    if (explicit < 0) return finish(req, res, true);
    if (typeof explicit === 'number' && Number.isFinite(explicit)) {
      applyRuntimePlayback(runtime, { index: explicit, ended: false });
    } else if (!edge?.awaitingPlayback) {
      if (runtime.index < runtime.queue.length - 1) {
        applyRuntimePlayback(runtime, { index: runtime.index + 1, ended: false });
      } else if (runtime.queue.length) {
        applyRuntimePlayback(runtime, { paused: true, ended: true });
      }
    }
    finish(req, res);
  });
}
