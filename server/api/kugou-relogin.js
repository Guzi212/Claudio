// 酷狗扫码续登录 · 由 Settings 视图触发。
//
// 流程契约：
//   POST /api/kugou/relogin/start
//     → { ok, key, qrImg(data:image/png;base64,...), qrUrl }
//
//   GET  /api/kugou/relogin/status?key=...
//     · status 0 过期 · 1 等扫码 · 2 等确认 · 4 成功
//     · 成功时后端从 KuGouMusicApi 响应里拿 token + userid，拼成
//       "token=...; userid=..." 写入 state.db.prefs.kugou_cookie
//     → { ok, status, statusText, savedCookie }
import 'dotenv/config';
import { dbApi } from '../db.js';

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
    r1 = await httpGet(`${BASE}${QR_KEY_PATH}`, { type: 'web' });
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

export async function checkRelogin(key, { httpGet = defaultGetFull, db = dbApi } = {}) {
  if (!key) throw new Error('key required');
  let raw;
  try {
    raw = await httpGet(`${BASE}${QR_CHECK_PATH}`, { key });
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
      db.setPref('kugou_cookie', `token=${token}; userid=${userid}`);
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
  const r = await axios.get(url, { params, timeout: 5_000 });
  return r.data;
}

// checkRelogin 专用：额外捕获 Set-Cookie headers，以便 token 只出现在 cookie 里时也能提取
async function defaultGetFull(url, params) {
  const { default: axios } = await import('axios');
  const r = await axios.get(url, { params, timeout: 5_000 });
  const cookies = {};
  for (const c of r.headers?.['set-cookie'] || []) {
    const [kv] = c.split(';');
    const eq = kv.indexOf('=');
    if (eq > 0) cookies[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
  }
  return { data: r.data, cookies };
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
}

export default { startRelogin, checkRelogin, mountKugouReloginRoutes };
