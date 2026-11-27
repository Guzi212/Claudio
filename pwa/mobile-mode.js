// 识别手机独立播放模式：手机浏览器 / PWA 独立窗自动走本地播放，不遥控电脑端。
// 电脑 Electron 始终返回 false；支持 URL 参数 ?mode=standalone / ?mode=remote 显式覆盖。
export function detectStandaloneMobile(win = globalThis.window) {
  if (!win || win?.claudioDesktop?.isDesktop) return false;
  try {
    const mode = new URLSearchParams(win.location?.search || '').get('mode')?.trim().toLowerCase();
    if (mode === 'standalone') return true;
    if (mode === 'remote') return false;
  } catch { /* ignore */ }
  const ua = String(win.navigator?.userAgent || '');
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
  try {
    const coarse = Boolean(win.matchMedia?.('(pointer: coarse)')?.matches);
    if (coarse && Number(win.innerWidth) > 0 && Number(win.innerWidth) <= 900) return true;
  } catch { /* ignore */ }
  return false;
}
