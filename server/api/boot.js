// 已弃用：控制请用 POST /api/control，下个版本移除。
// 仅保留 external 模式下的状态返回，不再执行冷启动选歌。
export function mountBootRoute(app, deps = {}) {
  const getRuntime = typeof deps.getRuntime === 'function'
    ? deps.getRuntime
    : () => deps.runtime;

  app.post('/api/boot', async (req, res) => {
    const runtime = getRuntime();
    if (!runtime) {
      res.status(500).json({ error: 'runtime 不可用' });
      return;
    }

    const waiting = !Array.isArray(runtime.queue) || runtime.queue.length === 0;
    res.json({
      say: waiting ? '等待点歌' : (runtime.lastSay || ''),
      queue: runtime.queue || [],
      index: runtime.index || 0,
      queueOffset: runtime.queueOffset || 0,
      reason: runtime.lastReason || '',
      intent: 'boot',
      brain: 'external',
      skipped: true,
      _resolveError: false,
    });
  });
}
