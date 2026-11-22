import { dbApi } from '../db.js';

export const KEYS = [
  'brain_mode',
  'dj_enabled',
  'dj_poll_seconds',
  'dj_min_remaining_minutes',
  'dj_batch_size',
  'deepseek_api_key',
  'deepseek_model',
  'adaptive_volume_enabled',
  'volume_safe_max',
  'like_target_listid',
  'like_target_name',
  'fish_api_key',
  'fish_voice_id',
  'weather_enabled',
  'openweather_api_key',
  'openweather_city',
  'calendar_provider',
  'ui_theme',
  'global_hotkey',
  'hotkey_media_key',
  'close_to_tray',
  'always_on_top_mini',
  'playback_quality',
];

export const DEFAULTS = {
  brain_mode: 'external',
  dj_enabled: 'false',
  dj_poll_seconds: '20',
  dj_min_remaining_minutes: '10',
  dj_batch_size: '5',
  deepseek_model: 'deepseek-chat',
  adaptive_volume_enabled: 'true',
  volume_safe_max: '85',
  weather_enabled: 'true',
  calendar_provider: 'none',
  ui_theme: 'auto',
  global_hotkey: 'CTRL+ALT+K',
  hotkey_media_key: 'false',
  close_to_tray: 'true',
  always_on_top_mini: 'true',
  playback_quality: 'flac',
};

const SENSITIVE = new Set(['openweather_api_key', 'fish_api_key', 'deepseek_api_key']);

const ENV_ALIASES = {
  brain_mode: ['BRAIN_MODE', 'CLAUDIO_BRAIN'],
  dj_enabled: ['DJ_ENABLED', 'CLAUDIO_DJ'],
  dj_batch_size: ['DJ_BATCH_SIZE', 'CLAUDIO_DJ_BATCH'],
};

function envNamesFor(key) {
  return ENV_ALIASES[key] || [key.toUpperCase()];
}

export function isSensitive(key) {
  return SENSITIVE.has(key);
}

export function get(key) {
  if (!KEYS.includes(key)) return '';
  const pref = dbApi.getPref(key);
  if (pref != null && pref !== '') return pref;
  for (const name of envNamesFor(key)) {
    const env = process.env[name];
    if (env != null && env !== '') return env;
  }
  return '';
}

export function getWithDefault(key) {
  const val = get(key);
  return val !== '' ? val : (DEFAULTS[key] ?? '');
}

export function getBoolean(key, fallback = false) {
  const raw = String(get(key) || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes') return true;
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return false;
  return fallback;
}

export function getNumber(key, fallback = 0) {
  const raw = get(key);
  if (raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function getAll() {
  const out = {};
  for (const k of KEYS) out[k] = get(k);
  return out;
}

export function set(key, value) {
  if (!KEYS.includes(key)) {
    throw new Error(`unknown setting key: ${key}`);
  }
  if (value === '' || value == null) {
    dbApi.delPref(key);
  } else {
    dbApi.setPref(key, String(value));
  }
}

export default { KEYS, DEFAULTS, getAll, get, getWithDefault, getBoolean, getNumber, set, isSensitive };
