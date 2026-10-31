// 聊天点歌。这是用户自己说的，允许覆盖还没放完的外部队列。
import { dbApi as defaultDb } from '../db.js';
import { route as defaultRoute } from '../router.js';
import { buildSystemPrompt as defaultBuildSystemPrompt } from '../context.js';
import { ask as defaultAsk } from '../claude.js';
import { synthesize as defaultSynthesize } from '../tts.js';
import { detectSignal as defaultDetectSignal, appendJournalEntry as defaultAppendJournal } from '../services/journal.js';
import { markQueueSource } from '../queue-source.js';
import { brainMode } from '../brain.js';
import { applyControl, EXTERNAL_CHAT_HINT } from '../playback-control.js';

export function mountChatRoute(app, deps = {}) {
  const ask = deps.ask || defaultAsk;
  const buildSystemPrompt = deps.buildSystemPrompt || defaultBuildSystemPrompt;
  const synthesize = deps.synthesize || defaultSynthesize;
  const routeMessage = deps.route || defaultRoute;
  const detectSignal = deps.detectSignal || defaultDetectSignal;
  const appendJournalEntry = deps.appendJournalEntry || defaultAppendJournal;
  const db = deps.db || defaultDb;
  const broadcast = typeof deps.broadcast === 'function' ? deps.broadcast : () => {};
  const getRuntime = typeof deps.getRuntime === 'function'
    ? deps.getRuntime
    : () => deps.runtime;
  const getBrain = typeof deps.brain === 'function'
    ? deps.brain
    : () => deps.brain || brainMode();
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

    // external：普通文字不选歌，也不调用 Claude。
    if (getBrain() !== 'internal') {
      const say = EXTERNAL_CHAT_HINT;
      db.addMessage('assistant', say);
      res.json({ say, queue: [], reason: '', intent: 'chat', brain: 'external' });
      return;
    }

    // internal chat: 走 Claude 子进程
    try {
      const systemPrompt = await buildSystemPrompt();
      const { say, queue: songQueue, reason, raw } = await ask(systemPrompt, message);

      // fire-and-forget：信号检测 + 日志追加，不阻塞响应
      try {
        const recentPlays = db.recentPlays(8);
        const signal = detectSignal(message, recentPlays, new Date());
        if (signal) appendJournalEntry(signal);
      } catch { /* 日志写入失败不影响主流程 */ }

      // 把 say 合成语音放队首（Fish Audio 未配置时 synthesize 返 null，自动降级）
      const voice = say ? await synthesize(say) : null;
      const ttsTrack = voice ? {
        title: '🔊 ' + say.slice(0, 40),
        artist: 'Claudio',
        audioUrl: voice.url,
        isTts: true,
        duration: 0,
      } : null;

      const finalQueue = ttsTrack ? [ttsTrack, ...songQueue] : songQueue;

      if (finalQueue.length > 0) {
        runtime.queue = finalQueue;
        runtime.queueOffset = 0;
        runtime.index = 0;
        runtime.paused = false;
        markQueueSource(runtime, 'claude');
        // 只把真正的歌写入历史（跳过 TTS 串场条）
        for (const q of finalQueue) {
          if (q.isTts) continue;
          db.addPlay({
            kugouId: q.kugouId, title: q.title, artist: q.artist,
            reason, source: 'claude',
          });
        }
      }
      runtime.lastSay = say;

      db.addMessage('assistant', say);
      broadcast({ type: 'state', runtime });

      const _resolveError = Array.isArray(raw?.play) && raw.play.length > 0 && songQueue.length === 0;
      res.json({ say, queue: finalQueue, reason, intent: 'chat', _raw: raw, _resolveError });
    } catch (err) {
      console.error('[chat] error:', err);
      res.status(500).json({ error: err.message });
    }
  });
}
