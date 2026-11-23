// 网易云音乐扫码登录 + state.db 凭证持久化 + 低频自动续期（对齐 kugou-login.js 结构）。
//
// 安全边界：日志与返回值严禁打印或回传完整 cookie / MUSIC_U 明文。
import axios from 'axios';
import 'dotenv/config';
import { dbApi } from '../db.js';
import { axiosProxyOptions } from '../outbound-proxy.js';
import { cookieMapFromSetCookie, serializeCookie } from './kugou-cookie.js';

const QR_KEY_PATH     = '/login/qr/key';
const QR_CREATE_PATH  = '/login/qr/create';
const QR_CHECK_PATH   = '/login/qr/check';
const STATUS_PATH     = '/login/status';
const REFRESH_PATH    = '/login/refresh';

export const COOKIE_PREF = 'netease_cookie';
export const REFRESHED_AT_PREF = 'netease_token_refreshed_at';

const SET_COOKIE_ATTRS = new Set([
  'max-age',
  'expires',
  'path',
  'domain',
  'samesite',
  'secure',
  'httponly',
  'priority',
  'partitioned',
]);

// Netease /login/qr/check 状态码 → Settings 弹窗统一状态码（0 过期 / 1 等扫码 / 2 等确认 / 4 成功）
const QR_CODE_MAP = {
  800: { status: 0, statusText: '过期' },
  801: { status: 1, statusText: '等扫码' },
  802: { status: 2, statusText: '等确认' },
  803: { status: 4, statusText: '成功' },
};

export function neteaseBaseUrl() {
  return String(process.env.NETEASE_API_BASE || '').trim().replace(/\/+$/, '');
}

/**
 * 续期间隔（毫秒）。默认 24h，可用 NETEASE_REFRESH_INTERVAL_HOURS 覆盖。
 * 低频刷新避免频繁请求触发上游风控。
 */
export function refreshIntervalMs() {
  const h = Number(process.env.NETEASE_REFRESH_INTERVAL_HOURS);
  const hours = Number.isFinite(h) && h > 0 ? h : 24;
  return hours * 60 * 60 * 1000;
}

function tickMs() {
  const interval = refreshIntervalMs();
  return Math.max(5 * 60 * 1000, Math.min(interval / 4, 6 * 60 * 60 * 1000));
}

/**
 * 解析网易云 cookie 字符串（兼容上游 `result.cookie.join(';')` 混入的 Max-Age/Path/Expires 等属性）。
 */
export function parseNeteaseCookie(str) {
  const out = {};
  if (!str || typeof str !== 'string') return out;
  for (const segment of str.split(';')) {
    const s = segment.trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    const k = s.slice(0, eq).trim();
    const v = s.slice(eq + 1).trim();
    if (!k || !v) continue;
    if (SET_COOKIE_ATTRS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/**
 * 合并并清洗网易云登录 cookie：剔除 Set-Cookie 属性，且在存在 MUSIC_U 时剔除匿名 MUSIC_A。
 */
export function sanitizeNeteaseCookie(...sources) {
  const merged = {};
  for (const src of sources) {
    const map = typeof src === 'string' ? parseNeteaseCookie(src) : (src || {});
    for (const [k, v] of Object.entries(map)) {
      if (!k || v == null || v === '') continue;
      if (SET_COOKIE_ATTRS.has(k.toLowerCase())) continue;
      merged[k] = String(v).trim();
    }
  }
  if (merged.MUSIC_U) {
    delete merged.MUSIC_A;
  }
  return merged;
}

export function hasMusicU(cookie) {
  const map = typeof cookie === 'string' ? parseNeteaseCookie(cookie) : (cookie || {});
  return Boolean(map.MUSIC_U);
}

function wrapApiError(err, base) {
  if (err?.code === 'ECONNREFUSED') {
    return new Error(`网易云 API 服务未启动（${base} 无法连接）`);
  }
  return err;
}

function normalizeQrDataUrl(raw) {
  const val = String(raw || '').trim();
  if (!val) return '';
  if (val.startsWith('data:image/') || /^https?:\/\//i.test(val)) return val;
  // 纯 base64 兜底转为 dataURL
  if (/^[A-Za-z0-9+/=\s]+$/.test(val) && val.length > 32) {
    return `data:image/png;base64,${val.replace(/\s+/g, '')}`;
  }
  return '';
}

function axiosGet(url, config = {}) {
  return axios.get(url, { ...config, ...axiosProxyOptions(url) });
}

async function httpGetFull(url, params = {}) {
  const r = await axiosGet(url, { params, timeout: 8_000 });
  return { data: r.data, cookies: cookieMapFromSetCookie(r.headers?.['set-cookie']) };
}

/**
 * 探测 MUSIC_U 登录态是否仍然有效（排除上游匿名账号回退）。
 */
export async function isCookieAlive(cookie, { httpGet = httpGetFull } = {}) {
  const base = neteaseBaseUrl();
  if (!base || !cookie || !hasMusicU(cookie)) return false;
  try {
    const clean = serializeCookie(sanitizeNeteaseCookie(cookie));
    const res = await httpGet(`${base}${STATUS_PATH}`, { cookie: clean, _t: Date.now() });
    const body = res?.data ?? res ?? {};
    const inner = body?.data || body || {};
    const profile = inner.profile || null;
    const account = inner.account || null;
    return Boolean(profile && (profile.userId || profile.nickname) && !account?.anonimousUser);
  } catch {
    return false;
  }
}

/**
 * 启动扫码登录：调 /login/qr/key → /login/qr/create?qrimg=true 返回 dataURL。
 */
export async function startQrLogin({ httpGet = httpGetFull } = {}) {
  const base = neteaseBaseUrl();
  if (!base) throw new Error('NETEASE_API_BASE 未配置');

  let r1;
  try {
    r1 = await httpGet(`${base}${QR_KEY_PATH}`, { _t: Date.now() });
  } catch (err) {
    throw wrapApiError(err, base);
  }
  const body1 = r1?.data ?? r1 ?? {};
  const key = body1?.data?.unikey || body1?.unikey || body1?.data?.qrcode || '';
  if (!key) throw new Error('QR key empty');

  let r2;
  try {
    r2 = await httpGet(`${base}${QR_CREATE_PATH}`, { key, qrimg: true, _t: Date.now() });
  } catch (err) {
    throw wrapApiError(err, base);
  }
  const body2 = r2?.data ?? r2 ?? {};
  const inner = body2?.data || body2 || {};
  const qrImg = normalizeQrDataUrl(inner.qrimg || inner.qrcode_img || inner.base64 || '');
  const qrUrl = String(inner.qrurl || inner.url || `https://music.163.com/login?codekey=${encodeURIComponent(key)}`).trim();
  return { key, qrImg, qrUrl };
}

/**
 * 轮询扫码状态：code=803 且提取到 MUSIC_U 时写入 state.db.prefs.netease_cookie。
 * 绝不在返回值或日志里包含 cookie 明文。
 */
export async function checkQrLogin(key, { httpGet = httpGetFull, db = dbApi, now = Date.now() } = {}) {
  if (!key) throw new Error('key required');
  const base = neteaseBaseUrl();
  if (!base) throw new Error('NETEASE_API_BASE 未配置');

  let raw;
  try {
    raw = await httpGet(`${base}${QR_CHECK_PATH}`, { key, _t: now });
  } catch (err) {
    throw wrapApiError(err, base);
  }

  const hasCookies = raw != null && typeof raw.cookies === 'object' && ('data' in raw);
  const body = hasCookies ? raw.data : raw;
  const headerCookies = hasCookies ? raw.cookies : {};

  const code = Number(body?.code ?? body?.data?.code);
  const mapped = QR_CODE_MAP[code] || { status: 1, statusText: `未知(${Number.isFinite(code) ? code : '?'})` };

  if (code === 803) {
    const cookieMap = sanitizeNeteaseCookie(
      body?.cookie || body?.data?.cookie || '',
      headerCookies,
    );
    if (cookieMap.MUSIC_U) {
      const finalCookie = serializeCookie(cookieMap);
      db.setPref(COOKIE_PREF, finalCookie);
      db.setPref(REFRESHED_AT_PREF, String(now));
      return {
        status: 4,
        code: 803,
        statusText: '成功',
        savedCookie: true,
        loggedIn: true,
      };
    }
    console.warn('[netease-login] code=803 但未提取到 MUSIC_U · cookie keys:', Object.keys(cookieMap));
    return {
      status: 4,
      code: 803,
      statusText: '成功',
      savedCookie: false,
      loggedIn: false,
    };
  }

  return {
    status: mapped.status,
    code: Number.isFinite(code) ? code : null,
    statusText: mapped.statusText,
    savedCookie: false,
    loggedIn: false,
    ...(body?.nickname ? { nickname: String(body.nickname) } : {}),
  };
}

/**
 * 调 /login/refresh 低频续期网易云会话，合并返回的新 cookie 字段并更新续期时间戳。
 */
export async function renewToken(cookie, { httpGet = httpGetFull, db = dbApi, now = Date.now() } = {}) {
  const current = sanitizeNeteaseCookie(cookie);
  if (!current.MUSIC_U) return { ok: false, reason: 'cookie 里没有 MUSIC_U' };

  const base = neteaseBaseUrl();
  if (!base) return { ok: false, reason: 'NETEASE_API_BASE 未配置' };

  let raw;
  try {
    raw = await httpGet(`${base}${REFRESH_PATH}`, {
      cookie: serializeCookie(current),
      _t: now,
    });
  } catch (err) {
    return { ok: false, reason: err.message };
  }

  const hasCookies = raw != null && typeof raw.cookies === 'object' && ('data' in raw);
  const body = hasCookies ? raw.data : raw;
  const headerCookies = hasCookies ? raw.cookies : {};
  const code = Number(body?.code ?? body?.data?.code);

  if (code !== 200) {
    return { ok: false, reason: `/login/refresh 返回 code=${Number.isFinite(code) ? code : '?'}` };
  }

  const incoming = sanitizeNeteaseCookie(
    body?.cookie || body?.data?.cookie || '',
    headerCookies,
  );
  const next = sanitizeNeteaseCookie(current, incoming);
  if (!next.MUSIC_U) return { ok: false, reason: '续期后缺少 MUSIC_U' };

  const str = serializeCookie(next);
  db.setPref(COOKIE_PREF, str);
  db.setPref(REFRESHED_AT_PREF, String(now));
  return { ok: true, cookie: str };
}

export function needsRenew({ db = dbApi, now = Date.now(), intervalMs = refreshIntervalMs() } = {}) {
  const last = Number(db.getPref(REFRESHED_AT_PREF)) || 0;
  if (!last) return true;
  return now - last >= intervalMs;
}

async function maybeRenew(cookie, { httpGet, db, now }) {
  if (!needsRenew({ db, now })) return { ok: false, reason: '未到续期时间' };
  const r = await renewToken(cookie, { httpGet, db, now });
  if (r.ok) {
    const hours = Math.round(refreshIntervalMs() / 3_600_000);
    console.log(`[netease-login] 会话已续期（低频，约每 ${hours}h 一次）`);
  }
  return r;
}

/**
 * 服务启动时检查本地保存的网易云登录态；失效时先尝试 /login/refresh 自愈，仍无凭证则降级匿名会话。
 */
export async function ensureLogin({
  db = dbApi,
  httpGet = httpGetFull,
  isAlive = isCookieAlive,
  now = Date.now(),
} = {}) {
  if (!neteaseBaseUrl()) {
    return { ok: false, source: null, skipped: true };
  }

  const savedCookie = db.getPref(COOKIE_PREF);
  if (savedCookie && await isAlive(savedCookie, { httpGet })) {
    console.log('[netease-login] OK · 已加载 state.db 登录凭证');
    await maybeRenew(savedCookie, { httpGet, db, now });
    return { ok: true, source: 'db' };
  }

  if (savedCookie && hasMusicU(savedCookie)) {
    const renewed = await renewToken(savedCookie, { httpGet, db, now });
    if (renewed.ok && await isAlive(renewed.cookie, { httpGet })) {
      console.log('[netease-login] OK · 旧 cookie 已通过 /login/refresh 续期');
      return { ok: true, source: 'renewed' };
    }
    console.warn('[netease-login] state.db 登录态已失效且续期未成功：', renewed.reason);
  }

  const envCookie = String(process.env.NETEASE_COOKIE || '').trim();
  if (envCookie && await isAlive(envCookie, { httpGet })) {
    console.log('[netease-login] OK · 使用环境变量 NETEASE_COOKIE');
    await maybeRenew(envCookie, { httpGet, db, now });
    return { ok: true, source: 'env' };
  }
  if (envCookie) {
    console.warn('[netease-login] 环境变量 NETEASE_COOKIE 已失效');
  }

  return { ok: false, source: 'anonymous' };
}

export async function runRefreshTick({
  db = dbApi,
  httpGet = httpGetFull,
  isAlive = isCookieAlive,
  log = console.log,
  now = Date.now(),
} = {}) {
  if (!neteaseBaseUrl()) return { ok: false, reason: 'NETEASE_API_BASE 未配置' };
  const cookie = db.getPref(COOKIE_PREF) || String(process.env.NETEASE_COOKIE || '').trim();
  if (!cookie || !hasMusicU(cookie)) return { ok: false, reason: 'cookie 缺失' };
  if (!needsRenew({ db, now })) return { ok: false, reason: '未到续期时间' };

  const alive = await isAlive(cookie, { httpGet });
  const r = await renewToken(cookie, { httpGet, db, now });
  if (r.ok) {
    log(`[netease-login] 巡检：会话已续期${alive ? '' : '（续期前已失效）'}`);
  } else {
    log('[netease-login] 巡检：续期未成功 ·', r.reason);
  }
  return r;
}

let refreshTimer = null;

export function startAutoRefresh(opts = {}) {
  stopAutoRefresh();
  if (!neteaseBaseUrl()) return null;
  refreshTimer = setInterval(() => {
    runRefreshTick(opts).catch(err => {
      console.warn('[netease-login] 巡检异常：', err.message);
    });
  }, tickMs());
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
  return refreshTimer;
}

export function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

export default {
  COOKIE_PREF,
  REFRESHED_AT_PREF,
  neteaseBaseUrl,
  refreshIntervalMs,
  parseNeteaseCookie,
  sanitizeNeteaseCookie,
  hasMusicU,
  startQrLogin,
  checkQrLogin,
  renewToken,
  needsRenew,
  ensureLogin,
  runRefreshTick,
  startAutoRefresh,
  stopAutoRefresh,
};
