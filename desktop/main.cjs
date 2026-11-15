const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, screen } = require('electron');
const {
  MIN_STANDARD,
  MINI_SIZE,
  normalizeAccelerator,
  clampBounds,
  clampPosition,
  loadWindowState,
  saveWindowState,
} = require('./window-state.cjs');
const { createSupervisor } = require('./supervisor.cjs');

function readCliArg(name) {
  const prefix = `--${name}=`;
  for (let i = 0; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
    if (arg === `--${name}` && i + 1 < process.argv.length) return process.argv[i + 1];
  }
  return '';
}

function hasCliFlag(name) {
  return process.argv.includes(`--${name}`);
}

// Configure isolated userData before requesting single-instance lock.
const customUserData = readCliArg('user-data-dir');
if (customUserData) {
  app.setPath('userData', path.resolve(customUserData));
}

// Required for un-gestured autoplay and keeping WebAudio / playback alive when occluded.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.setAppUserModelId('com.claudio.desktop');

const verifyDumpDir = readCliArg('verify-dump');
const serverPort = Number(readCliArg('port') || process.env.PORT || 8080);
const explicitUrl = readCliArg('url') || process.env.CLAUDIO_SERVER_URL || '';
const skipKugou = hasCliFlag('no-kugou') || ['1', 'true', 'yes'].includes(String(process.env.CLAUDIO_SKIP_KUGOU || '').toLowerCase());

function createWaveformIcon(size = 32) {
  const buf = Buffer.alloc(size * size * 4);
  const bg = { b: 27, g: 24, r: 24, a: 255 };     // #18181B
  const accent = { b: 49, g: 75, r: 200, a: 255 }; // #C84B31 (BGRA)
  const radius = Math.floor(size * 0.22);

  const inRoundedRect = (x, y) => {
    const rx = x < radius ? radius - 1 - x : x >= size - radius ? x - (size - radius) : 0;
    const ry = y < radius ? radius - 1 - y : y >= size - radius ? y - (size - radius) : 0;
    return rx * rx + ry * ry <= radius * radius;
  };

  const bars = [
    { x0: 0.16, x1: 0.28, y0: 0.34, y1: 0.66 },
    { x0: 0.35, x1: 0.47, y0: 0.18, y1: 0.82 },
    { x0: 0.54, x1: 0.66, y0: 0.25, y1: 0.75 },
    { x0: 0.73, x1: 0.84, y0: 0.38, y1: 0.62 },
  ];

  for (let y = 0; y < size; y += 1) {
    const ny = y / size;
    for (let x = 0; x < size; x += 1) {
      const idx = (y * size + x) * 4;
      if (!inRoundedRect(x, y)) {
        buf[idx + 3] = 0;
        continue;
      }
      const nx = x / size;
      const onBar = bars.some(b => nx >= b.x0 && nx <= b.x1 && ny >= b.y0 && ny <= b.y1);
      const px = onBar ? accent : bg;
      buf[idx] = px.b;
      buf[idx + 1] = px.g;
      buf[idx + 2] = px.r;
      buf[idx + 3] = px.a;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

let mainWindow = null;
let tray = null;
let supervisor = null;
let baseUrl = explicitUrl || `http://127.0.0.1:${serverPort}`;
let isQuitting = false;
let windowState = null;
let saveTimer = null;
let registeredShortcuts = [];

const desktopSettings = {
  globalHotkey: 'CTRL+ALT+K',
  hotkeyMediaKey: false,
  closeToTray: true,
  alwaysOnTopMini: true,
};

function persistStateSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (windowState) saveWindowState(app.getPath('userData'), windowState);
  }, 150);
}

function sendControl(command) {
  fetch(`${baseUrl}/api/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, agentId: 'desktop-shell', agentName: 'Desktop Shell' }),
  }).catch(() => {});
}

function applyShortcuts() {
  for (const acc of registeredShortcuts) {
    try { globalShortcut.unregister(acc); } catch { /* ignore */ }
  }
  registeredShortcuts = [];

  const hotkeyAcc = normalizeAccelerator(desktopSettings.globalHotkey);
  if (hotkeyAcc) {
    try {
      const ok = globalShortcut.register(hotkeyAcc, () => sendControl('toggle'));
      if (ok) registeredShortcuts.push(hotkeyAcc);
    } catch { /* ignore invalid or claimed shortcut */ }
  }

  if (desktopSettings.hotkeyMediaKey) {
    const mediaBindings = [
      ['MediaPlayPause', 'toggle'],
      ['MediaNextTrack', 'next'],
      ['MediaPreviousTrack', 'prev'],
    ];
    for (const [acc, action] of mediaBindings) {
      try {
        const ok = globalShortcut.register(acc, () => sendControl(action));
        if (ok) registeredShortcuts.push(acc);
      } catch { /* ignore */ }
    }
  }
}

function applySettingsSnapshot(s = {}) {
  if (s.global_hotkey !== undefined) {
    desktopSettings.globalHotkey = String(s.global_hotkey || 'CTRL+ALT+K');
  }
  if (s.hotkey_media_key !== undefined) {
    desktopSettings.hotkeyMediaKey = String(s.hotkey_media_key) === 'true';
  }
  if (s.close_to_tray !== undefined) {
    desktopSettings.closeToTray = String(s.close_to_tray) !== 'false';
  }
  if (s.always_on_top_mini !== undefined) {
    desktopSettings.alwaysOnTopMini = String(s.always_on_top_mini) !== 'false';
  }
  applyShortcuts();
  if (mainWindow && !mainWindow.isDestroyed() && windowState?.isMini) {
    mainWindow.setAlwaysOnTop(Boolean(desktopSettings.alwaysOnTopMini));
  }
}

async function hydrateRemoteSettings() {
  try {
    const r = await fetch(`${baseUrl}/api/settings`);
    if (r.ok) applySettingsSnapshot(await r.json());
  } catch {
    applyShortcuts();
  }
}

function applyWindowMode(mini) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const targetMini = Boolean(mini);
  const displays = screen.getAllDisplays();

  if (targetMini && !windowState.isMini) {
    windowState.standard = clampBounds(mainWindow.getBounds(), displays);
  } else if (!targetMini && windowState.isMini) {
    const b = mainWindow.getBounds();
    windowState.mini = { x: b.x, y: b.y };
  }

  windowState.isMini = targetMini;

  if (targetMini) {
    mainWindow.setResizable(true);
    mainWindow.setMinimumSize(320, 112);
    const bounds = clampPosition(windowState.mini, MINI_SIZE, displays);
    if (bounds.x != null) mainWindow.setBounds(bounds);
    else mainWindow.setSize(MINI_SIZE.width, MINI_SIZE.height);
    mainWindow.setResizable(false);
    mainWindow.setAlwaysOnTop(Boolean(desktopSettings.alwaysOnTopMini));
  } else {
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setResizable(true);
    mainWindow.setMinimumSize(MIN_STANDARD.width, MIN_STANDARD.height);
    const bounds = clampBounds(windowState.standard, displays);
    if (bounds.x != null) mainWindow.setBounds(bounds);
    else mainWindow.setSize(bounds.width, bounds.height);
  }

  saveWindowState(app.getPath('userData'), windowState);
  mainWindow.webContents.send('desktop:mini-changed', targetMini);
  return targetMini;
}

function createWindow(icon) {
  const displays = screen.getAllDisplays();
  windowState = loadWindowState(app.getPath('userData'), { displays });
  // In automated verification mode always boot Standard first so both modes can be verified cleanly.
  if (verifyDumpDir) windowState.isMini = false;

  const initialBounds = windowState.isMini
    ? clampPosition(windowState.mini, MINI_SIZE, displays)
    : windowState.standard;

  mainWindow = new BrowserWindow({
    width: initialBounds.width,
    height: initialBounds.height,
    ...(initialBounds.x != null ? { x: initialBounds.x, y: initialBounds.y } : {}),
    minWidth: windowState.isMini ? 320 : MIN_STANDARD.width,
    minHeight: windowState.isMini ? 112 : MIN_STANDARD.height,
    resizable: !windowState.isMini,
    alwaysOnTop: windowState.isMini ? Boolean(desktopSettings.alwaysOnTopMini) : false,
    frame: false,
    show: false,
    backgroundColor: '#F7F6F2',
    title: 'Claudio',
    icon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
    if (windowState.isMini) {
      mainWindow.webContents.send('desktop:mini-changed', true);
    }
  });

  const recordBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    const b = mainWindow.getBounds();
    if (windowState.isMini) windowState.mini = { x: b.x, y: b.y };
    else windowState.standard = b;
    persistStateSoon();
  };
  mainWindow.on('move', recordBounds);
  mainWindow.on('resize', recordBounds);

  mainWindow.on('close', e => {
    if (!isQuitting && desktopSettings.closeToTray && tray && !tray.isDestroyed()) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.loadURL(baseUrl);
}

function createTray(icon) {
  tray = new Tray(icon);
  tray.setToolTip('Claudio · 私人 AI 电台');
  const toggleShow = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isVisible()) {
      mainWindow.focus();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  };
  tray.on('click', toggleShow);
  tray.on('double-click', toggleShow);

  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: toggleShow },
    { label: '切换迷你模式', click: () => applyWindowMode(!windowState.isMini) },
    { type: 'separator' },
    { label: '播放 / 暂停', click: () => sendControl('toggle') },
    { label: '下一首', click: () => sendControl('next') },
    { type: 'separator' },
    {
      label: '退出 Claudio',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

async function runVerifyDump(targetDir) {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  fs.mkdirSync(targetDir, { recursive: true });

  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      const ready = await mainWindow.webContents.executeJavaScript(
        "document.documentElement.dataset.appReady === 'true' && !document.getElementById('desktop-titlebar')?.hidden",
      );
      if (ready) break;
    } catch { /* ignore while booting */ }
    await wait(100);
  }

  await wait(450);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  const standardBounds = mainWindow.getBounds();
  const standardImg = await mainWindow.webContents.capturePage();
  fs.writeFileSync(path.join(targetDir, 'standard.png'), standardImg.toPNG());

  applyWindowMode(true);
  await wait(500);
  const miniBounds = mainWindow.getBounds();
  const miniImg = await mainWindow.webContents.capturePage();
  fs.writeFileSync(path.join(targetDir, 'mini.png'), miniImg.toPNG());

  const report = {
    ok: true,
    url: baseUrl,
    standardBounds,
    miniBounds,
    isMini: Boolean(windowState?.isMini),
    alwaysOnTop: Boolean(mainWindow.isAlwaysOnTop()),
    trayReady: Boolean(tray && !tray.isDestroyed()),
    registeredShortcuts: [...registeredShortcuts],
  };
  fs.writeFileSync(path.join(targetDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

  isQuitting = true;
  app.quit();
}

const gotLock = verifyDumpDir ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  ipcMain.handle('desktop:minimize', () => mainWindow?.minimize());
  ipcMain.handle('desktop:close', () => mainWindow?.close());
  ipcMain.handle('desktop:toggle-mini', () => applyWindowMode(!windowState?.isMini));
  ipcMain.handle('desktop:set-mini', (_ev, flag) => applyWindowMode(Boolean(flag)));
  ipcMain.handle('desktop:get-state', () => ({
    isMini: Boolean(windowState?.isMini),
    url: baseUrl,
  }));
  ipcMain.handle('desktop:sync-settings', (_ev, settings) => {
    applySettingsSnapshot(settings || {});
    return { ok: true, registeredShortcuts: [...registeredShortcuts] };
  });

  app.whenReady().then(async () => {
    supervisor = createSupervisor({
      projectRoot: path.resolve(__dirname, '..'),
      port: serverPort,
      skipKugou,
    });
    if (!explicitUrl) {
      const ready = await supervisor.ensureReady();
      baseUrl = ready.url;
    }

    const icon = createWaveformIcon(32);
    await hydrateRemoteSettings();
    createWindow(icon);
    createTray(icon);

    if (verifyDumpDir) {
      mainWindow.webContents.once('did-finish-load', () => {
        runVerifyDump(verifyDumpDir).catch(err => {
          console.error('[desktop] verify-dump failed:', err);
          isQuitting = true;
          app.exit(1);
        });
      });
    }
  });

  app.on('before-quit', () => {
    isQuitting = true;
    globalShortcut.unregisterAll();
    if (windowState) saveWindowState(app.getPath('userData'), windowState);
    supervisor?.stop();
  });

  app.on('window-all-closed', () => {
    if (isQuitting || process.platform !== 'darwin') {
      app.quit();
    }
  });
}
