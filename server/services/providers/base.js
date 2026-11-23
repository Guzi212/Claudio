// 音乐源 Provider 抽象基类与公共工具

export const PROVIDER_NAMES = ['kugou', 'netease', 'qq'];
export const MUSIC_PROVIDER_MODES = ['multi', ...PROVIDER_NAMES];

export function normalizeProviderName(raw, { allowMulti = false } = {}) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return '';
  if (v === 'qqmusic' || v === 'qq_music') return 'qq';
  if (v === 'neteasecloud' || v === 'wy' || v === 'ncm') return 'netease';
  if (v === 'kg') return 'kugou';
  if (allowMulti && MUSIC_PROVIDER_MODES.includes(v)) return v;
  if (!allowMulti && PROVIDER_NAMES.includes(v)) return v;
  return '';
}

/**
 * 为跨平台曲目构造不与酷狗 hash 冲突的统一 ID：
 * - kugou 保持原始 hash（兼容既有播放历史 / 收藏 / 队列）
 * - netease / qq 加平台前缀（如 netease:123456、qq:003w2xz20QlUZt）
 */
export function encodeTrackId(provider, rawId) {
  const p = normalizeProviderName(provider);
  const id = String(rawId ?? '').trim();
  if (!id) return '';
  if (!p || p === 'kugou') return id;
  if (id.startsWith(`${p}:`)) return id;
  return `${p}:${id}`;
}

export function decodeTrackId(idOrHash, explicitProvider = '') {
  const raw = String(idOrHash ?? '').trim();
  for (const name of PROVIDER_NAMES) {
    const prefix = `${name}:`;
    if (raw.startsWith(prefix)) {
      return {
        provider: name,
        rawId: raw.slice(prefix.length).trim(),
      };
    }
  }
  const explicit = normalizeProviderName(explicitProvider);
  return {
    provider: explicit || 'kugou',
    rawId: raw,
  };
}

export function normalizeDurationSeconds(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // 超过 5 小时（18000 秒）视为毫秒
  if (n > 18_000) return Math.round(n / 1000);
  return Math.round(n);
}

export function msToSeconds(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n / 1000);
}

export class MusicProvider {
  constructor(name) {
    this.name = name;
  }

  isEnabled() {
    return false;
  }

  getBaseUrl() {
    return '';
  }

  async healthCheck() {
    return { ok: false, configured: this.isEnabled(), detail: 'not implemented' };
  }

  async search() {
    return [];
  }

  async trackUrl() {
    return null;
  }

  async lyric() {
    return null;
  }

  async playlist() {
    return { tracks: [], totalCount: 0, fetchedCount: 0, truncated: false };
  }

  async userPlaylists() {
    return [];
  }

  async resolveTrack() {
    return null;
  }
}
