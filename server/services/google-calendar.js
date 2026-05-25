import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';

const DEFAULT_CREDS = path.join(process.env.HOME, '.config/google-calendar-mcp/gcp-oauth.keys.json');
const CREDS_PATH = process.env.GOOGLE_OAUTH_CREDENTIALS || DEFAULT_CREDS;
const TOKENS_PATH = path.join(path.dirname(CREDS_PATH), 'tokens.json');
const CACHE_TTL_MS = 5 * 60_000;

const cache = { value: null, expiresAt: 0 };

function readCreds() {
  const raw = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
  const key = raw.installed || raw.web;
  return { clientId: key.client_id, clientSecret: key.client_secret, tokenUri: key.token_uri };
}

function readTokens() {
  const raw = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
  return raw.normal || raw;
}

function saveAccessToken(accessToken, expiryDate) {
  try {
    const raw = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
    const account = raw.normal ?? raw;
    account.access_token = accessToken;
    account.expiry_date = expiryDate;
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(raw, null, 2));
  } catch {
    // 非致命，下次会重新刷新
  }
}

async function getAccessToken() {
  const tokens = readTokens();
  if (tokens.expiry_date && tokens.expiry_date > Date.now() + 60_000) {
    return tokens.access_token;
  }
  const { clientId, clientSecret, tokenUri } = readCreds();
  const resp = await axios.post(
    tokenUri,
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10_000 },
  );
  const { access_token, expires_in } = resp.data;
  const expiry_date = Date.now() + expires_in * 1_000;
  saveAccessToken(access_token, expiry_date);
  return access_token;
}

function normalizeEvent(item) {
  return {
    title: item.summary || '(无标题)',
    start: item.start?.dateTime || item.start?.date || '',
    end: item.end?.dateTime || item.end?.date || '',
    location: typeof item.location === 'string' ? item.location : '',
  };
}

async function fetchEvents(accessToken, calendarId, timeMin, timeMax) {
  const resp = await axios.get(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { timeMin, timeMax, singleEvents: true, orderBy: 'startTime', maxResults: 20 },
      timeout: 10_000,
    },
  );
  return (resp.data.items || []).map(normalizeEvent);
}

export async function getTodayEvents() {
  if (cache.expiresAt > Date.now()) return cache.value;

  try {
    const accessToken = await getAccessToken();
    const now = new Date();
    const timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const timeMax = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

    const listResp = await axios.get('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 10_000,
    });
    const calendars = (listResp.data.items || []).filter(c => c.selected !== false);

    const results = await Promise.allSettled(
      calendars.map(cal => fetchEvents(accessToken, cal.id, timeMin, timeMax)),
    );
    const allEvents = results
      .flatMap(r => (r.status === 'fulfilled' ? r.value : []))
      .sort((a, b) => a.start.localeCompare(b.start));

    cache.value = allEvents;
    cache.expiresAt = Date.now() + CACHE_TTL_MS;
    return allEvents;
  } catch (err) {
    console.error('[google-calendar] getTodayEvents failed:', err.message);
    cache.value = null;
    cache.expiresAt = Date.now() + CACHE_TTL_MS;
    return null;
  }
}

export function _resetCache() {
  cache.value = null;
  cache.expiresAt = 0;
}

export default { getTodayEvents, _resetCache };
