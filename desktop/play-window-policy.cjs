'use strict';

// 点歌窗口策略：把设置里的 play_window_mode 翻译成窗口动作。
// 刻意保持纯函数、不 require electron，便于用 mock 窗口单测；
// main.cjs 负责在 ready-to-show / second-instance 等入口调用一次。

const PLAY_WINDOW_MODES = Object.freeze(['popup', 'background']);
const DEFAULT_PLAY_WINDOW_MODE = 'background';

const ACTIONS = Object.freeze({
  // popup：像今天一样唤起到前台
  RAISED_POPUP: 'raised_popup',
  // background：用户正在看 / 正在操作，保持原样
  LEFT_FOREGROUND: 'left_foreground',
  // background：可见但未聚焦，不激活地收入任务栏最小化
  MINIMIZED_INACTIVE: 'minimized_inactive',
  // background：已经在任务栏最小化
  ALREADY_MINIMIZED: 'already_minimized',
  // background：从隐藏（托盘 / 冷启未 show）回到任务栏最小化，且不抢焦点
  SHOWN_MINIMIZED_INACTIVE: 'shown_minimized_inactive',
  // 没有窗口可操作（未创建 / 已销毁），调用方不应自行创建第二个窗口
  UNSUPPORTED_NO_WINDOW: 'unsupported_no_window',
  // 平台缺少 showInactive，无法在“不激活”的前提下把窗口放回任务栏
  UNSUPPORTED_NO_SHOW_INACTIVE: 'unsupported_no_show_inactive',
});

// 唯一合法值只有 popup / background；缺省、空串、非法值一律按 background 解释。
// 注意：这里只做解释，不写库 —— 读路径绝不能把默认值落成 prefs。
function normalizePlayWindowMode(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === 'popup' ? 'popup' : DEFAULT_PLAY_WINDOW_MODE;
}

function isUsableWindow(win) {
  return Boolean(win) && typeof win.isDestroyed === 'function' && !win.isDestroyed();
}

function readFlag(win, name) {
  return typeof win[name] === 'function' ? Boolean(win[name]()) : false;
}

// 返回值描述实际动作，方便测试断言，也方便 main.cjs 记录诊断。
function applyPlayWindowPolicy(win, mode) {
  if (!isUsableWindow(win)) return ACTIONS.UNSUPPORTED_NO_WINDOW;

  const minimized = readFlag(win, 'isMinimized');
  const visible = readFlag(win, 'isVisible');
  const focused = readFlag(win, 'isFocused');

  if (normalizePlayWindowMode(mode) === 'popup') {
    if (minimized) win.restore();
    win.show();
    win.focus();
    return ACTIONS.RAISED_POPUP;
  }

  // background：静默，不弹窗、不抢焦点。只有用户正在操作（focused）时才保留。
  if (focused) return ACTIONS.LEFT_FOREGROUND;

  // 先处理不可见：hide() 后 isMinimized 仍可能为 true，不能当成已在任务栏而 no-op。
  if (!visible) {
    if (typeof win.showInactive !== 'function') return ACTIONS.UNSUPPORTED_NO_SHOW_INACTIVE;
    win.showInactive();
    win.minimize();
    return ACTIONS.SHOWN_MINIMIZED_INACTIVE;
  }

  if (minimized) return ACTIONS.ALREADY_MINIMIZED;

  // 可见但未聚焦：用户已切到别的应用。直接 minimize，不要 show/focus/restore。
  win.minimize();
  return ACTIONS.MINIMIZED_INACTIVE;
}

module.exports = {
  PLAY_WINDOW_MODES,
  DEFAULT_PLAY_WINDOW_MODE,
  ACTIONS,
  normalizePlayWindowMode,
  applyPlayWindowPolicy,
};
