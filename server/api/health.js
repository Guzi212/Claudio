import axios from 'axios';
import { dbApi } from '../db.js';
import { axiosProxyOptions } from '../outbound-proxy.js';
import { get as getSetting } from '../services/settings.js';
import { DEFAULT_KUGOU_API_BASE } from '../kugou-api-base.js';
import { checkProvidersHealth } from '../services/music.js';
import { parseCookie } from '../services/kugou-cookie.js';
import { REFRESHED_AT_PREF as KUGOU_REFRESHED_AT_PREF } from '../services/kugou-login.js';

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

// 公开契约兼容桩：日历、内置 AI 与常驻 DJ 已移除，lark / calendar / ai / dj 四个键保留一个版本。
const REMOVED_INTEGRATION = Object.freeze({ ok: false, detail: 'removed' });

export function mountHealthRoute(app) {
  app.get('/api/health/integrations', async (req, res) => {
    const [kugou, providersHealth] = await Promise.all([
      checkKugou(),
      checkProvidersHealth(),
    ]);
    res.json({
      kugou,
      netease: providersHealth.netease,
      qq: providersHealth.qq,
      weather: checkWeather(),
      tts: checkSettingKey('fish_api_key'),
      ai: { ...REMOVED_INTEGRATION },
      lark: { ...REMOVED_INTEGRATION },
      calendar: { ...REMOVED_INTEGRATION },
      dj: { ...REMOVED_INTEGRATION },
    });
  });
}

export default { mountHealthRoute };
