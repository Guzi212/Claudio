// 酷狗扫码续登录 · 由 Settings 视图触发。
//
// 流程契约：
//   POST /api/kugou/relogin/start
//     → { ok, key, qrImg(data:image/png;base64,...), qrUrl }
//
//   GET  /api/kugou/relogin/status?key=...
//     · status 0 过期 · 1 等扫码 · 2 等确认 · 4 成功
//     · 成功时后端从 KuGouMusicApi 响应里拿 token + userid，连同全部
//       Set-Cookie（dfid / t1 / 设备 cookie）一起写入 state.db.prefs.kugou_cookie，
//       供 /login/token 续期使用
//     → { ok, status, statusText, savedCookie }
import 'dotenv/config';
import { dbApi } from '../db.js';
import { buildCookieString, parseSetCookie } from '../services/kugou-cookie.js';

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
export async function startRelogin({ httpGet = defaultGet, now = () => Date.now() } = {}) {
  let r1;
  try {
    // 必须带 timestamp：KuGouMusicApi 有 2 分钟全局响应缓存（key 含 query），
    // 否则 2 分钟内重复「重扫码」会拿到同一个旧 key。见其 docs: 「调用务必带上时间戳，防止缓存」。
    r1 = await httpGet(`${BASE}${QR_KEY_PATH}`, { type: 'web', timestamp: now() });
  } catch (err) {
    throw wrapApiError(err);
  }
  const key = r1?.data?.qrcode || r1?.qrcode || '';
  if (!key) throw new Error('QR key empty');

  const r2 = await httpGet(`${BASE}${QR_CREATE_PATH}`, { key, qrimg: true, timestamp: now() });
  const inner = r2?.data || r2 || {};
  const qrImg = inner.qrcode_img || inner.base64 || inner.qrimg || '';
  const qrUrl = inner.url || inner.qrurl || '';
  return { key, qrImg, qrUrl };
}

export async function checkRelogin(key, { httpGet = defaultGetFull, db = dbApi, now = () => Date.now() } = {}) {
  if (!key) throw new Error('key required');
  let raw;
  try {
    // 关键：带 timestamp 穿透上游 2 分钟缓存。否则第一次 status=1 会被缓存，
    // 前端轮询永远只拿到「等扫码」，扫码后也看不到成功。
    raw = await httpGet(`${BASE}${QR_CHECK_PATH}`, { key, timestamp: now() });
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
    const body = res?.data || {};
    const token  = body.token  || body.userinfo?.token  || cookieMap.token;
    const userid = body.userid || body.userinfo?.userid || body.user_id || cookieMap.userid;

    if (token && userid) {
      // 完整落库：body 里的 token/userid/t1/vip_token + 响应中全部 Set-Cookie。
      // 字段越全，后续 /login/token 续期越稳（dfid/t1 是刷新加密参数的输入）。
      const fromBody = {};
      if (body.t1) fromBody.t1 = body.t1;
      if (body.vip_token) fromBody.vip_token = body.vip_token;
      if (body.vip_type) fromBody.vip_type = body.vip_type;
      if (body.dfid) fromBody.dfid = body.dfid;
      const cookie = buildCookieString({ ...cookieMap, ...fromBody, token, userid });
      db.setPref('kugou_cookie', cookie);
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

function defaultSleep(ms) {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    // 不因等待扫码而拖住进程退出
    if (t && typeof t.unref === 'function') t.unref();
  });
}

/**
 * 轮询扫码状态直到出结果。供终端启动流程后台调用（不阻塞 server.listen）。
 * 返回最终 checkRelogin 结果；超时返回 { status: -1 }。
 * 依赖注入（check / sleep / now）便于单测用假时钟，不真等待。
 */
export async function pollRelogin(key, {
  db = dbApi,
  intervalMs = 3_000,
  timeoutMs = 5 * 60 * 1000,
  check = checkRelogin,
  sleep = defaultSleep,
  now = () => Date.now(),
  onStatus = () => {},
} = {}) {
  const deadline = now() + timeoutMs;
  let last;
  while (now() < deadline) {
    const out = await check(key, { db });
    if (out.status !== last) {
      onStatus(out);
      last = out.status;
    }
    // 4 授权成功 · 0 二维码过期，都是终态
    if (out.status === 4 || out.status === 0) return out;
    await sleep(intervalMs);
  }
  const timeoutOut = { status: -1, statusText: '超时', savedCookie: false };
  onStatus(timeoutOut);
  return timeoutOut;
}

async function defaultGet(url, params) {
  const { default: axios } = await import('axios');
  const r = await axios.get(url, { params, timeout: 5_000 });
  return r.data;
}

// checkRelogin 专用：额外捕获 Set-Cookie headers，以便 token 只出现在 cookie 里时也能提取
async function defaultGetFull(url, params) {
  const { default: axios } = await import('axios');
  const r = await axios.get(url, { params, timeout: 5_000 });
  return { data: r.data, cookies: parseSetCookie(r.headers?.['set-cookie']) };
}

export function mountKugouReloginRoutes(app) {
  app.post('/api/kugou/relogin/start', async (req, res) => {
    try {
      const out = await startRelogin();
      res.json({ ok: true, ...out });
    } catch (err) {
      console.error('[kugou-relogin] start failed:', err.message);
      res.status(502).json({ ok: false, error: '扫码登录服务异常，请稍后重试' });
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
      res.status(502).json({ ok: false, error: '查询登录状态失败，请稍后重试' });
    }
  });
}

export default { startRelogin, checkRelogin, pollRelogin, mountKugouReloginRoutes };
