import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { dbApi, migratePlaySources } from '../server/db.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

describe('plays.source', () => {
  it('接受外部 bot', () => {
    const id = Number(dbApi.addPlay({
      kugouId: 'hash-bot',
      title: '外部测试曲',
      artist: '测试',
      reason: 'external',
      source: 'bot',
    }));
    const row = dbApi.recentPlays(20).find(item => Number(item.id) === id);
    expect(row?.source).toBe('bot');
  });

  it('旧库的 CHECK 会迁移到包含 bot', () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE plays (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kugou_id TEXT,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        reason TEXT,
        source TEXT NOT NULL DEFAULT 'claude' CHECK (source IN ('claude', 'manual', 'search')),
        ts INTEGER NOT NULL
      );
    `);
    database.prepare(`INSERT INTO plays (kugou_id, title, artist, reason, source, ts) VALUES (?, ?, ?, ?, ?, ?)`).run('h', '旧', '人', null, 'claude', 1);

    migratePlaySources(database);

    expect(() => {
      database.prepare(`INSERT INTO plays (kugou_id, title, artist, reason, source, ts) VALUES (?, ?, ?, ?, ?, ?)`).run('h2', '新', '人', null, 'bot', 2);
    }).not.toThrow();
    const rows = database.prepare(`SELECT source FROM plays ORDER BY id`).all();
    expect(rows.map(row => row.source)).toEqual(['claude', 'bot']);
  });
});
