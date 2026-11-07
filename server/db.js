import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// node:sqlite (Node 22.5+) — 内置，零编译。
// 用 createRequire 引入，绕过 Vite/Vitest 的静态 SSR 解析（它的 Node 内建列表还没收录 sqlite）。
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 测试不触碰用户的播放记录、凭据或仓库内的 state.db。
const DB_PATH = process.env.VITEST ? ':memory:' : path.resolve(__dirname, '..', 'state.db');

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
    source    TEXT NOT NULL DEFAULT 'claude' CHECK (source IN ('claude', 'manual', 'search', 'boot', 'bot')),
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

  CREATE TABLE IF NOT EXISTS feedback (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    kind      TEXT NOT NULL,
    kugou_id  TEXT,
    title     TEXT,
    artist    TEXT,
    ts        INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS like_pending (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    kugou_id        TEXT NOT NULL,
    title           TEXT NOT NULL,
    artist          TEXT NOT NULL DEFAULT '',
    album           TEXT NOT NULL DEFAULT '',
    album_id        TEXT NOT NULL DEFAULT '',
    mixsongid       TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'skipped')),
    target_playlist TEXT,
    target_listid   TEXT,
    note            TEXT,
    created_ts      INTEGER NOT NULL,
    resolved_ts     INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_plays_ts ON plays(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_feedback_ts ON feedback(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_like_pending_status ON like_pending(status, created_ts DESC);
`);

// 已有库的 plays.source 约束是建表时写死的。CREATE TABLE IF NOT EXISTS 不会改它，
// 所以这里发现旧约束里没有 bot 时重建表。boot 是 /api/boot 早就在写的值。
export function migratePlaySources(database) {
  const row = database.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'plays'`).get();
  const sql = row?.sql || '';
  if (sql.includes("'bot'")) return;

  database.exec('DROP TABLE IF EXISTS plays_migrated');
  database.exec('BEGIN');
  try {
    database.exec(`
      CREATE TABLE plays_migrated (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        kugou_id  TEXT,
        title     TEXT NOT NULL,
        artist    TEXT NOT NULL,
        reason    TEXT,
        source    TEXT NOT NULL DEFAULT 'claude' CHECK (source IN ('claude', 'manual', 'search', 'boot', 'bot')),
        ts        INTEGER NOT NULL
      );
      INSERT INTO plays_migrated (id, kugou_id, title, artist, reason, source, ts)
        SELECT id, kugou_id, title, artist, reason,
          CASE
            WHEN source IN ('claude', 'manual', 'search', 'boot', 'bot') THEN source
            ELSE 'manual'
          END,
          ts
        FROM plays;
      DROP TABLE plays;
      ALTER TABLE plays_migrated RENAME TO plays;
      CREATE INDEX IF NOT EXISTS idx_plays_ts ON plays(ts DESC);
    `);
    database.exec('COMMIT');
  } catch (err) {
    try { database.exec('ROLLBACK'); } catch { /* already closed */ }
    throw err;
  }
}

migratePlaySources(db);

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
  insertFeedback: db.prepare(`INSERT INTO feedback (kind, kugou_id, title, artist, ts) VALUES (?, ?, ?, ?, ?)`),
  recentFeedback: db.prepare(`SELECT id, kind, kugou_id, title, artist, ts FROM feedback ORDER BY ts DESC LIMIT ?`),
  insertLikePending: db.prepare(`INSERT INTO like_pending (kugou_id, title, artist, album, album_id, mixsongid, created_ts) VALUES (?, ?, ?, ?, ?, ?, ?)`),
  findPendingLike: db.prepare(`SELECT id FROM like_pending WHERE kugou_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`),
  pendingLikes: db.prepare(`SELECT * FROM like_pending WHERE status = 'pending' ORDER BY created_ts ASC, id ASC LIMIT ?`),
  getLikePending: db.prepare(`SELECT * FROM like_pending WHERE id = ?`),
  resolveLikePending: db.prepare(`UPDATE like_pending SET status = 'done', target_playlist = ?, target_listid = ?, resolved_ts = ? WHERE id = ? AND status = 'pending'`),
  skipLikePending: db.prepare(`UPDATE like_pending SET status = 'skipped', note = ?, resolved_ts = ? WHERE id = ? AND status = 'pending'`),
  cancelLikePendingByHash: db.prepare(`UPDATE like_pending SET status = 'skipped', note = 'unliked', resolved_ts = ? WHERE kugou_id = ? AND status = 'pending'`),
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
    return row ? row.value : null;
  },

  setPref(key, value) {
    stmts.setPref.run(key, value == null ? null : String(value));
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

  addFeedback({ kind, kugouId = null, title = '', artist = '' }) {
    return stmts.insertFeedback.run(kind, kugouId, title || '', artist || '', Date.now()).lastInsertRowid;
  },

  recentFeedback(n = 20) {
    return stmts.recentFeedback.all(n);
  },

  addLikePending({ kugouId, title, artist = '', album = '', albumId = '', mixsongid = '' }) {
    const existing = stmts.findPendingLike.get(kugouId);
    if (existing) return Number(existing.id);
    return Number(stmts.insertLikePending.run(
      kugouId, title, artist || '', album || '', albumId || '', mixsongid || '', Date.now(),
    ).lastInsertRowid);
  },

  pendingLikes(n = 100) {
    return stmts.pendingLikes.all(n);
  },

  getLikePending(id) {
    return stmts.getLikePending.get(id) || null;
  },

  resolveLikePending(id, { targetPlaylist = '', targetListid = '' } = {}) {
    stmts.resolveLikePending.run(targetPlaylist || '', targetListid || '', Date.now(), id);
  },

  skipLikePending(id, { note = '' } = {}) {
    stmts.skipLikePending.run(note || '', Date.now(), id);
  },

  cancelLikePendingByHash(kugouId) {
    stmts.cancelLikePendingByHash.run(Date.now(), kugouId);
  },

  raw: db,
};

export default dbApi;
