import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { inferTrackFeatures, isValidLearnTrack } from '../server/memory/track-features.js';
import { getContextSuggestion, syncLearnedTraits } from '../server/memory/learner.js';
import { migrateMemorySchema, dbApi } from '../server/db.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

function tsAtHour(daysAgo, hour, minute = 10, weekdayOverride = null) {
  const d = new Date('2026-11-12T12:00:00+08:00');
  d.setDate(d.getDate() - daysAgo);
  if (weekdayOverride != null) {
    while (d.getDay() !== weekdayOverride) d.setDate(d.getDate() - 1);
  }
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

describe('memory · track-features', () => {
  it('剔除 CLI 错误残留与音频文件名', () => {
    expect(isValidLearnTrack({ title: 'claude CLI exited with status 1' })).toBe(false);
    expect(isValidLearnTrack({ title: '说散就散.mp3' })).toBe(false);
    expect(isValidLearnTrack({ title: '晴天', quality: 'invalid' })).toBe(false);
    expect(isValidLearnTrack({ title: '晴天', quality: 'normal' })).toBe(true);
  });

  it('从标题/理由/歌词推断纯音乐与人声能量特征', () => {
    const f1 = inferTrackFeatures({ title: 'Merry Christmas Mr. Lawrence', artist: '坂本龙一', reason: '清晨安静钢琴纯音乐' });
    expect(f1.vocal).toBe('instrumental');
    expect(f1.energy).toBe('calm');

    const lyric = '[00:01.00]第一行歌词\n[00:05.00]第二行歌词\n[00:10.00]第三行歌词\n[00:15.00]第四行歌词';
    const f2 = inferTrackFeatures({ title: '奔跑', artist: '羽泉', reason: '流行节奏轻快活力', lyric });
    expect(f2.vocal).toBe('vocal');
    expect(f2.energy).toBe('energetic');
  });
});

describe('memory · dynamic learner (零硬编码时段)', () => {
  const NOW = new Date('2026-11-12T11:30:00+08:00').getTime();

  it('无数据冷启动时不强行给出音量或时段规则', () => {
    const sug = getContextSuggestion({ sessions: [], volumeObs: [], feedback: [], now: NOW });
    expect(sug.coldStart).toBe(true);
    expect(sug.confidence).toBeLessThan(0.3);
    expect(sug.suggestedVolume).toBeNull();
    expect(sug.vocalPreference).toBe('neutral');
    expect(sug.energyTarget).toBe('neutral');
  });

  it('同一算法完全按真实行为学出不同用户的不同作息偏好（无全局固定时间表）', () => {
    // 用户 A：08:00 听轻柔纯音乐音量 ~24；11:30 听人声流行音量 ~55
    const sessionsA = [
      { title: '钢琴曲1', artist: '坂本龙一', source: 'manual', started_ts: tsAtHour(1, 8, 10), local_hour: 8, weekday: 3, listened_sec: 220, duration_sec: 220, outcome: 'completed', vocal_hint: 'instrumental', energy_hint: 'calm' },
      { title: '钢琴曲2', artist: '久石让', source: 'bot', started_ts: tsAtHour(2, 8, 20), local_hour: 8, weekday: 2, listened_sec: 200, duration_sec: 210, outcome: 'completed', vocal_hint: 'instrumental', energy_hint: 'calm' },
      { title: '摇滚快歌', artist: '某乐队', source: 'bot', started_ts: tsAtHour(1, 8, 25), local_hour: 8, weekday: 3, listened_sec: 10, duration_sec: 240, outcome: 'skipped', vocal_hint: 'vocal', energy_hint: 'energetic' },
      { title: '晴天', artist: '周杰伦', source: 'manual', started_ts: tsAtHour(1, 11, 20), local_hour: 11, weekday: 3, listened_sec: 250, duration_sec: 260, outcome: 'completed', vocal_hint: 'vocal', energy_hint: 'energetic' },
      { title: '爱在西元前', artist: '周杰伦', source: 'bot', started_ts: tsAtHour(2, 11, 40), local_hour: 11, weekday: 2, listened_sec: 210, duration_sec: 220, outcome: 'completed', vocal_hint: 'vocal', energy_hint: 'energetic' },
    ];
    const volumesA = [
      { ts: tsAtHour(1, 8, 5), local_hour: 8, weekday: 3, volume: 22, trigger: 'manual' },
      { ts: tsAtHour(2, 8, 15), local_hour: 8, weekday: 2, volume: 25, trigger: 'manual' },
      { ts: tsAtHour(3, 8, 10), local_hour: 8, weekday: 1, volume: 24, trigger: 'manual' },
      { ts: tsAtHour(1, 11, 25), local_hour: 11, weekday: 3, volume: 54, trigger: 'manual' },
      { ts: tsAtHour(2, 11, 35), local_hour: 11, weekday: 2, volume: 56, trigger: 'manual' },
    ];

    const at8am = getContextSuggestion({ sessions: sessionsA, volumeObs: volumesA, now: tsAtHour(0, 8, 10) });
    expect(at8am.suggestedVolume).toBeGreaterThanOrEqual(20);
    expect(at8am.suggestedVolume).toBeLessThanOrEqual(28);
    expect(at8am.vocalPreference).toBe('prefer_instrumental');
    expect(at8am.energyTarget).toBe('calm');

    const at1130 = getContextSuggestion({ sessions: sessionsA, volumeObs: volumesA, now: tsAtHour(0, 11, 30) });
    expect(at1130.suggestedVolume).toBeGreaterThanOrEqual(50);
    expect(at1130.vocalPreference).toBe('prefer_vocal');
    expect(at1130.energyTarget).toBe('energetic');

    // 用户 B 反转作息：08:00 音量 ~62 听动感人声（证明未写死早上低音量规则）
    const sessionsB = [
      { title: '健身节奏', artist: 'A', source: 'manual', started_ts: tsAtHour(1, 8, 10), local_hour: 8, weekday: 3, listened_sec: 200, duration_sec: 200, outcome: 'completed', vocal_hint: 'vocal', energy_hint: 'energetic' },
      { title: '流行曲', artist: 'B', source: 'manual', started_ts: tsAtHour(2, 8, 15), local_hour: 8, weekday: 2, listened_sec: 190, duration_sec: 195, outcome: 'completed', vocal_hint: 'vocal', energy_hint: 'energetic' },
    ];
    const volumesB = [
      { ts: tsAtHour(1, 8, 10), local_hour: 8, weekday: 3, volume: 62, trigger: 'manual' },
      { ts: tsAtHour(2, 8, 10), local_hour: 8, weekday: 2, volume: 60, trigger: 'manual' },
    ];
    const userBAt8am = getContextSuggestion({ sessions: sessionsB, volumeObs: volumesB, now: tsAtHour(0, 8, 10) });
    expect(userBAt8am.suggestedVolume).toBeGreaterThanOrEqual(58);
    expect(userBAt8am.vocalPreference).toBe('prefer_vocal');
    expect(userBAt8am.energyTarget).toBe('energetic');
  });

  it('受安全上限 safeMaxVolume 限制且保留明确避开列表', () => {
    const volObs = [
      { ts: tsAtHour(1, 14, 0), local_hour: 14, weekday: 3, volume: 78, trigger: 'manual' },
      { ts: tsAtHour(2, 14, 0), local_hour: 14, weekday: 2, volume: 82, trigger: 'manual' },
    ];
    const sug = getContextSuggestion({
      volumeObs: volObs,
      feedback: [{ kind: 'dislike', title: '噪音歌', artist: '踩雷歌手' }],
      now: tsAtHour(0, 14, 0),
      safeMaxVolume: 45,
    });
    expect(sug.suggestedVolume).toBe(45);
    expect(sug.avoided).toContain('踩雷歌手');
  });
});

describe('memory · migration & syncLearnedTraits', () => {
  it('migrateMemorySchema 清洗脏历史但不删行，且建立四张记忆新表', () => {
    const legacy = new DatabaseSync(':memory:');
    legacy.exec(`
      CREATE TABLE plays (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kugou_id TEXT,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        reason TEXT,
        source TEXT NOT NULL DEFAULT 'claude',
        ts INTEGER NOT NULL
      );
      INSERT INTO plays (kugou_id, title, artist, source, ts) VALUES
        (NULL, 'claude CLI exited with status 1', '', 'claude', 1000),
        ('h1', '晴天', '周杰伦', 'bot', 2000),
        ('h2', '手选歌', '陈奕迅', 'manual', 3000);
    `);

    migrateMemorySchema(legacy);
    const rows = legacy.prepare('SELECT id, title, quality FROM plays ORDER BY id ASC').all();
    expect(rows).toHaveLength(3);
    expect(rows[0].quality).toBe('invalid');
    expect(rows[1].quality).toBe('legacy_queued');
    expect(rows[2].quality).toBe('normal');

    const tables = legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
    expect(tables).toEqual(expect.arrayContaining([
      'playback_sessions',
      'volume_observations',
      'memory_traits',
      'session_intents',
    ]));
  });

  it('syncLearnedTraits 尊重用户置顶 (pinned) 与否定 (dismissed) 纠正', () => {
    const tPinned = dbApi.upsertMemoryTrait({
      kind: 'context_slot',
      scope: 'hour:9',
      summary: '09:00 用户锁定的规则',
      source: 'learned',
      status: 'pinned',
    });
    const tDismissed = dbApi.upsertMemoryTrait({
      kind: 'context_slot',
      scope: 'hour:21',
      summary: '21:00 被否认的规则',
      source: 'learned',
      status: 'dismissed',
    });

    const base = tsAtHour(0, 9, 15);
    for (let i = 1; i <= 3; i++) {
      dbApi.addVolumeObservation({ ts: tsAtHour(i, 9, 0), localHour: 9, weekday: 2, volume: 33, trigger: 'manual' });
      dbApi.addVolumeObservation({ ts: tsAtHour(i, 21, 0), localHour: 21, weekday: 2, volume: 28, trigger: 'manual' });
    }

    syncLearnedTraits(dbApi, { now: base });

    const checkPinned = dbApi.getMemoryTrait(tPinned.id);
    const checkDismissed = dbApi.getMemoryTrait(tDismissed.id);
    expect(checkPinned.summary).toBe('09:00 用户锁定的规则');
    expect(checkPinned.status).toBe('pinned');
    expect(checkDismissed.status).toBe('dismissed');
  });
});
