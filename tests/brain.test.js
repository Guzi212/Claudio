import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { brainMode, startBrainServices } from '../server/brain.js';

describe('CLAUDIO_BRAIN', () => {
  it('缺省和空值都是 external', () => {
    expect(brainMode({})).toBe('external');
    expect(brainMode({ CLAUDIO_BRAIN: '' })).toBe('external');
    expect(brainMode({ CLAUDIO_BRAIN: '  ' })).toBe('external');
    expect(brainMode({ CLAUDIO_BRAIN: 'external' })).toBe('external');
    expect(brainMode({ CLAUDIO_BRAIN: 'nope' })).toBe('external');
  });

  it('只有 internal 才打开旧的选歌', () => {
    expect(brainMode({ CLAUDIO_BRAIN: 'internal' })).toBe('internal');
    expect(brainMode({ CLAUDIO_BRAIN: ' Internal ' })).toBe('internal');
  });

  it('external 不启动 scheduler', () => {
    const startScheduler = vi.fn(() => ({ stop: vi.fn() }));
    const handle = startBrainServices({
      brain: 'external',
      startScheduler,
      schedulerOptions: { runtime: {}, broadcast() {} },
    });
    expect(startScheduler).not.toHaveBeenCalled();
    expect(handle.started).toBe(false);
    expect(() => handle.stop()).not.toThrow();
  });

  it('internal 才把 scheduler 挂上', () => {
    const stop = vi.fn();
    const startScheduler = vi.fn(() => ({ stop }));
    const options = { runtime: { queue: [] }, broadcast() {} };
    const handle = startBrainServices({
      brain: 'internal',
      startScheduler,
      schedulerOptions: options,
    });
    expect(startScheduler).toHaveBeenCalledWith(options);
    handle.stop();
    expect(stop).toHaveBeenCalled();
  });

  it('app 启动走 startBrainServices，而不是无条件 startScheduler', () => {
    const source = fs.readFileSync(new URL('../server/app.js', import.meta.url), 'utf8');
    expect(source).toContain('startBrainServices');
    expect(source).toContain('brainMode');
    expect(source).not.toMatch(/const scheduler = startScheduler\(/);
  });
});
