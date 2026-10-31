import { playbackStatus, queueFinished } from '../playback-control.js';
import { applyRuntimePlayback } from '../queue-source.js';
import { stateBroadcast } from '../runtime-events.js';
import { continueFromPool } from '../continue-pool.js';

export function mountRuntimeRoutes(app, { runtime, broadcast, db, statusOptions = () => ({}) }) {
  for (const path of ['/api/status', '/api/now']) {
    app.get(path, (_req, res) => res.json(playbackStatus(runtime, statusOptions())));
  }
  // 不裁剪队列，因此续播前的索引可以作为迟到结束报告的边界。
  let boundary = null;
  const guard = () => boundary?.queue === runtime.queue ? boundary : null;

  function finish(req, res, stale = false) {
    const continued = queueFinished(runtime) && continueFromPool(runtime, { db });
    if (continued) boundary = { queue: runtime.queue, index: runtime.index, awaitingPlayback: true };
    // 续播是服务端的新播放指令，不能让报告 ended 的页面把它当作自己的回声。
    broadcast(stateBroadcast(runtime, continued ? undefined : req.body?.clientId));
    res.json({ ok: true, index: runtime.index, paused: playbackStatus(runtime).paused, continued, stale });
  }

  app.post('/api/runtime/state', (req, res) => {
    const { index, paused, ended } = req.body || {};
    const edge = guard();
    const stale = edge && ((ended === true && (!Number.isInteger(index) || index < edge.index))
      || (edge.awaitingPlayback && typeof index === 'number' && index < edge.index));
    if (!stale) {
      applyRuntimePlayback(runtime, { index, paused, ended });
      if (edge && ended === false && paused === false && index === runtime.index) edge.awaitingPlayback = false;
    }
    finish(req, res, Boolean(stale));
  });

  app.post('/api/runtime/advance', (req, res) => {
    const explicit = req.body?.index;
    const edge = guard();
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
