import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  PLAY_WINDOW_MODES,
  DEFAULT_PLAY_WINDOW_MODE,
  ACTIONS,
  normalizePlayWindowMode,
  applyPlayWindowPolicy,
} = require('../desktop/play-window-policy.cjs');

// 纯 mock 窗口：模拟 Electron BrowserWindow 的相关状态与调用，
// 不启动任何真实 Electron 进程，也不触碰 Win32 / 任务栏。
function makeWindow(initial = {}) {
  const state = {
    destroyed: false,
    minimized: false,
    visible: false,
    focused: false,
    ...initial,
  };
  const calls = [];
  const win = {
    state,
    calls,
    isDestroyed: () => state.destroyed,
    isMinimized: () => state.minimized,
    isVisible: () => state.visible,
    isFocused: () => state.focused,
    show: () => { calls.push('show'); state.visible = true; },
    showInactive: () => { calls.push('showInactive'); state.visible = true; },
    minimize: () => { calls.push('minimize'); state.minimized = true; state.visible = true; state.focused = false; },
    restore: () => { calls.push('restore'); state.minimized = false; state.visible = true; },
    focus: () => { calls.push('focus'); state.focused = true; },
    hide: () => { calls.push('hide'); state.visible = false; state.focused = false; },
  };
  return win;
}

describe('play-window-policy 归一化', () => {
  it('只认 popup / background，缺省、空串、非法值都按 background', () => {
    expect(PLAY_WINDOW_MODES).toEqual(['popup', 'background']);
    expect(DEFAULT_PLAY_WINDOW_MODE).toBe('background');
    expect(normalizePlayWindowMode('popup')).toBe('popup');
    expect(normalizePlayWindowMode(' POPUP ')).toBe('popup');
    expect(normalizePlayWindowMode('background')).toBe('background');
    expect(normalizePlayWindowMode('')).toBe('background');
    expect(normalizePlayWindowMode(undefined)).toBe('background');
    expect(normalizePlayWindowMode(null)).toBe('background');
    expect(normalizePlayWindowMode('tray')).toBe('background');
  });
});

describe('background（默认）：静默进任务栏最小化', () => {
  it('冷启 show:false 时走 showInactive + minimize，不 show / focus', () => {
    const win = makeWindow();
    const action = applyPlayWindowPolicy(win, 'background');

    expect(action).toBe(ACTIONS.SHOWN_MINIMIZED_INACTIVE);
    expect(win.calls).toEqual(['showInactive', 'minimize']);
    expect(win.calls).not.toContain('show');
    expect(win.calls).not.toContain('focus');
    expect(win.state.minimized).toBe(true);
    expect(win.state.visible).toBe(true);
    expect(win.state.focused).toBe(false);
  });

  it('设置为空串 / 非法值时与 background 完全一致', () => {
    for (const mode of ['', undefined, null, 'nonsense']) {
      const win = makeWindow();
      expect(applyPlayWindowPolicy(win, mode)).toBe(ACTIONS.SHOWN_MINIMIZED_INACTIVE);
      expect(win.calls).toEqual(['showInactive', 'minimize']);
    }
  });

  it('被 closeToTray 藏进托盘（不可见）时用不激活方式拉回任务栏', () => {
    const win = makeWindow({ visible: true });
    win.hide();
    win.calls.length = 0;

    const action = applyPlayWindowPolicy(win, 'background');

    expect(action).toBe(ACTIONS.SHOWN_MINIMIZED_INACTIVE);
    expect(win.calls).toEqual(['showInactive', 'minimize']);
    expect(win.calls).not.toContain('show');
    expect(win.calls).not.toContain('focus');
    expect(win.state.minimized).toBe(true);
    expect(win.state.focused).toBe(false);
  });

  it('已经最小化时 no-op，不 restore 再 minimize', () => {
    const win = makeWindow({ visible: true, minimized: true });
    const action = applyPlayWindowPolicy(win, 'background');

    expect(action).toBe(ACTIONS.ALREADY_MINIMIZED);
    expect(win.calls).toEqual([]);
  });

  it('用户正在前台操作时保留原状，不 minimize、不抢焦点', () => {
    const win = makeWindow({ visible: true, focused: true });
    const action = applyPlayWindowPolicy(win, 'background');

    expect(action).toBe(ACTIONS.LEFT_FOREGROUND);
    expect(win.calls).toEqual([]);
    expect(win.state.minimized).toBe(false);
  });

  it('窗口可见但未聚焦时直接 minimize，不 show、不 focus', () => {
    const win = makeWindow({ visible: true, focused: false });
    const action = applyPlayWindowPolicy(win, 'background');

    expect(action).toBe(ACTIONS.MINIMIZED_INACTIVE);
    expect(win.calls).toEqual(['minimize']);
    expect(win.calls).not.toContain('show');
    expect(win.calls).not.toContain('focus');
    expect(win.calls).not.toContain('restore');
    expect(win.state.minimized).toBe(true);
    expect(win.state.focused).toBe(false);
  });

  it('托盘隐藏且此前已最小化时，仍用不激活方式拉回任务栏，不因 isMinimized 而 no-op', () => {
    const win = makeWindow({ visible: true, minimized: true });
    win.hide();
    win.calls.length = 0;

    const action = applyPlayWindowPolicy(win, 'background');

    expect(action).toBe(ACTIONS.SHOWN_MINIMIZED_INACTIVE);
    expect(win.calls).toEqual(['showInactive', 'minimize']);
    expect(win.calls).not.toContain('show');
    expect(win.calls).not.toContain('focus');
  });

  it('同一窗口状态连续调用不会反复 minimize', () => {
    const win = makeWindow();
    expect(applyPlayWindowPolicy(win, 'background')).toBe(ACTIONS.SHOWN_MINIMIZED_INACTIVE);
    expect(applyPlayWindowPolicy(win, 'background')).toBe(ACTIONS.ALREADY_MINIMIZED);
    expect(win.calls.filter(c => c === 'minimize')).toHaveLength(1);
  });

  it('平台缺少 showInactive 时明确返回 unsupported，不退回抢焦点的 show', () => {
    const win = makeWindow();
    delete win.showInactive;
    const action = applyPlayWindowPolicy(win, 'background');

    expect(action).toBe(ACTIONS.UNSUPPORTED_NO_SHOW_INACTIVE);
    expect(win.calls).toEqual([]);
  });

  it('窗口不存在或已销毁时 no-op，不创建第二个窗口', () => {
    expect(applyPlayWindowPolicy(null, 'background')).toBe(ACTIONS.UNSUPPORTED_NO_WINDOW);
    expect(applyPlayWindowPolicy(undefined, 'popup')).toBe(ACTIONS.UNSUPPORTED_NO_WINDOW);
    const destroyed = makeWindow({ destroyed: true });
    expect(applyPlayWindowPolicy(destroyed, 'background')).toBe(ACTIONS.UNSUPPORTED_NO_WINDOW);
    expect(destroyed.calls).toEqual([]);
  });
});

describe('popup：保持原有唤起行为', () => {
  it('冷启时 show + focus，不做最小化', () => {
    const win = makeWindow();
    const action = applyPlayWindowPolicy(win, 'popup');

    expect(action).toBe(ACTIONS.RAISED_POPUP);
    expect(win.calls).toEqual(['show', 'focus']);
    expect(win.state.minimized).toBe(false);
    expect(win.state.focused).toBe(true);
  });

  it('二次启动 / 点歌入口遇到最小化窗口时先 restore 再 show + focus', () => {
    const win = makeWindow({ visible: true, minimized: true });
    const action = applyPlayWindowPolicy(win, 'popup');

    expect(action).toBe(ACTIONS.RAISED_POPUP);
    expect(win.calls).toEqual(['restore', 'show', 'focus']);
    expect(win.state.minimized).toBe(false);
    expect(win.state.focused).toBe(true);
  });

  it('从托盘隐藏状态唤起时 show + focus', () => {
    const win = makeWindow({ visible: true });
    win.hide();
    win.calls.length = 0;

    const action = applyPlayWindowPolicy(win, 'popup');

    expect(action).toBe(ACTIONS.RAISED_POPUP);
    expect(win.calls).toEqual(['show', 'focus']);
  });
});
