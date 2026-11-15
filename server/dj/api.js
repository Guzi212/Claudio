// 常驻主持人的控制口：看状态、手动补一批、手动重学品味。
// 挂载点在 app.js 的 authMiddleware 之后，鉴权和其它 /api 一致。

export function mountDjRoutes(app, deps = {}) {
  const getDj = typeof deps.getDj === 'function' ? deps.getDj : () => deps.dj;

  app.get('/api/dj/status', (req, res) => {
    const dj = getDj();
    if (!dj) {
      res.json({ ok: true, enabled: false });
      return;
    }
    try {
      res.json({ ok: true, enabled: true, ...dj.status() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/dj/refill', async (req, res) => {
    const dj = getDj();
    if (!dj) {
      res.status(409).json({ ok: false, error: '常驻主持人未启用（CLAUDIO_DJ=1 才开）' });
      return;
    }
    try {
      const result = await dj.refill({ trigger: 'manual' });
      res.status(200).json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/dj/learn', async (req, res) => {
    const dj = getDj();
    if (!dj) {
      res.status(409).json({ ok: false, error: '常驻主持人未启用（CLAUDIO_DJ=1 才开）' });
      return;
    }
    try {
      const result = await dj.learnTaste({ force: true });
      res.status(200).json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}

export default { mountDjRoutes };
