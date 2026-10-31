import { trimPlayedHistory } from './queue-source.js';

// 续播池独立于 internal 选歌候选池；只保存主持人已经选好的歌。
export const CONTINUE_POOL_KEY = 'continue_pool';

export function shuffleTracks(tracks, random = Math.random) {
  for (let i = tracks.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
  }
}

export function readContinuePool(db) {
  try {
    const pool = JSON.parse(db.getPref(CONTINUE_POOL_KEY) || 'null');
    if (!pool || !Array.isArray(pool.tracks) || !pool.tracks.length || pool.tracks.length > 200) return null;
    if (!pool.tracks.every(track => track && typeof track.kugouId === 'string' && track.kugouId)) return null;
    if (!Number.isInteger(pool.cursor) || pool.cursor < 0 || pool.cursor > pool.tracks.length) return null;
    if (!Number.isInteger(pool.batchSize) || pool.batchSize < 1 || pool.batchSize > 50) return null;
    if (typeof pool.loop !== 'boolean' || typeof pool.shuffle !== 'boolean') return null;
    if (!Number.isInteger(pool.continuedCount) || pool.continuedCount < 0) return null;
    return pool;
  } catch {
    return null;
  }
}

export function saveContinuePool(db, pool) {
  if (pool) db.setPref(CONTINUE_POOL_KEY, JSON.stringify(pool));
  else db.delPref(CONTINUE_POOL_KEY);
}

export function continuePoolView(runtime, { tracks = false } = {}) {
  const pool = runtime?.continuePool;
  if (!pool?.tracks?.length) return null;
  const view = {
    name: pool.name,
    size: pool.tracks.length,
    cursor: pool.cursor,
    remaining: pool.tracks.length - pool.cursor,
    loop: pool.loop,
    shuffle: pool.shuffle,
    batchSize: pool.batchSize,
    source: pool.source,
    setAt: pool.setAt,
    lastContinuedAt: pool.lastContinuedAt,
    continuedCount: pool.continuedCount,
    active: pool.loop || pool.cursor < pool.tracks.length,
  };
  if (tracks) view.tracks = pool.tracks.map(({ title, artist }) => ({ title, artist }));
  return view;
}

export function continueFromPool(runtime, { db, random = Math.random } = {}) {
  const current = runtime.continuePool;
  if (!continuePoolView(runtime)?.active) return false;
  // 先落盘，再同步切换 runtime；并发结束请求之间没有 await 窗口。
  const pool = { ...current, tracks: [...current.tracks] };
  const items = [];
  const queuedAt = new Date().toISOString();
  while (items.length < pool.batchSize) {
    if (pool.cursor >= pool.tracks.length) {
      if (!pool.loop) break;
      pool.cursor = 0;
      if (pool.shuffle) shuffleTracks(pool.tracks, random);
    }
    items.push({ ...pool.tracks[pool.cursor++], audioUrl: null, source: 'continue-pool', queuedAt });
  }
  // cursor 始终指向下一首；整轮用完时立即准备下一轮。
  if (pool.loop && pool.cursor === pool.tracks.length) {
    pool.cursor = 0;
    if (pool.shuffle) shuffleTracks(pool.tracks, random);
  }
  pool.lastContinuedAt = queuedAt;
  pool.continuedCount += items.length;
  saveContinuePool(db, pool);
  runtime.continuePool = pool;
  // 新批次前只保留有限历史；每次调用读取配置，迟到报告由 offset 换算。
  const rawHistory = process.env.CLAUDIO_QUEUE_HISTORY?.trim() || '';
  const history = /^\d+$/.test(rawHistory) ? Number(rawHistory) : NaN;
  const keep = Number.isSafeInteger(history) ? history : 20;
  runtime.index = runtime.queue.length;
  trimPlayedHistory(runtime, keep);
  runtime.queue.push(...items);
  runtime.queueSource = 'bot';
  runtime.paused = false;
  runtime.trackEnded = false;
  runtime.currentTime = 0;
  runtime.duration = 0;
  runtime.queuedAt = queuedAt;
  runtime.queuedSource = 'continue-pool';
  runtime.lastReason = items[0]?.reason || '';
  return true;
}
