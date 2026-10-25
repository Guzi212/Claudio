import axios from 'axios';
import 'dotenv/config';
import { dbApi } from '../db.js';
import {
  mergeCookieMap,
  serializeCookie,
  cookieMapFromSetCookie,
  pickIdentity,
  hasDfid,
} from './kugou-cookie.js';

const BASE = process.env.KUGOU_API_BASE || 'http://localhost:3000';

// KuGouMusicApi 社区版的登录接口路径。不同 fork 名字略有差异。
const LOGIN_PATH = '/login/cellphone';     // GET ?mobile=xxx&password=xxx
const STATUS_PATH = '/user/detail';        // GET （带 cookie 才能拿到）
const QR_KEY_PATH = '/login/qr/key';
const QR_CREATE_PATH = '/login/qr/create';
const REGISTER_DEV_PATH = '/register/dev'; // 换 dfid（设备漫游 id）
const TOKEN_PATH = '/login/token';         // 续期 token / t1 / vip_*

export const COOKIE_PREF = 'kugou_cookie';
export const REFRESHED_AT_PREF = 'kugou_token_refreshed_at';

/**
 * 续期间隔（毫秒）。默认 24h，可用 KUGOU_REFRESH_INTERVAL_HOURS 覆盖。
 *
 * 为什么不是「每次启动都续」：上游文档明确提醒
 * 「不要频繁调登录接口,不然可能会被风控」——开发期反复重启服务会疯狂触发续期。
 * 所以这里只在「距上次成功续期超过间隔」时才真正调 /login/token。
 */
export function refreshIntervalMs() {
  const h = Number(process.env.KUGOU_REFRESH_INTERVAL_HOURS);
  const hours = Number.isFinite(h) && h > 0 ? h : 24;
  return hours * 60 * 60 * 1000;
}

/** 后台巡检间隔：仅为「到点后能及时续期」，巡检本身不联网，不增加登录频率。 */
function tickMs() {
  const interval = refreshIntervalMs();
  return Math.max(5 * 60 * 1000, Math.min(interval / 4, 6 * 60 * 60 * 1000));
}

// ────────────────────────────────────────────────────────
// 底层 HTTP：额外把 Set-Cookie 也带回来（dfid / t1 都只在 Set-Cookie 里）
// ────────────────────────────────────────────────────────
async function httpGetFull(url, params = {}) {
  const r = await axios.get(url, { params, timeout: 8_000 });
  return { data: r.data, cookies: cookieMapFromSetCookie(r.headers?.['set-cookie']) };
}

/**
 * 探测 cookie 是否仍然有效（决定要不要续期 / 要不要让用户扫码）。
 *
 * 必须用 ?cookie= query 参数，不能用 Cookie 请求头 —— 实测（2026-09）上游
 * /user/detail 只在 query 形式下可用：
 *   Cookie 头 + token/userid       → 502 / error_code 20018
 *   Cookie 头 + token/userid/dfid  → 404
 *   ?cookie=... （两种内容都一样）  → 200 / status=1
 * 用头传会 4xx/5xx → axios 抛错 → 被误判成「cookie 失效」，于是每次启动都白调一次
 * /login/token 续期；上游文档明确警告「不要频繁调登录接口,不然可能会被风控」，
 * 高频登录正是把手机 / 电脑端挤下线的推手。
 */
async function isCookieAlive(cookie) {
  if (!cookie) return false;
  try {
    const res = await axios.get(`${BASE}${STATUS_PATH}`, {
      params: { cookie: serializeCookie(mergeCookieMap(cookie)) },
      timeout: 5_000,
    });
    return res.data && (res.data.status === 1 || res.data.userid || res.data?.data?.userid);
  } catch {
    return false;
  }
}

function pickCookieFromResponse(res) {
  // 优先用 KuGouMusicApi 返回里的 cookie 字段
  if (res.data?.cookie) return res.data.cookie;
  if (res.data?.data?.cookie) return res.data.data.cookie;

  // 退而求其次：从 set-cookie 头拼
  const fromHeader = cookieMapFromSetCookie(res.headers?.['set-cookie']);
  const str = serializeCookie(fromHeader);
  return str;
}

async function loginByPassword(username, password) {
  try {
    const res = await axios.get(`${BASE}${LOGIN_PATH}`, {
      params: { mobile: username, password },
      timeout: 10_000,
    });
    const cookie = pickCookieFromResponse(res);
    if (!cookie) {
      console.warn('[kugou-login] password login returned no cookie:', JSON.stringify(res.data).slice(0, 200));
      return null;
    }
    return cookie;
  } catch (err) {
    console.error('[kugou-login] password login failed:', err.message);
    return null;
  }
}

/**
 * 调 /register/dev 换 dfid。
 * dfid 是酷狗的「设备漫游 id」：没有它时上游会退回随机值，把每次播放都当成新设备。
 * 上游把它放在 Set-Cookie 里返回，所以这里必须用能拿到 set-cookie 的 httpGet。
 */
export async function fetchDfid(cookie, { httpGet = httpGetFull } = {}) {
  if (!cookie) return '';
  try {
    // 归一化成 ';' 连接再发：上游 cookieToJson 是 split(';') 且不 trim，
    // 旧库里存的 '; ' 格式会让 userid / dfid 变成 " userid" / " dfid" 而丢失，
    // 导致 register_dev 拿不到 userid（rsaEncrypt2 的 uid）→ 换不回 dfid。
    const res = await httpGet(`${BASE}${REGISTER_DEV_PATH}`, {
      cookie: serializeCookie(mergeCookieMap(cookie)),
    });
    return res?.cookies?.dfid || res?.data?.data?.dfid || '';
  } catch (err) {
    console.warn('[kugou-login] /register/dev 获取 dfid 失败：', err.message);
    return '';
  }
}

/**
 * 保证本地 cookie 带 dfid；缺了就补上并写回 state.db。
 * 失败（上游没起、被风控）时静默降级：返回原 cookie，不阻断启动。
 */
export async function ensureDfid(cookie, { httpGet = httpGetFull, db = dbApi } = {}) {
  if (!cookie) return { ok: false, cookie: '' };
  if (hasDfid(cookie)) return { ok: true, cookie };

  const dfid = await fetchDfid(cookie, { httpGet });
  if (!dfid) return { ok: false, cookie };

  const next = serializeCookie(mergeCookieMap(cookie, { dfid }));
  db.setPref(COOKIE_PREF, next);
  console.log('[kugou-login] 已补 dfid 到本地 cookie（防止上游把每次播放当新设备）');
  return { ok: true, cookie: next };
}

/**
 * 用 /login/token 续期：上游成功时会回新的 token / t1 / vip_type / vip_token，
 * 把它们合并进本地 cookie 并记录续期时间。
 */
export async function renewToken(cookie, { httpGet = httpGetFull, db = dbApi, now = Date.now() } = {}) {
  const current = mergeCookieMap(cookie);
  if (!current.token) return { ok: false, reason: 'cookie 里没有 token' };

  let res;
  try {
    res = await httpGet(`${BASE}${TOKEN_PATH}`, { cookie: serializeCookie(pickIdentity(current)) });
  } catch (err) {
    return { ok: false, reason: err.message };
  }

  // 上游把续期结果同时放在 body.data 和 Set-Cookie 里，两边都收。
  // 必须以上游「确实回了新 token」为准：否则保留旧 token 会被误判为续期成功，
  // 从而把下一次续期推迟一整个间隔。
  const incoming = mergeCookieMap(
    pickIdentity(res?.cookies),
    pickIdentity(res?.data?.data),
  );
  if (!incoming.token) return { ok: false, reason: '/login/token 未返回 token' };

  const next = mergeCookieMap(pickIdentity(current), incoming);

  const str = serializeCookie(next);
  db.setPref(COOKIE_PREF, str);
  db.setPref(REFRESHED_AT_PREF, String(now));
  return { ok: true, cookie: str };
}

/** 距上次成功续期是否已超过间隔（从未续期过 → true）。 */
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
    console.log(`[kugou-login] token 已续期（低频，约每 ${hours}h 一次）`);
  }
  return r;
}

/** 密码 / 扫码拿到新 cookie 后：补 dfid → 存库 → 记续期时间。 */
async function adoptFreshCookie(cookie, { httpGet, db, now }) {
  const { cookie: withDfid } = await ensureDfid(cookie, { httpGet, db });
  const finalCookie = withDfid || cookie;
  db.setPref(COOKIE_PREF, finalCookie);
  db.setPref(REFRESHED_AT_PREF, String(now));
  return finalCookie;
}

async function printQrHint() {
  try {
    const r1 = await axios.get(`${BASE}${QR_KEY_PATH}`, { timeout: 5_000 });
    const key = r1.data?.data?.qrcode || r1.data?.qrcode || '';
    if (!key) {
      console.warn('[kugou-login] QR key 获取失败，请手动到 KuGouMusicApi 文档查 QR 流程');
      return;
    }
    const r2 = await axios.get(`${BASE}${QR_CREATE_PATH}`, { params: { key, qrimg: true }, timeout: 5_000 });
    const qrurl = r2.data?.data?.qrurl || r2.data?.qrurl || r2.data?.data?.url || '';
    console.warn('');
    console.warn('  ┌─────────────────────────────────────────────┐');
    console.warn('  │  KuGou 登录失败 · 请手机扫码登录              │');
    console.warn('  │  扫码 URL:                                   │');
    console.warn(`  │  ${qrurl}`);
    console.warn('  │  扫完成后重启服务                              │');
    console.warn('  └─────────────────────────────────────────────┘');
    console.warn('');
  } catch (err) {
    console.warn('[kugou-login] QR 流程不可用：', err.message);
  }
}

/**
 * 启动时调用一次。
 * 1) .env 的 KUGOU_COOKIE（用户手动贴的）
 * 2) state.db.prefs.kugou_cookie（扫码 / 自动登录留下的完整 cookie）
 * 3) 已失效 → 先试 /login/token 自愈续期，能免扫码就不用扫码
 * 4) 用户名密码登录
 * 5) 全失败 → 打印 QR 提示
 */
export async function ensureLogin({ db = dbApi, httpGet = httpGetFull, isAlive = isCookieAlive, hint = printQrHint, now = Date.now() } = {}) {
  const envCookie = process.env.KUGOU_COOKIE;
  if (envCookie && await isAlive(envCookie)) {
    console.log('[kugou-login] OK · 用 .env 里的 KUGOU_COOKIE');
    const { cookie: envFull } = await ensureDfid(envCookie, { httpGet, db });
    await maybeRenew(envFull || envCookie, { httpGet, db, now });
    return { ok: true, source: 'env' };
  }
  if (envCookie) console.warn('[kugou-login] .env 里的 KUGOU_COOKIE 已失效');

  const savedCookie = db.getPref(COOKIE_PREF);
  if (savedCookie && await isAlive(savedCookie)) {
    console.log('[kugou-login] OK · 用 state.db 里上次保存的 cookie');
    // 先用带 dfid 的完整身份去续期，避免续期请求本身又被当成新设备
    const { cookie: savedFull } = await ensureDfid(savedCookie, { httpGet, db });
    await maybeRenew(savedFull || savedCookie, { httpGet, db, now });
    return { ok: true, source: 'db' };
  }

  // cookie 失效时不急着让用户扫码：先试一次续期，续期成功就等于免扫码。
  if (savedCookie && savedCookie.includes('token=')) {
    const renewed = await renewToken(savedCookie, { httpGet, db, now });
    if (renewed.ok && await isAlive(renewed.cookie)) {
      console.log('[kugou-login] OK · 旧 cookie 已通过 /login/token 续期（无需扫码）');
      await ensureDfid(renewed.cookie, { httpGet, db });
      return { ok: true, source: 'renewed' };
    }
    console.warn('[kugou-login] 续期未成功：', renewed.reason);
  }

  const username = process.env.KUGOU_USERNAME;
  const password = process.env.KUGOU_PASSWORD;
  if (username && password) {
    const fresh = await loginByPassword(username, password);
    if (fresh && await isAlive(fresh)) {
      await adoptFreshCookie(fresh, { httpGet, db, now });
      console.log('[kugou-login] OK · 用用户名密码登录成功，完整 cookie 已保存到 state.db');
      return { ok: true, source: 'fresh' };
    }
  }

  console.warn('[kugou-login] FAIL · 所有登录方式都失败');
  await hint();
  return { ok: false, source: null };
}

/**
 * 单次巡检：只在「到续期时间」时才联网调 /login/token。
 * 单独导出是为了让单测可以直接驱动，不必依赖真实定时器。
 */
export async function runRefreshTick({ db = dbApi, httpGet = httpGetFull, isAlive = isCookieAlive, log = console.log, now = Date.now() } = {}) {
  const cookie = db.getPref(COOKIE_PREF) || process.env.KUGOU_COOKIE || '';
  if (!cookie) return { ok: false, reason: 'cookie 缺失' };
  if (!needsRenew({ db, now })) return { ok: false, reason: '未到续期时间' };

  const alive = await isAlive(cookie);
  const r = await renewToken(cookie, { httpGet, db, now });
  if (r.ok) {
    log(`[kugou-login] 巡检：token 已续期${alive ? '' : '（续期前已失效）'}`);
  } else {
    log('[kugou-login] 巡检：续期未成功 ·', r.reason);
  }
  return r;
}

let refreshTimer = null;

/** 挂后台续期定时器（不阻止进程退出）。 */
export function startAutoRefresh(opts = {}) {
  stopAutoRefresh();
  refreshTimer = setInterval(() => {
    runRefreshTick(opts).catch(err => {
      console.warn('[kugou-login] 巡检异常：', err.message);
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
  ensureLogin,
  ensureDfid,
  renewToken,
  needsRenew,
  runRefreshTick,
  startAutoRefresh,
  stopAutoRefresh,
};
