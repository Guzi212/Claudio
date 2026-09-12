import axios from 'axios';
import 'dotenv/config';
import { dbApi } from '../db.js';
import { parseSetCookie, mergeCookies } from './kugou-cookie.js';
import { startRelogin, pollRelogin } from '../api/kugou-relogin.js';

const BASE = process.env.KUGOU_API_BASE || 'http://localhost:3000';

// KuGouMusicApi 社区版的登录接口路径。不同 fork 名字略有差异。
const LOGIN_PATH = '/login/cellphone';     // GET ?mobile=xxx&password=xxx
const STATUS_PATH = '/user/detail';        // GET （带 cookie 才能拿到）
const REFRESH_PATH = '/login/token';       // GET （带 cookie，延长 token 过期时间）

const DEFAULT_REFRESH_MS = 12 * 60 * 60 * 1000;

// 续期间隔：默认 12h，可用 KUGOU_REFRESH_INTERVAL_HOURS 覆盖。
// token 实测 2-3 天过期，12h 一次能在过期前稳定续上。
export function refreshIntervalMs(env = process.env) {
  const hours = Number(env.KUGOU_REFRESH_INTERVAL_HOURS);
  if (Number.isFinite(hours) && hours > 0) return hours * 60 * 60 * 1000;
  return DEFAULT_REFRESH_MS;
}

// ── 底层 GET（可注入，便于单测 mock）──────────────────────────────

async function defaultGetDetail(url, { Cookie, params } = {}) {
  const r = await axios.get(url, {
    headers: Cookie ? { Cookie } : undefined,
    params,
    timeout: 5_000,
  });
  return { data: r.data };
}

// 续期/扫码专用：除了 body，还捕获 Set-Cookie（token 可能只在 cookie 里）。
async function defaultGetFull(url, { cookie, params } = {}) {
  const r = await axios.get(url, {
    headers: cookie ? { Cookie: cookie } : undefined,
    params,
    timeout: 10_000,
  });
  return { data: r.data, cookies: parseSetCookie(r.headers?.['set-cookie']) };
}

// ── 查活 & 续期 ──────────────────────────────────────────────────
//
// 注意：KuGouMusicApi 有 2 分钟全局响应缓存，缓存 key = hostname + originalUrl（忽略 Cookie 头）。
// 查活 / 续期的 URL 用 query 区分不了 cookie，若不带 timestamp，重扫后立刻重启可能命中旧缓存，
// 被误判成「已失效」而再次弹扫码。故这三个接口调用都带 timestamp 穿透缓存。

export async function isCookieAlive(cookie, { httpGet = defaultGetDetail, now = () => Date.now() } = {}) {
  if (!cookie) return false;
  try {
    const res = await httpGet(`${BASE}${STATUS_PATH}`, { Cookie: cookie, params: { timestamp: now() } });
    const data = res?.data ?? res;
    return Boolean(data && (data.status === 1 || data.userid || data?.data?.userid));
  } catch {
    return false;
  }
}

/**
 * 调 /login/token 续期。
 * 成功返回合并后的完整 cookie 字符串；失败（接口异常 / status!=1）返回 null。
 * 不抛错：调用方据此决定是否回退到扫码。
 */
export async function refreshCookie(cookie, { httpGet = defaultGetFull, now = () => Date.now() } = {}) {
  if (!cookie) return null;
  let res;
  try {
    res = await httpGet(`${BASE}${REFRESH_PATH}`, { cookie, params: { timestamp: now() } });
  } catch (err) {
    console.warn('[kugou-login] 刷新登录请求失败:', err.message);
    return null;
  }

  const body = res?.data;
  const ok = body?.status === 1 || body?.data?.status === 1;
  if (!ok) {
    console.warn('[kugou-login] 刷新登录未成功 · status =',
      body?.status ?? body?.data?.status ?? body?.error_code);
    return null;
  }

  const fromBody = {};
  const d = body?.data || body || {};
  if (d.token) fromBody.token = d.token;
  if (d.userid) fromBody.userid = d.userid;
  if (d.t1) fromBody.t1 = d.t1;
  if (d.vip_token) fromBody.vip_token = d.vip_token;
  if (d.vip_type) fromBody.vip_type = d.vip_type;

  return mergeCookies(cookie, { ...(res.cookies || {}), ...fromBody });
}

// 只做续期，绝不触发账密登录（避免频繁登录被风控）。
export async function refreshLogin({ db = dbApi, env = process.env, refresh = refreshCookie } = {}) {
  const cookie = db.getPref('kugou_cookie') || env.KUGOU_COOKIE || '';
  if (!cookie) return { ok: false, reason: 'no-cookie' };

  const fresh = await refresh(cookie);
  if (!fresh) return { ok: false, reason: 'refresh-failed' };

  db.setPref('kugou_cookie', fresh);
  return { ok: true };
}

/**
 * 起一个定时续期器。返回 { stop }，进程退出时调用。
 * 依赖全部可注入，测试不会真起定时器。
 */
export function startAutoRefresh({
  intervalMs = refreshIntervalMs(),
  log = (...args) => console.log('[kugou-login]', ...args),
  refresh = () => refreshLogin(),
  timer = setInterval,
  clear = clearInterval,
} = {}) {
  const id = timer(async () => {
    const out = await refresh();
    if (out?.ok) log('自动续期成功');
    else log(`自动续期失败（${out?.reason || 'unknown'}），可到设置里重新扫码`);
  }, intervalMs);
  if (id && typeof id.unref === 'function') id.unref();
  return { stop: () => clear(id) };
}

// ── 账密登录 & 扫码提示（兜底路径）────────────────────────────────

function pickCookieFromResponse(res) {
  // 优先用 KuGouMusicApi 返回里的 cookie 字段
  if (res.data?.cookie) return res.data.cookie;
  if (res.data?.data?.cookie) return res.data.data.cookie;

  // 退而求其次：从 set-cookie 头拼
  const setCookie = res.headers?.['set-cookie'];
  if (Array.isArray(setCookie) && setCookie.length) {
    return setCookie.map(c => c.split(';')[0]).join('; ');
  }
  return '';
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
 * 启动兜底：打印二维码 URL，并在后台轮询扫码状态，成功即落库（无需重启）。
 * 不阻塞启动：轮询是 fire-and-forget 的后台任务。
 * 返回 { ok, key } 便于测试断言。
 */
export async function beginQrLogin({
  db = dbApi,
  log = (...args) => console.warn(...args),
  start = startRelogin,
  poll = pollRelogin,
} = {}) {
  let qr;
  try {
    qr = await start();
  } catch (err) {
    console.warn('[kugou-login] QR 流程不可用：', err.message);
    return { ok: false, key: '' };
  }

  const { key, qrUrl } = qr || {};
  if (!key) {
    console.warn('[kugou-login] QR key 获取失败，请手动到 KuGouMusicApi 文档查 QR 流程');
    return { ok: false, key: '' };
  }

  console.warn('');
  console.warn('  ┌─────────────────────────────────────────────┐');
  console.warn('  │  KuGou 登录失败 · 请手机酷狗 App 扫码         │');
  console.warn('  │  扫码 URL:                                   │');
  console.warn(`  │  ${qrUrl}`);
  console.warn('  │  扫码后无需重启，服务会自动保存登录           │');
  console.warn('  └─────────────────────────────────────────────┘');
  console.warn('');

  // 后台轮询：status=4 时 checkRelogin 会把完整 cookie 写进 state.db，
  // 服务层 getCookie() 每次读 db，故生效无需重启。
  // 返回 task 便于测试等待，但调用方（ensureLogin）不 await 它，避免阻塞 server.listen。
  const task = Promise.resolve()
    .then(() => poll(key, {
      db,
      onStatus: (out) => {
        if (out.status === 4) log('✓ 扫码登录成功，cookie 已写入 state.db');
        else if (out.status === 0) log('二维码已过期，请到 PWA 设置重新扫码');
        else if (out.status === -1) log('扫码超时，请到 PWA 设置重新扫码');
      },
    }))
    .catch(err => { log('扫码轮询失败：', err.message); });

  return { ok: true, key, task };
}

/**
 * 启动时调用一次。
 * 1) 取 cookie（.env 的 KUGOU_COOKIE 优先，否则 state.db.prefs.kugou_cookie）
 * 2) cookie 存活 → 主动调 /login/token 续期（核心：不再等它过期才重登）
 * 3) cookie 失效/缺失 → .env 账密登录兜底
 * 4) 全失败 → 打印 QR 提示
 */
export async function ensureLogin({
  db = dbApi,
  env = process.env,
  aliveCheck = isCookieAlive,
  refresh = refreshCookie,
  passwordLogin = loginByPassword,
  qrHint = beginQrLogin,
} = {}) {
  const sources = [
    ['db', db.getPref('kugou_cookie')],
    ['env', env.KUGOU_COOKIE],
  ];

  for (const [source, cookie] of sources) {
    if (!cookie) continue;
    if (!(await aliveCheck(cookie))) {
      console.warn(`[kugou-login] ${source} 里的 cookie 已失效`);
      continue;
    }
    const fresh = await refresh(cookie);
    if (fresh) {
      db.setPref('kugou_cookie', fresh);
      console.log(`[kugou-login] OK · 续期成功（${source} → state.db）`);
      return { ok: true, source: 'refresh' };
    }
    console.log(`[kugou-login] OK · 用 ${source} 里的 cookie（本次未续期）`);
    // 把可用 cookie 落一份到 db：定时续期只认 db，且服务层读 db 优先。
    if (source !== 'db') db.setPref('kugou_cookie', cookie);
    return { ok: true, source };
  }

  if (env.KUGOU_USERNAME && env.KUGOU_PASSWORD) {
    const fresh = await passwordLogin(env.KUGOU_USERNAME, env.KUGOU_PASSWORD);
    if (fresh && await aliveCheck(fresh)) {
      db.setPref('kugou_cookie', fresh);
      console.log('[kugou-login] OK · 用用户名密码登录成功，cookie 已保存到 state.db');
      return { ok: true, source: 'fresh' };
    }
  }

  console.warn('[kugou-login] FAIL · 所有登录方式都失败');
  await qrHint();
  return { ok: false, source: null };
}

export default { ensureLogin, refreshLogin, refreshCookie, isCookieAlive, startAutoRefresh, refreshIntervalMs, beginQrLogin };
