import axios from 'axios';
import 'dotenv/config';
import { get as getSetting } from './settings.js';

const BASE = 'https://api.openweathermap.org/data/2.5';
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

function now() {
  return Date.now();
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
    const d = res.data || {};
    const value = {
      temp: Math.round(d.main?.temp ?? NaN),
      condition: d.weather?.[0]?.description || '',
      humidity: d.main?.humidity ?? null,
      city: d.name || getCity(),
    };
    cache.current = { value, expiresAt: now() + CACHE_TTL_MS };
    return value;
  } catch (err) {
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
