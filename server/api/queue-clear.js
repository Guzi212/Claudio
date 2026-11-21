import { clearQueue } from '../queue-clear.js';

/**
 * 正式清空入口。POST /api/queue/clear 与 DELETE /api/queue 语义完全一致。
 *
 * 广播的 state 不带 origin / clientId：清空必须让所有客户端一起停声，
 * 任何页面都不能把这条广播当成自己的回声而跳过。
 */
export function mountQueueClearRoutes(app, deps = {}) {
  const getRuntime = typeof deps.getRuntime === 'function'
    ? deps.getRuntime
    : () => deps.runtime;
  const broadcast = typeof deps.broadcast === 'function' ? deps.broadcast : () => {};

  const handler = (req, res) => {
    const runtime = getRuntime();
    if (!runtime) {
      res.status(500).json({ ok: false, error: 'runtime 不可用' });
      return;
    }
    const body = req.body || {};
    const result = clearQueue(runtime, { reason: body.reason });
    if (!result.ok) {
      res.status(result.status || 500).json(result);
      return;
    }
    broadcast({ type: 'state', runtime });
    res.json(result);
  };

  app.post('/api/queue/clear', handler);
  app.delete('/api/queue', handler);
}
