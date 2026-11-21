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
const { applyPlayWindowPolicy, normalizePlayWindowMode } = require('./play-window-policy.cjs');
const {
  normalizeThemeName,
  iconSetForTheme,
  backgroundColorForTheme,
} = require('./theme-icons.cjs');

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

let currentIconVariant = 'ink';

function createTrayImage(icons) {
  const img = nativeImage.createEmpty();
  try {
    if (fs.existsSync(icons.trayIcon16)) {
      img.addRepresentation({ scaleFactor: 1, buffer: fs.readFileSync(icons.trayIcon16) });
    }
    if (fs.existsSync(icons.trayIcon)) {
      img.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(icons.trayIcon) });
    }
  } catch { /* fallback below */ }
  if (!img.isEmpty()) return img;
  return nativeImage.createFromPath(icons.trayIcon);
}

function applyThemeIcons(theme) {
  const validTheme = normalizeThemeName(theme);
  const icons = iconSetForTheme(validTheme);
  currentIconVariant = icons.variant;

  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.setIcon(icons.windowIcon);
    } catch {
      const winImg = nativeImage.createFromPath(icons.windowIcon);
      if (!winImg.isEmpty()) mainWindow.setIcon(winImg);
    }
  }
  if (tray && !tray.isDestroyed()) {
    tray.setImage(createTrayImage(icons));
  }
  if (windowState && windowState.theme !== validTheme) {
    windowState.theme = validTheme;
    persistStateSoon();
  }
  return {
    ok: true,
    theme: validTheme,
    variant: icons.variant,
    windowIcon: icons.windowIcon,
    trayIcon: icons.trayIcon,
  };
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
  playWindowMode: 'background',
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
  if (s.play_window_mode !== undefined) {
    // 唯一事实源是设置；'' / 非法值按 background 解释，读路径不写库。
    desktopSettings.playWindowMode = normalizePlayWindowMode(s.play_window_mode);
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

function createWindow(icons, initialTheme) {
  const displays = screen.getAllDisplays();
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
    backgroundColor: backgroundColorForTheme(initialTheme),
    title: 'Claudio',
    icon: icons.windowIcon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // 冷启入口同样走设置：默认 background 时只把窗口放进任务栏最小化，不抢焦点。
    // verify-dump 的自动截图需要可见窗口，保持旧的 popup 语义。
    applyPlayWindowPolicy(mainWindow, verifyDumpDir ? 'popup' : desktopSettings.playWindowMode);
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
    iconVariant: currentIconVariant,
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
    // 点歌 / 再次启动官方入口：popup 才 restore/show/focus；
    // background 只把窗口保持在任务栏最小化，不抢焦点。
    applyPlayWindowPolicy(mainWindow, desktopSettings.playWindowMode);
  });

  ipcMain.handle('desktop:minimize', () => mainWindow?.minimize());
  ipcMain.handle('desktop:close', () => mainWindow?.close());
  ipcMain.handle('desktop:toggle-mini', () => applyWindowMode(!windowState?.isMini));
  ipcMain.handle('desktop:set-mini', (_ev, flag) => applyWindowMode(Boolean(flag)));
  ipcMain.handle('desktop:get-state', () => ({
    isMini: Boolean(windowState?.isMini),
    url: baseUrl,
    theme: windowState?.theme || 'auto',
    iconVariant: currentIconVariant,
  }));
  ipcMain.handle('desktop:sync-settings', (_ev, settings) => {
    applySettingsSnapshot(settings || {});
    return { ok: true, registeredShortcuts: [...registeredShortcuts] };
  });
  ipcMain.handle('desktop:set-theme-icon', (_ev, theme) => applyThemeIcons(theme));

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

    const displays = screen.getAllDisplays();
    windowState = loadWindowState(app.getPath('userData'), { displays });
    const initialTheme = normalizeThemeName(windowState.theme);
    const icons = iconSetForTheme(initialTheme);
    currentIconVariant = icons.variant;

    await hydrateRemoteSettings();
    createWindow(icons, initialTheme);
    createTray(createTrayImage(icons));

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
