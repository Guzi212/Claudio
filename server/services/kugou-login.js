import axios from 'axios';
import 'dotenv/config';
import { dbApi } from '../db.js';

const BASE = process.env.KUGOU_API_BASE || 'http://localhost:3000';

// KuGouMusicApi 社区版的登录接口路径。不同 fork 名字略有差异。
const LOGIN_PATH = '/login/cellphone';     // GET ?mobile=xxx&password=xxx
const STATUS_PATH = '/user/detail';        // GET （带 cookie 才能拿到）
const QR_KEY_PATH = '/login/qr/key';
const QR_CREATE_PATH = '/login/qr/create';

async function isCookieAlive(cookie) {
  if (!cookie) return false;
  try {
    const res = await axios.get(`${BASE}${STATUS_PATH}`, {
      headers: { Cookie: cookie },
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

async function printQrHint() {
  try {
    const r1 = await axios.get(`${BASE}${QR_KEY_PATH}`, { timeout: 5_000 });
    const key = r1.data?.data?.qrcode || r1.data?.qrcode || '';
    if (!key) {
      console.warn('[kugou-login] QR key 获取失败，请手动到 KuGouMusicApi 文档查 QR 流程');
      return;
    }
    const r2 = await axios.get(`${BASE}${QR_CREATE_PATH}`, { params: { key, qrimg: true }, timeout: 5_000 });
    const qrurl = r2.data?.data?.qrurl || r2.data?.qrurl || '';
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
 * 1) 优先用 .env 的 KUGOU_COOKIE（用户手动贴的）
 * 2) 否则用 state.db.prefs.kugou_cookie（之前自动登录留下的）
 * 3) 仍失效就用 .env 的用户名密码尝试 login
 * 4) 全失败 → 打印 QR 提示
 */
export async function ensureLogin() {
  const envCookie = process.env.KUGOU_COOKIE;
  if (envCookie) {
    if (await isCookieAlive(envCookie)) {
      console.log('[kugou-login] OK · 用 .env 里的 KUGOU_COOKIE');
      return { ok: true, source: 'env' };
    }
    console.warn('[kugou-login] .env 里的 KUGOU_COOKIE 已失效');
  }

  const savedCookie = dbApi.getPref('kugou_cookie');
  if (savedCookie && await isCookieAlive(savedCookie)) {
    console.log('[kugou-login] OK · 用 state.db 里上次保存的 cookie');
    return { ok: true, source: 'db' };
  }

  const username = process.env.KUGOU_USERNAME;
  const password = process.env.KUGOU_PASSWORD;
  if (username && password) {
    const fresh = await loginByPassword(username, password);
    if (fresh && await isCookieAlive(fresh)) {
      dbApi.setPref('kugou_cookie', fresh);
      console.log('[kugou-login] OK · 用用户名密码登录成功，cookie 已保存到 state.db');
      return { ok: true, source: 'fresh' };
    }
  }

  console.warn('[kugou-login] FAIL · 所有登录方式都失败');
  await printQrHint();
  return { ok: false, source: null };
}

export default { ensureLogin };
