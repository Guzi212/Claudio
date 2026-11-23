import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const windowState = require('../desktop/window-state.cjs');
const supervisor = require('../desktop/supervisor.cjs');
const themeIcons = require('../desktop/theme-icons.cjs');
const externalLinks = require('../desktop/external-links.cjs');

describe('desktop window-state', () => {
  it('规范化全局快捷键字符串为 Electron Accelerator', () => {
    expect(windowState.normalizeAccelerator('CTRL+ALT+K')).toBe('CommandOrControl+Alt+K');
    expect(windowState.normalizeAccelerator('shift + ctrl + 9')).toBe('Shift+CommandOrControl+9');
    expect(windowState.normalizeAccelerator('alt+f12')).toBe('Alt+F12');
    expect(windowState.normalizeAccelerator('win+space')).toBe('Super+Space');
    expect(windowState.normalizeAccelerator('')).toBe('');
    expect(windowState.normalizeAccelerator('CTRL+ALT')).toBe('');
  });

  it('将越界或过小窗口矩形约束到可见显示器工作区内', () => {
    const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
    expect(windowState.clampBounds({ x: 3000, y: -50, width: 300, height: 400 }, displays)).toEqual({
      width: 420,
      height: 520,
      x: 1500,
      y: 0,
    });
    expect(windowState.clampPosition({ x: 1800, y: 1000 }, windowState.MINI_SIZE, displays)).toEqual({
      width: 380,
      height: 136,
      x: 1540,
      y: 904,
    });
  });

  it('持久化读写窗口状态并在文件损坏时安全回退默认', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-winstate-'));
    try {
      const saved = {
        isMini: true,
        standard: { x: 120, y: 80, width: 1080, height: 740 },
        mini: { x: 40, y: 40 },
      };
      expect(windowState.saveWindowState(dir, saved)).toBe(true);
      const loaded = windowState.loadWindowState(dir, {
        displays: [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
      });
      expect(loaded).toEqual(saved);

      fs.writeFileSync(path.join(dir, 'window-state.json'), '{broken-json', 'utf8');
      const fallback = windowState.loadWindowState(dir);
      expect(fallback.isMini).toBe(false);
      expect(fallback.standard).toEqual(windowState.DEFAULT_STANDARD);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('desktop process supervisor', () => {
  it('Claudio 与 KuGou 已在线时直接复用，不重复拉起进程', async () => {
    const spawnImpl = vi.fn();
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
    const sup = supervisor.createSupervisor({
      projectRoot: process.cwd(),
      port: 18088,
      fetchImpl,
      spawnImpl,
      log: () => {},
    });

    const ready = await sup.ensureReady();
    expect(ready.url).toBe('http://127.0.0.1:18088');
    expect(ready.claudio.reused).toBe(true);
    expect(ready.kugou.reused).toBe(true);
    expect(spawnImpl).not.toHaveBeenCalled();

    sup.stop();
  });

  it('服务未启动时仅拉起缺失服务，stop 仅回收自己拉起的子进程', async () => {
    let serverReady = false;
    const fakeChild = { pid: 98765, killed: false, kill: vi.fn() };
    const spawnImpl = vi.fn(() => {
      setTimeout(() => { serverReady = true; }, 10);
      return fakeChild;
    });
    const fetchImpl = vi.fn(async url => {
      if (String(url).includes('/api/health') && serverReady) return { ok: true, status: 200 };
      throw new Error('ECONNREFUSED');
    });
    const killImpl = vi.fn();

    const sup = supervisor.createSupervisor({
      projectRoot: process.cwd(),
      port: 18089,
      skipKugou: true,
      claudioDbPath: 'C:/tmp/test.db',
      fetchImpl,
      spawnImpl,
      killImpl,
      sleepImpl: () => new Promise(r => setTimeout(r, 15)),
      log: () => {},
    });

    const ready = await sup.ensureReady();
    expect(ready.claudio.started).toBe(true);
    expect(ready.kugou.skipped).toBe(true);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl.mock.calls[0][1]).toEqual(['--no-warnings', 'server/app.js']);
    expect(spawnImpl.mock.calls[0][2].env.PORT).toBe('18089');
    expect(spawnImpl.mock.calls[0][2].env.CLAUDIO_DB_PATH).toBe('C:/tmp/test.db');

    sup.stop();
    expect(killImpl).toHaveBeenCalledTimes(1);
    expect(killImpl).toHaveBeenCalledWith(fakeChild);
  });
});

describe('desktop control bridge', () => {
  it('发送 /api/control 约定的 command 字段并带 JSON Content-Type', () => {
    const main = fs.readFileSync(path.resolve('desktop/main.cjs'), 'utf8');
    expect(main).toContain("headers: { 'Content-Type': 'application/json' }");
    expect(main).toMatch(/body: JSON\.stringify\(\{ command,/);
    expect(main).not.toMatch(/body: JSON\.stringify\(\{ action,/);
  });
});

describe('desktop theme icons', () => {
  it('iconSetForTheme 按主题返回水墨或像素图标组，且全部资源与 7 尺寸 ICO 均有效', () => {
    const pixelSet = themeIcons.iconSetForTheme('pixel');
    expect(pixelSet.variant).toBe('pixel');
    expect(path.basename(pixelSet.windowIcon)).toBe('claudio-pixel.ico');
    expect(path.basename(pixelSet.trayIcon)).toBe('tray-pixel-32.png');
    expect(path.basename(pixelSet.trayIcon16)).toBe('tray-pixel-16.png');

    for (const theme of ['auto', 'light', 'dark', '', undefined, 'invalid']) {
      const inkSet = themeIcons.iconSetForTheme(theme);
      expect(inkSet.variant).toBe('ink');
      expect(path.basename(inkSet.windowIcon)).toBe('claudio-ink.ico');
      expect(path.basename(inkSet.trayIcon)).toBe('tray-ink-32.png');
      expect(path.basename(inkSet.trayIcon16)).toBe('tray-ink-16.png');
    }

    for (const set of [themeIcons.iconSetForTheme('ink'), pixelSet]) {
      expect(fs.existsSync(set.windowIcon)).toBe(true);
      expect(fs.existsSync(set.trayIcon)).toBe(true);
      expect(fs.existsSync(set.trayIcon16)).toBe(true);
      const buf = fs.readFileSync(set.windowIcon);
      const count = buf.readUInt16LE(4);
      expect(count).toBe(7);
      const dims = Array.from({ length: count }, (_, i) => buf[6 + i * 16] || 256);
      expect(dims).toEqual([16, 24, 32, 48, 64, 128, 256]);
    }
  });

  it('window-state 持久化 theme 字段，且 main/preload 移除旧波形图标并接入主题图标 IPC', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-theme-state-'));
    try {
      const saved = {
        isMini: false,
        standard: { x: 80, y: 60, width: 1040, height: 700 },
        mini: {},
        theme: 'pixel',
      };
      expect(windowState.saveWindowState(dir, saved)).toBe(true);
      const loaded = windowState.loadWindowState(dir, {
        displays: [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
      });
      expect(loaded.theme).toBe('pixel');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    const main = fs.readFileSync(path.resolve('desktop/main.cjs'), 'utf8');
    const preload = fs.readFileSync(path.resolve('desktop/preload.cjs'), 'utf8');
    expect(main).not.toContain('createWaveformIcon');
    expect(main).toContain("ipcMain.handle('desktop:set-theme-icon'");
    expect(preload).toContain("setThemeIcon: theme => ipcRenderer.invoke('desktop:set-theme-icon', theme)");
  });
});

describe('open-player.ps1 混合启动契约', () => {
  it('保持纯 ASCII、Chrome 参数契约，并支持优先启动桌面客户端', () => {
    const ps1 = fs.readFileSync(path.resolve('scripts/open-player.ps1'), 'utf8');
    // 纯 ASCII 保证 PowerShell 5 无 BOM 安全解析
    expect(/^[\x00-\x7F]*$/.test(ps1)).toBe(true);
    expect(ps1).toContain('desktop\\main.cjs');
    expect(ps1).toContain('[switch]$Browser');
    expect(ps1).toContain('chrome.exe');
    expect(ps1).toContain('--autoplay-policy=no-user-gesture-required');
    expect(ps1).toContain('--user-data-dir=');
    expect(ps1).not.toContain('msedge');
  });
});

describe('desktop external link handling', () => {
  it('仅放行 https://github.com/ 开头链接，拦截其它协议、域名和伪装地址', () => {
    expect(externalLinks.isAllowedExternalUrl('https://github.com/Guzi212/Claudio/issues/new/choose')).toBe(true);
    expect(externalLinks.isAllowedExternalUrl('https://github.com/')).toBe(true);
    expect(externalLinks.isAllowedExternalUrl('http://github.com/Guzi212/Claudio')).toBe(false);
    expect(externalLinks.isAllowedExternalUrl('https://github.com.evil.com/Guzi212/Claudio')).toBe(false);
    expect(externalLinks.isAllowedExternalUrl('https://github.com@evil.com/path')).toBe(false);
    expect(externalLinks.isAllowedExternalUrl('https://github.com:8443/Guzi212/Claudio')).toBe(false);
    expect(externalLinks.isAllowedExternalUrl('https://example.com/')).toBe(false);
    expect(externalLinks.isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
    expect(externalLinks.isAllowedExternalUrl('file:///C:/Windows/win.ini')).toBe(false);
    expect(externalLinks.isAllowedExternalUrl('')).toBe(false);
  });

  it('setWindowOpenHandler 与 will-navigate 阻止应用内跳转，并仅将 GitHub 链接交给系统浏览器', () => {
    const openExternal = vi.fn(async () => {});
    let windowOpenHandler = null;
    const listeners = {};
    const fakeWebContents = {
      setWindowOpenHandler: fn => { windowOpenHandler = fn; },
      on: (event, fn) => { listeners[event] = fn; },
    };

    externalLinks.attachExternalLinkHandlers(fakeWebContents, {
      openExternal,
      appOrigin: 'http://127.0.0.1:8080',
    });

    const ghUrl = 'https://github.com/Guzi212/Claudio/issues/new/choose';
    expect(windowOpenHandler({ url: ghUrl })).toEqual({ action: 'deny' });
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(ghUrl);

    expect(windowOpenHandler({ url: 'https://evil.example/phish' })).toEqual({ action: 'deny' });
    expect(openExternal).toHaveBeenCalledTimes(1);

    const sameOriginEvent = { preventDefault: vi.fn() };
    listeners['will-navigate'](sameOriginEvent, 'http://127.0.0.1:8080/?view=settings');
    expect(sameOriginEvent.preventDefault).not.toHaveBeenCalled();

    const ghNavEvent = { preventDefault: vi.fn() };
    listeners['will-navigate'](ghNavEvent, ghUrl);
    expect(ghNavEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledTimes(2);
    expect(openExternal).toHaveBeenLastCalledWith(ghUrl);

    const otherNavEvent = { preventDefault: vi.fn() };
    listeners['will-navigate'](otherNavEvent, 'https://example.com/other');
    expect(otherNavEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledTimes(2);

    const main = fs.readFileSync(path.resolve('desktop/main.cjs'), 'utf8');
    expect(main).toContain('shell');
    expect(main).toContain('attachExternalLinkHandlers');
    expect(main).toContain('shell.openExternal(url)');
  });

  it('will-redirect 仅对主框架复用同源放行、GitHub 外开、其他来源拦截策略，且不误伤子框架', () => {
    const openExternal = vi.fn(async () => {});
    const listeners = {};
    const fakeWebContents = {
      setWindowOpenHandler: vi.fn(),
      on: (event, fn) => { listeners[event] = fn; },
    };

    externalLinks.attachExternalLinkHandlers(fakeWebContents, {
      openExternal,
      appOrigin: 'http://127.0.0.1:8080',
    });

    const onWillRedirect = listeners['will-redirect'];
    expect(typeof onWillRedirect).toBe('function');

    // 主框架：同源重定向放行
    const sameOriginEvent = {
      url: 'http://127.0.0.1:8080/?view=settings',
      isMainFrame: true,
      preventDefault: vi.fn(),
    };
    onWillRedirect(sameOriginEvent, sameOriginEvent.url, false, true);
    expect(sameOriginEvent.preventDefault).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();

    // 主框架：GitHub 重定向拦截并交由系统浏览器打开（Electron details 对象形态）
    const ghUrl = 'https://github.com/Guzi212/Claudio/issues';
    const ghEvent = {
      url: ghUrl,
      isMainFrame: true,
      preventDefault: vi.fn(),
    };
    onWillRedirect(ghEvent);
    expect(ghEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenLastCalledWith(ghUrl);

    // 主框架：其他跨源重定向拦截且不外开（旧版位置参数形态）
    const otherEvent = { preventDefault: vi.fn() };
    onWillRedirect(otherEvent, 'https://example.com/phish', false, true);
    expect(otherEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledTimes(1);

    // 非主框架（子框架）：不拦截、不外开
    const subFrameOtherEvent = {
      url: 'https://example.com/embed',
      isMainFrame: false,
      preventDefault: vi.fn(),
    };
    onWillRedirect(subFrameOtherEvent, subFrameOtherEvent.url, false, false);
    expect(subFrameOtherEvent.preventDefault).not.toHaveBeenCalled();

    const subFrameGhEvent = { preventDefault: vi.fn() };
    onWillRedirect(subFrameGhEvent, ghUrl, false, false);
    expect(subFrameGhEvent.preventDefault).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledTimes(1);
  });
});
