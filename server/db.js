import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// node:sqlite (Node 22.5+) — 内置，零编译。
// 用 createRequire 引入，绕过 Vite/Vitest 的静态 SSR 解析（它的 Node 内建列表还没收录 sqlite）。
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 测试不触碰用户的播放记录、凭据或仓库内的 state.db。
const DB_PATH = process.env.VITEST
  ? ':memory:'
  : (process.env.CLAUDIO_DB_PATH
    ? path.resolve(process.env.CLAUDIO_DB_PATH)
    : path.resolve(__dirname, '..', 'state.db'));

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

/**
 * 幂等迁移记忆系统表结构：为 plays 补充 quality / agent_id，
 * 标记脏历史并创建 playback_sessions / volume_observations / memory_traits / session_intents。
 */
export function migrateMemorySchema(database) {
  const cols = database.prepare(`PRAGMA table_info(plays)`).all().map(c => c.name);
  const hadQuality = cols.includes('quality');
  const hadAgentId = cols.includes('agent_id');

  database.exec(`
    CREATE TABLE IF NOT EXISTS playback_sessions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      kugou_id       TEXT,
      title          TEXT NOT NULL,
      artist         TEXT NOT NULL DEFAULT '',
      source         TEXT NOT NULL DEFAULT 'manual',
      agent_id       TEXT,
      started_ts     INTEGER NOT NULL,
      ended_ts       INTEGER,
      listened_sec   REAL NOT NULL DEFAULT 0,
      duration_sec   REAL NOT NULL DEFAULT 0,
      outcome        TEXT NOT NULL DEFAULT 'playing' CHECK (outcome IN ('playing', 'completed', 'skipped', 'disliked', 'interrupted')),
      local_hour     INTEGER NOT NULL,
      weekday        INTEGER NOT NULL,
      initial_volume INTEGER,
      final_volume   INTEGER,
      vocal_hint     TEXT NOT NULL DEFAULT 'unknown',
      energy_hint    TEXT NOT NULL DEFAULT 'unknown'
    );

    CREATE TABLE IF NOT EXISTS volume_observations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         INTEGER NOT NULL,
      local_hour INTEGER NOT NULL,
      weekday    INTEGER NOT NULL,
      volume     INTEGER NOT NULL,
      trigger    TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'init', 'adaptive'))
    );

    CREATE TABLE IF NOT EXISTS memory_traits (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT NOT NULL,
      scope       TEXT NOT NULL DEFAULT 'global',
      summary     TEXT NOT NULL,
      evidence    TEXT NOT NULL DEFAULT '',
      confidence  REAL NOT NULL DEFAULT 0.5,
      weight      REAL NOT NULL DEFAULT 1.0,
      source      TEXT NOT NULL DEFAULT 'learned' CHECK (source IN ('learned', 'user', 'imported')),
      status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pinned', 'dismissed')),
      updated_ts  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_intents (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      text       TEXT NOT NULL,
      source     TEXT NOT NULL DEFAULT 'user',
      created_ts INTEGER NOT NULL,
      expires_ts INTEGER NOT NULL,
      cleared_ts INTEGER
    );
  `);

  if (!hadQuality) {
    database.exec(`ALTER TABLE plays ADD COLUMN quality TEXT NOT NULL DEFAULT 'normal'`);
  }
  if (!hadAgentId) {
    database.exec(`ALTER TABLE plays ADD COLUMN agent_id TEXT`);
  }

  // 清洗 AI CLI 错误残留，避免进入近期播放和记忆蒸馏
  database.exec(`UPDATE plays SET quality = 'invalid' WHERE title LIKE 'claude CLI exited%' AND quality != 'invalid'`);

  if (!hadQuality) {
    // 历史排队列无对应真实播放会话，降权为 legacy_queued（保留行但区别于真实播放）
    database.exec(`
      UPDATE plays
      SET quality = 'legacy_queued'
      WHERE quality = 'normal'
        AND source IN ('bot', 'claude')
    `);
  }

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_plays_quality ON plays(quality, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_playback_sessions_started ON playback_sessions(started_ts DESC);
    CREATE INDEX IF NOT EXISTS idx_volume_obs_ts ON volume_observations(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_traits_status ON memory_traits(status, updated_ts DESC);
    CREATE INDEX IF NOT EXISTS idx_session_intents_exp ON session_intents(expires_ts DESC);
  `);
}

migrateMemorySchema(db);

const stmts = {
  insertMessage: db.prepare(`INSERT INTO messages (role, content, ts) VALUES (?, ?, ?)`),
  recentMessages: db.prepare(`SELECT id, role, content, ts FROM messages ORDER BY ts DESC LIMIT ?`),
  insertPlay: db.prepare(`INSERT INTO plays (kugou_id, title, artist, reason, source, quality, agent_id, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  recentPlays: db.prepare(`SELECT id, kugou_id, title, artist, reason, source, quality, agent_id, ts FROM plays WHERE quality != 'invalid' ORDER BY ts DESC LIMIT ?`),
  recentPlaysAll: db.prepare(`SELECT id, kugou_id, title, artist, reason, source, quality, agent_id, ts FROM plays ORDER BY ts DESC LIMIT ?`),
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
  insertSession: db.prepare(`
    INSERT INTO playback_sessions (
      kugou_id, title, artist, source, agent_id, started_ts, duration_sec,
      outcome, local_hour, weekday, initial_volume, vocal_hint, energy_hint
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'playing', ?, ?, ?, ?, ?)
  `),
  getSession: db.prepare(`SELECT * FROM playback_sessions WHERE id = ?`),
  finishSession: db.prepare(`
    UPDATE playback_sessions
    SET ended_ts = ?,
        listened_sec = MAX(listened_sec, ?),
        duration_sec = CASE WHEN ? > 0 THEN ? ELSE duration_sec END,
        outcome = ?,
        final_volume = COALESCE(?, final_volume)
    WHERE id = ?
  `),
  recentSessions: db.prepare(`SELECT * FROM playback_sessions WHERE started_ts >= ? ORDER BY started_ts DESC LIMIT ?`),
  insertVolumeObs: db.prepare(`INSERT INTO volume_observations (ts, local_hour, weekday, volume, trigger) VALUES (?, ?, ?, ?, ?)`),
  recentVolumeObs: db.prepare(`SELECT * FROM volume_observations WHERE ts >= ? ORDER BY ts DESC LIMIT ?`),
  listTraitsActive: db.prepare(`
    SELECT * FROM memory_traits
    WHERE status != 'dismissed'
    ORDER BY CASE status WHEN 'pinned' THEN 0 ELSE 1 END, confidence DESC, updated_ts DESC
  `),
  listTraitsAll: db.prepare(`
    SELECT * FROM memory_traits
    ORDER BY CASE status WHEN 'pinned' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, confidence DESC, updated_ts DESC
  `),
  getTrait: db.prepare(`SELECT * FROM memory_traits WHERE id = ?`),
  findLearnedTrait: db.prepare(`SELECT * FROM memory_traits WHERE source = 'learned' AND kind = ? AND scope = ? ORDER BY id DESC LIMIT 1`),
  insertTrait: db.prepare(`
    INSERT INTO memory_traits (kind, scope, summary, evidence, confidence, weight, source, status, updated_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateLearnedTrait: db.prepare(`
    UPDATE memory_traits
    SET summary = ?, evidence = ?, confidence = ?, weight = ?, updated_ts = ?
    WHERE id = ?
  `),
  deleteTrait: db.prepare(`DELETE FROM memory_traits WHERE id = ?`),
  getActiveIntent: db.prepare(`SELECT * FROM session_intents WHERE cleared_ts IS NULL AND expires_ts > ? ORDER BY created_ts DESC LIMIT 1`),
  clearActiveIntents: db.prepare(`UPDATE session_intents SET cleared_ts = ? WHERE cleared_ts IS NULL`),
  insertIntent: db.prepare(`INSERT INTO session_intents (text, source, created_ts, expires_ts) VALUES (?, ?, ?, ?)`),
};

export const dbApi = {
  addMessage(role, content) {
    return stmts.insertMessage.run(role, content, Date.now()).lastInsertRowid;
  },

  recentMessages(n = 20) {
    return stmts.recentMessages.all(n).reverse();
  },

  addPlay({ kugouId = null, title, artist, reason = null, source = 'claude', quality = 'normal', agentId = null }) {
    const cleanTitle = String(title || '');
    const effectiveQuality = /^claude CLI exited/i.test(cleanTitle) ? 'invalid' : quality;
    return stmts.insertPlay.run(kugouId, title, artist, reason, source, effectiveQuality, agentId, Date.now()).lastInsertRowid;
  },

  recentPlays(n = 20, { includeInvalid = false } = {}) {
    return includeInvalid ? stmts.recentPlaysAll.all(n) : stmts.recentPlays.all(n);
  },

  startPlaybackSession({
    kugouId = null,
    title,
    artist = '',
    source = 'manual',
    agentId = null,
    startedTs = Date.now(),
    durationSec = 0,
    localHour,
    weekday,
    initialVolume = null,
    vocalHint = 'unknown',
    energyHint = 'unknown',
  }) {
    const d = new Date(startedTs);
    const hour = Number.isFinite(localHour) ? localHour : d.getHours();
    const day = Number.isFinite(weekday) ? weekday : d.getDay();
    return Number(stmts.insertSession.run(
      kugouId,
      String(title || ''),
      String(artist || ''),
      source,
      agentId,
      startedTs,
      Math.max(0, Number(durationSec) || 0),
      hour,
      day,
      initialVolume == null ? null : Math.round(Number(initialVolume)),
      vocalHint,
      energyHint,
    ).lastInsertRowid);
  },

  getPlaybackSession(id) {
    return stmts.getSession.get(id) || null;
  },

  finishPlaybackSession(id, {
    endedTs = Date.now(),
    listenedSec = 0,
    durationSec = 0,
    outcome = 'completed',
    finalVolume = null,
  } = {}) {
    const dur = Math.max(0, Number(durationSec) || 0);
    const listened = Math.max(0, Number(listenedSec) || 0);
    const vol = finalVolume == null ? null : Math.round(Number(finalVolume));
    stmts.finishSession.run(endedTs, listened, dur, dur, outcome, vol, id);
    return stmts.getSession.get(id) || null;
  },

  recentPlaybackSessions({ sinceTs = 0, limit = 500 } = {}) {
    return stmts.recentSessions.all(sinceTs, limit);
  },

  addVolumeObservation({ ts = Date.now(), localHour, weekday, volume, trigger = 'manual' }) {
    const d = new Date(ts);
    const hour = Number.isFinite(localHour) ? localHour : d.getHours();
    const day = Number.isFinite(weekday) ? weekday : d.getDay();
    const vol = Math.max(0, Math.min(100, Math.round(Number(volume))));
    return Number(stmts.insertVolumeObs.run(ts, hour, day, vol, trigger).lastInsertRowid);
  },

  recentVolumeObservations({ sinceTs = 0, limit = 500 } = {}) {
    return stmts.recentVolumeObs.all(sinceTs, limit);
  },

  listMemoryTraits({ includeDismissed = false } = {}) {
    return includeDismissed ? stmts.listTraitsAll.all() : stmts.listTraitsActive.all();
  },

  getMemoryTrait(id) {
    return stmts.getTrait.get(id) || null;
  },

  upsertMemoryTrait({
    kind,
    scope = 'global',
    summary,
    evidence = '',
    confidence = 0.5,
    weight = 1.0,
    source = 'learned',
    status = 'active',
    updatedTs = Date.now(),
  }) {
    if (source === 'learned') {
      const existing = stmts.findLearnedTrait.get(kind, scope);
      if (existing) {
        if (existing.status === 'dismissed' || existing.status === 'pinned') {
          return existing;
        }
        stmts.updateLearnedTrait.run(
          summary,
          evidence,
          Number(confidence),
          Number(weight),
          updatedTs,
          existing.id,
        );
        return stmts.getTrait.get(existing.id);
      }
    }
    const id = Number(stmts.insertTrait.run(
      kind,
      scope,
      summary,
      evidence,
      Number(confidence),
      Number(weight),
      source,
      status,
      updatedTs,
    ).lastInsertRowid);
    return stmts.getTrait.get(id);
  },

  patchMemoryTrait(id, patch = {}) {
    const existing = stmts.getTrait.get(id);
    if (!existing) return null;
    const nextSummary = typeof patch.summary === 'string' && patch.summary.trim()
      ? patch.summary.trim()
      : existing.summary;
    const nextStatus = ['active', 'pinned', 'dismissed'].includes(patch.status)
      ? patch.status
      : existing.status;
    const nextWeight = Number.isFinite(Number(patch.weight)) ? Number(patch.weight) : existing.weight;
    const nextConf = Number.isFinite(Number(patch.confidence)) ? Number(patch.confidence) : existing.confidence;
    const nextEvidence = typeof patch.evidence === 'string' ? patch.evidence : existing.evidence;
    db.prepare(`
      UPDATE memory_traits
      SET summary = ?, status = ?, weight = ?, confidence = ?, evidence = ?, updated_ts = ?
      WHERE id = ?
    `).run(nextSummary, nextStatus, nextWeight, nextConf, nextEvidence, Date.now(), id);
    return stmts.getTrait.get(id);
  },

  deleteMemoryTrait(id) {
    return stmts.deleteTrait.run(id).changes > 0;
  },

  getActiveSessionIntent({ now = Date.now() } = {}) {
    return stmts.getActiveIntent.get(now) || null;
  },

  setSessionIntent({ text, source = 'user', ttlMinutes = 120, now = Date.now() }) {
    const clean = String(text || '').trim();
    if (!clean) return null;
    const expiresTs = now + Math.max(5, Number(ttlMinutes) || 120) * 60_000;
    stmts.clearActiveIntents.run(now);
    const id = Number(stmts.insertIntent.run(clean, source, now, expiresTs).lastInsertRowid);
    return db.prepare(`SELECT * FROM session_intents WHERE id = ?`).get(id) || null;
  },

  clearSessionIntent({ now = Date.now() } = {}) {
    return stmts.clearActiveIntents.run(now).changes;
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
