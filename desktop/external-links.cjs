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

function resolveLinkAction(url, { appOrigin = '', allowSameOrigin = false } = {}) {
  if (allowSameOrigin && isSameOriginUrl(url, appOrigin)) return 'allow';
  if (isAllowedExternalUrl(url)) return 'open-external';
  return 'deny';
}

function handleExternalLink(url, { openExternal, appOrigin = '', allowSameOrigin = false, event = null } = {}) {
  const action = resolveLinkAction(url, { appOrigin, allowSameOrigin });
  if (action === 'allow') return action;
  event?.preventDefault?.();
  if (action === 'open-external' && typeof openExternal === 'function') {
    Promise.resolve(openExternal(url)).catch(() => {});
  }
  return action;
}

function createWindowOpenHandler(openExternal) {
  return ({ url } = {}) => {
    handleExternalLink(url, { openExternal, allowSameOrigin: false });
    return { action: 'deny' };
  };
}

function attachExternalLinkHandlers(webContents, { openExternal, appOrigin = '' } = {}) {
  if (!webContents) return;
  webContents.setWindowOpenHandler(createWindowOpenHandler(openExternal));
  webContents.on('will-navigate', (event, url) => {
    const targetUrl = typeof event?.url === 'string' ? event.url : url;
    handleExternalLink(targetUrl, { openExternal, appOrigin, allowSameOrigin: true, event });
  });
  webContents.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
    const mainFrame = typeof event?.isMainFrame === 'boolean'
      ? event.isMainFrame
      : Boolean(isMainFrame);
    if (!mainFrame) return;
    const targetUrl = typeof event?.url === 'string' ? event.url : url;
    handleExternalLink(targetUrl, { openExternal, appOrigin, allowSameOrigin: true, event });
  });
}

module.exports = {
  ALLOWED_EXTERNAL_PREFIX,
  isAllowedExternalUrl,
  resolveLinkAction,
  createWindowOpenHandler,
  attachExternalLinkHandlers,
};
