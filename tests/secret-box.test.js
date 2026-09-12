import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, isEncrypted, FORMAT_PREFIX } from '../server/util/secret-box.js';

describe('secret-box', () => {
  it('加密结果带版本前缀，且不含明文', () => {
    const out = encrypt('sk-super-secret');
    expect(out.startsWith(FORMAT_PREFIX)).toBe(true);
    expect(out).not.toContain('sk-super-secret');
    expect(isEncrypted(out)).toBe(true);
  });

  it('加解密可往返（含 unicode）', () => {
    for (const v of ['sk-abc123', '中文密钥🎵', 'a'.repeat(4096)]) {
      expect(decrypt(encrypt(v))).toBe(v);
    }
  });

  it('相同明文两次加密得到不同密文（随机 IV）', () => {
    expect(encrypt('same')).not.toBe(encrypt('same'));
  });

  it('decrypt 对历史明文原样返回（兼容迁移）', () => {
    expect(decrypt('plain-old-value')).toBe('plain-old-value');
  });

  it('null / undefined 原样返回', () => {
    expect(encrypt(null)).toBeNull();
    expect(decrypt(null)).toBeNull();
    expect(encrypt(undefined)).toBeUndefined();
  });

  it('密文被篡改时解密抛错（GCM 认证）', () => {
    const cipher = encrypt('tamper-me');
    const body = cipher.slice(FORMAT_PREFIX.length);
    // 翻转 base64 内容中的一个字符
    const flipped = body.slice(0, 4) + (body[4] === 'A' ? 'B' : 'A') + body.slice(5);
    expect(() => decrypt(FORMAT_PREFIX + flipped)).toThrow();
  });
});
