const ALLOWED_EXTERNAL_PREFIX = 'https://github.com/';

function isAllowedExternalUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith(ALLOWED_EXTERNAL_PREFIX)) return false;
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:'
      && parsed.hostname === 'github.com'
      && !parsed.username
      && !parsed.password
      && parsed.port === '';
  } catch {
    return false;
  }
}

function isSameOriginUrl(rawUrl, appOrigin) {
  if (!appOrigin || typeof rawUrl !== 'string') return false;
  try {
    return new URL(rawUrl).origin === appOrigin;
  } catch {
    return false;
  }
}

function createWindowOpenHandler(openExternal) {
  return ({ url } = {}) => {
    if (isAllowedExternalUrl(url) && typeof openExternal === 'function') {
      Promise.resolve(openExternal(url)).catch(() => {});
    }
    return { action: 'deny' };
  };
}

function attachExternalLinkHandlers(webContents, { openExternal, appOrigin = '' } = {}) {
  if (!webContents) return;
  webContents.setWindowOpenHandler(createWindowOpenHandler(openExternal));
  webContents.on('will-navigate', (event, url) => {
    if (isSameOriginUrl(url, appOrigin)) return;
    event.preventDefault();
    if (isAllowedExternalUrl(url) && typeof openExternal === 'function') {
      Promise.resolve(openExternal(url)).catch(() => {});
    }
  });
}

module.exports = {
  ALLOWED_EXTERNAL_PREFIX,
  isAllowedExternalUrl,
  createWindowOpenHandler,
  attachExternalLinkHandlers,
};
