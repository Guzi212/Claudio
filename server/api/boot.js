// 开机电台。Claude 推荐要等几秒，这期间外部点歌可能已经写入 runtime。
// 所以是否覆盖队列，必须等 ask 回来之后再看 hasActiveExternalQueue。
import { dbApi as defaultDb } from '../db.js';
import { buildSystemPrompt as defaultBuildSystemPrompt } from '../context.js';
import { ask as defaultAsk } from '../claude.js';
import { hasActiveExternalQueue, markQueueSource } from '../queue-source.js';
import { brainMode } from '../brain.js';

export const BOOT_MSG = '刚打开电台，请根据现在的时间和天气推荐开播曲目';
export const PRESERVE_EXTERNAL_SAY = '外部点歌还在播，开机电台先不换歌';

export function mountBootRoute(app, deps = {}) {
  const ask = deps.ask || defaultAsk;
  const buildSystemPrompt = deps.buildSystemPrompt || defaultBuildSystemPrompt;
  const db = deps.db || defaultDb;
  const broadcast = typeof deps.broadcast === 'function' ? deps.broadcast : () => {};
  const getRuntime = typeof deps.getRuntime === 'function'
    ? deps.getRuntime
    : () => deps.runtime;
  const getBrain = typeof deps.brain === 'function'
    ? deps.brain
    : () => deps.brain || brainMode();

  app.post('/api/boot', async (req, res) => {
    const runtime = getRuntime();
    if (!runtime) {
      res.status(500).json({ error: 'runtime 不可用' });
      return;
    }

    // 默认 external：不开机选歌，也不调用 Claude。
    if (getBrain() !== 'internal') {
      const waiting = !Array.isArray(runtime.queue) || runtime.queue.length === 0;
      res.json({
        say: waiting ? '等待点歌' : (runtime.lastSay || ''),
        queue: runtime.queue || [],
        index: runtime.index || 0,
        queueOffset: runtime.queueOffset || 0,
        reason: runtime.lastReason || '',
        intent: 'boot',
        brain: 'external',
        skipped: true,
        _resolveError: false,
      });
      return;
    }

    try {
      const systemPrompt = await buildSystemPrompt();
      const { say, queue: songQueue, reason, raw } = await ask(systemPrompt, BOOT_MSG);

      if (hasActiveExternalQueue(runtime)) {
        const hint = PRESERVE_EXTERNAL_SAY;
        runtime.lastSay = hint;
        db.addMessage('user', BOOT_MSG);
        db.addMessage('assistant', hint);
        broadcast({ type: 'state', runtime });
        res.json({
          say: hint,
          queue: runtime.queue,
          index: runtime.index,
          queueOffset: runtime.queueOffset || 0,
          reason: '',
          intent: 'boot',
          skipped: true,
          preserved: 'external',
          _resolveError: false,
        });
        return;
      }

      if (songQueue.length > 0) {
        runtime.queue = songQueue;
        runtime.queueOffset = 0;
        runtime.index = 0;
        runtime.paused = false;
        markQueueSource(runtime, 'boot');
        for (const q of songQueue) {
          db.addPlay({ kugouId: q.kugouId, title: q.title, artist: q.artist, reason, source: 'boot' });
        }
      }
      runtime.lastSay = say;
      db.addMessage('user', BOOT_MSG);
      db.addMessage('assistant', say);
      broadcast({ type: 'state', runtime });

      const _resolveError = Array.isArray(raw?.play) && raw.play.length > 0 && songQueue.length === 0;
      res.json({
        say,
        queue: songQueue,
        index: runtime.index,
        queueOffset: runtime.queueOffset || 0,
        reason,
        intent: 'boot',
        _resolveError,
      });
    } catch (err) {
      console.error('[boot] error:', err);
      res.status(500).json({ error: err.message });
    }
  });
}
