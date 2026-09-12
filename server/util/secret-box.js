// 本地凭据加密（AES-256-GCM）。
//
// 目标：state.db 被离线拷走后，单独读库拿不到 API Key / 酷狗 cookie 明文。
// 密钥由「本机指纹」派生（machine-id 或 hostname+用户名+平台+架构），不落盘、无需额外配置。
//
// 注意：指纹变化（换机器 / 改主机名）会导致解密失败。此时读取方按「未配置」处理，
// 用户重新在设置里填一次即可；旧明文值会被就地迁移为密文。
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';

const FORMAT_PREFIX = 'enc:v1:';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const KDF_SALT = 'claudio-secret-box:v1';

function readFirstExisting(paths) {
  for (const p of paths) {
    try {
      const text = fs.readFileSync(p, 'utf8').trim();
      if (text) return text;
    } catch {
      // 文件不存在 / 不可读 → 尝试下一个
    }
  }
  return '';
}

function machineFingerprint() {
  const parts = [];
  // Linux / 容器常见 machine-id
  const machineId = readFirstExisting(['/etc/machine-id', '/var/lib/dbus/machine-id']);
  if (machineId) parts.push(machineId);

  const override = String(process.env.CLAUDIO_SECRET_SALT || '').trim();
  if (override) parts.push(override);

  try {
    parts.push(os.hostname());
  } catch { /* ignore */ }
  try {
    parts.push(os.userInfo().username);
  } catch { /* ignore */ }
  parts.push(process.platform, process.arch);

  if (parts.length === 0) parts.push('claudio-fallback');
  return parts.join('|');
}

let cachedKey = null;
function deriveKey() {
  if (!cachedKey) {
    cachedKey = crypto.scryptSync(machineFingerprint(), KDF_SALT, KEY_BYTES);
  }
  return cachedKey;
}

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(FORMAT_PREFIX);
}

export function encrypt(plaintext) {
  if (plaintext == null) return plaintext;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, tag, ciphertext]).toString('base64');
  return FORMAT_PREFIX + packed;
}

// 非密文原样返回（兼容历史明文）；密文解密失败会抛错，由调用方决定如何处理。
export function decrypt(value) {
  if (value == null) return value;
  if (!isEncrypted(value)) return value;
  const packed = Buffer.from(value.slice(FORMAT_PREFIX.length), 'base64');
  const iv = packed.subarray(0, IV_BYTES);
  const tag = packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = packed.subarray(IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export { FORMAT_PREFIX };
export default { encrypt, decrypt, isEncrypted, FORMAT_PREFIX };
