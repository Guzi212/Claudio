import { describe, expect, it } from 'vitest';
import {
  axiosProxyOptions,
  isLoopbackHostname,
  parseAxiosProxy,
  proxyForTarget,
} from '../server/outbound-proxy.js';

describe('outbound proxy', () => {
  it('回环主机名', () => {
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('127.1.2.3')).toBe(true);
    expect(isLoopbackHostname('::1')).toBe(true);
    expect(isLoopbackHostname('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('cdn.kugou.com')).toBe(false);
    expect(isLoopbackHostname('10.0.0.1')).toBe(false);
  });

  it('不填 KUGOU_PROXY 时外部地址也直连', () => {
    expect(proxyForTarget('https://cdn.kugou.com/a.mp3', {})).toBe(false);
    expect(axiosProxyOptions('http://127.0.0.1:3000/search', {
      KUGOU_PROXY: 'http://127.0.0.1:7890',
    })).toEqual({ proxy: false });
  });

  it('外部地址使用 KUGOU_PROXY，本机地址永远不走', () => {
    const env = { KUGOU_PROXY: 'http://127.0.0.1:7890' };
    expect(proxyForTarget('https://fs.kugou.com/a.mp3', env)).toEqual({
      protocol: 'http',
      host: '127.0.0.1',
      port: 7890,
    });
    expect(proxyForTarget('http://localhost:3000/search', env)).toBe(false);
    expect(proxyForTarget('http://127.0.0.1:3000/song/url', env)).toBe(false);
    expect(proxyForTarget('http://[::1]:3000/user/detail', env)).toBe(false);
  });

  it('解析带认证的代理，拒绝不支持的协议', () => {
    expect(parseAxiosProxy('http://user:p%40ss@127.0.0.1:7890')).toEqual({
      protocol: 'http',
      host: '127.0.0.1',
      port: 7890,
      auth: { username: 'user', password: 'p@ss' },
    });
    expect(parseAxiosProxy('socks5://127.0.0.1:7890')).toBeNull();
    expect(proxyForTarget('https://cdn.kugou.com/a.mp3', { KUGOU_PROXY: 'socks5://127.0.0.1:7890' })).toBe(false);
  });
});
