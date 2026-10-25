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

  it('把 KUGOU_PROXY 传给 KuGouMusicApi 的 KUGOU_API_PROXY，不设置 HTTP_PROXY', async () => {
    const { startDev } = await import('../scripts/dev.js');
    const spawnProcess = vi.fn(() => fakeChild());
    const logs = [];

    await startDev({
      env: { KUGOU_PROXY: 'http://127.0.0.1:7890' },
      projectRoot: '/Users/me/workspace/Claudio',
      platform: 'darwin',
      isApiReachable: async () => false,
      waitForApi: async () => true,
      spawnProcess,
      log: message => logs.push(message),
      error: () => {},
    });

    const kugouEnv = spawnProcess.mock.calls[0][2].env;
    const claudioEnv = spawnProcess.mock.calls[1][2].env;
    expect(kugouEnv.KUGOU_API_PROXY).toBe('http://127.0.0.1:7890');
    expect(kugouEnv.KUGOU_PROXY).toBe('http://127.0.0.1:7890');
    expect(kugouEnv.HTTP_PROXY).toBeUndefined();
    expect(kugouEnv.HTTPS_PROXY).toBeUndefined();
    expect(kugouEnv.http_proxy).toBeUndefined();
    expect(claudioEnv.KUGOU_PROXY).toBe('http://127.0.0.1:7890');
    expect(claudioEnv.KUGOU_API_PROXY).toBeUndefined();
    expect(logs.some(line => line.includes('KUGOU_API_PROXY'))).toBe(true);
  });

  it('没填 KUGOU_PROXY 时不覆盖上游自己的 KUGOU_API_PROXY', async () => {
    const { startDev } = await import('../scripts/dev.js');
    const spawnProcess = vi.fn(() => fakeChild());

    await startDev({
      env: {},
      projectRoot: '/Users/me/workspace/Claudio',
      platform: 'darwin',
      isApiReachable: async () => false,
      waitForApi: async () => true,
      spawnProcess,
      log: () => {},
      error: () => {},
    });

    expect(spawnProcess.mock.calls[0][2].env.KUGOU_API_PROXY).toBeUndefined();
  });

  it('上游已在跑时提醒 KUGOU_PROXY 没有注入进去', async () => {
    const { startDev } = await import('../scripts/dev.js');
    const logs = [];

    await startDev({
      env: { KUGOU_PROXY: 'http://127.0.0.1:7890' },
      projectRoot: '/Users/me/workspace/Claudio',
      platform: 'darwin',
      isApiReachable: async () => true,
      waitForApi: vi.fn(),
      spawnProcess: vi.fn(() => fakeChild()),
      log: message => logs.push(message),
      error: () => {},
    });

    expect(logs.some(line => line.includes('already running'))).toBe(true);
  });
});
