import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { dbApi } from '../db.js';
import { get as getSetting } from '../services/settings.js';

const execAsync = promisify(exec);
const LARK_TIMEOUT_MS = 3_000;

function checkKugou() {
  const cookie = dbApi.getPref('kugou_cookie') || process.env.KUGOU_COOKIE || '';
  if (cookie) return { ok: true, detail: 'cookie alive' };
  return { ok: false, detail: 'cookie missing' };
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
    const [lark] = await Promise.all([checkLark()]);
    res.json({
      kugou: checkKugou(),
      weather: checkSettingKey('openweather_api_key'),
      tts: checkSettingKey('fish_api_key'),
      lark,
    });
  });
}

export default { mountHealthRoute };
