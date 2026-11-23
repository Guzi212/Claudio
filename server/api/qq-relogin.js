// QQ 音乐可选扫码登录（不阻塞未登录使用：未登录仍可搜歌、播免费曲）。
import axios from 'axios';
import { axiosProxyOptions } from '../outbound-proxy.js';

function qqBaseUrl() {
  return String(process.env.QQ_API_BASE || '').trim().replace(/\/+$/, '');
}

export function mountQQReloginRoutes(app) {
  app.post('/api/qq/relogin/start', async (req, res) => {
    const base = qqBaseUrl();
    if (!base) {
      res.status(400).json({ ok: false, error: 'QQ_API_BASE 未配置' });
      return;
    }
    const type = String(req.query?.type || req.body?.type || 'qq').trim().toLowerCase();
    try {
      const url = `${base}/login/qr/start`;
      const r = await axios.post(url, null, {
        params: { type },
        timeout: 8_000,
        ...axiosProxyOptions(url),
      });
      res.json(r.data);
    } catch (err) {
      res.status(502).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/qq/relogin/status', async (req, res) => {
    const base = qqBaseUrl();
    if (!base) {
      res.status(400).json({ ok: false, error: 'QQ_API_BASE 未配置' });
      return;
    }
    const key = String(req.query?.key || '').trim();
    if (!key) {
      res.status(400).json({ ok: false, error: 'missing key' });
      return;
    }
    try {
      const url = `${base}/login/qr/check`;
      const r = await axios.get(url, {
        params: { key },
        timeout: 6_000,
        ...axiosProxyOptions(url),
      });
      res.json(r.data);
    } catch (err) {
      res.status(502).json({ ok: false, error: err.message });
    }
  });
}

export default { mountQQReloginRoutes };
