import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const windowState = require('../desktop/window-state.cjs');
const supervisor = require('../desktop/supervisor.cjs');

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
