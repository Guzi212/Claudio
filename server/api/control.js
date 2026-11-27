import { dbApi as defaultDb } from '../db.js';
import { applyControl, SCENE_PREF_KEY } from '../playback-control.js';

const CLIENT_CONTROL_COMMANDS = new Set(['play', 'pause', 'toggle', 'next', 'prev', 'jump', 'volume']);

export function mountControlRoute(app, deps = {}) {
  const db = deps.db || defaultDb;
  const broadcast = typeof deps.broadcast === 'function' ? deps.broadcast : () => {};
  const sendToClient = typeof deps.sendToClient === 'function' ? deps.sendToClient : () => 0;
  const getRuntime = typeof deps.getRuntime === 'function'
    ? deps.getRuntime
    : () => deps.runtime;
  const rememberVolume = typeof deps.rememberVolume === 'function' ? deps.rememberVolume : () => {};

  app.post('/api/control', (req, res) => {
    const body = req.body || {};
    const targetClientId = typeof body.targetClientId === 'string' ? body.targetClientId.trim().slice(0, 80) : '';
    if (targetClientId) {
      const command = String(body.command || '').trim().toLowerCase();
      if (!CLIENT_CONTROL_COMMANDS.has(command)) {
        res.status(400).json({ ok: false, error: `不支持的定向指令: ${command || '(empty)'}` });
        return;
      }
      const say = typeof body.say === 'string' ? body.say.trim().slice(0, 300) : '';
      const delivered = sendToClient(targetClientId, {
        type: 'client-control',
        targetClientId,
        command,
        value: body.value ?? body.arg,
        ...(say ? { say } : {}),
      });
      res.json({ ok: true, command, targetClientId, delivered });
      return;
    }

    const runtime = getRuntime();
    if (!runtime) {
      res.status(500).json({ ok: false, error: 'runtime 不可用' });
      return;
    }
    if (body.agentId || body.agentName) {
      const id = String(body.agentId || body.agentName).trim().slice(0, 60);
      const name = String(body.agentName || body.agentId).trim().slice(0, 60);
      if (id) {
        runtime.activeAgent = { id, name: name || id, updatedAt: new Date().toISOString() };
      }
    }
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
      try {
        db.addVolumeObservation?.({
          volume: result.volume,
          trigger: body.trigger === 'adaptive' ? 'adaptive' : 'manual',
        });
      } catch { /* 音量观察失败不影响控制 */ }
    }
    if (result.command === 'scene') {
      try {
        if (result.scene?.id === 'auto') db.delPref?.(SCENE_PREF_KEY);
        else db.setPref?.(SCENE_PREF_KEY, JSON.stringify(result.scene));
      } catch { /* 场景落盘失败不影响控制 */ }
    }
    broadcast({ type: 'state', runtime });
    res.json(result);
  });
}
