// 界面主题读写与生效工具：仅在独立模块缓存 ui_theme（不与 session URL 模块混用存储）。
const THEME_KEY = 'claudio:ui-theme';

export function normalizeTheme(theme = 'auto') {
  return ['auto', 'light', 'dark'].includes(theme) ? theme : 'auto';
}

export function readSavedTheme() {
  try {
    return localStorage.getItem(THEME_KEY) || '';
  } catch {
    return '';
  }
}

export function applyTheme(theme = 'auto', { persist = true } = {}) {
  const valid = normalizeTheme(theme);
  document.documentElement.dataset.theme = valid;
  if (persist) {
    try { localStorage.setItem(THEME_KEY, valid); } catch { /* */ }
  }
  const dark = valid === 'dark'
    || (valid === 'auto' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#121316' : '#F7F6F2');
  return valid;
}
