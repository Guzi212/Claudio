import { describe, it, expect } from 'vitest';
import {
  hostMatches,
  isPrivateIp,
  assertProxyHost,
  validateProxyUrl,
  isKugouHost,
  assertKugouHost,
  safeLookup,
} from '../server/util/net-guard.js';

describe('hostMatches', () => {
  it('精确匹配与子域匹配', () => {
    expect(hostMatches('kugou.com')).toBe(true);
    expect(hostMatches('t1.kugou.com')).toBe(true);
    expect(hostMatches('a.b.kugou.net')).toBe(true);
  });

  it('拒绝后缀欺骗（evil-kugou.com / kugou.com.evil.com）', () => {
    expect(hostMatches('evil-kugou.com')).toBe(false);
    expect(hostMatches('kugou.com.evil.com')).toBe(false);
    expect(hostMatches('notkugou.com')).toBe(false);
  });

  it('大小写 / 末尾点归一化', () => {
    expect(hostMatches('T1.KUGOU.COM')).toBe(true);
    expect(hostMatches('t1.kugou.com.')).toBe(true);
  });
});

describe('isPrivateIp', () => {
  it('拦内网 / 保留 / 环回', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it('公网放行', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '104.16.0.1', '2001:4860:4860::8888']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it('非法/空值视为不安全', () => {
    expect(isPrivateIp('')).toBe(true);
    expect(isPrivateIp('not-an-ip')).toBe(true);
    expect(isPrivateIp(null)).toBe(true);
  });
});

describe('assertProxyHost', () => {
  it('白名单内放行', () => {
    expect(assertProxyHost('t1.kugou.com')).toBe('t1.kugou.com');
  });

  it('白名单外拒绝', () => {
    expect(() => assertProxyHost('evil.com')).toThrow(/白名单/);
  });

  it('内网 IP 直接拒绝', () => {
    expect(() => assertProxyHost('127.0.0.1')).toThrow(/内网/);
    expect(() => assertProxyHost('192.168.0.1')).toThrow(/内网/);
  });

  it('allowAny 仍不能绕过内网限制', () => {
    expect(() => assertProxyHost('10.0.0.1', { allowAny: true })).toThrow(/内网/);
    expect(assertProxyHost('example.com', { allowAny: true })).toBe('example.com');
  });
});

describe('validateProxyUrl', () => {
  it('拒绝非 http/https 协议', () => {
    expect(() => validateProxyUrl('file:///etc/passwd')).toThrow(/协议/);
    expect(() => validateProxyUrl('javascript:alert(1)')).toThrow(/协议/);
    expect(() => validateProxyUrl('ftp://kugou.com/x')).toThrow(/协议/);
  });

  it('拒绝非法 URL', () => {
    expect(() => validateProxyUrl('not a url')).toThrow(/无效/);
  });

  it('合法酷狗 URL 返回 URL 对象', () => {
    const u = validateProxyUrl('https://t1.kugou.com/song.mp3?x=1');
    expect(u.hostname).toBe('t1.kugou.com');
  });
});

describe('isKugouHost / assertKugouHost', () => {
  it('只认酷狗域名', () => {
    expect(isKugouHost('t1.kugou.com')).toBe(true);
    expect(isKugouHost('kugou.net')).toBe(false); // 分享链接规则更窄
    expect(isKugouHost('evil-kugou.com')).toBe(false);
  });

  it('assertKugouHost 非法时抛错', () => {
    expect(() => assertKugouHost('evil.com')).toThrow(/酷狗域名/);
  });
});

describe('safeLookup', () => {
  it('拦截解析到内网的域名', async () => {
    await new Promise(resolve => {
      safeLookup('localhost', {}, (err, address) => {
        expect(err).toBeTruthy();
        expect(err.code).toBe('ESSRFBLOCKED');
        resolve();
      });
    });
  });

  it('公网地址正常回传', async () => {
    await new Promise(resolve => {
      safeLookup('8.8.8.8', {}, (err, address) => {
        expect(err).toBeFalsy();
        expect(address).toBe('8.8.8.8');
        resolve();
      });
    });
  });
});
