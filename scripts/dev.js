import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const DEFAULT_KUGOU_API_BASE = 'http://localhost:3000';
const DEFAULT_WAIT_MS = 20_000;
const DEFAULT_INTERVAL_MS = 500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function npmCommand(platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function buildDevConfig({
  env = process.env,
  projectRoot = PROJECT_ROOT,
  platform = process.platform,
} = {}) {
  const kugouApiBase = env.KUGOU_API_BASE || DEFAULT_KUGOU_API_BASE;
  const kugouApiDir = path.resolve(projectRoot, env.KUGOU_API_DIR || '../KuGouMusicApi');

  return {
    kugouApiBase,
    kugouApiDir,
    kugou: {
      command: npmCommand(platform),
      args: ['start'],
      cwd: kugouApiDir,
    },
    claudio: {
      command: process.execPath,
      args: ['--no-warnings', 'server/app.js'],
      cwd: projectRoot,
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

function spawnChild({ command, args, cwd, env, spawnProcess, log, label }) {
  log(`[dev] starting ${label}: ${command} ${args.join(' ')} (${cwd})`);
  return spawnProcess(command, args, {
    cwd,
    env,
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
  log = console.log,
  error = console.error,
  manageSignals = false,
} = {}) {
  const config = buildDevConfig({ env, projectRoot, platform });
  const childEnv = {
    ...env,
    KUGOU_API_BASE: config.kugouApiBase,
  };
  const children = [];
  let shuttingDown = false;

  const shutdown = code => {
    if (shuttingDown) return;
    shuttingDown = true;
    killChildren(children);
    if (manageSignals) process.exit(code);
  };

  const watchExit = (child, label) => {
    child.on?.('exit', (code, signal) => {
      if (shuttingDown) return;
      const suffix = signal ? `signal ${signal}` : `code ${code ?? 0}`;
      error(`[dev] ${label} exited (${suffix}); stopping the other process`);
      shutdown(code || 1);
    });
  };

  let kugouStarted = false;
  if (await isApiReachable(config.kugouApiBase)) {
    log(`[dev] KuGouMusicApi already reachable at ${config.kugouApiBase}`);
  } else {
    const kugouChild = spawnChild({
      ...config.kugou,
      env: childEnv,
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
    children,
  };
}

if (path.resolve(process.argv[1] || '') === THIS_FILE) {
  startDev({ manageSignals: true }).catch(err => {
    console.error(`[dev] ${err.message}`);
    process.exit(1);
  });
}
