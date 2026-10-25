import { describe, expect, it } from 'vitest';
import { resolveListenHost } from '../server/listen.js';

describe('resolveListenHost', () => {
  it('默认 127.0.0.1', () => {
    expect(resolveListenHost({})).toBe('127.0.0.1');
    expect(resolveListenHost({ CLAUDIO_HOST: '' })).toBe('127.0.0.1');
    expect(resolveListenHost({ CLAUDIO_HOST: '   ' })).toBe('127.0.0.1');
  });

  it('CLAUDIO_HOST 可以放开监听', () => {
    expect(resolveListenHost({ CLAUDIO_HOST: '0.0.0.0' })).toBe('0.0.0.0');
    expect(resolveListenHost({ CLAUDIO_HOST: ' 192.168.1.5 ' })).toBe('192.168.1.5');
  });
});
