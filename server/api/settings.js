import { KEYS, get, set, isSensitive } from '../services/settings.js';
import { invalidateCache as invalidateWeatherCache } from '../services/weather.js';
import { favoriteStore as defaultFavoriteStore } from '../services/kugou-favorite.js';

const MASK = '****已配置';

function viewKey(key) {
  const value = get(key);
  if (!value) return '';
  return isSensitive(key) ? MASK : value;
}

export function mountSettingsRoutes(app, deps = {}) {
  const onSettingsSaved = typeof deps.onSettingsSaved === 'function' ? deps.onSettingsSaved : null;
  const favoriteStore = deps.favoriteStore || defaultFavoriteStore;

  app.get('/api/settings', (req, res) => {
    const out = {};
    for (const k of KEYS) out[k] = viewKey(k);
    res.json(out);
  });

  app.put('/api/settings', async (req, res) => {
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
      if (key.startsWith('openweather_') || key === 'weather_enabled') weatherTouched = true;
    }

    if (weatherTouched) invalidateWeatherCache();
    if (applied.includes('like_target_listid') || applied.includes('like_target_name')) {
      // 红心目标歌单变了，旧的歌单缓存必须立刻作废。
      favoriteStore.invalidate?.();
    }
    if (onSettingsSaved && applied.length) {
      try {
        await onSettingsSaved(applied, body);
      } catch (err) {
        console.warn('[settings-api] onSettingsSaved warning:', err.message);
      }
    }

    res.json({ ok: true, applied });
  });
}

export default { mountSettingsRoutes };
