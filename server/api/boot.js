// 开机电台。Claude 推荐要等几秒，这期间外部点歌可能已经写入 runtime。
// 所以是否覆盖队列，必须等 ask 回来之后再看 hasActiveExternalQueue。
import { dbApi as defaultDb } from '../db.js';
import { buildSystemPrompt as defaultBuildSystemPrompt } from '../context.js';
import { ask as defaultAsk } from '../claude.js';
import { hasActiveExternalQueue, markQueueSource, queueEpochOf } from '../queue-source.js';
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
      const startedEpoch = queueEpochOf(runtime);
      // 用户明确清空过：开机电台不自动回填，等下一次明确点歌。
      if (runtime.continueSuppressed) {
        res.json({
          say: '等待点歌',
          queue: runtime.queue || [],
          index: runtime.index || 0,
          queueOffset: runtime.queueOffset || 0,
          reason: 'cleared',
          intent: 'boot',
          brain: 'internal',
          skipped: true,
          preserved: 'cleared',
          _resolveError: false,
        });
        return;
      }
      const systemPrompt = await buildSystemPrompt();
      const { say, queue: songQueue, reason, raw } = await ask(systemPrompt, BOOT_MSG);

      // 外部点歌在等待期间写入：即使 epoch 变了，也优先按「外部队列还在播」处理。
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

      // clear 之后、或等待期间被别的明确点歌换了队列：开机电台都不回填。
      if (runtime.continueSuppressed || queueEpochOf(runtime) !== startedEpoch) {
        const hasQueue = Array.isArray(runtime.queue) && runtime.queue.length > 0;
        broadcast({ type: 'state', runtime });
        res.json({
          say: hasQueue ? (runtime.lastSay || '队列已更新，开机电台先不换歌') : '等待点歌',
          queue: runtime.queue,
          index: runtime.index,
          queueOffset: runtime.queueOffset || 0,
          reason: hasQueue ? '' : 'cleared',
          intent: 'boot',
          brain: 'internal',
          skipped: true,
          preserved: hasQueue ? 'changed' : 'cleared',
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
