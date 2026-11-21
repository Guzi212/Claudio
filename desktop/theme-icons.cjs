const path = require('node:path');

const VALID_THEMES = ['auto', 'light', 'dark', 'pixel'];

function normalizeThemeName(theme) {
  return VALID_THEMES.includes(theme) ? theme : 'auto';
}

function iconSetForTheme(theme, iconsDir = path.join(__dirname, 'icons')) {
  const variant = theme === 'pixel' ? 'pixel' : 'ink';
  return {
    variant,
    windowIcon: path.join(iconsDir, `claudio-${variant}.ico`),
    trayIcon: path.join(iconsDir, `tray-${variant}-32.png`),
    trayIcon16: path.join(iconsDir, `tray-${variant}-16.png`),
  };
}

function backgroundColorForTheme(theme) {
  if (theme === 'pixel') return '#0B1526';
  if (theme === 'dark') return '#171512';
  return '#F2EDE1';
}

module.exports = {
  VALID_THEMES,
  normalizeThemeName,
  iconSetForTheme,
  backgroundColorForTheme,
};
