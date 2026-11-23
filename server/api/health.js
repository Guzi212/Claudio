import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import axios from 'axios';
import { dbApi } from '../db.js';
import { axiosProxyOptions } from '../outbound-proxy.js';
import { get as getSetting } from '../services/settings.js';
import { DEFAULT_KUGOU_API_BASE } from '../kugou-api-base.js';
import { checkProvidersHealth } from '../services/music.js';
import { parseCookie } from '../services/kugou-cookie.js';
import { REFRESHED_AT_PREF as KUGOU_REFRESHED_AT_PREF } from '../services/kugou-login.js';

const execAsync = promisify(exec);
const LARK_TIMEOUT_MS = 3_000;
const KUGOU_BASE = process.env.KUGOU_API_BASE || DEFAULT_KUGOU_API_BASE;

function credentialAgeFields(updatedAt, now = Date.now()) {
  const ts = Number(updatedAt) || 0;
  if (ts <= 0) {
    return {
      credentialUpdatedAt: null,
      credentialAgeMs: null,
      credentialAgeHours: null,
    };
  }
  const ageMs = Math.max(0, now - ts);
  return {
    credentialUpdatedAt: ts,
    credentialAgeMs: ageMs,
    credentialAgeHours: Math.round((ageMs / 3_600_000) * 10) / 10,
  };
}

async function checkKugou(now = Date.now()) {
  const cookie = dbApi.getPref('kugou_cookie') || process.env.KUGOU_COOKIE || '';
  const refreshedAt = Number(dbApi.getPref(KUGOU_REFRESHED_AT_PREF)) || 0;
  const age = credentialAgeFields(refreshedAt, now);
  if (!cookie) {
    return {
      ok: false,
      loggedIn: false,
      userid: null,
      account: null,
      ...credentialAgeFields(0, now),
      detail: 'cookie missing',
    };
  }
  const cookieUserid = parseCookie(cookie).userid || null;
  try {
    // ⚠️ 同 services/kugou.js：KuGouMusicApi 不读 Cookie 请求头，
    // 凭据必须作为 query 参数发送，否则永远被判为 token 过期。
    const detailUrl = `${KUGOU_BASE}/user/detail`;
    const res = await axios.get(detailUrl, {
      params: { cookie },
      timeout: 4_000,
      ...axiosProxyOptions(detailUrl),
    });
    const d = res.data;
    const info = d?.data || d || {};
    if (d?.status === 1 || info?.userid) {
      const userid = info.userid != null ? String(info.userid) : cookieUserid;
      const nickname = info.nickname || '';
      const isVip = Boolean(info.vip_type || info.is_vip);
      const account = nickname && userid
        ? `${nickname} (${userid})`
        : (nickname || userid || null);
      const ageSuffix = age.credentialAgeHours != null ? ` · 账龄 ${age.credentialAgeHours}h` : '';
      return {
        ok: true,
        loggedIn: true,
        userid,
        account,
        ...age,
        detail: nickname
          ? `token valid (${nickname}${isVip ? ' · VIP' : ''}${ageSuffix})`
          : `token valid${userid ? ` (${userid})` : ''}${ageSuffix}`,
        ...(nickname ? { nickname } : {}),
        ...(isVip ? { isVip } : {}),
      };
    }
    return {
      ok: false,
      loggedIn: false,
      userid: cookieUserid,
      account: cookieUserid,
      ...age,
      detail: `token expired (error_code=${d?.error_code ?? '?'})`,
    };
  } catch (err) {
    const baseFail = {
      ok: false,
      loggedIn: false,
      userid: cookieUserid,
      account: cookieUserid,
      ...age,
    };
    if (err.code === 'ECONNREFUSED') return { ...baseFail, detail: 'kugou api not running' };
    const code = err.response?.data?.error_code;
    if (code === 20018) return { ...baseFail, detail: 'token expired · 需要重新扫码登录' };
    if (err.response?.status === 404) return { ...baseFail, detail: 'token expired · 需要重新扫码登录' };
    return { ...baseFail, detail: err.message };
  }
}

function checkSettingKey(key, okDetail = 'configured', failDetail = 'no key') {
  return getSetting(key)
    ? { ok: true, detail: okDetail }
    : { ok: false, detail: failDetail };
}

function checkWeather() {
  const enabled = String(getSetting('weather_enabled') || 'true').trim().toLowerCase();
  if (enabled === '0' || enabled === 'false' || enabled === 'off' || enabled === 'no') {
    return { ok: false, detail: 'disabled' };
  }
  return getSetting('openweather_api_key')
    ? { ok: true, detail: 'OpenWeather + Open-Meteo' }
    : { ok: true, detail: 'Open-Meteo (keyless)' };
}

function hasClaudeCliOnPath(env = process.env) {
  if (env.CLAUDE_BIN) {
    try { return fs.existsSync(env.CLAUDE_BIN); } catch { return false; }
  }
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const candidates = process.platform === 'win32'
    ? ['claude.cmd', 'claude.exe', 'claude']
    : ['claude'];
  for (const dir of dirs) {
    for (const name of candidates) {
      try {
        if (fs.existsSync(path.join(dir, name))) return true;
      } catch { /* ignore */ }
    }
  }
  return false;
}

function checkAi() {
  if (getSetting('deepseek_api_key')) {
    return { ok: true, detail: 'DeepSeek key configured' };
  }
  if (hasClaudeCliOnPath()) {
    return { ok: true, detail: 'claude CLI available' };
  }
  return { ok: false, detail: 'no API key or claude CLI' };
}

async function checkLark() {
  try {
    await execAsync('lark-cli --version', { timeout: LARK_TIMEOUT_MS });
    return { ok: true, detail: 'lark-cli ok' };
  } catch (err) {
    const msg = String(err?.message || '');
    if (err?.code === 'ENOENT' || /not (recognized|found)/i.test(msg)) {
      return { ok: false, detail: 'not installed' };
    }
    return { ok: false, detail: 'not logged in' };
  }
}

function checkCalendar(lark) {
  const provider = String(getSetting('calendar_provider') || 'none').trim().toLowerCase();
  if (provider === 'lark') {
    return { ok: lark.ok, provider: 'lark', detail: lark.detail };
  }
  if (provider === 'google') {
    const credsPath = process.env.GOOGLE_OAUTH_CREDENTIALS
      || path.join(os.homedir(), '.config/google-calendar-mcp/gcp-oauth.keys.json');
    const tokensPath = path.join(path.dirname(credsPath), 'tokens.json');
    const ready = fs.existsSync(credsPath) && fs.existsSync(tokensPath);
    return { ok: ready, provider: 'google', detail: ready ? 'oauth ready' : 'oauth credentials missing' };
  }
  return { ok: false, provider: 'none', detail: 'disabled' };
}

export function mountHealthRoute(app, deps = {}) {
  const getDj = typeof deps.getDj === 'function' ? deps.getDj : () => null;

  app.get('/api/health/integrations', async (req, res) => {
    const [lark, kugou, providersHealth] = await Promise.all([
      checkLark(),
      checkKugou(),
      checkProvidersHealth(),
    ]);
    const djHandle = getDj();
    const djStatus = djHandle?.status?.() || null;
    res.json({
      kugou,
      netease: providersHealth.netease,
      qq: providersHealth.qq,
      weather: checkWeather(),
      tts: checkSettingKey('fish_api_key'),
      ai: checkAi(),
      lark,
      calendar: checkCalendar(lark),
      dj: djStatus?.enabled
        ? { ok: true, detail: `running (${djStatus.config?.batchSize || 5} tracks/refill)` }
        : { ok: false, detail: 'standby' },
    });
  });
}

export default { mountHealthRoute };
