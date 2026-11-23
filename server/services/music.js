// 多音乐源统一编排服务（酷狗 + 网易云 + QQ 音乐）
import { dbApi as defaultDb } from '../db.js';
import { getWithDefault as getSettingWithDefault } from './settings.js';
import {
  MUSIC_PROVIDER_MODES,
  PROVIDER_NAMES,
  decodeTrackId,
  normalizeProviderName,
} from './providers/base.js';
import { kugouProvider } from './providers/kugou.js';
import { neteaseProvider } from './providers/netease.js';
import { qqProvider } from './providers/qq.js';

export { MUSIC_PROVIDER_MODES, PROVIDER_NAMES, decodeTrackId, normalizeProviderName };

export function defaultProvidersMap() {
  return {
    kugou: kugouProvider,
    netease: neteaseProvider,
    qq: qqProvider,
  };
}

export function getMusicProvider({ getSetting = getSettingWithDefault } = {}) {
  const raw = getSetting('music_provider');
  return normalizeProviderName(raw, { allowMulti: true }) || 'multi';
}

export function getEnabledProviders(providers = defaultProvidersMap()) {
  return PROVIDER_NAMES.filter(name => providers[name]?.isEnabled?.());
}

export function resolveProviderOrder({
  requestedProvider = '',
  configuredProvider = getMusicProvider(),
  providers = defaultProvidersMap(),
} = {}) {
  const explicit = normalizeProviderName(requestedProvider, { allowMulti: true });
  const mode = explicit || configuredProvider || 'multi';
  if (mode === 'multi') {
    return PROVIDER_NAMES
      .map(name => providers[name])
      .filter(p => p && p.isEnabled());
  }
  const single = providers[mode];
  return single && single.isEnabled() ? [single] : [];
}

export function createMusicService({
  providers = defaultProvidersMap(),
  db = defaultDb,
  getSetting = getSettingWithDefault,
} = {}) {
  function configuredMode() {
    return getMusicProvider({ getSetting });
  }

  function enabledProviderNames() {
    return getEnabledProviders(providers);
  }

  function orderFor(requestedProvider = '') {
    return resolveProviderOrder({
      requestedProvider,
      configuredProvider: configuredMode(),
      providers,
    });
  }

  async function search({ title = '', artist = '', hint = '', provider = '' } = {}) {
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle) {
      return { provider: configuredMode(), providersUsed: [], tracks: [] };
    }

    const explicit = normalizeProviderName(provider, { allowMulti: true });
    if (provider && !explicit) {
      throw new Error(`未知音乐源: ${provider}`);
    }

    const mode = explicit || configuredMode();
    const list = orderFor(mode);
    if (!list.length) {
      return { provider: mode, providersUsed: [], tracks: [] };
    }

    const settled = await Promise.allSettled(
      list.map(p => p.search({ title: cleanTitle, artist, hint })),
    );

    const priorityIndex = new Map(PROVIDER_NAMES.map((name, idx) => [name, idx]));
    const merged = [];
    for (let i = 0; i < list.length; i += 1) {
      const outcome = settled[i];
      if (outcome.status !== 'fulfilled' || !Array.isArray(outcome.value)) continue;
      for (const item of outcome.value) {
        merged.push({
          ...item,
          provider: item.provider || list[i].name,
        });
      }
    }

    merged.sort((a, b) => {
      const diff = (Number(b.score) || 0) - (Number(a.score) || 0);
      if (diff !== 0) return diff;
      return (priorityIndex.get(a.provider) ?? 99) - (priorityIndex.get(b.provider) ?? 99);
    });

    return {
      provider: mode,
      providersUsed: list.map(p => p.name),
      tracks: merged,
    };
  }

  async function resolveTrack({
    title = '',
    artist = '',
    hint = '',
    hash = '',
    id = '',
    provider = '',
    recordUnmatched = true,
  } = {}) {
    const explicit = normalizeProviderName(provider, { allowMulti: true });
    if (provider && !explicit) {
      throw new Error(`未知音乐源: ${provider}`);
    }

    const rawIdentifier = String(hash || id || '').trim();
    if (rawIdentifier) {
      const decoded = decodeTrackId(rawIdentifier, explicit && explicit !== 'multi' ? explicit : '');
      const targetProvider = providers[decoded.provider];
      if (targetProvider?.isEnabled?.()) {
        const hit = await targetProvider.resolveTrack({
          title,
          artist,
          hint,
          id: decoded.rawId,
          hash: decoded.rawId,
          recordUnmatched: false,
        });
        if (hit) {
          return { ...hit, provider: hit.provider || decoded.provider };
        }
      }
      if (!title) {
        if (recordUnmatched) db.addUnmatched({ title: rawIdentifier, artist, hint });
        return null;
      }
    }

    const list = orderFor(explicit);
    for (const p of list) {
      const hit = await p.resolveTrack({
        title,
        artist,
        hint,
        recordUnmatched: false,
      });
      if (hit) {
        return { ...hit, provider: hit.provider || p.name };
      }
    }

    if (recordUnmatched && (title || rawIdentifier)) {
      db.addUnmatched({ title: title || rawIdentifier, artist, hint });
    }
    return null;
  }

  async function trackUrl(idOrHash, { provider = '', targetQuality = '' } = {}) {
    const decoded = decodeTrackId(idOrHash, provider);
    const target = providers[decoded.provider];
    if (!target || !target.isEnabled()) return null;
    return target.trackUrl(decoded.rawId, { targetQuality });
  }

  async function lyric(idOrHash, { provider = '' } = {}) {
    const decoded = decodeTrackId(idOrHash, provider);
    const target = providers[decoded.provider];
    if (!target || !target.isEnabled()) return null;
    return target.lyric(decoded.rawId);
  }

  async function playlist(idOrOpts, { provider = 'kugou', ...opts } = {}) {
    const name = normalizeProviderName(provider) || 'kugou';
    const target = providers[name];
    if (!target || !target.isEnabled()) {
      return { tracks: [], totalCount: 0, fetchedCount: 0, truncated: false };
    }
    return target.playlist(idOrOpts, opts);
  }

  async function checkProvidersHealth() {
    const [netease, qq] = await Promise.all([
      providers.netease?.healthCheck?.() ?? Promise.resolve({ ok: false, configured: false, detail: 'unavailable' }),
      providers.qq?.healthCheck?.() ?? Promise.resolve({ ok: false, configured: false, detail: 'unavailable' }),
    ]);
    return { netease, qq };
  }

  return {
    providers,
    getMusicProvider: configuredMode,
    getEnabledProviders: enabledProviderNames,
    resolveProviderOrder: orderFor,
    search,
    resolveTrack,
    trackUrl,
    lyric,
    playlist,
    checkProvidersHealth,
  };
}

export const musicService = createMusicService();

export const search = (...args) => musicService.search(...args);
export const resolveTrack = (...args) => musicService.resolveTrack(...args);
export const trackUrl = (...args) => musicService.trackUrl(...args);
export const lyric = (...args) => musicService.lyric(...args);
export const playlist = (...args) => musicService.playlist(...args);
export const checkProvidersHealth = (...args) => musicService.checkProvidersHealth(...args);

export default musicService;
