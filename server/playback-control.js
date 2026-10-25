// 播放控制与状态快照。聊天里的 /skip 和 bot 的 /api/control 共用这里。
import { defaultVolume } from './volume-store.js';

export const EXTERNAL_CHAT_HINT = '选歌请在 Grok Bot 里找 Claudio主持人。';

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
    paused: Boolean(runtime.paused),
    volume: Number.isFinite(runtime.volume) ? runtime.volume : defaultVolume(),
    currentTime: Number.isFinite(runtime.currentTime) ? runtime.currentTime : 0,
    duration: Number.isFinite(runtime.duration) ? runtime.duration : 0,
    active: Boolean(runtime.active),
    listeners,
    lastSay: runtime.lastSay || '',
    reason: runtime.lastReason || '',
    queuedAt: runtime.queuedAt || null,
    source: runtime.queuedSource || '',
  };
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
  const queue = Array.isArray(runtime.queue) ? runtime.queue : (runtime.queue = []);
  if (!Number.isFinite(runtime.volume)) runtime.volume = defaultVolume();

  const base = () => playbackStatus(runtime);

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
      runtime.paused = false;
      runtime.trackEnded = false;
      return { ...base(), command: 'play', say: '▶ 继续', feedback: null };
    case 'volume':
    case 'vol': {
      const raw = value != null && value !== '' ? value : arg;
      const volume = clampVolume(raw);
      if (volume == null) {
        return { ok: false, status: 400, error: 'volume 需要 0 到 100 的数字', command: 'volume' };
      }
      runtime.volume = volume;
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
        say: '命令：/skip /prev /pause /play /vol N /now /queue',
      };
    default:
      return { ok: false, status: 400, error: `未知命令：${cmd}`, command: cmd };
  }
}

export function applyProgress(runtime, body = {}) {
  if (!runtime) return;
  if (typeof body.currentTime === 'number' && Number.isFinite(body.currentTime)) {
    runtime.currentTime = Math.max(0, body.currentTime);
  }
  if (typeof body.duration === 'number' && Number.isFinite(body.duration)) {
    runtime.duration = Math.max(0, body.duration);
  }
  const volume = clampVolume(body.volume);
  if (volume != null && body.volume != null) runtime.volume = volume;
  if (typeof body.paused === 'boolean') runtime.paused = body.paused;
  if (typeof body.index === 'number' && Number.isFinite(body.index) && Array.isArray(runtime.queue) && runtime.queue.length) {
    const next = Math.max(0, Math.min(Math.trunc(body.index), runtime.queue.length - 1));
    if (next !== runtime.index) runtime.trackEnded = false;
    runtime.index = next;
  }
}
