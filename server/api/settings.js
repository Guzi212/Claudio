import { KEYS, get, set, isSensitive } from '../services/settings.js';
import { invalidateCache as invalidateWeatherCache } from '../services/weather.js';

const MASK = '****已配置';

function viewKey(key) {
  const value = get(key);
  if (!value) return '';
  return isSensitive(key) ? MASK : value;
}

export function mountSettingsRoutes(app) {
  app.get('/api/settings', (req, res) => {
    const out = {};
    for (const k of KEYS) out[k] = viewKey(k);
    res.json(out);
  });

  app.put('/api/settings', (req, res) => {
    const body = req.body || {};
    const applied = [];
    let weatherTouched = false;

    for (const key of KEYS) {
      if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
      const value = body[key];
      // 占位回传：前端把 GET 的 mask 原样回传 → 视作不变更
      if (isSensitive(key) && value === MASK) continue;

      set(key, value);
      applied.push(key);
      if (key.startsWith('openweather_')) weatherTouched = true;
    }

    if (weatherTouched) invalidateWeatherCache();

    res.json({ ok: true, applied });
  });
}

export default { mountSettingsRoutes };
