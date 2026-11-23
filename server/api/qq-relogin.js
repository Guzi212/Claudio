// QQ 音乐可选扫码登录（不阻塞未登录使用：未登录仍可搜歌、播免费曲）。
// 扫码成功时由 qq-music-server.py 写入 .qq-credential.json，同时在 Claudio state.db
// 记录脱敏的登录时间与 musicid，供低频续期节流与 /api/health/integrations 账龄统计复用。
import axios from 'axios';
import { dbApi } from '../db.js';
import { axiosProxyOptions } from '../outbound-proxy.js';
import {
  qqBaseUrl,
  REFRESHED_AT_PREF,
  MUSICID_PREF,
} from '../services/qq-login.js';

function wrapApiError(err, base) {
  if (err?.code === 'ECONNREFUSED') {
    return new Error(`QQ 音乐 API 服务未启动（${base} 无法连接）`);
  }
  return err;
}

async function defaultPost(url, params) {
  const r = await axios.post(url, null, {
    params,
    timeout: 8_000,
    ...axiosProxyOptions(url),
  });
  return r.data;
}

async function defaultGet(url, params) {
  const r = await axios.get(url, {
    params,
    timeout: 6_000,
    ...axiosProxyOptions(url),
  });
  return r.data;
}

export async function startQQRelogin(type = 'qq', { httpPost = defaultPost } = {}) {
  const base = qqBaseUrl();
  if (!base) throw new Error('QQ_API_BASE 未配置');
  const cleanType = String(type || 'qq').trim().toLowerCase() === 'wx' ? 'wx' : 'qq';
  try {
    return await httpPost(`${base}/login/qr/start`, { type: cleanType });
  } catch (err) {
    throw wrapApiError(err, base);
  }
}

export async function checkQQRelogin(key, { httpGet = defaultGet, db = dbApi, now = Date.now() } = {}) {
  if (!key) throw new Error('key required');
  const base = qqBaseUrl();
  if (!base) throw new Error('QQ_API_BASE 未配置');

  let data;
  try {
    data = await httpGet(`${base}/login/qr/check`, { key });
  } catch (err) {
    if (err?.response?.status === 404 && err?.response?.data) {
      return { ok: true, status: 0, statusText: '已过期', savedCookie: false, loggedIn: false };
    }
    throw wrapApiError(err, base);
  }

  if (data?.status === 4 && data?.loggedIn) {
    db.setPref(REFRESHED_AT_PREF, String(now));
    if (data.musicid) {
      db.setPref(MUSICID_PREF, String(data.musicid));
    }
    return {
      ...data,
      savedCookie: true,
    };
  }
  return {
    ...data,
    savedCookie: false,
  };
}

export function mountQQReloginRoutes(app) {
  app.post('/api/qq/relogin/start', async (req, res) => {
    if (!qqBaseUrl()) {
      res.status(400).json({ ok: false, error: 'QQ_API_BASE 未配置' });
      return;
    }
    const type = String(req.query?.type || req.body?.type || 'qq').trim().toLowerCase();
    try {
      const data = await startQQRelogin(type);
      res.json(data);
    } catch (err) {
      res.status(502).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/qq/relogin/status', async (req, res) => {
    if (!qqBaseUrl()) {
      res.status(400).json({ ok: false, error: 'QQ_API_BASE 未配置' });
      return;
    }
    const key = String(req.query?.key || '').trim();
    if (!key) {
      res.status(400).json({ ok: false, error: 'missing key' });
      return;
    }
    try {
      const data = await checkQQRelogin(key);
      res.json(data);
    } catch (err) {
      res.status(502).json({ ok: false, error: err.message });
    }
  });
}

export default { startQQRelogin, checkQQRelogin, mountQQReloginRoutes };
