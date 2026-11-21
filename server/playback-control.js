// 播放控制与状态快照。聊天里的 /skip 和 bot 的 /api/control 共用这里。
import { defaultVolume } from './volume-store.js';
import { continuePoolView } from './continue-pool.js';
import {
  reportedQueueIndex,
  queueFinished,
  notePlaybackActivity,
  continuousListenMinutes,
  queueEpochOf,
  queueWriteIsStale,
  PAUSE_RESET_MS,
} from './queue-source.js';

export { queueFinished, notePlaybackActivity, continuousListenMinutes, PAUSE_RESET_MS };

export const EXTERNAL_CHAT_HINT = '当前为外部主持模式，请通过已接入的 Agent 或常驻 DJ 点歌。';

export const SCENES = {
  auto: '自动',
  library: '图书馆专注',
  dorm: '寝室放空',
};
export const SCENE_TTL_MS = 8 * 3_600_000;
export const SCENE_PREF_KEY = 'player_scene';

export function activeScene(runtime = {}, now = Date.now()) {
  const raw = runtime?.scene;
  const id = typeof raw === 'string'
    ? raw.trim().toLowerCase()
    : String(raw?.id || 'auto').trim().toLowerCase();
  if (!id || !Object.prototype.hasOwnProperty.call(SCENES, id) || id === 'auto') {
    return { id: 'auto', label: SCENES.auto, updatedAt: null };
  }
  const updatedAt = raw && typeof raw === 'object' ? (raw.updatedAt || null) : null;
  const ts = updatedAt ? Date.parse(updatedAt) : NaN;
  if (Number.isFinite(ts) && now - ts > SCENE_TTL_MS) {
    return { id: 'auto', label: SCENES.auto, updatedAt: null };
  }
  return { id, label: SCENES[id], updatedAt };
}

export function readSavedScene(db, now = Date.now()) {
  try {
    const raw = db?.getPref?.(SCENE_PREF_KEY);
    if (!raw) return { id: 'auto', label: SCENES.auto, updatedAt: null };
    const parsed = JSON.parse(raw);
    return activeScene({ scene: parsed }, now);
  } catch {
    return { id: 'auto', label: SCENES.auto, updatedAt: null };
  }
}

export function applyScene(runtime, sceneId, { db = null, now = Date.now() } = {}) {
  const id = String(sceneId ?? '').trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(SCENES, id)) {
    return { ok: false, error: `scene 只能是 ${Object.keys(SCENES).join('、')}` };
  }
  const next = {
    id,
    label: SCENES[id],
    updatedAt: id === 'auto' ? null : new Date(now).toISOString(),
  };
  if (runtime && typeof runtime === 'object') runtime.scene = next;
  if (db?.setPref) {
    if (id === 'auto' && db.delPref) db.delPref(SCENE_PREF_KEY);
    else db.setPref(SCENE_PREF_KEY, JSON.stringify(next));
  }
  return { ok: true, scene: next };
}

export function clampVolume(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function playbackStatus(runtime = {}, { listeners = 0, brain = 'external' } = {}) {
  const queue = Array.isArray(runtime.queue) ? runtime.queue : [];
  const index = Number.isFinite(runtime.index) ? runtime.index : 0;
  const safeIndex = queue.length ? Math.max(0, Math.min(index, queue.length - 1)) : 0;
  return {
    ok: true,
    brain,
    nowPlaying: queue[safeIndex] || null,
    queue,
    index: queue.length ? safeIndex : 0,
    queueOffset: runtime.queueOffset || 0,
    paused: Boolean(runtime.paused) || queueFinished(runtime),
    volume: Number.isFinite(runtime.volume) ? runtime.volume : defaultVolume(),
    // 只有用户/客户端真的设过音量才为 true；默认 30 不代表显式选择。
    volumeExplicit: runtime.volumeExplicit === true,
    currentTime: Number.isFinite(runtime.currentTime) ? runtime.currentTime : 0,
    duration: Number.isFinite(runtime.duration) ? runtime.duration : 0,
    active: Boolean(runtime.active),
    listeners,
    continuousListenMinutes: continuousListenMinutes(runtime),
    scene: activeScene(runtime),
    lastSay: runtime.lastSay || '',
    reason: runtime.lastReason || '',
    queuedAt: runtime.queuedAt || null,
    source: runtime.queuedSource || '',
    activeAgent: runtime.activeAgent || null,
    continuePool: continuePoolView(runtime),
    // 只读的队列版本与续播抑制状态，方便客户端识别 clear 后的窗口期。
    queueEpoch: queueEpochOf(runtime),
    continueSuppressed: Boolean(runtime.continueSuppressed),
  };
}

function restartFromStart(runtime) {
  // 重播从当前保留队列的第 0 首开始，即裁剪后最早保留的历史曲目。
  runtime.index = 0;
  runtime.currentTime = 0;
  runtime.paused = false;
  runtime.trackEnded = false;
}

function trackOf(queue, index) {
  const item = queue[index];
  if (!item) return null;
  return {
    kugouId: item.kugouId || '',
    title: item.title || '',
    artist: item.artist || '',
  };
}

export function applyControl(runtime, { command, arg, value } = {}) {
  const cmd = String(command || '').toLowerCase();
  if (!Array.isArray(runtime.queue)) {
    runtime.queue = [];
    runtime.queueOffset = 0;
  }
  const queue = runtime.queue;
  if (!Number.isFinite(runtime.volume)) runtime.volume = defaultVolume();

  const base = () => {
    notePlaybackActivity(runtime);
    return playbackStatus(runtime);
  };

  switch (cmd) {
    case 'skip':
    case 'next': {
      const skipped = trackOf(queue, runtime.index);
      if (queue.length && runtime.index < queue.length - 1) {
        runtime.index += 1;
        runtime.trackEnded = false;
        runtime.currentTime = 0;
        runtime.paused = false;
        return {
          ...base(),
          command: 'next',
          say: `▶ 下一首：${queue[runtime.index]?.title || '(队列结束)'}`,
          feedback: skipped ? { kind: 'skip', ...skipped } : null,
        };
      }
      return {
        ...base(),
        command: 'next',
        say: `▶ 下一首：${queue[runtime.index]?.title || '(队列结束)'}`,
        feedback: null,
      };
    }
    case 'prev':
    case 'back': {
      if (runtime.index > 0) {
        runtime.index -= 1;
        runtime.trackEnded = false;
        runtime.currentTime = 0;
        runtime.paused = false;
      }
      return {
        ...base(),
        command: 'prev',
        say: `◀ 上一首：${queue[runtime.index]?.title || '(队列开始)'}`,
        feedback: null,
      };
    }
    case 'pause':
      runtime.paused = true;
      return { ...base(), command: 'pause', say: '⏸ 暂停', feedback: null };
    case 'play':
    case 'resume':
      if (!queue.length) {
        runtime.paused = true;
        runtime.trackEnded = false;
        return { ...base(), command: 'play', say: '队列是空的', feedback: null };
      }
      if (queueFinished(runtime)) {
        restartFromStart(runtime);
        return { ...base(), command: 'play', say: `▶ ${queue[0]?.title || ''}`, feedback: null };
      }
      runtime.paused = false;
      runtime.trackEnded = false;
      return { ...base(), command: 'play', say: '▶ 继续', feedback: null };
    case 'toggle': {
      if (!queue.length) {
        runtime.paused = true;
        return { ...base(), command: 'toggle', say: '队列是空的', feedback: null };
      }
      if (queueFinished(runtime)) {
        restartFromStart(runtime);
        return { ...base(), command: 'toggle', say: `▶ ${queue[0]?.title || ''}`, feedback: null };
      }
      if (runtime.paused) {
        runtime.paused = false;
        runtime.trackEnded = false;
        return { ...base(), command: 'toggle', say: '▶ 继续', feedback: null };
      }
      runtime.paused = true;
      return { ...base(), command: 'toggle', say: '⏸ 暂停', feedback: null };
    }
    case 'volume':
    case 'vol': {
      const raw = value != null && value !== '' ? value : arg;
      const volume = clampVolume(raw);
      if (volume == null) {
        return { ok: false, status: 400, error: 'volume 需要 0 到 100 的数字', command: 'volume' };
      }
      runtime.volume = volume;
      runtime.volumeExplicit = true;
      return { ...base(), command: 'volume', say: `音量 ${volume}`, feedback: null };
    }
    case 'jump': {
      const raw = value != null && value !== '' ? value : arg;
      const idx = Number(raw);
      if (!Number.isFinite(idx)) {
        return { ok: false, status: 400, error: 'jump 的 value 是从 0 开始的曲目序号', command: 'jump' };
      }
      if (!queue.length) {
        return { ok: false, status: 400, error: '队列是空的', command: 'jump' };
      }
      runtime.index = Math.max(0, Math.min(Math.trunc(idx), queue.length - 1));
      runtime.trackEnded = false;
      runtime.currentTime = 0;
      runtime.paused = false;
      return {
        ...base(),
        command: 'jump',
        say: `▶ ${queue[runtime.index]?.title || ''}`,
        feedback: null,
      };
    }
    case 'now':
      return {
        ...base(),
        command: 'now',
        feedback: null,
        say: queue[runtime.index]
          ? `🎵 ${queue[runtime.index].title} — ${queue[runtime.index].artist}`
          : '(没有正在播放)',
      };
    case 'queue':
      return {
        ...base(),
        command: 'queue',
        feedback: null,
        say: queue.length
          ? '当前队列：\n' + queue.map((q, i) => `${i === runtime.index ? '▶' : '  '} ${q.title} — ${q.artist}`).join('\n')
          : '(队列空)',
      };
    case 'help':
      return {
        ...base(),
        command: 'help',
        feedback: null,
        say: '命令：/skip /prev /pause /play /toggle /vol N /scene auto|library|dorm /now /queue',
      };
    case 'scene': {
      const raw = value != null && value !== '' ? value : arg;
      const applied = applyScene(runtime, raw);
      if (!applied.ok) {
        return { ok: false, status: 400, error: applied.error, command: 'scene' };
      }
      return { ...base(), command: 'scene', say: `场景切换为：${applied.scene.label}`, feedback: null };
    }
    default:
      return { ok: false, status: 400, error: `未知命令：${cmd}`, command: cmd };
  }
}

export function applyProgress(runtime, body = {}) {
  if (!runtime) return;
  // 音量不是播放进度：即使这条上报已经过期，用户刚拖过的音量仍然算数。
  const volume = clampVolume(body.volume);
  if (volume != null && body.volume != null) {
    runtime.volume = volume;
    runtime.volumeExplicit = true;
  }
  // clear 之后的旧 epoch / 旧客户端上报不能把队列或进度复活。
  if (queueWriteIsStale(runtime, body)) return;
  const index = reportedQueueIndex(runtime, body);
  if (index < 0) return;
  // 旧曲的 WS 进度可能晚于队尾的 HTTP 请求抵达；不能把续播指针拉回去。
  if (runtime.queue?.[runtime.index]?.source === 'continue-pool'
    && typeof index === 'number' && index < runtime.index) return;
  if (typeof body.currentTime === 'number' && Number.isFinite(body.currentTime)) {
    runtime.currentTime = Math.max(0, body.currentTime);
  }
  if (typeof body.duration === 'number' && Number.isFinite(body.duration)) {
    runtime.duration = Math.max(0, body.duration);
  }
  if (typeof index === 'number' && Array.isArray(runtime.queue) && runtime.queue.length) {
    const next = Math.max(0, Math.min(Math.trunc(index), runtime.queue.length - 1));
    if (next !== runtime.index) runtime.trackEnded = false;
    runtime.index = next;
  }
  if (typeof body.paused === 'boolean') {
    runtime.paused = body.paused === false && queueFinished(runtime) ? true : body.paused;
  }
  notePlaybackActivity(runtime);
}
