// 已弃用：控制请用 POST /api/control，下个版本移除。
// 仅保留斜杠控制命令与外部模式提示，不再调用内置模型。
import { dbApi as defaultDb } from '../db.js';
import { route as defaultRoute } from '../router.js';
import { applyControl, EXTERNAL_CHAT_HINT } from '../playback-control.js';

export function mountChatRoute(app, deps = {}) {
  const routeMessage = deps.route || defaultRoute;
  const db = deps.db || defaultDb;
  const broadcast = typeof deps.broadcast === 'function' ? deps.broadcast : () => {};
  const getRuntime = typeof deps.getRuntime === 'function'
    ? deps.getRuntime
    : () => deps.runtime;
  const rememberVolume = typeof deps.rememberVolume === 'function' ? deps.rememberVolume : () => {};

  app.post('/api/chat', async (req, res) => {
    const message = String(req.body?.message || '').trim();
    if (!message) {
      res.status(400).json({ error: 'message required' });
      return;
    }

    const runtime = getRuntime();
    if (!runtime) {
      res.status(500).json({ error: 'runtime 不可用' });
      return;
    }

    db.addMessage('user', message);

    const intent = routeMessage(message);

    if (intent.intent === 'control') {
      const result = applyControl(runtime, { command: intent.command, arg: intent.arg, value: intent.arg });
      if (!result.ok) {
        const say = result.error || `(未实现的命令：${intent.command})`;
        db.addMessage('assistant', say);
        res.json({ say, queue: runtime.queue, reason: '', intent: intent.intent });
        return;
      }
      if (result.feedback) {
        try { db.addFeedback(result.feedback); } catch { /* 反馈写失败不影响控制 */ }
      }
      if (result.command === 'volume') {
        try { rememberVolume(result.volume, { force: true }); } catch { /* 音量记失败不影响这次控制 */ }
      }
      db.addMessage('assistant', `(control: ${intent.command}) ${result.say}`);
      broadcast({ type: 'state', runtime });
      res.json({
        say: result.say,
        queue: result.queue,
        index: result.index,
        paused: result.paused,
        volume: result.volume,
      });
      return;
    }

    if (intent.intent === 'unknown-command') {
      const say = `不认识的命令：/${intent.command}。试试 /skip /pause /play /toggle /vol N`;
      db.addMessage('assistant', say);
      res.json({ say, queue: [], reason: '', intent: intent.intent });
      return;
    }

    const say = EXTERNAL_CHAT_HINT;
    db.addMessage('assistant', say);
    res.json({ say, queue: [], reason: '', intent: 'chat', brain: 'external' });
  });
}
