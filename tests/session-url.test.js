import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { urlWithoutToken } from '../pwa/session-url.js';

describe('urlWithoutToken', () => {
  it('去掉 token，保留路径、其它参数和 hash', () => {
    expect(urlWithoutToken('http://127.0.0.1:8080/?token=secret&view=player')).toBe('/?view=player');
    expect(urlWithoutToken('http://127.0.0.1:8080/?view=player&token=secret')).toBe('/?view=player');
    expect(urlWithoutToken('http://127.0.0.1:8080/?token=secret')).toBe('/');
    expect(urlWithoutToken('http://127.0.0.1:8080/index.html?view=settings#x')).toBe('/index.html?view=settings#x');
    expect(urlWithoutToken('http://127.0.0.1:8080/?token=secret#top')).toBe('/#top');
  });
});

describe('PWA 换 cookie', () => {
  const appJs = fs.readFileSync(new URL('../pwa/app.js', import.meta.url), 'utf8');
  const sw = fs.readFileSync(new URL('../pwa/sw.js', import.meta.url), 'utf8');

  it('先换会话再拉播放器和 WebSocket，页面里不写密钥', () => {
    expect(appJs.indexOf('await adoptUrlToken()')).toBeGreaterThan(-1);
    expect(appJs.indexOf('await adoptUrlToken()')).toBeLessThan(appJs.indexOf('initPlayer()'));
    expect(appJs.indexOf('await adoptUrlToken()')).toBeLessThan(appJs.indexOf('connectWs()'));
    expect(appJs).toContain("credentials: 'same-origin'");
    expect(appJs).toContain('urlWithoutToken');
    expect(appJs).not.toContain('localStorage');
    expect(appJs).not.toContain('CLAUDIO_API_TOKEN');
  });

  it('service worker 不把 ?token= 写进缓存', () => {
    expect(sw).toContain("const CACHE = 'claudio-shell-v10'");
    expect(sw).toContain("url.searchParams.has('token')");
    expect(sw).toContain('/session-url.js');
  });
});
