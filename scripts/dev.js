import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { DEFAULT_KUGOU_API_BASE, localKugouApiPort } from '../server/kugou-api-base.js';

const THIS_FILE = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const DEFAULT_WAIT_MS = 20_000;
const DEFAULT_INTERVAL_MS = 500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function npmCommand(platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

function resolveQqPython(qqApiDir, platform) {
  const venvPy = platform === 'win32'
    ? path.join(qqApiDir, '.venv', 'Scripts', 'python.exe')
    : path.join(qqApiDir, '.venv', 'bin', 'python');
  if (fs.existsSync(venvPy)) return venvPy;
  return platform === 'win32' ? 'python' : 'python3';
}

export function buildDevConfig({
  env = process.env,
  projectRoot = PROJECT_ROOT,
  platform = process.platform,
} = {}) {
  const kugouApiBase = env.KUGOU_API_BASE || DEFAULT_KUGOU_API_BASE;
  const kugouApiDir = path.resolve(projectRoot, env.KUGOU_API_DIR || '../KuGouMusicApi');
  const kugouProxy = String(env.KUGOU_PROXY || '').trim();
  // 上游只读 PORT 决定监听端口。不传的话它会继承 Claudio 的 PORT（.env 里常是 8080）
  // 或落回 3000，和 KUGOU_API_BASE 对不上。
  const kugouApiPort = localKugouApiPort(kugouApiBase);

  const neteaseApiBase = String(env.NETEASE_API_BASE || '').trim();
  const neteaseApiDir = path.resolve(projectRoot, env.NETEASE_API_DIR || '../NeteaseCloudMusicApiEnhanced');
  const neteaseApiPort = neteaseApiBase ? localKugouApiPort(neteaseApiBase) : null;

  const qqApiBase = String(env.QQ_API_BASE || '').trim();
  const qqApiDir = path.resolve(projectRoot, env.QQ_API_DIR || '../QQMusicApi');
  const qqApiPort = qqApiBase ? localKugouApiPort(qqApiBase) : null;

  return {
    kugouApiBase,
    kugouApiPort,
    kugouApiDir,
    kugouProxy,
    kugou: {
      command: npmCommand(platform),
      args: ['start'],
      cwd: kugouApiDir,
      // Node >= 18.20 / 20.12 refuses to spawn .cmd/.bat without a shell on Windows (EINVAL).
      shell: platform === 'win32',
    },
    neteaseApiBase,
    neteaseApiPort,
    neteaseApiDir,
    netease: {
      command: npmCommand(platform),
      args: ['start'],
      cwd: neteaseApiDir,
      shell: platform === 'win32',
    },
    qqApiBase,
    qqApiPort,
    qqApiDir,
    qq: {
      command: resolveQqPython(qqApiDir, platform),
      args: [path.join(projectRoot, 'scripts', 'qq-music-server.py')],
      cwd: projectRoot,
      shell: false,
    },
    claudio: {
      command: process.execPath,
      args: ['--no-warnings', 'server/app.js'],
      cwd: projectRoot,
      shell: false,
    },
  };
}

export async function isHttpReachable(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 1500,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('当前 Node 版本缺少 fetch，无法探测 KuGouMusicApi 是否已启动');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetchImpl(url, { method: 'GET', signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForHttp(url, {
  timeoutMs = DEFAULT_WAIT_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  isReachable = isHttpReachable,
  sleepFn = sleep,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isReachable(url)) return true;
    await sleepFn(intervalMs);
  }
  return false;
}

function spawnChild({ command, args, cwd, shell = false, env, spawnProcess, log, label }) {
  log(`[dev] starting ${label}: ${command} ${args.join(' ')} (${cwd})`);
  // With shell: true, pass one command string (static, no user input) to avoid Node's DEP0190 warning.
  if (shell) {
    return spawnProcess([command, ...args].join(' '), [], { cwd, env, shell, stdio: 'inherit' });
  }
  return spawnProcess(command, args, {
    cwd,
    env,
    shell,
    stdio: 'inherit',
  });
}

function killChildren(children) {
  for (const child of children) {
    if (child && !child.killed) child.kill();
  }
}

export async function startDev({
  env = process.env,
  projectRoot = PROJECT_ROOT,
  platform = process.platform,
  spawnProcess = spawn,
  isApiReachable = isHttpReachable,
  waitForApi = waitForHttp,
  pathExists = fs.existsSync,
  log = console.log,
  error = console.error,
  manageSignals = false,
} = {}) {
  const config = buildDevConfig({ env, projectRoot, platform });
  const childEnv = {
    ...env,
    KUGOU_API_BASE: config.kugouApiBase,
  };
  // 上游 util/runtime.js 的 resolveProxy() 只读 KUGOU_API_PROXY，不读 HTTP(S)_PROXY。
  // 所以这里不设置 HTTP_PROXY / HTTPS_PROXY，只把 Claudio 的 KUGOU_PROXY 抄给上游。
  const kugouEnv = config.kugouProxy
    ? { ...childEnv, KUGOU_API_PROXY: config.kugouProxy }
    : { ...childEnv };
  if (config.kugouApiPort) kugouEnv.PORT = config.kugouApiPort;
  else delete kugouEnv.PORT;
  const children = [];
  let shuttingDown = false;

  const shutdown = code => {
    if (shuttingDown) return;
    shuttingDown = true;
    killChildren(children);
    if (manageSignals) process.exit(code);
  };

  const watchExit = (child, label, { optional = false } = {}) => {
    child.on?.('exit', (code, signal) => {
      if (shuttingDown) return;
      const suffix = signal ? `signal ${signal}` : `code ${code ?? 0}`;
      if (optional) {
        error(`[dev] ${label} exited (${suffix}); continuing without it`);
        return;
      }
      error(`[dev] ${label} exited (${suffix}); stopping the other process`);
      shutdown(code || 1);
    });
  };

  let kugouStarted = false;
  if (await isApiReachable(config.kugouApiBase)) {
    log(`[dev] KuGouMusicApi already reachable at ${config.kugouApiBase}`);
    if (config.kugouProxy) {
      log('[dev] KUGOU_PROXY is set, but KuGouMusicApi is already running so KUGOU_API_PROXY was not applied. Restart it from this command, or export KUGOU_API_PROXY in that process.');
    }
  } else {
    if (config.kugouProxy) {
      log('[dev] forwarding KUGOU_PROXY to KuGouMusicApi as KUGOU_API_PROXY');
    }
    const kugouChild = spawnChild({
      ...config.kugou,
      env: kugouEnv,
      spawnProcess,
      log,
      label: 'KuGouMusicApi',
    });
    children.push(kugouChild);
    watchExit(kugouChild, 'KuGouMusicApi');
    kugouStarted = true;

    const ready = await waitForApi(config.kugouApiBase, {
      timeoutMs: DEFAULT_WAIT_MS,
      intervalMs: DEFAULT_INTERVAL_MS,
      isReachable: isApiReachable,
    });
    if (!ready) {
      error(`[dev] KuGouMusicApi did not become reachable at ${config.kugouApiBase}`);
      shutdown(1);
      throw new Error(`KuGouMusicApi 启动超时：${config.kugouApiBase}`);
    }
  }

  let neteaseStarted = false;
  if (config.neteaseApiBase && config.neteaseApiPort) {
    if (await isApiReachable(config.neteaseApiBase)) {
      log(`[dev] NeteaseApi already reachable at ${config.neteaseApiBase}`);
    } else if (pathExists(config.neteaseApiDir)) {
      const neteaseEnv = {
        ...childEnv,
        PORT: config.neteaseApiPort,
        ENABLE_GENERAL_UNBLOCK: 'false',
      };
      const neteaseChild = spawnChild({
        ...config.netease,
        env: neteaseEnv,
        spawnProcess,
        log,
        label: 'NeteaseApi',
      });
      children.push(neteaseChild);
      watchExit(neteaseChild, 'NeteaseApi', { optional: true });
      neteaseStarted = true;

      const ready = await waitForApi(`${config.neteaseApiBase.replace(/\/+$/, '')}/search?keywords=test&limit=1`, {
        timeoutMs: DEFAULT_WAIT_MS,
        intervalMs: DEFAULT_INTERVAL_MS,
        isReachable: isApiReachable,
      });
      if (!ready) {
        error(`[dev] NeteaseApi did not become reachable at ${config.neteaseApiBase} (continuing)`);
      }
    } else {
      log(`[dev] NETEASE_API_BASE set, but directory missing: ${config.neteaseApiDir}`);
    }
  }

  let qqStarted = false;
  if (config.qqApiBase && config.qqApiPort) {
    if (await isApiReachable(`${config.qqApiBase.replace(/\/+$/, '')}/health`)) {
      log(`[dev] QQMusicApi wrapper already reachable at ${config.qqApiBase}`);
    } else if (pathExists(config.qqApiDir)) {
      // QQMusicApi 底层 niquests 会拾取宿主代理 env（Clash socks5）走 SOCKS，
      // 缺依赖报错、走代理还易触发腾讯风控。双保险：spawn env 里显式剥掉。
      const qqEnv = {
        ...childEnv,
        PORT: config.qqApiPort,
        QQ_API_DIR: config.qqApiDir,
        PYTHONDONTWRITEBYTECODE: '1',
      };
      for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
        delete qqEnv[k];
      }
      const qqChild = spawnChild({
        ...config.qq,
        env: qqEnv,
        spawnProcess,
        log,
        label: 'QQMusicApi',
      });
      children.push(qqChild);
      watchExit(qqChild, 'QQMusicApi', { optional: true });
      qqStarted = true;

      const ready = await waitForApi(`${config.qqApiBase.replace(/\/+$/, '')}/health`, {
        timeoutMs: DEFAULT_WAIT_MS,
        intervalMs: DEFAULT_INTERVAL_MS,
        isReachable: isApiReachable,
      });
      if (!ready) {
        error(`[dev] QQMusicApi wrapper did not become reachable at ${config.qqApiBase} (continuing)`);
      }
    } else {
      log(`[dev] QQ_API_BASE set, but directory missing: ${config.qqApiDir}`);
    }
  }

  const claudioChild = spawnChild({
    ...config.claudio,
    env: childEnv,
    spawnProcess,
    log,
    label: 'Claudio',
  });
  children.push(claudioChild);
  watchExit(claudioChild, 'Claudio');

  if (manageSignals) {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => shutdown(0));
    }
  }

  return {
    ...config,
    kugouStarted,
    neteaseStarted,
    qqStarted,
    children,
  };
}

if (path.resolve(process.argv[1] || '') === THIS_FILE) {
  loadEnv();
  startDev({ manageSignals: true }).catch(err => {
    console.error(`[dev] ${err.message}`);
    process.exit(1);
  });
}
