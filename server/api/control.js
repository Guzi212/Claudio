import { dbApi as defaultDb } from '../db.js';
import { applyControl } from '../playback-control.js';

export function mountControlRoute(app, deps = {}) {
  const db = deps.db || defaultDb;
  const broadcast = typeof deps.broadcast === 'function' ? deps.broadcast : () => {};
  const getRuntime = typeof deps.getRuntime === 'function'
    ? deps.getRuntime
    : () => deps.runtime;
  const rememberVolume = typeof deps.rememberVolume === 'function' ? deps.rememberVolume : () => {};

  app.post('/api/control', (req, res) => {
    const runtime = getRuntime();
    if (!runtime) {
      res.status(500).json({ ok: false, error: 'runtime 不可用' });
      return;
    }
    const body = req.body || {};
    const result = applyControl(runtime, {
      command: body.command,
      value: body.value,
      arg: body.value,
    });
    if (!result.ok) {
      res.status(result.status || 400).json(result);
      return;
    }
    if (result.feedback) {
      try { db.addFeedback(result.feedback); } catch { /* 反馈写失败不影响控制 */ }
    }
    if (result.command === 'volume') {
      try { rememberVolume(result.volume, { force: true }); } catch { /* 音量记失败不影响这次控制 */ }
    }
    broadcast({ type: 'state', runtime });
    res.json(result);
  });
}
