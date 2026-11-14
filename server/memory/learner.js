// 动态情境品味与习惯学习引擎。
// 不含任何写死的人群/时段规律：所有时段建议、音量偏好、人声/能量倾向均从真实播放与反馈权重计算。
import { isValidLearnTrack } from './track-features.js';

const DAY_MS = 86_400_000;
const HALF_LIFE_DAYS = 21;
const TIME_SIGMA_HOURS = 1.5;

/**
 * 计算 24 小时制上的环形小时距离（0..12）。
 */
export function circularHourDistance(h1, h2) {
  const a = ((Number(h1) % 24) + 24) % 24;
  const b = ((Number(h2) % 24) + 24) % 24;
  const diff = Math.abs(a - b);
  return Math.min(diff, 24 - diff);
}

/**
 * 高斯环形时间核权重：相邻小时高度共享，远隔时段迅速衰减。
 */
export function timeKernelWeight(obsHour, targetHour, sigma = TIME_SIGMA_HOURS) {
  const dist = circularHourDistance(obsHour, targetHour);
  return Math.exp(-(dist * dist) / (2 * sigma * sigma));
}

function isWeekend(day) {
  return day === 0 || day === 6;
}

/**
 * 工作日/周末亲和系数：同类日期权重大，异类日期弱参考，样本稀疏时仍可借力。
 */
export function weekdayAffinity(obsWeekday, targetWeekday) {
  if (!Number.isFinite(obsWeekday) || !Number.isFinite(targetWeekday)) return 1.0;
  return isWeekend(obsWeekday) === isWeekend(targetWeekday) ? 1.0 : 0.65;
}

/**
 * 21 天半衰期指数时间衰减（EWMA），近期行为占主导。
 */
export function recencyWeight(obsTs, nowTs, halfLifeDays = HALF_LIFE_DAYS) {
  const ageDays = Math.max(0, (nowTs - Number(obsTs || nowTs)) / DAY_MS);
  return Math.exp((-ageDays * Math.LN2) / halfLifeDays);
}

/**
 * 将单次播放会话的完成度与来源转成偏好分 [-2.0, +1.5]。
 */
export function sessionPreferenceScore(session) {
  if (!session || !isValidLearnTrack(session)) return 0;
  const outcome = String(session.outcome || 'playing');
  const listened = Math.max(0, Number(session.listened_sec ?? session.listenedSec) || 0);
  const duration = Math.max(0, Number(session.duration_sec ?? session.durationSec) || 0);
  const ratio = duration > 0 ? listened / duration : 0;
  const manualBoost = (session.source === 'manual' || session.source === 'search') ? 0.3 : 0;

  if (outcome === 'disliked') return -2.0;
  if (outcome === 'completed' || (duration > 0 && ratio >= 0.85)) return 1.2 + manualBoost;
  if (outcome === 'skipped') {
    if (listened < 30 || (duration > 0 && ratio < 0.2)) return -1.0;
    if (duration > 0 && ratio >= 0.65) return 0.7;
    return 0.1;
  }
  if (outcome === 'interrupted') {
    if (listened >= 60 || (duration > 0 && ratio >= 0.45)) return 0.5 + manualBoost;
    return 0.1;
  }
  return 0;
}

function weightedMeanVolume(observations, targetHour, targetWeekday, nowTs) {
  const TRIGGER_WEIGHT = { manual: 1.25, init: 0.45, adaptive: 0.2 };
  let weightSum = 0;
  let valueSum = 0;
  const weightedPoints = [];

  for (const obs of observations) {
    const vol = Number(obs?.volume);
    if (!Number.isFinite(vol) || vol < 0 || vol > 100) continue;
    const obsHour = Number(obs.local_hour ?? obs.localHour ?? new Date(obs.ts).getHours());
    const obsDay = Number(obs.weekday ?? new Date(obs.ts).getDay());
    const triggerW = TRIGGER_WEIGHT[obs.trigger] ?? 0.5;
    const w = triggerW
      * timeKernelWeight(obsHour, targetHour)
      * weekdayAffinity(obsDay, targetWeekday)
      * recencyWeight(obs.ts, nowTs);
    if (w < 0.05) continue;
    weightSum += w;
    valueSum += vol * w;
    weightedPoints.push({ vol, w });
  }

  const confidence = Number((1 - Math.exp(-weightSum / 3.2)).toFixed(2));
  if (weightSum < 0.75 || weightedPoints.length === 0) {
    return {
      suggestedVolume: null,
      volumeRange: null,
      volumeConfidence: confidence,
      volumeWeight: Number(weightSum.toFixed(2)),
    };
  }

  const suggested = Math.round(valueSum / weightSum);
  const relevant = weightedPoints.filter(p => p.w >= 0.25).map(p => p.vol);
  const pool = relevant.length ? relevant : weightedPoints.map(p => p.vol);
  return {
    suggestedVolume: suggested,
    volumeRange: [Math.min(...pool), Math.max(...pool)],
    volumeConfidence: confidence,
    volumeWeight: Number(weightSum.toFixed(2)),
  };
}

/**
 * 计算指定本地时刻与星期的动态情境音乐偏好画像。
 * 冷启动（无足够相关证据）时返回低置信度与 neutral，不编造默认规则。
 */
export function getContextSuggestion({
  sessions = [],
  volumeObs = [],
  feedback = [],
  traits = [],
  tasteText = '',
  now = Date.now(),
  safeMaxVolume = 85,
} = {}) {
  const nowTs = now instanceof Date ? now.getTime() : Number(now);
  const dt = new Date(nowTs);
  const targetHour = dt.getHours();
  const targetWeekday = dt.getDay();

  const volStats = weightedMeanVolume(volumeObs, targetHour, targetWeekday, nowTs);
  const cappedVolume = volStats.suggestedVolume == null
    ? null
    : Math.min(safeMaxVolume, Math.max(0, volStats.suggestedVolume));

  let sessionWeightTotal = 0;
  let vocalPos = 0;
  let instPos = 0;
  let energyScoreSum = 0;
  let energyWeightSum = 0;
  const artistScores = new Map();
  const avoidedSet = new Map();

  for (const s of sessions) {
    const score = sessionPreferenceScore(s);
    if (!score) continue;
    const obsHour = Number(s.local_hour ?? s.localHour ?? new Date(s.started_ts).getHours());
    const obsDay = Number(s.weekday ?? new Date(s.started_ts).getDay());
    const kw = timeKernelWeight(obsHour, targetHour)
      * weekdayAffinity(obsDay, targetWeekday)
      * recencyWeight(s.started_ts, nowTs);
    if (kw < 0.05) continue;

    sessionWeightTotal += kw * Math.abs(score);

    const vocalHint = s.vocal_hint || s.vocalHint || 'unknown';
    if (vocalHint === 'vocal') {
      if (score > 0) vocalPos += kw * score;
      else vocalPos += kw * score * 0.6;
    } else if (vocalHint === 'instrumental') {
      if (score > 0) instPos += kw * score;
      else instPos += kw * score * 0.6;
    }

    const energyHint = s.energy_hint || s.energyHint || 'unknown';
    if (score > 0 && (energyHint === 'calm' || energyHint === 'moderate' || energyHint === 'energetic')) {
      const val = energyHint === 'calm' ? -1 : energyHint === 'energetic' ? 1 : 0;
      const ew = kw * score;
      energyScoreSum += val * ew;
      energyWeightSum += ew;
    }

    const artist = String(s.artist || '').trim();
    if (artist) {
      artistScores.set(artist, (artistScores.get(artist) || 0) + kw * score);
      if (s.outcome === 'disliked') {
        avoidedSet.set(artist, `${s.title || artist}（明确不喜欢）`);
      }
    }
  }

  for (const fb of feedback) {
    if (fb?.kind === 'dislike') {
      const label = fb.artist ? `${fb.artist}` : fb.title;
      if (label) avoidedSet.set(label, `${fb.title || label}（点踩）`);
    }
  }

  const vocalDelta = (vocalPos - instPos) / (Math.max(0, vocalPos) + Math.max(0, instPos) + 1.4);
  let vocalPreference = 'neutral';
  if (vocalDelta >= 0.22) vocalPreference = 'prefer_vocal';
  else if (vocalDelta <= -0.22) vocalPreference = 'prefer_instrumental';

  const energyMean = energyWeightSum > 0.6 ? energyScoreSum / energyWeightSum : 0;
  let energyTarget = 'neutral';
  if (energyWeightSum >= 0.6) {
    if (energyMean <= -0.28) energyTarget = 'calm';
    else if (energyMean >= 0.28) energyTarget = 'energetic';
    else energyTarget = 'moderate';
  }

  const topArtists = [...artistScores.entries()]
    .filter(([, score]) => score > 0.4)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([artist, score]) => ({ artist, score: Number(score.toFixed(2)) }));

  const avoided = [...avoidedSet.keys()].slice(0, 6);
  const overallConfidence = Number(
    Math.max(volStats.volumeConfidence, 1 - Math.exp(-sessionWeightTotal / 4.0)).toFixed(2),
  );

  // 冷启动稀疏先验：仅当无足够行为数据时提供温和先验标注，不硬编码时段结论
  const hasPriorText = String(tasteText || '').trim().length > 0;
  const activeTraits = (traits || []).filter(t => t && t.status !== 'dismissed');

  return {
    hour: targetHour,
    weekday: targetWeekday,
    confidence: overallConfidence,
    coldStart: overallConfidence < 0.3,
    hasPriorText,
    suggestedVolume: cappedVolume,
    volumeRange: volStats.volumeRange,
    volumeConfidence: volStats.volumeConfidence,
    vocalPreference,
    energyTarget,
    topArtists,
    avoided,
    activeTraits: activeTraits.slice(0, 8),
  };
}

function padHour(h) {
  return `${String(h).padStart(2, '0')}:00`;
}

function translateVocal(v) {
  if (v === 'prefer_vocal') return '偏好人声歌曲';
  if (v === 'prefer_instrumental') return '偏好纯音乐/器乐';
  return '';
}

function translateEnergy(e) {
  if (e === 'calm') return '安静舒缓';
  if (e === 'energetic') return '富有活力/节奏感';
  if (e === 'moderate') return '节奏适中';
  return '';
}

/**
 * 扫描近期观察数据并同步生成可解释、可置顶、可删除的 `memory_traits`。
 * 尊重用户已置顶 (`pinned`) 与已否定 (`dismissed`) 的条目。
 */
export function syncLearnedTraits(db, { now = Date.now(), days = 30, safeMaxVolume = 85 } = {}) {
  const since = now - days * DAY_MS;
  const sessions = db.recentPlaybackSessions?.({ sinceTs: since, limit: 500 }) || [];
  const volumeObs = db.recentVolumeObservations?.({ sinceTs: since, limit: 500 }) || [];
  const feedback = db.recentFeedback?.(200) || [];

  const dtBase = new Date(now);
  const candidates = [];

  for (let hour = 0; hour < 24; hour++) {
    const probe = new Date(dtBase);
    probe.setHours(hour, 15, 0, 0);
    const sug = getContextSuggestion({
      sessions,
      volumeObs,
      feedback,
      now: probe.getTime(),
      safeMaxVolume,
    });
    const volStr = sug.suggestedVolume != null ? `音量约 ${sug.suggestedVolume}%` : '';
    const vocStr = translateVocal(sug.vocalPreference);
    const engStr = translateEnergy(sug.energyTarget);
    const descParts = [volStr, engStr, vocStr].filter(Boolean);
    if (sug.confidence >= 0.55 && descParts.length > 0) {
      candidates.push({ hour, sug, descParts });
    }
  }

  // 取相互距离 >= 3 小时的局部证据峰值时段，避免相邻小时重复产生多条相同结论
  candidates.sort((a, b) => b.sug.confidence - a.sug.confidence);
  const picked = [];
  for (const c of candidates) {
    if (picked.some(p => circularHourDistance(p.hour, c.hour) < 3)) continue;
    picked.push(c);
    if (picked.length >= 4) break;
  }

  const saved = [];
  for (const { hour, sug, descParts } of picked) {
    const scope = `hour:${hour}`;
    const artistHint = sug.topArtists.length
      ? `（常听：${sug.topArtists.slice(0, 2).map(a => a.artist).join('、')}）`
      : '';
    const summary = `${padHour(hour)} 前后通常${descParts.join('、')}${artistHint}`;
    const evidence = `近 ${days} 天自适应样本（置信度 ${Math.round(sug.confidence * 100)}%）`;
    const row = db.upsertMemoryTrait({
      kind: 'context_slot',
      scope,
      summary,
      evidence,
      confidence: sug.confidence,
      weight: 1.0,
      source: 'learned',
    });
    if (row) saved.push(row);
  }

  return saved;
}
