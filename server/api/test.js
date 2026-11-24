import { getCurrent, invalidateCache } from '../services/weather.js';
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

  app.post('/api/test/ai', async (req, res) => {
    try {
      res.json(await testAi(deps));
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });
}
