import { describe, expect, it } from 'vitest';
import {
  hostAllowed,
  hostGuard,
  originAllowed,
  parseHostSpec,
} from '../server/host-guard.js';

function res() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

describe('parseHostSpec', () => {
  it('裸 IPv6 不按最后一个冒号切端口', () => {
    expect(parseHostSpec('::1')).toEqual({ host: '::1', port: '' });
    expect(parseHostSpec('[::1]')).toEqual({ host: '::1', port: '' });
    expect(parseHostSpec('[::1]:8080')).toEqual({ host: '::1', port: '8080' });
    expect(parseHostSpec('radio.example.com:8443')).toEqual({ host: 'radio.example.com', port: '8443' });
  });

  it('拒绝十六进制、前导零和缺 Host', () => {
    expect(parseHostSpec('0x7f.0.0.1')).toBeNull();
    expect(parseHostSpec('127.0.0.01')).toBeNull();
    expect(parseHostSpec('')).toBeNull();
    expect(parseHostSpec(undefined)).toBeNull();
  });
});

describe('hostAllowed', () => {
  it('默认放行 localhost、127.0.0.1、[::1]，带不带端口都行', () => {
    for (const host of [
      'localhost',
      'localhost:8080',
      'LocalHost:8080',
      'localhost.',
      '127.0.0.1',
      '127.0.0.1:8080',
      '[::1]',
      '[::1]:8080',
      '::1',
    ]) {
      expect(hostAllowed(host), host).toBe(true);
    }
  });

  it('默认拒绝其它主机，以及看起来像回环的别的写法', () => {
    for (const host of ['evil.com', '192.168.1.20', '0x7f.0.0.1', '127.0.0.01', '2130706433', '127.1']) {
      expect(hostAllowed(host), host).toBe(false);
    }
  });

  it('CLAUDIO_ALLOWED_HOSTS 追加白名单，host:port 只匹配该端口', () => {
    const env = { CLAUDIO_ALLOWED_HOSTS: '192.168.1.20, radio.example.com:8443' };
    expect(hostAllowed('192.168.1.20', env)).toBe(true);
    expect(hostAllowed('192.168.1.20:9090', env)).toBe(true);
    expect(hostAllowed('radio.example.com:8443', env)).toBe(true);
    expect(hostAllowed('Radio.Example.com:8443', env)).toBe(true);
    expect(hostAllowed('radio.example.com', env)).toBe(false);
    expect(hostAllowed('radio.example.com:443', env)).toBe(false);
    expect(hostAllowed('evil.com', env)).toBe(false);
    expect(hostAllowed('localhost:8080', env)).toBe(true);
  });
});

describe('originAllowed', () => {
  it('没有 Origin 放行，null 和非 http(s) 拒绝', () => {
    expect(originAllowed(undefined)).toBe(true);
    expect(originAllowed('')).toBe(true);
    expect(originAllowed('   ')).toBe(true);
    expect(originAllowed('null')).toBe(false);
    expect(originAllowed('http://evil.com')).toBe(false);
    expect(originAllowed('http://127.0.0.1.evil.com')).toBe(false);
    expect(originAllowed('file://localhost')).toBe(false);
    expect(originAllowed('http://127.0.0.1:8080')).toBe(true);
    expect(originAllowed('http://user:pass@127.0.0.1')).toBe(false);
  });

  it('Origin 跟 Host 用同一份额外白名单', () => {
    const env = { CLAUDIO_ALLOWED_HOSTS: 'radio.example.com' };
    expect(originAllowed('https://radio.example.com', env)).toBe(true);
    expect(originAllowed('https://radio.example.com:8443', env)).toBe(true);
    expect(originAllowed('https://evil.com', env)).toBe(false);
  });
});

describe('hostGuard', () => {
  it('不匹配时 403，且不回显 Host', () => {
    const response = res();
    let called = false;
    hostGuard({ headers: { host: 'evil.com' } }, response, () => { called = true; });
    expect(called).toBe(false);
    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({ ok: false, error: 'forbidden host' });
    expect(JSON.stringify(response.body)).not.toContain('evil.com');
  });

  it('默认主机放行', () => {
    let called = false;
    hostGuard({ headers: { host: '127.0.0.1:8080' } }, res(), () => { called = true; });
    expect(called).toBe(true);
  });

  it('缺少 Host 拒绝', () => {
    const response = res();
    hostGuard({ headers: {} }, response, () => {});
    expect(response.statusCode).toBe(403);
  });
});
