import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import axios from 'axios';
import { dbApi } from '../db.js';
import { get as getSetting } from '../services/settings.js';

const execAsync = promisify(exec);
const LARK_TIMEOUT_MS = 3_000;
const KUGOU_BASE = process.env.KUGOU_API_BASE || 'http://localhost:3000';

async function checkKugou() {
  const cookie = dbApi.getPref('kugou_cookie') || process.env.KUGOU_COOKIE || '';
  if (!cookie) return { ok: false, detail: 'cookie missing' };
  try {
    const res = await axios.get(`${KUGOU_BASE}/user/detail`, {
      headers: { Cookie: cookie },
      timeout: 4_000,
    });
    const d = res.data;
    if (d?.status === 1 || d?.userid || d?.data?.userid) {
      return { ok: true, detail: 'token valid' };
    }
    return { ok: false, detail: `token expired (error_code=${d?.error_code ?? '?'})` };
  } catch (err) {
    if (err.code === 'ECONNREFUSED') return { ok: false, detail: 'kugou api not running' };
    const code = err.response?.data?.error_code;
    if (code === 20018) return { ok: false, detail: 'token expired · 需要重新扫码登录' };
    return { ok: false, detail: err.message };
  }
}

function checkSettingKey(key, okDetail = 'configured', failDetail = 'no key') {
  return getSetting(key)
    ? { ok: true, detail: okDetail }
    : { ok: false, detail: failDetail };
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

export function mountHealthRoute(app) {
  app.get('/api/health/integrations', async (req, res) => {
    const [lark, kugou] = await Promise.all([checkLark(), checkKugou()]);
    res.json({
      kugou,
      weather: checkSettingKey('openweather_api_key'),
      tts: checkSettingKey('fish_api_key'),
      ai: checkSettingKey('deepseek_api_key', 'key configured', 'no API key'),
      lark,
    });
  });
}

export default { mountHealthRoute };
