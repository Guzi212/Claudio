import { getCurrent as defaultGetCurrent } from '../services/weather.js';
import { getBoolean as getBoolSetting } from '../services/settings.js';

export function mountWeatherRoute(app, deps = {}) {
  const isEnabled = deps.isEnabled || (() => getBoolSetting('weather_enabled', true));
  const getCurrent = deps.getCurrent || defaultGetCurrent;
  app.get('/api/weather', async (req, res) => {
    try {
      if (!isEnabled()) {
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
