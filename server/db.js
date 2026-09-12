import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { encrypt, decrypt, isEncrypted } from './util/secret-box.js';

// node:sqlite (Node 22.5+) — 内置，零编译。
// 用 createRequire 引入，绕过 Vite/Vitest 的静态 SSR 解析（它的 Node 内建列表还没收录 sqlite）。
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '..', 'state.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    role    TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    ts      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS plays (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    kugou_id  TEXT,
    title     TEXT NOT NULL,
    artist    TEXT NOT NULL,
    reason    TEXT,
    source    TEXT NOT NULL DEFAULT 'claude' CHECK (source IN ('claude', 'manual', 'search')),
    ts        INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS prefs (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS unmatched (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    title  TEXT NOT NULL,
    artist TEXT NOT NULL,
    hint   TEXT,
    ts     INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_plays_ts ON plays(ts DESC);
`);

// 需要在 state.db 里加密落盘的敏感 pref（API Key / cookie）。
// 加解密统一收口在 db 层，调用方读到的仍是明文，无需改动各业务代码。
const ENCRYPTED_PREF_KEYS = new Set([
  'openweather_api_key',
  'fish_api_key',
  'deepseek_api_key',
  'kugou_cookie',
]);

function needsEncryption(key) {
  return ENCRYPTED_PREF_KEYS.has(key);
}

const stmts = {
  insertMessage: db.prepare(`INSERT INTO messages (role, content, ts) VALUES (?, ?, ?)`),
  recentMessages: db.prepare(`SELECT id, role, content, ts FROM messages ORDER BY ts DESC LIMIT ?`),
  insertPlay: db.prepare(`INSERT INTO plays (kugou_id, title, artist, reason, source, ts) VALUES (?, ?, ?, ?, ?, ?)`),
  recentPlays: db.prepare(`SELECT id, kugou_id, title, artist, reason, source, ts FROM plays ORDER BY ts DESC LIMIT ?`),
  getPref: db.prepare(`SELECT value FROM prefs WHERE key = ?`),
  setPref: db.prepare(`INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
  delPref: db.prepare(`DELETE FROM prefs WHERE key = ?`),
  insertUnmatched: db.prepare(`INSERT INTO unmatched (title, artist, hint, ts) VALUES (?, ?, ?, ?)`),
  recentUnmatched: db.prepare(`SELECT id, title, artist, hint, ts FROM unmatched ORDER BY ts DESC LIMIT ?`),
};

export const dbApi = {
  addMessage(role, content) {
    return stmts.insertMessage.run(role, content, Date.now()).lastInsertRowid;
  },

  recentMessages(n = 20) {
    return stmts.recentMessages.all(n).reverse();
  },

  addPlay({ kugouId = null, title, artist, reason = null, source = 'claude' }) {
    return stmts.insertPlay.run(kugouId, title, artist, reason, source, Date.now()).lastInsertRowid;
  },

  recentPlays(n = 20) {
    return stmts.recentPlays.all(n);
  },

  getPref(key) {
    const row = stmts.getPref.get(key);
    if (!row) return null;
    const value = row.value;
    if (value == null || value === '') return value ?? null;

    if (!needsEncryption(key)) return value;
    if (isEncrypted(value)) {
      try {
        return decrypt(value);
      } catch {
        console.warn(`[db] 无法解密 prefs.${key}（可能换了机器或指纹变化），按未配置处理，请在设置里重新填写`);
        return '';
      }
    }
    // 历史明文 → 首次读取时就地迁移为密文（一次性迁移）。
    try {
      stmts.setPref.run(key, encrypt(value));
    } catch {
      // 迁移失败不阻断读取，下次再试。
    }
    return value;
  },

  setPref(key, value) {
    const v = value == null ? null : String(value);
    if (v == null || v === '') {
      stmts.setPref.run(key, v);
      return;
    }
    stmts.setPref.run(key, needsEncryption(key) ? encrypt(v) : v);
  },

  delPref(key) {
    stmts.delPref.run(key);
  },

  addUnmatched({ title, artist, hint = null }) {
    return stmts.insertUnmatched.run(title, artist, hint, Date.now()).lastInsertRowid;
  },

  recentUnmatched(n = 50) {
    return stmts.recentUnmatched.all(n);
  },

  raw: db,
};

export default dbApi;
