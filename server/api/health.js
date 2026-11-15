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

const execAsync = promisify(exec);
const LARK_TIMEOUT_MS = 3_000;
const KUGOU_BASE = process.env.KUGOU_API_BASE || DEFAULT_KUGOU_API_BASE;

async function checkKugou() {
  const cookie = dbApi.getPref('kugou_cookie') || process.env.KUGOU_COOKIE || '';
  if (!cookie) return { ok: false, detail: 'cookie missing' };
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
      const nickname = info.nickname || '';
      const isVip = Boolean(info.vip_type || info.is_vip);
      return {
        ok: true,
        detail: nickname ? `token valid (${nickname}${isVip ? ' · VIP' : ''})` : 'token valid',
        ...(nickname ? { nickname } : {}),
        ...(isVip ? { isVip } : {}),
      };
    }
    return { ok: false, detail: `token expired (error_code=${d?.error_code ?? '?'})` };
  } catch (err) {
    if (err.code === 'ECONNREFUSED') return { ok: false, detail: 'kugou api not running' };
    const code = err.response?.data?.error_code;
    if (code === 20018) return { ok: false, detail: 'token expired · 需要重新扫码登录' };
    if (err.response?.status === 404) return { ok: false, detail: 'token expired · 需要重新扫码登录' };
    return { ok: false, detail: err.message };
  }
}

function checkSettingKey(key, okDetail = 'configured', failDetail = 'no key') {
  return getSetting(key)
    ? { ok: true, detail: okDetail }
    : { ok: false, detail: failDetail };
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
    const [lark, kugou] = await Promise.all([checkLark(), checkKugou()]);
    const djHandle = getDj();
    const djStatus = djHandle?.status?.() || null;
    res.json({
      kugou,
      weather: checkSettingKey('openweather_api_key'),
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
