// 界面主题读写与生效工具：仅在独立模块缓存 ui_theme（不与 session URL 模块混用存储）。
const THEME_KEY = 'claudio:ui-theme';
const THEME_COLORS = {
  auto: '#f2ede1',
  light: '#f2ede1',
  dark: '#171512',
  pixel: '#0B1526',
};

export function normalizeTheme(theme = 'auto') {
  return ['auto', 'light', 'dark', 'pixel'].includes(theme) ? theme : 'auto';
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
  // auto / light 保留宣纸水墨底色，dark 用暗墨夜色，pixel 用深夜蓝金底色。
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[valid] || THEME_COLORS.auto);
  try {
    const res = globalThis.window?.claudioDesktop?.setThemeIcon?.(valid);
    if (res && typeof res.catch === 'function') res.catch(() => {});
  } catch { /* ignore in browser or tests */ }
  return valid;
}
