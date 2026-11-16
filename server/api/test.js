import { getCurrent, invalidateCache } from '../services/weather.js';
import { getTodayEvents as defaultGoogleEvents, _resetCache as resetGoogleCache } from '../services/google-calendar.js';
import { getTodayEvents as defaultLarkEvents, _resetCache as resetLarkCache } from '../services/lark-calendar.js';
import { get as getSetting } from '../services/settings.js';
import { complete as defaultComplete } from '../claude.js';
import { synthesize } from '../tts.js';

export async function testWeather({ getWeather = getCurrent, clearCache = invalidateCache } = {}) {
  clearCache();
  const data = await getWeather();
  if (!data) return { ok: false, error: '天气服务请求失败（请检查网络、城市名或 API Key）' };
  return { ok: true, data };
}

export async function testTts({ tts = synthesize, voiceId } = {}) {
  const opts = voiceId != null ? { voiceId } : {};
  const result = await tts('早安，Claudio 在线。', opts);
  if (!result) return { ok: false, error: '未配置 Fish Audio API Key 或合成失败' };
  return { ok: true, url: result.url };
}

export async function testCalendar({
  provider = String(getSetting('calendar_provider') || 'none').trim().toLowerCase(),
  getGoogleEvents = defaultGoogleEvents,
  getLarkEvents = defaultLarkEvents,
} = {}) {
  if (provider === 'none' || !provider) {
    return { ok: false, provider: 'none', error: '日程注入已关闭（none）' };
  }
  if (provider === 'google') {
    resetGoogleCache();
    const events = await getGoogleEvents();
    if (!events) return { ok: false, provider: 'google', error: 'Google Calendar 未完成 OAuth 授权或读取失败' };
    return { ok: true, provider: 'google', count: events.length };
  }
  if (provider === 'lark') {
    resetLarkCache();
    const events = await getLarkEvents();
    if (!events) return { ok: false, provider: 'lark', error: '飞书日历 lark-cli 未安装或未登录' };
    return { ok: true, provider: 'lark', count: events.length };
  }
  return { ok: false, provider, error: `未知日历来源：${provider}` };
}

export async function testAi({ complete = defaultComplete } = {}) {
  const reply = await complete('你是连接测试助手。只回复 OK。', 'ping', { timeoutMs: 25_000 });
  if (!String(reply || '').trim()) return { ok: false, error: 'AI 返回空响应' };
  return { ok: true, reply: String(reply).trim().slice(0, 80) };
}

export function mountTestRoutes(app, deps = {}) {
  app.post('/api/test/weather', async (req, res) => {
    try {
      res.json(await testWeather(deps));
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  app.post('/api/test/tts', async (req, res) => {
    try {
      const { voice_id } = req.body || {};
      const opts = { ...deps, ...(voice_id != null ? { voiceId: voice_id } : {}) };
      res.json(await testTts(opts));
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  app.post('/api/test/calendar', async (req, res) => {
    try {
      const provider = req.body?.provider;
      res.json(await testCalendar({ ...deps, ...(provider ? { provider } : {}) }));
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  app.post('/api/test/ai', async (req, res) => {
    try {
      res.json(await testAi(deps));
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });
}
