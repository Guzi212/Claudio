const MODES = ['DARK', 'POETRY', 'FOCUS'];
const FALLBACK_DIALOG = '欢迎来到 Claudio，电台已经准备好接收你的 mood。';
const MAX_DIALOG_LENGTH = 72;
const STUDIO_TIME_ZONE = 'Asia/Shanghai';

function clampIndex(index, size) {
  if (!size) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(Math.trunc(index), size - 1));
}

function shortText(value, fallback = FALLBACK_DIALOG) {
  const text = String(value || '').trim() || fallback;
  return text.length > MAX_DIALOG_LENGTH ? `${text.slice(0, MAX_DIALOG_LENGTH)}…` : text;
}

function clockState(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: STUDIO_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    weekday: 'long',
    hourCycle: 'h23',
  }).formatToParts(now).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});

  return {
    iso: now.toISOString(),
    hhmm: `${parts.hour}:${parts.minute}`,
    weekday: parts.weekday,
    date: `${parts.day} · ${parts.month} · ${parts.year}`,
  };
}

function signalBars(seedText) {
  const seed = String(seedText || 'Claudio Radio');
  return Array.from({ length: 24 }, (_, i) => {
    const code = seed.charCodeAt(i % seed.length) || 67;
    return 24 + ((code + i * 17) % 72);
  });
}

export function buildStudioState({ runtime = {}, now = new Date() } = {}) {
  const queue = Array.isArray(runtime.queue) ? runtime.queue : [];
  const index = clampIndex(Number(runtime.index || 0), queue.length);
  const current = queue[index] || null;
  const title = current?.title || 'Claudio Radio';
  const artist = current?.artist || 'Claude DJ · 私人电台';

  return {
    brand: 'Claudio',
    modes: MODES,
    activeMode: 'FOCUS',
    onAir: runtime.paused !== true,
    clock: clockState(now),
    nowPlaying: current
      ? {
          title,
          artist,
          audioUrl: current.audioUrl || null,
          kugouId: current.kugouId || null,
          isTts: current.isTts === true,
        }
      : null,
    displayTrack: { title, artist },
    dialog: shortText(runtime.lastSay),
    queue: {
      size: queue.length,
      index,
      paused: runtime.paused === true,
    },
    visualizer: {
      bars: signalBars(`${title} ${artist}`),
    },
  };
}

export function mountStudioRoutes(app, deps = {}) {
  const getRuntime = typeof deps.getRuntime === 'function'
    ? deps.getRuntime
    : () => deps.runtime || {};
  const getNow = typeof deps.now === 'function'
    ? deps.now
    : () => new Date();

  app.get('/api/studio/state', (req, res) => {
    res.json({
      ok: true,
      studio: buildStudioState({
        runtime: getRuntime(),
        now: getNow(),
      }),
    });
  });
}

export default { buildStudioState, mountStudioRoutes };
