// 酷狗扫码续登录 · 由 Settings 视图触发。
//
// 流程契约：
//   POST /api/kugou/relogin/start
//     → { ok, key, qrImg(data:image/png;base64,...), qrUrl }
//
//   GET  /api/kugou/relogin/status?key=...
//     · status 0 过期 · 1 等扫码 · 2 等确认 · 4 成功
//     · 成功时后端把上游返回的整段登录态（token / userid / t1 / vip_*）连同
//       /register/dev 换来的 dfid 一起写入 state.db.prefs.kugou_cookie
//       —— 只存 token+userid 会让上游把每次请求当新设备，进而触发风控挤下线
//     → { ok, status, statusText, savedCookie }
import 'dotenv/config';
import { dbApi } from '../db.js';
import { mergeCookieMap, serializeCookie, pickIdentity } from '../services/kugou-cookie.js';
import { ensureDfid, COOKIE_PREF, REFRESHED_AT_PREF } from '../services/kugou-login.js';
import { axiosProxyOptions } from '../outbound-proxy.js';

const BASE = process.env.KUGOU_API_BASE || 'http://localhost:3000';
const QR_KEY_PATH    = '/login/qr/key';
const QR_CREATE_PATH = '/login/qr/create';
const QR_CHECK_PATH  = '/login/qr/check';

const STATUS_TEXT = { 0: '过期', 1: '等扫码', 2: '等确认', 4: '成功' };

function wrapApiError(err) {
  if (err.code === 'ECONNREFUSED') {
    return new Error(`酷狗 API 服务未启动（${BASE} 无法连接）`);
  }
  return err;
}

// 依赖注入版的核心逻辑，便于单测 mock fetch / dbApi 替身
export async function startRelogin({ httpGet = defaultGet } = {}) {
  let r1;
  try {
    // 不再传 type:'web'。上游 login_qr_key 里 type=web → appid=1014（Web 版），
    // 不传 → appid=1001（App 版）；而真正发 token 的 login_qr_check 和后续
    // /login/token 续期都走 App 版（appid=1005）。上游文档也提示
    // 「不同版本的 token 是不通用的」，所以统一切到 App 版这条链。
    r1 = await httpGet(`${BASE}${QR_KEY_PATH}`, {});
  } catch (err) {
    throw wrapApiError(err);
  }
  const key = r1?.data?.qrcode || r1?.qrcode || '';
  if (!key) throw new Error('QR key empty');

  const r2 = await httpGet(`${BASE}${QR_CREATE_PATH}`, { key, qrimg: true });
  const inner = r2?.data || r2 || {};
  const qrImg = inner.qrcode_img || inner.base64 || inner.qrimg || '';
  const qrUrl = inner.url || inner.qrurl || '';
  return { key, qrImg, qrUrl };
}

// 把扫码 / 探测拿到的登录态落库：整段 cookie（含 t1 / vip_*）+ dfid，
// 并记录续期时间（避免启动时立刻再来一次 /login/token）。
async function persistSession({ token, userid, extra = {}, httpGet, db }) {
  const base = serializeCookie(pickIdentity(mergeCookieMap(extra, { token, userid })));
  const { cookie: withDfid } = await ensureDfid(base, { httpGet, db });
  const finalCookie = withDfid || base;
  db.setPref(COOKIE_PREF, finalCookie);
  db.setPref(REFRESHED_AT_PREF, String(Date.now()));
  return finalCookie;
}

export async function checkRelogin(key, { httpGet = defaultGetFull, db = dbApi } = {}) {
  if (!key) throw new Error('key required');
  let raw;
  try {
    // _t 时间戳破 KuGou 端 max-age=120 缓存，确保每次拿到实时扫码状态
    raw = await httpGet(`${BASE}${QR_CHECK_PATH}`, { key, _t: Date.now() });
  } catch (err) {
    throw wrapApiError(err);
  }

  // 兼容两种格式：
  //   旧（测试 mock）: { data: { status, token, userid } }
  //   新（defaultGetFull）: { data: <http body>, cookies: { token, userid, ... } }
  const hasCookies = raw != null && typeof raw.cookies === 'object';
  const res = hasCookies ? raw.data : raw;
  const cookieMap = hasCookies ? raw.cookies : {};

  const status = res?.data?.status;
  const statusText = STATUS_TEXT[status] || `未知(${status})`;

  if (status === 4) {
    const token  = res?.data?.token  || res?.data?.userinfo?.token  || cookieMap.token;
    const userid = res?.data?.userid || res?.data?.userinfo?.userid || res?.data?.user_id || cookieMap.userid;

    if (token && userid) {
      await persistSession({ token, userid, extra: cookieMap, httpGet, db });
      return { status, statusText, savedCookie: true };
    }

    // 调试：帮助诊断 Kugou API 响应字段名变化
    console.warn('[kugou-relogin] status=4 但 token/userid 未找到'
      + ' · body.data keys:', Object.keys(res?.data || {})
      + ' · cookie keys:', Object.keys(cookieMap));
    return { status, statusText, savedCookie: false };
  }
  return { status, statusText, savedCookie: false };
}

async function defaultGet(url, params) {
  const { default: axios } = await import('axios');
  const r = await axios.get(url, { params, timeout: 5_000, ...axiosProxyOptions(url) });
  return r.data;
}

// checkRelogin 专用：额外捕获 Set-Cookie headers，以便 token 只出现在 cookie 里时也能提取
async function defaultGetFull(url, params) {
  const { default: axios } = await import('axios');
  const r = await axios.get(url, { params, timeout: 5_000, ...axiosProxyOptions(url) });
  const cookies = {};
  for (const c of r.headers?.['set-cookie'] || []) {
    const [kv] = c.split(';');
    const eq = kv.indexOf('=');
    if (eq > 0) cookies[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
  }
  return { data: r.data, cookies };
}

// 探测上游 API 的内部 session 是否已认证（扫码后上游自身 cookie jar 会更新，
// 但 /login/qr/check 状态码可能卡在 1）。不带我们存的 cookie，依赖上游自身 session。
export async function probeSession({ httpGetFull = defaultGetFull, db = dbApi } = {}) {
  const raw = await httpGetFull(`${BASE}/user/detail`, {});
  const hasCookies = raw != null && typeof raw.cookies === 'object';
  const body = hasCookies ? raw.data : raw;
  const cookieMap = hasCookies ? raw.cookies : {};

  // 上游用自身 session 返回了有效用户
  const userid = body?.userid || body?.data?.userid || body?.userinfo?.userid || cookieMap.userid;
  const token  = body?.token  || body?.data?.token  || body?.userinfo?.token  || cookieMap.token;

  if (userid && token) {
    await persistSession({ token, userid, extra: cookieMap, httpGet: httpGetFull, db });
    return { found: true, userid };
  }
  // 部分实现只在 Set-Cookie 里有 token，userid 在 body
  if (userid && cookieMap.token) {
    await persistSession({ token: cookieMap.token, userid, extra: cookieMap, httpGet: httpGetFull, db });
    return { found: true, userid };
  }
  return { found: false };
}

export function mountKugouReloginRoutes(app) {
  app.post('/api/kugou/relogin/start', async (req, res) => {
    try {
      const out = await startRelogin();
      res.json({ ok: true, ...out });
    } catch (err) {
      console.error('[kugou-relogin] start failed:', err.message);
      res.status(502).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/kugou/relogin/status', async (req, res) => {
    const key = String(req.query.key || '').trim();
    if (!key) {
      res.status(400).json({ ok: false, error: 'missing key' });
      return;
    }
    try {
      const out = await checkRelogin(key);
      res.json({ ok: true, ...out });
    } catch (err) {
      console.error('[kugou-relogin] check failed:', err.message);
      res.status(502).json({ ok: false, error: err.message });
    }
  });

  // 探测上游是否已认证，成功则保存 cookie 到 DB
  app.post('/api/kugou/relogin/probe', async (req, res) => {
    try {
      const out = await probeSession();
      res.json({ ok: true, ...out });
    } catch (err) {
      console.error('[kugou-relogin] probe failed:', err.message);
      res.status(502).json({ ok: false, error: err.message });
    }
  });
}

export default { startRelogin, checkRelogin, probeSession, mountKugouReloginRoutes };
