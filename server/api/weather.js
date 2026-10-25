import { getCurrent as defaultGetCurrent } from '../services/weather.js';
import { brainMode } from '../brain.js';

export function mountWeatherRoute(app, deps = {}) {
  const currentBrain = deps.brain || brainMode;
  const getCurrent = deps.getCurrent || defaultGetCurrent;
  app.get('/api/weather', async (req, res) => {
    try {
      // external 是默认播放器。页面不再显示天气，这里直接空对象，避免无效 key 每 5 分钟打出 401。
      // internal 的选歌提示仍在 buildSystemPrompt 里自己取天气，不走这条路由。
      if (currentBrain() !== 'internal') {
        res.json({});
        return;
      }
      const data = await getCurrent();
      res.json(data ?? {});
    } catch (err) {
      console.error('[api/weather] failed:', err.message);
      res.json({});
    }
  });
}

export default { mountWeatherRoute };
