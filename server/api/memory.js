import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbApi as defaultDb } from '../db.js';
import { inferTrackFeatures } from '../memory/track-features.js';
import { getContextSuggestion, syncLearnedTraits } from '../memory/learner.js';
import { resolveReadUserFile } from '../services/user-files.js';
import * as defaultSettings from '../services/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, '../..');
const DAY_MS = 86_400_000;
const VALID_TRAIT_STATUS = new Set(['active', 'pinned', 'dismissed']);
const VALID_OUTCOMES = new Set(['playing', 'completed', 'skipped', 'disliked', 'interrupted']);

function parsePositiveId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * 挂载统一记忆系统接口 `/api/memory/*`，供 UI 与任意外部/内置 Agent 共享读写用户品味与习惯。
 */
export function mountMemoryRoutes(app, deps = {}) {
  const db = deps.db || defaultDb;
  const rootDir = deps.rootDir || DEFAULT_ROOT;
  const getRuntime = typeof deps.getRuntime === 'function' ? deps.getRuntime : () => deps.runtime;
  const getSetting = typeof deps.getSetting === 'function' ? deps.getSetting : defaultSettings.get;
  const broadcast = typeof deps.broadcast === 'function' ? deps.broadcast : () => {};
  const nowFn = typeof deps.now === 'function' ? deps.now : () => Date.now();

  app.get('/api/memory/brief', (req, res) => {
    try {
      const days = Math.max(1, Math.min(90, Number(req.query?.days) || 30));
      const baseNow = nowFn();
      const targetDate = new Date(baseNow);
      if (req.query?.hour != null && req.query.hour !== '' && Number.isFinite(Number(req.query.hour))) {
        const h = Math.max(0, Math.min(23, Math.trunc(Number(req.query.hour))));
        targetDate.setHours(h, 0, 0, 0);
      }
      const targetTs = targetDate.getTime();
      const since = baseNow - days * DAY_MS;

      const tasteText = resolveReadUserFile(rootDir, 'user/taste.md').content;
      const learnedText = resolveReadUserFile(rootDir, 'user/taste.learned.md').content;
      const sessions = db.recentPlaybackSessions?.({ sinceTs: since, limit: 500 }) || [];
      const volumeObs = db.recentVolumeObservations?.({ sinceTs: since, limit: 500 }) || [];
      const feedback = db.recentFeedback?.(100) || [];
      const traits = db.listMemoryTraits?.({ includeDismissed: false }) || [];
      const safeMaxRaw = Number(getSetting('volume_safe_max'));
      const safeMaxVolume = Number.isFinite(safeMaxRaw) && safeMaxRaw > 0 ? Math.min(100, safeMaxRaw) : 85;

      const context = getContextSuggestion({
        sessions,
        volumeObs,
        feedback,
        traits,
        tasteText,
        now: targetTs,
        safeMaxVolume,
      });

      const activeIntent = db.getActiveSessionIntent?.({ now: baseNow }) || null;
      const runtime = getRuntime?.();

      res.json({
        ok: true,
        generatedAt: new Date(baseNow).toISOString(),
        activeAgent: runtime?.activeAgent || null,
        activeIntent,
        context,
        traits,
        avoided: context.avoided,
        tasteSummary: {
          handWrittenLength: tasteText.length,
          learnedLength: learnedText.length,
          sessionCount: sessions.length,
          volumeSampleCount: volumeObs.length,
        },
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/memory/traits', (req, res) => {
    const includeDismissed = req.query?.includeDismissed === '1' || req.query?.includeDismissed === 'true';
    const traits = db.listMemoryTraits?.({ includeDismissed }) || [];
    res.json({ ok: true, traits });
  });

  app.post('/api/memory/traits', (req, res) => {
    const body = req.body || {};
    const summary = String(body.summary || '').trim().slice(0, 240);
    if (!summary) {
      res.status(400).json({ ok: false, error: 'summary 必填' });
      return;
    }
    const kind = String(body.kind || 'preference').trim().slice(0, 40) || 'preference';
    const scope = String(body.scope || 'global').trim().slice(0, 40) || 'global';
    const status = body.status === 'active' ? 'active' : 'pinned';
    const weight = Number.isFinite(Number(body.weight)) ? Number(body.weight) : 1.2;
    const evidence = String(body.evidence || '用户直接补充').trim().slice(0, 200);

    const trait = db.upsertMemoryTrait({
      kind,
      scope,
      summary,
      evidence,
      confidence: 1.0,
      weight,
      source: 'user',
      status,
      updatedTs: nowFn(),
    });
    res.status(201).json({ ok: true, trait });
  });

  app.patch('/api/memory/traits/:id', (req, res) => {
    const id = parsePositiveId(req.params?.id);
    if (!id) {
      res.status(400).json({ ok: false, error: 'id 必须是正整数' });
      return;
    }
    const body = req.body || {};
    const patch = {};
    if (body.status !== undefined) {
      if (!VALID_TRAIT_STATUS.has(body.status)) {
        res.status(400).json({ ok: false, error: 'status 只能是 active、pinned 或 dismissed' });
        return;
      }
      patch.status = body.status;
    }
    if (typeof body.summary === 'string' && body.summary.trim()) {
      patch.summary = body.summary.trim().slice(0, 240);
    }
    if (body.weight !== undefined && Number.isFinite(Number(body.weight))) {
      patch.weight = Number(body.weight);
    }
    const trait = db.patchMemoryTrait(id, patch);
    if (!trait) {
      res.status(404).json({ ok: false, error: '记忆条不存在' });
      return;
    }
    res.json({ ok: true, trait });
  });

  app.delete('/api/memory/traits/:id', (req, res) => {
    const id = parsePositiveId(req.params?.id);
    if (!id) {
      res.status(400).json({ ok: false, error: 'id 必须是正整数' });
      return;
    }
    const ok = db.deleteMemoryTrait(id);
    if (!ok) {
      res.status(404).json({ ok: false, error: '记忆条不存在' });
      return;
    }
    res.json({ ok: true });
  });

  app.get('/api/memory/intent', (req, res) => {
    const intent = db.getActiveSessionIntent?.({ now: nowFn() }) || null;
    res.json({ ok: true, intent });
  });

  app.post('/api/memory/intent', (req, res) => {
    const body = req.body || {};
    const text = String(body.text || '').trim().slice(0, 200);
    if (!text) {
      res.status(400).json({ ok: false, error: 'text 必填' });
      return;
    }
    const source = String(body.source || 'user').trim().slice(0, 40) || 'user';
    const ttlMinutes = Math.max(5, Math.min(720, Number(body.ttlMinutes) || 120));
    const intent = db.setSessionIntent({ text, source, ttlMinutes, now: nowFn() });
    broadcast({ type: 'memory-intent', intent });
    res.json({ ok: true, intent });
  });

  app.delete('/api/memory/intent', (req, res) => {
    const cleared = db.clearSessionIntent?.({ now: nowFn() }) || 0;
    broadcast({ type: 'memory-intent', intent: null });
    res.json({ ok: true, cleared });
  });

  app.post('/api/memory/telemetry', (req, res) => {
    try {
      const body = req.body || {};
      const event = String(body.event || '').trim();
      const ts = Number.isFinite(Number(body.ts)) ? Number(body.ts) : nowFn();
      const dt = new Date(ts);
      const localHour = dt.getHours();
      const weekday = dt.getDay();

      if (event === 'volume') {
        const vol = Number(body.volume);
        if (!Number.isFinite(vol) || vol < 0 || vol > 100) {
          res.status(400).json({ ok: false, error: 'volume 必须是 0..100 的数字' });
          return;
        }
        const trigger = ['manual', 'init', 'adaptive'].includes(body.trigger) ? body.trigger : 'manual';
        const id = db.addVolumeObservation({ ts, localHour, weekday, volume: vol, trigger });
        res.json({ ok: true, id });
        return;
      }

      if (event === 'session_start') {
        const title = String(body.title || '').trim();
        if (!title) {
          res.status(400).json({ ok: false, error: 'title 必填' });
          return;
        }
        const features = inferTrackFeatures({
          title,
          artist: body.artist || '',
          reason: body.reason || '',
          lyric: body.lyric || '',
        });
        const sessionId = db.startPlaybackSession({
          kugouId: body.kugouId || null,
          title,
          artist: body.artist || '',
          source: body.source || 'manual',
          agentId: body.agentId || null,
          startedTs: ts,
          durationSec: Number(body.durationSec) || 0,
          localHour,
          weekday,
          initialVolume: body.initialVolume ?? null,
          vocalHint: features.vocal,
          energyHint: features.energy,
        });
        res.json({ ok: true, sessionId, features });
        return;
      }

      if (event === 'session_end') {
        const outcome = VALID_OUTCOMES.has(body.outcome) ? body.outcome : 'completed';
        let session = null;
        const sid = parsePositiveId(body.sessionId);
        if (sid) {
          session = db.finishPlaybackSession(sid, {
            endedTs: ts,
            listenedSec: Number(body.listenedSec) || 0,
            durationSec: Number(body.durationSec) || 0,
            outcome,
            finalVolume: body.finalVolume ?? null,
          });
        } else if (body.title) {
          const features = inferTrackFeatures({
            title: body.title,
            artist: body.artist || '',
            reason: body.reason || '',
            lyric: body.lyric || '',
          });
          const createdId = db.startPlaybackSession({
            kugouId: body.kugouId || null,
            title: String(body.title).trim(),
            artist: body.artist || '',
            source: body.source || 'manual',
            agentId: body.agentId || null,
            startedTs: ts - Math.round((Number(body.listenedSec) || 0) * 1000),
            durationSec: Number(body.durationSec) || 0,
            localHour,
            weekday,
            initialVolume: body.finalVolume ?? null,
            vocalHint: features.vocal,
            energyHint: features.energy,
          });
          session = db.finishPlaybackSession(createdId, {
            endedTs: ts,
            listenedSec: Number(body.listenedSec) || 0,
            durationSec: Number(body.durationSec) || 0,
            outcome,
            finalVolume: body.finalVolume ?? null,
          });
        }
        if (outcome === 'disliked' && (body.title || session?.title)) {
          db.addFeedback({
            kind: 'dislike',
            kugouId: body.kugouId || session?.kugou_id || null,
            title: body.title || session?.title || '',
            artist: body.artist || session?.artist || '',
          });
        }
        if (typeof db.upsertMemoryTrait === 'function' && (outcome === 'completed' || outcome === 'skipped' || outcome === 'disliked')) {
          try { syncLearnedTraits(db, { now: ts }); } catch { /* */ }
        }
        res.json({ ok: true, session });
        return;
      }

      if (event === 'dislike') {
        const title = String(body.title || '').trim();
        const artist = String(body.artist || '').trim();
        const kugouId = String(body.kugouId || '').trim();
        if (!title && !kugouId) {
          res.status(400).json({ ok: false, error: 'title 或 kugouId 必填' });
          return;
        }
        const fbId = db.addFeedback({ kind: 'dislike', kugouId: kugouId || null, title, artist });
        const sid = parsePositiveId(body.sessionId);
        if (sid) {
          db.finishPlaybackSession(sid, {
            endedTs: ts,
            listenedSec: Number(body.listenedSec) || 0,
            durationSec: Number(body.durationSec) || 0,
            outcome: 'disliked',
            finalVolume: body.finalVolume ?? null,
          });
        }
        if (typeof db.upsertMemoryTrait === 'function') {
          try { syncLearnedTraits(db, { now: ts }); } catch { /* */ }
        }
        res.json({ ok: true, id: fbId });
        return;
      }

      res.status(400).json({ ok: false, error: '不支持的 telemetry event' });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}

export default { mountMemoryRoutes };
