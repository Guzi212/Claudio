import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

// 当前听众要求：主持人临时写的「现在想听什么」，盖过长期品味。
// 用文件 mtime 判新鲜度，超过 TTL 就当没写过，避免昨天的要求今天还在生效。
const SESSION_NOTE_FILE = 'user/session-note.md';
const SESSION_NOTE_TTL_MS = 6 * 3_600_000;

export function readSessionNote({ rootDir = ROOT, now = Date.now() } = {}) {
  const full = path.join(rootDir, SESSION_NOTE_FILE);
  let stat;
  let raw;
  try {
    stat = fs.statSync(full);
    raw = fs.readFileSync(full, 'utf8');
  } catch {
    return null;
  }
  const ageMs = now - stat.mtimeMs;
  if (ageMs > SESSION_NOTE_TTL_MS) return null;
  const text = raw
    .split('\n')
    .filter(line => !line.trim().startsWith('<!--') && !line.trim().endsWith('-->'))
    .join('\n')
    .trim();
  if (!text) return null;
  return { text, ageMinutes: Math.max(0, Math.round(ageMs / 60000)) };
}

export function writeSessionNote({ rootDir = ROOT, text, now = Date.now() } = {}) {
  const clean = String(text || '').trim().slice(0, 300);
  if (!clean) {
    clearSessionNote({ rootDir });
    return null;
  }
  const full = path.join(rootDir, SESSION_NOTE_FILE);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `${clean}\n`, 'utf8');
  const sec = now / 1000;
  try { fs.utimesSync(full, sec, sec); } catch { /* ignore */ }
  return { text: clean, ageMinutes: 0 };
}

export function clearSessionNote({ rootDir = ROOT } = {}) {
  const full = path.join(rootDir, SESSION_NOTE_FILE);
  try {
    fs.unlinkSync(full);
    return true;
  } catch {
    return false;
  }
}
