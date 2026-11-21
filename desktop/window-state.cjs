const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_STANDARD = { width: 1040, height: 700 };
const MIN_STANDARD = { width: 420, height: 520 };
const MINI_SIZE = { width: 380, height: 136 };

const MODIFIER_MAP = {
  ctrl: 'CommandOrControl',
  control: 'CommandOrControl',
  cmd: 'CommandOrControl',
  command: 'CommandOrControl',
  commandorcontrol: 'CommandOrControl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  win: 'Super',
  super: 'Super',
  meta: 'Super',
};

const KEY_ALIASES = {
  space: 'Space',
  spacebar: 'Space',
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Return',
  return: 'Return',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  plus: 'Plus',
};

function normalizeAccelerator(raw) {
  const input = String(raw || '').trim();
  if (!input) return '';
  const tokens = input.split('+').map(t => t.trim()).filter(Boolean);
  if (!tokens.length) return '';

  const modifiers = [];
  let keyToken = '';
  for (const part of tokens) {
    const lower = part.toLowerCase();
    if (MODIFIER_MAP[lower]) {
      const mod = MODIFIER_MAP[lower];
      if (!modifiers.includes(mod)) modifiers.push(mod);
      continue;
    }
    if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(part)) {
      keyToken = part.toUpperCase();
    } else if (/^[a-z]$/i.test(part)) {
      keyToken = part.toUpperCase();
    } else if (KEY_ALIASES[lower]) {
      keyToken = KEY_ALIASES[lower];
    } else {
      keyToken = part;
    }
  }
  if (!keyToken) return '';
  return [...modifiers, keyToken].join('+');
}

function pickDisplay(bounds, displays) {
  const list = Array.isArray(displays) ? displays.filter(d => d && d.workArea) : [];
  if (!list.length) return null;
  if (Number.isFinite(bounds?.x) && Number.isFinite(bounds?.y)) {
    const cx = bounds.x + Math.round((Number(bounds.width) || 0) / 2);
    const cy = bounds.y + Math.round((Number(bounds.height) || 0) / 2);
    const found = list.find(({ workArea: wa }) => (
      cx >= wa.x && cx <= wa.x + wa.width && cy >= wa.y && cy <= wa.y + wa.height
    ));
    if (found) return found.workArea;
  }
  return list[0].workArea;
}

function clampBounds(bounds = {}, displays = [], { minSize = MIN_STANDARD, defaults = DEFAULT_STANDARD } = {}) {
  const wa = pickDisplay(bounds, displays);
  let width = Number.isFinite(Number(bounds.width)) ? Math.round(Number(bounds.width)) : defaults.width;
  let height = Number.isFinite(Number(bounds.height)) ? Math.round(Number(bounds.height)) : defaults.height;

  width = Math.max(minSize.width, width);
  height = Math.max(minSize.height, height);

  if (wa) {
    width = Math.min(width, Math.max(minSize.width, wa.width));
    height = Math.min(height, Math.max(minSize.height, wa.height));
  }

  const out = { width, height };
  if (Number.isFinite(Number(bounds.x)) && Number.isFinite(Number(bounds.y))) {
    let x = Math.round(Number(bounds.x));
    let y = Math.round(Number(bounds.y));
    if (wa) {
      x = Math.min(Math.max(x, wa.x), Math.max(wa.x, wa.x + wa.width - width));
      y = Math.min(Math.max(y, wa.y), Math.max(wa.y, wa.y + wa.height - height));
    }
    out.x = x;
    out.y = y;
  }
  return out;
}

function clampPosition(pos = {}, size = MINI_SIZE, displays = []) {
  const wa = pickDisplay({ x: pos.x, y: pos.y, width: size.width, height: size.height }, displays);
  const out = { width: size.width, height: size.height };
  if (Number.isFinite(Number(pos.x)) && Number.isFinite(Number(pos.y))) {
    let x = Math.round(Number(pos.x));
    let y = Math.round(Number(pos.y));
    if (wa) {
      x = Math.min(Math.max(x, wa.x), Math.max(wa.x, wa.x + wa.width - size.width));
      y = Math.min(Math.max(y, wa.y), Math.max(wa.y, wa.y + wa.height - size.height));
    }
    out.x = x;
    out.y = y;
  }
  return out;
}

function stateFilePath(stateDir) {
  return path.join(stateDir, 'window-state.json');
}

function loadWindowState(stateDir, { displays = [] } = {}) {
  const fallback = {
    isMini: false,
    standard: clampBounds(DEFAULT_STANDARD, displays),
    mini: {},
  };
  try {
    const raw = fs.readFileSync(stateFilePath(stateDir), 'utf8');
    const parsed = JSON.parse(raw);
    const standard = clampBounds(parsed?.standard || DEFAULT_STANDARD, displays);
    const mini = Number.isFinite(Number(parsed?.mini?.x)) && Number.isFinite(Number(parsed?.mini?.y))
      ? clampPosition(parsed.mini, MINI_SIZE, displays)
      : {};
    const out = {
      isMini: Boolean(parsed?.isMini),
      standard,
      mini: mini.x != null ? { x: mini.x, y: mini.y } : {},
    };
    if (['auto', 'light', 'dark', 'pixel'].includes(parsed?.theme)) {
      out.theme = parsed.theme;
    }
    return out;
  } catch {
    return fallback;
  }
}

function saveWindowState(stateDir, nextState) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFilePath(stateDir), JSON.stringify(nextState, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_STANDARD,
  MIN_STANDARD,
  MINI_SIZE,
  normalizeAccelerator,
  clampBounds,
  clampPosition,
  loadWindowState,
  saveWindowState,
};
