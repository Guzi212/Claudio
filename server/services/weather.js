import axios from 'axios';
import 'dotenv/config';
import { get as getSetting } from './settings.js';

const BASE = 'https://api.openweathermap.org/data/2.5';
const GEO_BASE = 'https://api.openweathermap.org/geo/1.0';
const CACHE_TTL_MS = 60_000;
const TIMEOUT_MS = 8_000;

const cache = {
  current: { value: null, expiresAt: 0 },
  next24h: { value: null, expiresAt: 0 },
};

function getKey() {
  return getSetting('openweather_api_key') || '';
}

function getCity() {
  return getSetting('openweather_city') || 'Shanghai';
}

function client() {
  return axios.create({ baseURL: BASE, timeout: TIMEOUT_MS });
}

function geoClient() {
  return axios.create({ baseURL: GEO_BASE, timeout: TIMEOUT_MS });
}

function now() {
  return Date.now();
}

function isCityNotFound(err) {
  return err?.response?.status === 404;
}

async function resolveCity(apiKey) {
  const res = await geoClient().get('/direct', {
    params: { q: getCity(), limit: 1, appid: apiKey },
  });
  const hit = Array.isArray(res.data) ? res.data[0] : null;
  if (!hit || !Number.isFinite(hit.lat) || !Number.isFinite(hit.lon)) return null;
  return { lat: hit.lat, lon: hit.lon };
}

function currentFromResponse(data) {
  return {
    temp: Math.round(data.main?.temp ?? NaN),
    condition: data.weather?.[0]?.description || '',
    humidity: data.main?.humidity ?? null,
    city: data.name || getCity(),
  };
}

export async function getCurrent() {
  if (cache.current.expiresAt > now()) return cache.current.value;

  const apiKey = getKey();
  if (!apiKey) {
    cache.current = { value: null, expiresAt: now() + CACHE_TTL_MS };
    return null;
  }

  try {
    const res = await client().get('/weather', {
      params: { q: getCity(), appid: apiKey, units: 'metric', lang: 'zh_cn' },
    });
    const value = currentFromResponse(res.data || {});
    cache.current = { value, expiresAt: now() + CACHE_TTL_MS };
    return value;
  } catch (err) {
    if (isCityNotFound(err)) {
      try {
        const coords = await resolveCity(apiKey);
        if (coords) {
          const res = await client().get('/weather', {
            params: { ...coords, appid: apiKey, units: 'metric', lang: 'zh_cn' },
          });
          const value = currentFromResponse(res.data || {});
          cache.current = { value, expiresAt: now() + CACHE_TTL_MS };
          return value;
        }
      } catch (geoErr) {
        console.error('[weather] geocoding fallback failed:', geoErr.message);
      }
    }
    console.error('[weather] getCurrent failed:', err.message);
    cache.current = { value: null, expiresAt: now() + CACHE_TTL_MS };
    return null;
  }
}

export async function getNext24h() {
  if (cache.next24h.expiresAt > now()) return cache.next24h.value;

  const apiKey = getKey();
  if (!apiKey) {
    cache.next24h = { value: null, expiresAt: now() + CACHE_TTL_MS };
    return null;
  }

  try {
    const res = await client().get('/forecast', {
      params: { q: getCity(), appid: apiKey, units: 'metric', lang: 'zh_cn' },
    });
    const list = Array.isArray(res.data?.list) ? res.data.list : [];
    // 24h ≈ 8 个 3 小时块
    const value = list.slice(0, 8).map(item => ({
      time: item.dt_txt || new Date((item.dt || 0) * 1000).toISOString(),
      temp: Math.round(item.main?.temp ?? NaN),
      condition: item.weather?.[0]?.description || '',
    }));
    cache.next24h = { value, expiresAt: now() + CACHE_TTL_MS };
    return value;
  } catch (err) {
    console.error('[weather] getNext24h failed:', err.message);
    cache.next24h = { value: null, expiresAt: now() + CACHE_TTL_MS };
    return null;
  }
}

// settings 改动后由 app.js 调用，避免缓存陈旧
export function invalidateCache() {
  cache.current = { value: null, expiresAt: 0 };
  cache.next24h = { value: null, expiresAt: 0 };
}

// 测试辅助：清缓存（保留旧 API 名以兼容老测试）
export function _resetCache() {
  invalidateCache();
}

export default { getCurrent, getNext24h, invalidateCache, _resetCache };
