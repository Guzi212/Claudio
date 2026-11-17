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
  // auto / light 均保留宣纸水墨画风，仅显式选择 dark 时切换暗墨夜色。
  const dark = valid === 'dark';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#171512' : '#f2ede1');
  return valid;
}
