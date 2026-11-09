// 常驻主持人：盯着队列，快放完就自己补一批，顺手把品味学下来。
//
// 它不接管播放，只往队尾接歌（append），所以不会打断正在放的那首。
// 外部 bot（飞书里的我、手动点歌）随时能插进来：投过歌之后 3 分钟内它让位。
import { ask as defaultAsk, complete as defaultComplete } from '../claude.js';
import { buildSystemPrompt as defaultBuildSystemPrompt } from '../context.js';
import { dbApi as defaultDb } from '../db.js';
import { synthesize as defaultSynthesize } from '../tts.js';
import { normalizeForMatch } from '../services/kugou.js';
import { markQueueSource } from '../queue-source.js';
import {
  updateLearnedTaste,
  readTasteState,
  writeTasteState,
  trackKey,
} from './taste-memory.js';

export const DJ_SOURCE = 'resident-dj';

export const DJ_DEFAULTS = {
  tickMs: 20_000,          // 多久看一眼队列
  refillBelowSeconds: 600, // 剩余不足 10 分钟就补
  batchSize: 5,            // 一次补几首
  yieldMs: 180_000,        // 外部刚投过歌，多久内让位
  cooldownMs: 90_000,      // 失败后多久再试
  recentLimit: 25,         // 去重时看最近多少首
  tasteEveryPlays: 15,     // 新增多少条播放后重新蒸馏品味
  tasteMinIntervalMs: 6 * 3_600_000,
  tasteDays: 30,
};

function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function readDjOptions(env = process.env) {
  return {
    tickMs: envNumber('CLAUDIO_DJ_TICK_MS', DJ_DEFAULTS.tickMs),
    refillBelowSeconds: envNumber('CLAUDIO_DJ_REFILL_BELOW', DJ_DEFAULTS.refillBelowSeconds),
    batchSize: envNumber('CLAUDIO_DJ_BATCH', DJ_DEFAULTS.batchSize),
    yieldMs: envNumber('CLAUDIO_DJ_YIELD_MS', DJ_DEFAULTS.yieldMs),
  };
}

export function djEnabled(env = process.env) {
  const raw = String(env?.CLAUDIO_DJ ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

/** 队列里还剩多少秒。TTS 和没时长的条目按 0 算。 */
export function queueRemainingSeconds(runtime) {
  const queue = Array.isArray(runtime?.queue) ? runtime.queue : [];
  const index = Number.isFinite(runtime?.index) ? runtime.index : 0;
  const currentTime = Number(runtime?.currentTime) || 0;
  let total = 0;
  for (let i = Math.max(0, index); i < queue.length; i += 1) {
    const d = Number(queue[i]?.duration);
    if (Number.isFinite(d) && d > 0) total += d;
  }
  return Math.max(0, total - currentTime);
}

/**
 * 该不该补歌。返回 {ok, reason}，reason 用于日志和 /api/dj/status。
 */
export function shouldRefill(runtime, {
  refillBelowSeconds = DJ_DEFAULTS.refillBelowSeconds,
  yieldMs = DJ_DEFAULTS.yieldMs,
  now = Date.now(),
} = {}) {
  if (!runtime) return { ok: false, reason: 'no-runtime' };
  if (!runtime.active) return { ok: false, reason: 'inactive' };
  if (runtime.paused) return { ok: false, reason: 'paused' };

  const queuedAt = runtime.queuedAt ? Date.parse(runtime.queuedAt) : NaN;
  const freshlyExternal = Number.isFinite(queuedAt)
    && now - queuedAt < yieldMs
    && runtime.queuedSource !== DJ_SOURCE;
  if (freshlyExternal) return { ok: false, reason: 'external-active' };

  const queue = Array.isArray(runtime.queue) ? runtime.queue : [];
  if (!queue.length) return { ok: true, reason: 'empty' };

  const remaining = queueRemainingSeconds(runtime);
  if (remaining > refillBelowSeconds) return { ok: false, reason: 'enough' };
  return { ok: true, reason: 'low', remaining };
}

export function buildRefillPrompt({ remainingSeconds = 0, batchSize = 5, recent = [] } = {}) {
  const minutes = Math.max(0, Math.round(remainingSeconds / 60));
  const recentLines = recent.length
    ? recent.slice(0, 20).map(p => `  · ${p.title} — ${p.artist}`).join('\n')
    : '  （还没有）';
  return [
    `【自动续播】队列里大概还剩 ${minutes} 分钟。`,
    `接着排 ${batchSize} 首，保持现在的氛围。`,
    '',
    '下面是他最近听过的，**一首都不要出现在这次 play 里**，也不要给同名的 live / 翻唱 / 钢琴改编版：',
    recentLines,
    '',
    '从你自己的音乐知识里找没出现过的曲目，宁可换一个相近的作曲家和风格，也不要重复上面的。',
    'say 用一两句话顺口接上，像电台里换气，不要写成节目介绍或歌单推荐文案。',
    `play 给满 ${batchSize} 首，reason 写 5 字以内的氛围标签。`,
  ].join('\n');
}

/** 去掉最近播过的和本批里重复的。 */
export function pickFreshTracks(queue, recentKeys) {
  const seen = new Set(recentKeys instanceof Set ? recentKeys : []);
  const out = [];
  for (const t of Array.isArray(queue) ? queue : []) {
    const title = String(t?.title || '').trim();
    if (!title) continue;
    const k = trackKey(title, t.artist);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** 两段文本是否指同一个东西：包含关系，或字符重叠 60% 以上（容忍繁简、后缀差异）。 */
function similarText(a, b) {
  if (!a || !b) return true;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const setA = new Set([...a]);
  const hit = [...b].filter(c => setA.has(c)).length;
  return hit / Math.max(a.length, b.length) >= 0.6;
}

/** 解析结果和模型要的是不是同一首。resolveTrack 偶尔张冠李戴，宁可少补也不要投错。 */
export function isFaithfulMatch(track) {
  const gotTitle = normalizeForMatch(track?.title || '');
  if (!gotTitle) return false;
  if (!similarText(gotTitle, normalizeForMatch(track?.requested?.title || ''))) return false;

  const wantArtist = normalizeForMatch(track?.requested?.artist || '');
  const gotArtist = normalizeForMatch(track?.artist || '');
  if (wantArtist && gotArtist && !similarText(gotArtist, wantArtist)) return false;

  return true;
}

function toQueueItem(track, { queuedAt, reason }) {
  const item = {
    title: track.title,
    artist: track.artist || '',
    album: track.album || '',
    duration: Number(track.duration) || 0,
    kugouId: track.kugouId || '',
    audioUrl: track.audioUrl || null,
    comment: track.comment || '',
    source: DJ_SOURCE,
    queuedAt,
  };
  if (track.requested) item.requested = track.requested;
  if (track.cover) item.cover = track.cover;
  if (reason) item.reason = reason;
  return item;
}

/**
 * 启动常驻主持人。
 * 依赖全部可注入，测试里塞 fake runtime / fake ask 就能跑。
 */
export function startResidentDj({
  runtime,
  broadcast = () => {},
  log = (...args) => console.log('[dj]', ...args),
  ask = defaultAsk,
  complete = defaultComplete,
  buildSystemPrompt = defaultBuildSystemPrompt,
  db = defaultDb,
  synthesize = defaultSynthesize,
  rootDir,
  now = () => Date.now(),
  options = {},
} = {}) {
  if (!runtime) throw new Error('startResidentDj 需要 runtime');

  const cfg = { ...DJ_DEFAULTS, ...readDjOptions(), ...options };
  const state = {
    startedAt: new Date(now()).toISOString(),
    refillCount: 0,
    lastRefillAt: null,
    lastRefillTracks: 0,
    lastError: null,
    lastDecision: null,
    inflight: false,
    lastAttemptAt: 0,
    tasteLearnedAt: null,
    tastePlayCount: 0,
    tasteError: null,
  };

  let timer = null;
  let stopped = false;

  async function maybeLearnTaste({ force = false } = {}) {
    try {
      const plays = db.recentPlays(1);
      const latestId = Number(plays[0]?.id) || 0;
      const prev = readTasteState(db);
      const lastId = Number(prev.lastPlayId) || 0;
      const lastTs = Number(prev.lastTs) || 0;
      const enoughNew = latestId - lastId >= cfg.tasteEveryPlays;
      const enoughTime = now() - lastTs >= cfg.tasteMinIntervalMs;
      if (!force && !(enoughNew && enoughTime)) return { ok: false, reason: 'not-due' };

      const result = await updateLearnedTaste({
        db,
        complete,
        rootDir,
        now: now(),
        days: cfg.tasteDays,
        log,
      });
      if (result.ok) {
        writeTasteState(db, { lastPlayId: latestId, lastTs: now() });
        state.tasteLearnedAt = new Date(now()).toISOString();
        state.tastePlayCount = result.stats?.totalPlays ?? 0;
        state.tasteError = null;
      } else {
        state.tasteError = result.reason || 'failed';
      }
      return result;
    } catch (err) {
      state.tasteError = err.message;
      log(`taste learn failed: ${err.message}`);
      return { ok: false, reason: 'error', error: err.message };
    }
  }

  async function doRefill({ trigger = 'auto' } = {}) {
    if (state.inflight) return { ok: false, reason: 'inflight' };
    state.inflight = true;
    state.lastAttemptAt = now();
    try {
      const systemPrompt = await buildSystemPrompt();
      const recent = db.recentPlays(cfg.recentLimit) || [];
      const recentKeys = new Set(recent.map(p => trackKey(p.title, p.artist)));
      const remaining = queueRemainingSeconds(runtime);
      const userMessage = buildRefillPrompt({
        remainingSeconds: remaining,
        batchSize: cfg.batchSize,
        recent,
      });

      const { say, queue, reason } = await ask(systemPrompt, userMessage);
      const deduped = pickFreshTracks(queue, recentKeys);
      const fresh = deduped.filter(isFaithfulMatch);
      const dupDropped = (queue || []).length - deduped.length;
      const unfaithfulDropped = deduped.length - fresh.length;
      if (!fresh.length) {
        state.lastError = 'no-fresh-tracks';
        log(`refill skipped: ${dupDropped} 首重复、${unfaithfulDropped} 首解析对不上`);
        return { ok: false, reason: 'no-fresh-tracks' };
      }
      if (dupDropped || unfaithfulDropped) {
        log(`refill: 丢弃 ${dupDropped} 首重复、${unfaithfulDropped} 首解析对不上`);
      }

      const queuedAt = new Date(now()).toISOString();
      const items = fresh.map(t => toQueueItem(t, { queuedAt, reason }));

      if (say) {
        try {
          const voice = await synthesize(say);
          if (voice?.url) {
            items.unshift({
              title: '🔊 ' + say.slice(0, 40),
              artist: 'Claudio',
              album: '',
              duration: 0,
              kugouId: '',
              audioUrl: voice.url,
              comment: '',
              source: DJ_SOURCE,
              queuedAt,
              isTts: true,
            });
          }
        } catch (err) {
          log(`tts skipped: ${err.message}`);
        }
      }

      const wasEmpty = !Array.isArray(runtime.queue) || runtime.queue.length === 0;
      runtime.queue = [...(runtime.queue || []), ...items];
      if (wasEmpty) {
        runtime.index = 0;
        runtime.paused = false;
        markQueueSource(runtime, 'bot');
      } else {
        runtime.queueSource = 'bot';
      }
      if (say) runtime.lastSay = say;
      if (reason) runtime.lastReason = reason;
      runtime.queuedAt = queuedAt;
      runtime.queuedSource = DJ_SOURCE;

      for (const item of items) {
        if (item.isTts) continue;
        db.addPlay({
          kugouId: item.kugouId || null,
          title: item.title,
          artist: item.artist,
          reason: reason || null,
          source: 'bot',
        });
      }

      broadcast({ type: 'external-queue', mode: 'append', tracks: items, say, reason, queuedAt, source: DJ_SOURCE });
      broadcast({ type: 'state', runtime });

      state.refillCount += 1;
      state.lastRefillAt = queuedAt;
      state.lastRefillTracks = items.filter(i => !i.isTts).length;
      state.lastError = null;
      log(`refill(${trigger}): +${state.lastRefillTracks} 首，剩 ${Math.round(queueRemainingSeconds(runtime) / 60)} 分钟`);
      return {
        ok: true,
        added: state.lastRefillTracks,
        say,
        reason,
        trigger,
        tracks: items.filter(i => !i.isTts).map(t => ({
          title: t.title,
          artist: t.artist,
          requested: t.requested || null,
        })),
      };
    } catch (err) {
      state.lastError = err.message;
      log(`refill failed: ${err.message}`);
      return { ok: false, reason: 'error', error: err.message };
    } finally {
      state.inflight = false;
    }
  }

  async function tick() {
    if (stopped) return;
    const decision = shouldRefill(runtime, { ...cfg, now: now() });
    state.lastDecision = decision.reason;
    if (!decision.ok) return;
    if (now() - state.lastAttemptAt < cfg.cooldownMs) return;
    await doRefill({ trigger: 'auto' });
    await maybeLearnTaste();
  }

  timer = setInterval(() => { tick().catch(err => log(`tick error: ${err.message}`)); }, cfg.tickMs);
  if (typeof timer.unref === 'function') timer.unref();
  log(`常驻主持人已启动：每 ${Math.round(cfg.tickMs / 1000)}s 看一次，剩余不足 ${Math.round(cfg.refillBelowSeconds / 60)} 分钟补 ${cfg.batchSize} 首`);

  return {
    state,
    config: cfg,
    tick,
    refill: doRefill,
    learnTaste: maybeLearnTaste,
    status() {
      return {
        enabled: true,
        startedAt: state.startedAt,
        refillCount: state.refillCount,
        lastRefillAt: state.lastRefillAt,
        lastRefillTracks: state.lastRefillTracks,
        lastError: state.lastError,
        lastDecision: state.lastDecision,
        inflight: state.inflight,
        remainingSeconds: queueRemainingSeconds(runtime),
        tasteLearnedAt: state.tasteLearnedAt,
        tastePlayCount: state.tastePlayCount,
        tasteError: state.tasteError,
        config: {
          tickMs: cfg.tickMs,
          refillBelowSeconds: cfg.refillBelowSeconds,
          batchSize: cfg.batchSize,
          yieldMs: cfg.yieldMs,
        },
      };
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      log('常驻主持人已停止');
    },
  };
}

export default { startResidentDj, shouldRefill, queueRemainingSeconds, buildRefillPrompt, pickFreshTracks, djEnabled, DJ_SOURCE };
