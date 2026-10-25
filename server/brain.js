// 谁来选歌。默认 external：Claudio 只做播放器，不调用 Claude。
// internal 才恢复开机电台、聊天选歌和定时推歌。

export function brainMode(env = process.env) {
  const raw = String(env?.CLAUDIO_BRAIN ?? '').trim().toLowerCase();
  return raw === 'internal' ? 'internal' : 'external';
}

export function startBrainServices({ brain, startScheduler, schedulerOptions } = {}) {
  if (brain !== 'internal') {
    return { started: false, stop() {} };
  }
  if (typeof startScheduler !== 'function') {
    throw new Error('internal 模式需要 startScheduler');
  }
  const handle = startScheduler(schedulerOptions);
  return {
    started: true,
    stop() {
      if (handle && typeof handle.stop === 'function') handle.stop();
    },
  };
}
