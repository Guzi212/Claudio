import axios from 'axios';
import { dbApi } from '../../db.js';
import { axiosProxyOptions } from '../../outbound-proxy.js';
import { getWithDefault as getSettingWithDefault } from '../settings.js';
import { REFRESHED_AT_PREF as QQ_REFRESHED_AT_PREF } from '../qq-login.js';
import {
  MusicProvider,
  decodeTrackId,
  encodeTrackId,
  normalizeDurationSeconds,
} from './base.js';
import { scoreCandidate } from './scoring.js';

const SCORE_THRESHOLD = 60;

export class QQMusicProvider extends MusicProvider {
  constructor() {
    super('qq');
  }

  getBaseUrl() {
    return String(process.env.QQ_API_BASE || '').trim().replace(/\/+$/, '');
  }

  isEnabled() {
    return Boolean(this.getBaseUrl());
  }

  _client(timeout = 8_000) {
    const baseURL = this.getBaseUrl();
    return axios.create({
      baseURL,
      timeout,
      ...axiosProxyOptions(baseURL),
    });
  }

  async healthCheck({ now = Date.now() } = {}) {
    const empty = {
      loggedIn: false,
      musicid: 0,
      account: null,
      canRefresh: false,
      credentialUpdatedAt: null,
      credentialAgeMs: null,
      credentialAgeHours: null,
      keyExpiresIn: null,
      expiresAt: null,
      expiresInHours: null,
    };
    if (!this.isEnabled()) {
      return { ok: false, configured: false, ...empty, detail: 'not configured' };
    }
    try {
      const res = await this._client(3_000).get('/health');
      const d = res.data || {};
      const loggedIn = Boolean(d.loggedIn);
      const musicid = Number(d.musicid || 0);
      if (!loggedIn) {
        return {
          ok: Boolean(d.ok),
          configured: true,
          ...empty,
          detail: d.detail || 'online · unauthenticated (search only)',
        };
      }

      const dbUpdatedAt = Number(dbApi.getPref?.(QQ_REFRESHED_AT_PREF)) || 0;
      const updatedAt = Number(d.credentialCreatedAt || dbUpdatedAt) || null;
      const ageMs = updatedAt
        ? Math.max(0, now - updatedAt)
        : (Number.isFinite(d.credentialAgeMs) ? Math.max(0, Number(d.credentialAgeMs)) : null);
      const ageHours = ageMs != null ? Math.round((ageMs / 3_600_000) * 10) / 10 : null;
      const keyExpiresIn = Number(d.keyExpiresIn) > 0 ? Number(d.keyExpiresIn) : null;
      const expiresAt = Number(d.expiresAt) > 0 ? Number(d.expiresAt) : null;
      const expiresInMs = expiresAt != null
        ? expiresAt - now
        : (Number.isFinite(d.expiresInMs) ? Number(d.expiresInMs) : null);
      const expiresInHours = expiresInMs != null ? Math.round((expiresInMs / 3_600_000) * 10) / 10 : null;
      const canRefresh = d.canRefresh != null ? Boolean(d.canRefresh) : true;
      const expired = Boolean(d.expired || (expiresInMs != null && expiresInMs <= 0));

      const detailParts = [`logged in (${musicid || 'qq'})`];
      if (ageHours != null) detailParts.push(`账龄 ${ageHours}h`);
      if (expiresInHours != null) {
        detailParts.push(expired ? '已过有效期' : `剩余 ${expiresInHours}h`);
      }
      if (d.canRefresh === false) detailParts.push('无 refresh_key');

      return {
        ok: Boolean(d.ok),
        configured: true,
        loggedIn: true,
        musicid,
        account: musicid ? String(musicid) : null,
        canRefresh,
        credentialUpdatedAt: updatedAt,
        credentialAgeMs: ageMs,
        credentialAgeHours: ageHours,
        keyExpiresIn,
        expiresAt,
        expiresInHours,
        ...(expired ? { expired: true } : {}),
        detail: detailParts.join(' · '),
      };
    } catch (err) {
      return {
        ok: false,
        configured: true,
        ...empty,
        detail: err.code === 'ECONNREFUSED' ? 'qq api not running' : err.message,
      };
    }
  }

  async search({ title = '', artist = '', hint = '' } = {}) {
    if (!this.isEnabled()) return [];
    const keyword = [title, artist, hint].filter(Boolean).join(' ').trim();
    if (!keyword) return [];
    try {
      const res = await this._client().get('/search', {
        params: { keywords: keyword, num: 15 },
      });
      const list = Array.isArray(res.data?.tracks) ? res.data.tracks : [];
      const candidates = list.slice(0, 15).map(item => {
        const rawId = String(item.mid || item.id || '').trim();
        const duration = normalizeDurationSeconds(item.duration);
        return {
          provider: 'qq',
          id: rawId,
          hash: encodeTrackId('qq', rawId),
          title: String(item.title || item.name || '').trim(),
          artist: String(item.artist || '').trim(),
          album: String(item.album || '').trim(),
          duration,
          cover: String(item.cover || '').trim(),
          raw: item,
        };
      }).filter(c => c.id && c.title);

      return candidates
        .map(c => ({ ...c, score: scoreCandidate({ title, artist, hint }, c) }))
        .sort((a, b) => b.score - a.score);
    } catch (err) {
      console.error('[qq] search failed:', err.message);
      return [];
    }
  }

  async trackUrl(idOrHash, { targetQuality = '', mediaMid = '', songType = undefined } = {}) {
    if (!this.isEnabled()) return null;
    const { rawId } = decodeTrackId(idOrHash, 'qq');
    if (!rawId) return null;
    const quality = String(targetQuality || getSettingWithDefault('playback_quality') || 'flac').trim().toLowerCase();
    try {
      const params = { mid: rawId, quality };
      if (mediaMid) params.media_mid = mediaMid;
      if (songType != null) params.song_type = songType;
      const res = await this._client(8_000).get('/song/url', { params });
      const url = res.data?.url ? String(res.data.url).trim() : '';
      if (!url) return null;
      return {
        url,
        quality: String(res.data?.quality || quality),
      };
    } catch (err) {
      console.error('[qq] trackUrl failed:', err.message);
      return null;
    }
  }

  async lyric(idOrHash) {
    if (!this.isEnabled()) return null;
    const { rawId } = decodeTrackId(idOrHash, 'qq');
    if (!rawId) return null;
    try {
      const res = await this._client().get('/lyric', { params: { mid: rawId } });
      const text = res.data?.lyric;
      return typeof text === 'string' && text.trim() ? text : null;
    } catch (err) {
      console.error('[qq] lyric failed:', err.message);
      return null;
    }
  }

  async playlist(idOrOpts, { limit = 300 } = {}) {
    if (!this.isEnabled()) {
      return { tracks: [], totalCount: 0, fetchedCount: 0, truncated: false };
    }
    const id = typeof idOrOpts === 'object'
      ? String(idOrOpts?.id || idOrOpts?.disstid || '').trim()
      : String(idOrOpts || '').trim();
    if (!id) throw new Error('QQMusicProvider.playlist: id 必填');
    const res = await this._client(12_000).get('/playlist', { params: { id, limit } });
    const list = Array.isArray(res.data?.tracks) ? res.data.tracks : [];
    const tracks = list.map(item => {
      const rawId = String(item.mid || item.id || '').trim();
      return {
        provider: 'qq',
        id: rawId,
        hash: encodeTrackId('qq', rawId),
        title: String(item.title || item.name || '').trim(),
        artist: String(item.artist || '').trim(),
        album: String(item.album || '').trim(),
        duration: normalizeDurationSeconds(item.duration),
        cover: String(item.cover || '').trim(),
      };
    }).filter(t => t.id && t.title);
    const totalCount = Number(res.data?.totalCount || tracks.length) || tracks.length;
    return {
      tracks,
      totalCount,
      fetchedCount: tracks.length,
      truncated: Boolean(res.data?.truncated || totalCount > tracks.length),
    };
  }

  async resolveTrack({ title = '', artist = '', hint = '', id = '', hash = '' } = {}) {
    if (!this.isEnabled()) return null;
    const explicit = decodeTrackId(hash || id || '', 'qq').rawId;
    if (explicit) {
      const resolved = await this.trackUrl(explicit);
      if (resolved?.url) {
        const candidates = title ? await this.search({ title, artist, hint }) : [];
        const meta = candidates.find(c => c.id === explicit) || null;
        return {
          provider: 'qq',
          providerTrackId: explicit,
          kugouId: encodeTrackId('qq', explicit),
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
    for (const c of candidates.slice(0, 5)) {
      if (c.score < SCORE_THRESHOLD) break;
      const resolved = await this.trackUrl(c.id, {
        mediaMid: c.raw?.mediaMid || '',
        songType: c.raw?.songType,
      });
      if (resolved?.url) {
        return {
          provider: 'qq',
          providerTrackId: c.id,
          kugouId: encodeTrackId('qq', c.id),
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

export const qqProvider = new QQMusicProvider();
export default qqProvider;
