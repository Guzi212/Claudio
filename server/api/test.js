import { getCurrent, invalidateCache } from '../services/weather.js';
import { synthesize } from '../tts.js';

export async function testWeather({ getWeather = getCurrent, clearCache = invalidateCache } = {}) {
  clearCache();
  const data = await getWeather();
  if (!data) return { ok: false, error: '未配置 OpenWeather API Key 或请求失败' };
  return { ok: true, data };
}

export async function testTts({ tts = synthesize } = {}) {
  const result = await tts('早安，Claudio 在线。');
  if (!result) return { ok: false, error: '未配置 Fish Audio API Key 或合成失败' };
  return { ok: true, url: result.url };
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
      res.json(await testTts(deps));
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });
}
