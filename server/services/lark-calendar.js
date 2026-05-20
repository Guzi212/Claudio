import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const CACHE_TTL_MS = 60_000;
const TIMEOUT_MS = 15_000;
const MAX_BUFFER = 4 * 1024 * 1024;
const CMD = 'lark-cli calendar +agenda --format json';

const cache = { value: null, expiresAt: 0 };

function now() {
  return Date.now();
}

function pickEvents(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];
  return (
    parsed.events
    || parsed.items
    || parsed.agenda
    || parsed.data?.events
    || parsed.data?.items
    || parsed.data?.agenda
    || (Array.isArray(parsed.data) ? parsed.data : null)
    || []
  );
}

function normalizeTime(t) {
  if (!t) return '';
  if (typeof t === 'string') return t;
  if (typeof t === 'number') return new Date(t).toISOString();
  if (typeof t === 'object') {
    return t.date_time || t.dateTime || t.timestamp || t.time || '';
  }
  return '';
}

function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = raw.title || raw.summary || raw.subject || raw.name || '(无标题)';
  const start = normalizeTime(raw.start_time || raw.start || raw.startTime);
  const end = normalizeTime(raw.end_time || raw.end || raw.endTime);
  const location = raw.location?.name || raw.location || raw.place || '';
  return { title, start, end, location };
}

export async function getTodayEvents() {
  if (cache.expiresAt > now()) return cache.value;

  try {
    const { stdout } = await execAsync(CMD, { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER });
    const text = (stdout || '').trim();
    if (!text) {
      cache.value = [];
      cache.expiresAt = now() + CACHE_TTL_MS;
      return [];
    }
    const parsed = JSON.parse(text);
    const list = pickEvents(parsed);
    const value = Array.isArray(list)
      ? list.map(normalizeEvent).filter(Boolean)
      : [];
    cache.value = value;
    cache.expiresAt = now() + CACHE_TTL_MS;
    return value;
  } catch (err) {
    console.error('[lark-calendar] getTodayEvents failed:', err.message);
    cache.value = null;
    cache.expiresAt = now() + CACHE_TTL_MS;
    return null;
  }
}

// 测试辅助：清缓存
export function _resetCache() {
  cache.value = null;
  cache.expiresAt = 0;
}

export default { getTodayEvents, _resetCache };
