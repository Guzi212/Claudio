import * as kugouMod from '../kugou.js';
import { DEFAULT_KUGOU_API_BASE } from '../../kugou-api-base.js';
import { MusicProvider, normalizeDurationSeconds } from './base.js';

function kugouService() {
  return kugouMod.default && typeof kugouMod.default === 'object' ? kugouMod.default : kugouMod;
}

function callKugou(name, ...args) {
  const mod = kugouService();
  const fn = typeof mod[name] === 'function' ? mod[name] : kugouMod[name];
  if (typeof fn !== 'function') {
    throw new Error(`kugou service missing ${name}`);
  }
  return fn(...args);
}

export class KugouProvider extends MusicProvider {
  constructor() {
    super('kugou');
  }

  getBaseUrl() {
    return String(process.env.KUGOU_API_BASE || DEFAULT_KUGOU_API_BASE).trim();
  }

  isEnabled() {
    const raw = String(process.env.KUGOU_API_BASE ?? '').trim().toLowerCase();
    return !['off', 'none', 'false', 'disabled'].includes(raw);
  }

  async search({ title = '', artist = '', hint = '' } = {}) {
    if (!this.isEnabled()) return [];
    const rows = await callKugou('search', { title, artist, hint });
    return (Array.isArray(rows) ? rows : []).map(item => ({
      ...item,
      provider: 'kugou',
      id: item.hash || '',
      hash: item.hash || '',
      duration: normalizeDurationSeconds(item.duration),
    }));
  }

  async trackUrl(hash, { targetQuality = '' } = {}) {
    if (!this.isEnabled() || !hash) return null;
    return callKugou('songUrlForPlayback', hash, targetQuality ? { targetQuality } : undefined);
  }

  async lyric(hash) {
    if (!this.isEnabled() || !hash) return null;
    return callKugou('lyric', hash);
  }

  async playlist(idOrOpts, opts = {}) {
    if (!this.isEnabled()) return { tracks: [], totalCount: 0, fetchedCount: 0, truncated: false };
    const req = typeof idOrOpts === 'string'
      ? { globalCollectionId: idOrOpts, ...opts }
      : { ...(idOrOpts || {}), ...opts };
    return callKugou('fetchUserPlaylistTracks', req);
  }

  async userPlaylists(opts = {}) {
    if (!this.isEnabled()) return [];
    return callKugou('fetchUserPlaylists', opts);
  }

  async resolveTrack({ title = '', artist = '', hint = '', hash = '', id = '', recordUnmatched = false } = {}) {
    if (!this.isEnabled()) return null;
    const track = await callKugou('resolveTrack', {
      title,
      artist,
      hint,
      hash: hash || id || '',
      recordUnmatched,
    });
    if (!track) return null;
    return {
      ...track,
      provider: 'kugou',
      providerTrackId: track.kugouId || hash || id || '',
    };
  }
}

export const kugouProvider = new KugouProvider();
export default kugouProvider;
