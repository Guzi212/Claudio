// QQ 音乐低频凭证续期与启动登录态自检（实际 Credential 与设备指纹由 scripts/qq-music-server.py 持久化）。
//
// 防风控策略：
// - 默认每 24h（QQ_REFRESH_INTERVAL_HOURS 可调）最多调一次 /login/refresh；
// - 未到间隔、未登录、或凭证无 refresh_key/refresh_token 时完全不触发腾讯侧 LoginServer 请求；
// - 日志与接口全程只记录 musicid 与时间戳，严禁输出 musickey / refresh_key 明文。
import axios from 'axios';
import 'dotenv/config';
import { dbApi } from '../db.js';
import { axiosProxyOptions } from '../outbound-proxy.js';

export const REFRESHED_AT_PREF = 'qq_token_refreshed_at';
export const MUSICID_PREF = 'qq_musicid';

export function qqBaseUrl() {
  return String(process.env.QQ_API_BASE || '').trim().replace(/\/+$/, '');
}

export function refreshIntervalMs() {
  const h = Number(process.env.QQ_REFRESH_INTERVAL_HOURS);
  const hours = Number.isFinite(h) && h > 0 ? h : 24;
  return hours * 60 * 60 * 1000;
}

function tickMs() {
  const interval = refreshIntervalMs();
  return Math.max(5 * 60 * 1000, Math.min(interval / 4, 6 * 60 * 60 * 1000));
}

async function defaultGet(url, params = {}) {
  const r = await axios.get(url, { params, timeout: 6_000, ...axiosProxyOptions(url) });
  return r.data;
}

async function defaultPost(url, params = {}) {
  const r = await axios.post(url, null, { params, timeout: 8_000, ...axiosProxyOptions(url) });
  return r.data;
}

export function needsRenew({ db = dbApi, now = Date.now(), intervalMs = refreshIntervalMs() } = {}) {
  const last = Number(db.getPref(REFRESHED_AT_PREF)) || 0;
  if (!last) return true;
  return now - last >= intervalMs;
}

export async function fetchQQLoginStatus({ httpGet = defaultGet } = {}) {
  const base = qqBaseUrl();
  if (!base) return { ok: false, loggedIn: false, reason: 'QQ_API_BASE 未配置' };
  try {
    const data = await httpGet(`${base}/login/status`);
    return data && typeof data === 'object' ? data : { ok: false, loggedIn: false };
  } catch (err) {
    return { ok: false, loggedIn: false, reason: err.message };
  }
}

export async function renewToken({
  httpPost = defaultPost,
  db = dbApi,
  now = Date.now(),
} = {}) {
  const base = qqBaseUrl();
  if (!base) return { ok: false, reason: 'QQ_API_BASE 未配置' };

  let data;
  try {
    data = await httpPost(`${base}/login/refresh`);
  } catch (err) {
    const status = err?.response?.status;
    if (status === 404) {
      return { ok: false, reason: 'qq wrapper 尚未支持 /login/refresh（重启 wrapper 后生效）' };
    }
    return { ok: false, reason: err.message };
  }

  if (!data?.ok) {
    return { ok: false, reason: data?.reason || data?.error || 'refresh failed' };
  }

  db.setPref(REFRESHED_AT_PREF, String(now));
  if (data.musicid) {
    db.setPref(MUSICID_PREF, String(data.musicid));
  }
  return {
    ok: true,
    musicid: Number(data.musicid || 0),
    expiresAt: data.expiresAt ?? null,
    keyExpiresIn: data.keyExpiresIn ?? null,
  };
}

/**
 * 启动时检查 QQ wrapper 当前登录态；若已登录且支持刷新、且凭证年龄超过续期间隔或已过期，则低频刷新一次。
 */
export async function ensureLogin({
  db = dbApi,
  httpGet = defaultGet,
  httpPost = defaultPost,
  now = Date.now(),
} = {}) {
  if (!qqBaseUrl()) {
    return { ok: false, source: null, skipped: true };
  }

  const status = await fetchQQLoginStatus({ httpGet });
  if (!status.ok || !status.loggedIn) {
    return { ok: false, source: 'unauthenticated' };
  }

  if (status.musicid) {
    db.setPref(MUSICID_PREF, String(status.musicid));
  }

  // 若 wrapper 回报了准确的凭证创建时间，同步进 state.db 作为节流基准，防止刚扫码就重启触发刷新
  if (Number(status.credentialCreatedAt) > 0 && !db.getPref(REFRESHED_AT_PREF)) {
    db.setPref(REFRESHED_AT_PREF, String(status.credentialCreatedAt));
  }

  if (status.canRefresh === false) {
    console.log(`[qq-login] OK · 已登录 (musicid=${status.musicid || '?'}) · 无 refresh_key，跳过自动续期`);
    return { ok: true, source: 'static' };
  }

  const shouldRefresh = Boolean(status.expired) || needsRenew({ db, now });
  if (!shouldRefresh) {
    console.log(`[qq-login] OK · 已登录 (musicid=${status.musicid || '?'})`);
    return { ok: true, source: 'file' };
  }

  const renewed = await renewToken({ httpPost, db, now });
  if (renewed.ok) {
    const hours = Math.round(refreshIntervalMs() / 3_600_000);
    console.log(`[qq-login] OK · 凭证已低频续期 (musicid=${renewed.musicid || status.musicid || '?'}, 约每 ${hours}h 一次)`);
    return { ok: true, source: 'renewed' };
  }

  console.warn('[qq-login] 续期未成功（继续使用当前凭证）：', renewed.reason);
  return { ok: true, source: 'file' };
}

export async function runRefreshTick({
  db = dbApi,
  httpGet = defaultGet,
  httpPost = defaultPost,
  log = console.log,
  now = Date.now(),
} = {}) {
  if (!qqBaseUrl()) return { ok: false, reason: 'QQ_API_BASE 未配置' };
  if (!needsRenew({ db, now })) return { ok: false, reason: '未到续期时间' };

  const status = await fetchQQLoginStatus({ httpGet });
  if (!status.ok || !status.loggedIn) {
    return { ok: false, reason: '未登录' };
  }
  if (status.canRefresh === false) {
    return { ok: false, reason: '凭证不含 refresh_key，不可刷新' };
  }
  if (!status.expired && Number.isFinite(status.credentialAgeMs) && status.credentialAgeMs < refreshIntervalMs()) {
    db.setPref(REFRESHED_AT_PREF, String(Math.max(1, now - Number(status.credentialAgeMs))));
    return { ok: false, reason: '未到续期时间' };
  }

  const r = await renewToken({ httpPost, db, now });
  if (r.ok) {
    log(`[qq-login] 巡检：凭证已续期 (musicid=${r.musicid || status.musicid || '?'})`);
  } else {
    log('[qq-login] 巡检：续期未成功 ·', r.reason);
  }
  return r;
}

let refreshTimer = null;

export function startAutoRefresh(opts = {}) {
  stopAutoRefresh();
  if (!qqBaseUrl()) return null;
  refreshTimer = setInterval(() => {
    runRefreshTick(opts).catch(err => {
      console.warn('[qq-login] 巡检异常：', err.message);
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
  REFRESHED_AT_PREF,
  MUSICID_PREF,
  qqBaseUrl,
  refreshIntervalMs,
  needsRenew,
  fetchQQLoginStatus,
  renewToken,
  ensureLogin,
  runRefreshTick,
  startAutoRefresh,
  stopAutoRefresh,
};
