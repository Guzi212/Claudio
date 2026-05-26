import { EventEmitter } from 'node:events';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

function fakeChild() {
  const child = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

describe('scripts/dev', () => {
  it('默认从 Claudio 同级的 KuGouMusicApi 目录启动上游', async () => {
    const { buildDevConfig } = await import('../scripts/dev.js');
    const projectRoot = '/Users/me/workspace/Claudio';

    const config = buildDevConfig({ env: {}, projectRoot, platform: 'darwin' });

    expect(config.kugouApiBase).toBe('http://localhost:3000');
    expect(config.kugouApiDir).toBe(path.resolve('/Users/me/workspace/KuGouMusicApi'));
    expect(config.kugou.command).toBe('npm');
    expect(config.kugou.args).toEqual(['start']);
    expect(config.claudio.command).toBe(process.execPath);
    expect(config.claudio.args).toEqual(['--no-warnings', 'server/app.js']);
  });

  it('KUGOU_API_DIR 可覆盖默认上游目录', async () => {
    const { buildDevConfig } = await import('../scripts/dev.js');
    const projectRoot = '/Users/me/workspace/Claudio';

    const config = buildDevConfig({
      env: { KUGOU_API_DIR: '/opt/kugou-api', KUGOU_API_BASE: 'http://127.0.0.1:3300' },
      projectRoot,
      platform: 'darwin',
    });

    expect(config.kugouApiDir).toBe('/opt/kugou-api');
    expect(config.kugouApiBase).toBe('http://127.0.0.1:3300');
  });

  it('上游未运行时先启动 KuGouMusicApi，ready 后再启动 Claudio', async () => {
    const { startDev } = await import('../scripts/dev.js');
    const calls = [];
    const children = [fakeChild(), fakeChild()];
    const spawnProcess = vi.fn((command, args, opts) => {
      calls.push({ command, args, cwd: opts.cwd });
      return children[calls.length - 1];
    });
    const waitForApi = vi.fn(async () => true);

    const result = await startDev({
      env: {},
      projectRoot: '/Users/me/workspace/Claudio',
      platform: 'darwin',
      isApiReachable: async () => false,
      waitForApi,
      spawnProcess,
      log: () => {},
      error: () => {},
    });

    expect(calls.map(call => call.cwd)).toEqual([
      path.resolve('/Users/me/workspace/KuGouMusicApi'),
      '/Users/me/workspace/Claudio',
    ]);
    expect(waitForApi).toHaveBeenCalledWith('http://localhost:3000', expect.any(Object));
    expect(result.kugouStarted).toBe(true);
  });

  it('上游已运行时不重复启动 KuGouMusicApi，只启动 Claudio', async () => {
    const { startDev } = await import('../scripts/dev.js');
    const spawnProcess = vi.fn(() => fakeChild());

    const result = await startDev({
      env: {},
      projectRoot: '/Users/me/workspace/Claudio',
      platform: 'darwin',
      isApiReachable: async () => true,
      waitForApi: vi.fn(),
      spawnProcess,
      log: () => {},
      error: () => {},
    });

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(spawnProcess.mock.calls[0][2].cwd).toBe('/Users/me/workspace/Claudio');
    expect(result.kugouStarted).toBe(false);
  });
});
