import { getCurrent } from '../services/weather.js';

export function mountWeatherRoute(app) {
  app.get('/api/weather', async (req, res) => {
    try {
      const data = await getCurrent();
      res.json(data ?? {});
    } catch (err) {
      console.error('[api/weather] failed:', err.message);
      res.json({});
    }
  });
}

export default { mountWeatherRoute };
