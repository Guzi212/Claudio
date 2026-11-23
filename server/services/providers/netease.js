import axios from 'axios';
import { dbApi } from '../../db.js';
import { axiosProxyOptions } from '../../outbound-proxy.js';
import { getWithDefault as getSettingWithDefault } from '../settings.js';
import {
  MusicProvider,
  decodeTrackId,
  encodeTrackId,
  msToSeconds,
} from './base.js';
import { scoreCandidate } from './scoring.js';

const SCORE_THRESHOLD = 60;

function neteaseLevelForQuality(quality) {
  const q = String(quality || '').trim().toLowerCase();
  switch (q) {
    case 'viper_clear':
    case 'viper_atmos':
    case 'high':
    case 'flac':
      return 'lossless';
    case '320':
      return 'exhigh';
    case '128':
    default:
      return 'standard';
  }
}

function qualityFromNeteaseItem(item = {}, fallbackQuality = '128') {
  const level = String(item.level || '').toLowerCase();
  const type = String(item.type || '').toLowerCase();
  const br = Number(item.br) || 0;
  if (type === 'flac' || ['lossless', 'hires', 'jyeffect', 'vivid', 'jymaster', 'sky'].includes(level)) {
    return 'flac';
  }
  if (level === 'exhigh' || br >= 320_000) return '320';
  if (level === 'standard' || level === 'higher' || (br > 0 && br < 320_000)) return '128';
  return fallbackQuality || '128';
}

function isFreeTrial(item) {
  const ft = item?.freeTrialInfo;
  if (!ft || ft === 'null') return false;
  return typeof ft === 'object';
}

function extractCookieFromResponse(res) {
  const bodyCookie = res?.data?.cookie;
  if (typeof bodyCookie === 'string' && bodyCookie.trim()) {
    return bodyCookie.trim();
  }
  const setCookies = res?.headers?.['set-cookie'];
  if (Array.isArray(setCookies) && setCookies.length) {
    return setCookies.map(c => String(c).split(';')[0].trim()).filter(Boolean).join('; ');
  }
  return '';
}

function mapNeteaseSong(item = {}) {
  const rawId = String(item.id || '').trim();
  const artists = Array.isArray(item.ar)
    ? item.ar
    : (Array.isArray(item.artists) ? item.artists : []);
  const artist = artists.map(a => String(a?.name || '').trim()).filter(Boolean).join(', ');
  const albumObj = item.al || item.album || {};
  const album = String(albumObj?.name || '').trim();
  const cover = String(albumObj?.picUrl || '').trim();
  const duration = msToSeconds(item.dt ?? item.duration);

  return {
    provider: 'netease',
    id: rawId,
    hash: encodeTrackId('netease', rawId),
    title: String(item.name || '').trim(),
    artist,
    album,
    duration,
    cover,
    raw: item,
  };
}

export class NeteaseProvider extends MusicProvider {
  constructor() {
    super('netease');
    this._anonCookie = '';
    this._anonAttemptedAt = 0;
    this._anonPromise = null;
  }

  getBaseUrl() {
    return String(process.env.NETEASE_API_BASE || '').trim().replace(/\/+$/, '');
  }

  isEnabled() {
    return Boolean(this.getBaseUrl());
  }

  _client(timeout = 10_000) {
    const baseURL = this.getBaseUrl();
    return axios.create({
      baseURL,
      timeout,
      ...axiosProxyOptions(baseURL),
    });
  }

  async ensureCookie({ forceRefresh = false } = {}) {
    if (!this.isEnabled()) return '';
    const envCookie = String(process.env.NETEASE_COOKIE || '').trim();
    if (envCookie) return envCookie;

    const dbCookie = String(dbApi.getPref?.('netease_cookie') || '').trim();
    if (dbCookie) return dbCookie;

    if (!forceRefresh && this._anonCookie) return this._anonCookie;
    if (!forceRefresh && this._anonAttemptedAt && (Date.now() - this._anonAttemptedAt < 300_000)) {
      return '';
    }
    if (this._anonPromise && !forceRefresh) return this._anonPromise;

    this._anonPromise = (async () => {
      this._anonAttemptedAt = Date.now();
      try {
        const res = await this._client(6_000).get('/register/anonimous', {
          params: { _t: Date.now() },
        });
        const cookie = extractCookieFromResponse(res);
        if (cookie) this._anonCookie = cookie;
        return cookie;
      } catch (err) {
        console.warn('[netease] anonymous login failed:', err.message);
        return '';
      } finally {
        this._anonPromise = null;
      }
    })();

    return this._anonPromise;
  }

  async healthCheck() {
    if (!this.isEnabled()) {
      return { ok: false, configured: false, detail: 'not configured' };
    }
    try {
      const cookie = await this.ensureCookie();
      const res = await this._client(3_500).get('/login/status', {
        params: cookie ? { cookie, _t: Date.now() } : { _t: Date.now() },
      });
      const profile = res.data?.data?.profile || res.data?.profile || null;
      const nickname = profile?.nickname || '';
      if (nickname) {
        return { ok: true, configured: true, anonymous: false, detail: `logged in (${nickname})` };
      }
      return {
        ok: true,
        configured: true,
        anonymous: true,
        detail: cookie ? 'anonymous cookie ready' : 'online (upstream anonymous)',
      };
    } catch (err) {
      return {
        ok: false,
        configured: true,
        detail: err.code === 'ECONNREFUSED' ? 'netease api not running' : err.message,
      };
    }
  }

  async search({ title = '', artist = '', hint = '' } = {}) {
    if (!this.isEnabled()) return [];
    const keyword = [title, artist, hint].filter(Boolean).join(' ').trim();
    if (!keyword) return [];
    try {
      const cookie = await this.ensureCookie();
      const res = await this._client().get('/cloudsearch', {
        params: {
          keywords: keyword,
          type: 1,
          limit: 15,
          ...(cookie ? { cookie } : {}),
        },
      });
      const list = Array.isArray(res.data?.result?.songs) ? res.data.result.songs : [];
      const candidates = list.slice(0, 15).map(mapNeteaseSong).filter(c => c.id && c.title);
      return candidates
        .map(c => ({ ...c, score: scoreCandidate({ title, artist, hint }, c) }))
        .sort((a, b) => b.score - a.score);
    } catch (err) {
      console.error('[netease] search failed:', err.message);
      return [];
    }
  }

  async trackUrl(idOrHash, { targetQuality = '' } = {}) {
    if (!this.isEnabled()) return null;
    const { rawId } = decodeTrackId(idOrHash, 'netease');
    if (!rawId) return null;

    const quality = String(targetQuality || getSettingWithDefault('playback_quality') || 'flac').trim().toLowerCase();
    const level = neteaseLevelForQuality(quality);
    const levelsToTry = level === 'standard' ? ['standard'] : [level, 'standard'];
    const cookie = await this.ensureCookie();

    for (const lv of levelsToTry) {
      try {
        const res = await this._client().get('/song/url/v1', {
          params: {
            id: rawId,
            level: lv,
            ...(cookie ? { cookie } : {}),
          },
        });
        const list = Array.isArray(res.data?.data) ? res.data.data : [];
        const item = list.find(x => String(x?.id || '') === rawId) || list[0];
        const url = item?.url ? String(item.url).trim() : '';
        if (!url) continue;
        // 拒绝 30s VIP 试听残片，回退后续候选或下一平台
        if (isFreeTrial(item)) continue;
        return {
          url,
          quality: qualityFromNeteaseItem(item, lv === 'lossless' ? 'flac' : (lv === 'exhigh' ? '320' : '128')),
        };
      } catch (err) {
        console.error('[netease] trackUrl failed:', err.message);
      }
    }
    return null;
  }

  async lyric(idOrHash) {
    if (!this.isEnabled()) return null;
    const { rawId } = decodeTrackId(idOrHash, 'netease');
    if (!rawId) return null;
    try {
      const cookie = await this.ensureCookie();
      const res = await this._client().get('/lyric', {
        params: { id: rawId, ...(cookie ? { cookie } : {}) },
      });
      const text = res.data?.lrc?.lyric;
      return typeof text === 'string' && text.trim() ? text : null;
    } catch (err) {
      console.error('[netease] lyric failed:', err.message);
      return null;
    }
  }

  async playlist(idOrOpts, { limit = 300, offset = 0 } = {}) {
    if (!this.isEnabled()) {
      return { tracks: [], totalCount: 0, fetchedCount: 0, truncated: false };
    }
    const id = typeof idOrOpts === 'object'
      ? String(idOrOpts?.id || '').trim()
      : String(idOrOpts || '').trim();
    if (!id) throw new Error('NeteaseProvider.playlist: id 必填');

    const cookie = await this.ensureCookie();
    const res = await this._client(12_000).get('/playlist/track/all', {
      params: { id, limit, offset, ...(cookie ? { cookie } : {}) },
    });
    const rawSongs = Array.isArray(res.data?.songs) ? res.data.songs : [];
    const tracks = rawSongs.map(mapNeteaseSong).filter(t => t.id && t.title);
    return {
      tracks,
      totalCount: tracks.length,
      fetchedCount: tracks.length,
      truncated: tracks.length >= limit,
    };
  }

  async resolveTrack({ title = '', artist = '', hint = '', id = '', hash = '' } = {}) {
    if (!this.isEnabled()) return null;
    const explicit = decodeTrackId(hash || id || '', 'netease').rawId;
    if (explicit) {
      const resolved = await this.trackUrl(explicit);
      if (resolved?.url) {
        const candidates = title ? await this.search({ title, artist, hint }) : [];
        const meta = candidates.find(c => c.id === explicit) || null;
        return {
          provider: 'netease',
          providerTrackId: explicit,
          kugouId: encodeTrackId('netease', explicit),
          title: meta?.title || title || explicit,
          artist: meta?.artist || artist || '',
          album: meta?.album || '',
          duration: meta?.duration || 0,
          upstreamUrl: resolved.url,
          score: 200,
          cover: meta?.cover || '',
          audioQuality: resolved.quality,
        };
      }
      if (!title) return null;
    }

    const candidates = await this.search({ title, artist, hint });
    for (const c of candidates) {
      if (c.score < SCORE_THRESHOLD) break;
      const resolved = await this.trackUrl(c.id);
      if (resolved?.url) {
        return {
          provider: 'netease',
          providerTrackId: c.id,
          kugouId: encodeTrackId('netease', c.id),
          title: c.title,
          artist: c.artist,
          album: c.album,
          duration: c.duration,
          upstreamUrl: resolved.url,
          score: c.score,
          cover: c.cover,
          audioQuality: resolved.quality,
        };
      }
    }
    return null;
  }
}

export const neteaseProvider = new NeteaseProvider();
export default neteaseProvider;
