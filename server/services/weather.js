import axios from 'axios';
import 'dotenv/config';
import { get as getSetting } from './settings.js';

const BASE = 'https://api.openweathermap.org/data/2.5';
const GEO_BASE = 'https://api.openweathermap.org/geo/1.0';
const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1';
const OPEN_METEO_GEO_BASE = 'https://geocoding-api.open-meteo.com/v1';
const CACHE_TTL_MS = 60_000;
const TIMEOUT_MS = 8_000;

const PRESET_COORDS = {
  changsha: { lat: 28.1987, lon: 112.9709, name: 'Changsha' },
  长沙: { lat: 28.1987, lon: 112.9709, name: 'Changsha' },
  shanghai: { lat: 31.2304, lon: 121.4737, name: 'Shanghai' },
  上海: { lat: 31.2304, lon: 121.4737, name: 'Shanghai' },
  beijing: { lat: 39.9042, lon: 116.4074, name: 'Beijing' },
  北京: { lat: 39.9042, lon: 116.4074, name: 'Beijing' },
  guangzhou: { lat: 23.1291, lon: 113.2644, name: 'Guangzhou' },
  广州: { lat: 23.1291, lon: 113.2644, name: 'Guangzhou' },
  shenzhen: { lat: 22.5431, lon: 114.0579, name: 'Shenzhen' },
  深圳: { lat: 22.5431, lon: 114.0579, name: 'Shenzhen' },
  wuhan: { lat: 30.5928, lon: 114.3055, name: 'Wuhan' },
  武汉: { lat: 30.5928, lon: 114.3055, name: 'Wuhan' },
  chengdu: { lat: 30.5728, lon: 104.0668, name: 'Chengdu' },
  成都: { lat: 30.5728, lon: 104.0668, name: 'Chengdu' },
  hangzhou: { lat: 30.2741, lon: 120.1551, name: 'Hangzhou' },
  杭州: { lat: 30.2741, lon: 120.1551, name: 'Hangzhou' },
};

const cache = {
  current: { value: null, expiresAt: 0 },
  next24h: { value: null, expiresAt: 0 },
};

function getKey() {
  return getSetting('openweather_api_key') || '';
}

function getCity() {
  return getSetting('openweather_city') || 'Changsha';
}

function client() {
  return axios.create({ baseURL: BASE, timeout: TIMEOUT_MS });
}

function geoClient() {
  return axios.create({ baseURL: GEO_BASE, timeout: TIMEOUT_MS });
}

function openMeteoClient() {
  return axios.create({ baseURL: OPEN_METEO_BASE, timeout: TIMEOUT_MS });
}

function openMeteoGeoClient() {
  return axios.create({ baseURL: OPEN_METEO_GEO_BASE, timeout: TIMEOUT_MS });
}

function now() {
  return Date.now();
}

function isCityNotFound(err) {
  return err?.response?.status === 404;
}

function shouldFallbackFromOpenWeather(err) {
  const status = err?.response?.status;
  return status === 401 || status === 403 || status === 429;
}

function wmoToWeather(code, isDay = 1) {
  const c = Number(code);
  const d = isDay ? 'd' : 'n';
  if (c === 0) return { condition: '晴', icon: `01${d}` };
  if (c === 1) return { condition: '大部晴朗', icon: `02${d}` };
  if (c === 2) return { condition: '多云', icon: `03${d}` };
  if (c === 3) return { condition: '阴', icon: `04${d}` };
  if (c === 45 || c === 48) return { condition: '雾', icon: '50d' };
  if ([51, 53, 55, 56, 57].includes(c)) return { condition: '毛毛雨', icon: '09d' };
  if ([61, 80].includes(c)) return { condition: '小雨', icon: '10d' };
  if ([63, 81].includes(c)) return { condition: '中雨', icon: '10d' };
  if ([65, 82].includes(c)) return { condition: '大雨', icon: '10d' };
  if ([66, 67].includes(c)) return { condition: '冻雨', icon: '13d' };
  if ([71, 73, 75, 77, 85, 86].includes(c)) return { condition: '雪', icon: '13d' };
  if ([95, 96, 99].includes(c)) return { condition: '雷阵雨', icon: '11d' };
  return { condition: '多云', icon: `03${d}` };
}

async function resolveOpenMeteoCity() {
  const rawCity = getCity();
  const baseName = String(rawCity || '').trim().split(',')[0].trim();
  const preset = PRESET_COORDS[baseName.toLowerCase()];
  if (preset) return preset;

  const res = await openMeteoGeoClient().get('/search', {
    params: { name: baseName || 'Changsha', count: 1, language: 'zh', format: 'json' },
  });
  const hit = Array.isArray(res.data?.results) ? res.data.results[0] : null;
  if (!hit || !Number.isFinite(hit.latitude) || !Number.isFinite(hit.longitude)) return null;
  return { lat: hit.latitude, lon: hit.longitude, name: hit.name || baseName };
}

async function fetchOpenMeteoCurrent() {
  const coords = await resolveOpenMeteoCity();
  if (!coords) return null;
  const res = await openMeteoClient().get('/forecast', {
    params: {
      latitude: coords.lat,
      longitude: coords.lon,
      current: 'temperature_2m,relative_humidity_2m,weather_code,is_day',
      timezone: 'Asia/Shanghai',
    },
  });
  const cur = res.data?.current;
  if (!cur || !Number.isFinite(Number(cur.temperature_2m))) return null;
  const mapped = wmoToWeather(cur.weather_code, cur.is_day ?? 1);
  return {
    temp: Math.round(Number(cur.temperature_2m)),
    condition: mapped.condition,
    icon: mapped.icon,
    humidity: cur.relative_humidity_2m != null ? Math.round(Number(cur.relative_humidity_2m)) : null,
    city: coords.name,
  };
}

async function fetchOpenMeteoNext24h() {
  const coords = await resolveOpenMeteoCity();
  if (!coords) return null;
  const res = await openMeteoClient().get('/forecast', {
    params: {
      latitude: coords.lat,
      longitude: coords.lon,
      hourly: 'temperature_2m,weather_code',
      forecast_days: 2,
      timezone: 'Asia/Shanghai',
    },
  });
  const times = Array.isArray(res.data?.hourly?.time) ? res.data.hourly.time : [];
  const temps = Array.isArray(res.data?.hourly?.temperature_2m) ? res.data.hourly.temperature_2m : [];
  const codes = Array.isArray(res.data?.hourly?.weather_code) ? res.data.hourly.weather_code : [];
  if (!times.length) return null;
  const value = [];
  for (let i = 0; i < times.length && value.length < 8; i += 3) {
    value.push({
      time: times[i],
      temp: Math.round(Number(temps[i] ?? NaN)),
      condition: wmoToWeather(codes[i]).condition,
    });
  }
  return value;
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
    icon: data.weather?.[0]?.icon || '',
    humidity: data.main?.humidity ?? null,
    city: data.name || getCity(),
  };
}

export async function getCurrent() {
  if (cache.current.expiresAt > now()) return cache.current.value;

  const apiKey = getKey();
  if (!apiKey) {
    try {
      const value = await fetchOpenMeteoCurrent();
      cache.current = { value, expiresAt: now() + CACHE_TTL_MS };
      return value;
    } catch (err) {
      console.error('[weather] open-meteo getCurrent failed:', err.message);
      cache.current = { value: null, expiresAt: now() + CACHE_TTL_MS };
      return null;
    }
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
        if (shouldFallbackFromOpenWeather(geoErr)) {
          try {
            const fallback = await fetchOpenMeteoCurrent();
            if (fallback) {
              cache.current = { value: fallback, expiresAt: now() + CACHE_TTL_MS };
              return fallback;
            }
          } catch { /* fall through */ }
        }
        console.error('[weather] geocoding fallback failed:', geoErr.message);
      }
    }
    if (shouldFallbackFromOpenWeather(err)) {
      try {
        const fallback = await fetchOpenMeteoCurrent();
        if (fallback) {
          cache.current = { value: fallback, expiresAt: now() + CACHE_TTL_MS };
          return fallback;
        }
      } catch (omErr) {
        console.error('[weather] open-meteo fallback failed:', omErr.message);
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
    try {
      const value = await fetchOpenMeteoNext24h();
      cache.next24h = { value, expiresAt: now() + CACHE_TTL_MS };
      return value;
    } catch (err) {
      console.error('[weather] open-meteo getNext24h failed:', err.message);
      cache.next24h = { value: null, expiresAt: now() + CACHE_TTL_MS };
      return null;
    }
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
    if (shouldFallbackFromOpenWeather(err)) {
      try {
        const fallback = await fetchOpenMeteoNext24h();
        if (fallback) {
          cache.next24h = { value: fallback, expiresAt: now() + CACHE_TTL_MS };
          return fallback;
        }
      } catch (omErr) {
        console.error('[weather] open-meteo forecast fallback failed:', omErr.message);
      }
    }
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
