// 网易云音乐扫码登录 API · 由 Settings 视图触发。
//
// 流程契约（与酷狗 / QQ 保持统一）：
//   POST /api/netease/relogin/start
//     → { ok, key, qrImg(data:image/png;base64,...), qrUrl }
//   GET  /api/netease/relogin/status?key=...
//     → { ok, status(0|1|2|4), statusText, savedCookie, loggedIn }
import {
  neteaseBaseUrl,
  startQrLogin,
  checkQrLogin,
} from '../services/netease-login.js';

export { startQrLogin as startNeteaseRelogin, checkQrLogin as checkNeteaseRelogin };

export function mountNeteaseReloginRoutes(app) {
  app.post('/api/netease/relogin/start', async (req, res) => {
    if (!neteaseBaseUrl()) {
      res.status(400).json({ ok: false, error: 'NETEASE_API_BASE 未配置' });
      return;
    }
    try {
      const out = await startQrLogin();
      res.json({ ok: true, ...out });
    } catch (err) {
      console.error('[netease-relogin] start failed:', err.message);
      res.status(502).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/netease/relogin/status', async (req, res) => {
    if (!neteaseBaseUrl()) {
      res.status(400).json({ ok: false, error: 'NETEASE_API_BASE 未配置' });
      return;
    }
    const key = String(req.query?.key || '').trim();
    if (!key) {
      res.status(400).json({ ok: false, error: 'missing key' });
      return;
    }
    try {
      const out = await checkQrLogin(key);
      res.json({ ok: true, ...out });
    } catch (err) {
      console.error('[netease-relogin] check failed:', err.message);
      res.status(502).json({ ok: false, error: err.message });
    }
  });
}

export default {
  startNeteaseRelogin: startQrLogin,
  checkNeteaseRelogin: checkQrLogin,
  mountNeteaseReloginRoutes,
};
