import { dbApi } from '../db.js';

export const KEYS = [
  'openweather_api_key',
  'openweather_city',
  'fish_api_key',
  'fish_voice_id',
];

const SENSITIVE = new Set(['openweather_api_key', 'fish_api_key']);

function envName(key) {
  return key.toUpperCase();
}

export function isSensitive(key) {
  return SENSITIVE.has(key);
}

export function get(key) {
  if (!KEYS.includes(key)) return '';
  const pref = dbApi.getPref(key);
  if (pref != null && pref !== '') return pref;
  const env = process.env[envName(key)];
  return env == null ? '' : env;
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

export default { KEYS, getAll, get, set, isSensitive };
