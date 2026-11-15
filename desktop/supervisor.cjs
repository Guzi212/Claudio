const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_WAIT_MS = 18_000;
const DEFAULT_INTERVAL_MS = 350;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function isHttpReachable(url, { fetchImpl = globalThis.fetch, timeoutMs = 1500 } = {}) {
  if (typeof fetchImpl !== 'function') return false;
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

async function waitForHttp(url, {
  timeoutMs = DEFAULT_WAIT_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHttpReachable(url, { fetchImpl })) return true;
    await sleepImpl(intervalMs);
  }
  return false;
}

function defaultKillChild(child, platform = process.platform) {
  if (!child || child.killed) return;
  if (platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      return;
    } catch { /* fallback below */ }
  }
  try { child.kill(); } catch { /* ignore */ }
}

function createSupervisor({
  projectRoot = path.resolve(__dirname, '..'),
  port = Number(process.env.PORT) || 8080,
  kugouApiBase = process.env.KUGOU_API_BASE || 'http://127.0.0.1:33400',
  kugouApiDir = path.resolve(projectRoot, process.env.KUGOU_API_DIR || '../KuGouMusicApi'),
  skipKugou = ['1', 'true', 'yes'].includes(String(process.env.CLAUDIO_SKIP_KUGOU || '').toLowerCase()),
  claudioDbPath = process.env.CLAUDIO_DB_PATH || '',
  nodeCommand = '',
  env = process.env,
  platform = process.platform,
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  existsSyncImpl = fs.existsSync,
  sleepImpl = sleep,
  killImpl = null,
  log = console.log,
} = {}) {
  const ownedChildren = [];
  const claudioUrl = `http://127.0.0.1:${port}`;
  const healthUrl = `${claudioUrl}/api/health`;

  function parseKugouPort() {
    try {
      const u = new URL(kugouApiBase);
      return Number(u.port) || 33400;
    } catch {
      return 33400;
    }
  }

  async function ensureKugou() {
    if (skipKugou) return { started: false, skipped: true };
    if (await isHttpReachable(kugouApiBase, { fetchImpl })) {
      return { started: false, reused: true };
    }
    if (!existsSyncImpl(path.join(kugouApiDir, 'package.json'))) {
      return { started: false, missingDir: true };
    }
    const kugouPort = parseKugouPort();
    const kugouEnv = {
      ...env,
      PORT: String(kugouPort),
      HOST: '127.0.0.1',
    };
    const cmd = platform === 'win32' ? 'npm.cmd start' : 'npm';
    const args = platform === 'win32' ? [] : ['start'];
    log(`[desktop] starting KuGouMusicApi on :${kugouPort}`);
    const child = spawnImpl(cmd, args, {
      cwd: kugouApiDir,
      env: kugouEnv,
      shell: platform === 'win32',
      windowsHide: true,
      stdio: 'ignore',
    });
    ownedChildren.push(child);
    await waitForHttp(kugouApiBase, { timeoutMs: 12_000, fetchImpl, sleepImpl });
    return { started: true };
  }

  async function ensureClaudio() {
    if (await isHttpReachable(healthUrl, { fetchImpl })) {
      return { started: false, reused: true, url: claudioUrl };
    }

    const useElectronAsNode = !nodeCommand && Boolean(process.versions?.electron);
    const exec = nodeCommand || process.execPath;
    const childEnv = {
      ...env,
      PORT: String(port),
      ...(claudioDbPath ? { CLAUDIO_DB_PATH: claudioDbPath } : {}),
      ...(useElectronAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    };
    log(`[desktop] starting Claudio server on ${claudioUrl}`);
    const child = spawnImpl(exec, ['--no-warnings', 'server/app.js'], {
      cwd: projectRoot,
      env: childEnv,
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    ownedChildren.push(child);

    const ready = await waitForHttp(healthUrl, { timeoutMs: DEFAULT_WAIT_MS, fetchImpl, sleepImpl });
    if (!ready) {
      throw new Error(`Claudio server failed to respond at ${healthUrl}`);
    }
    return { started: true, reused: false, url: claudioUrl };
  }

  async function ensureReady() {
    const kugou = await ensureKugou();
    const claudio = await ensureClaudio();
    return { url: claudio.url, claudio, kugou };
  }

  function stop() {
    const killer = killImpl || (child => defaultKillChild(child, platform));
    while (ownedChildren.length) {
      const child = ownedChildren.pop();
      killer(child);
    }
  }

  return {
    claudioUrl,
    ownedChildren,
    ensureReady,
    stop,
  };
}

module.exports = {
  isHttpReachable,
  waitForHttp,
  createSupervisor,
};
