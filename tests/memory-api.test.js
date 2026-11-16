import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dbApi } from '../server/db.js';
import { mountMemoryRoutes } from '../server/api/memory.js';
import { mountExternalQueueRoutes } from '../server/api/external-queue.js';
import { mountControlRoute } from '../server/api/control.js';

function mockApp() {
  const routes = {};
  return {
    routes,
    get(p, h) { routes[`GET ${p}`] = h; },
    post(p, h) { routes[`POST ${p}`] = h; },
    put(p, h) { routes[`PUT ${p}`] = h; },
    patch(p, h) { routes[`PATCH ${p}`] = h; },
    delete(p, h) { routes[`DELETE ${p}`] = h; },
  };
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}

describe('memory API & 多 Agent 解耦', () => {
  it('支持 CRUD traits、即时意图与上下文画像摘要', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-mem-api-'));
    fs.mkdirSync(path.join(tmpRoot, 'user'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'user', 'taste.local.md'), '# 个人品味\n- 喜欢城市民谣\n', 'utf8');

    const runtime = { queue: [], index: 0, volume: 30, activeAgent: null };
    const broadcast = vi.fn();
    const app = mockApp();
    mountMemoryRoutes(app, { db: dbApi, rootDir: tmpRoot, runtime, broadcast });

    // POST trait
    const createRes = mockRes();
    await app.routes['POST /api/memory/traits']({
      body: { summary: '工作时不要重金属摇滚', kind: 'preference', status: 'pinned' },
    }, createRes);
    expect(createRes.statusCode).toBe(201);
    expect(createRes.body.trait.summary).toBe('工作时不要重金属摇滚');
    const id = createRes.body.trait.id;

    // PATCH trait -> dismissed
    const patchRes = mockRes();
    await app.routes['PATCH /api/memory/traits/:id']({
      params: { id: String(id) },
      body: { status: 'dismissed' },
    }, patchRes);
    expect(patchRes.body.trait.status).toBe('dismissed');

    // POST intent -> GET intent -> GET brief -> DELETE intent
    const intentRes = mockRes();
    await app.routes['POST /api/memory/intent']({ body: { text: '今晚想听安静的木吉他', ttlMinutes: 90 } }, intentRes);
    expect(intentRes.body.ok).toBe(true);
    expect(intentRes.body.intent.text).toBe('今晚想听安静的木吉他');

    const briefRes = mockRes();
    await app.routes['GET /api/memory/brief']({ query: {} }, briefRes);
    expect(briefRes.body.ok).toBe(true);
    expect(briefRes.body.activeIntent.text).toBe('今晚想听安静的木吉他');
    expect(briefRes.body.tasteSummary.handWrittenLength).toBeGreaterThan(5);

    const delIntentRes = mockRes();
    await app.routes['DELETE /api/memory/intent']({}, delIntentRes);
    expect(delIntentRes.body.ok).toBe(true);

    const delTraitRes = mockRes();
    await app.routes['DELETE /api/memory/traits/:id']({ params: { id: String(id) } }, delTraitRes);
    expect(delTraitRes.body.ok).toBe(true);
  });

  it('POST /api/memory/telemetry 采集播放会话、音量与点踩事件', async () => {
    const app = mockApp();
    mountMemoryRoutes(app, { db: dbApi, rootDir: process.cwd(), runtime: {} });

    const startRes = mockRes();
    await app.routes['POST /api/memory/telemetry']({
      body: {
        event: 'session_start',
        kugouId: 'k-mem-1',
        title: 'Gymnopédie No.1',
        artist: 'Erik Satie',
        reason: '钢琴纯音乐放松',
        durationSec: 185,
        initialVolume: 26,
      },
    }, startRes);
    expect(startRes.body.ok).toBe(true);
    expect(startRes.body.features.vocal).toBe('instrumental');

    const endRes = mockRes();
    await app.routes['POST /api/memory/telemetry']({
      body: {
        event: 'session_end',
        sessionId: startRes.body.sessionId,
        listenedSec: 180,
        durationSec: 185,
        outcome: 'completed',
        finalVolume: 26,
      },
    }, endRes);
    expect(endRes.body.ok).toBe(true);
    expect(endRes.body.session.outcome).toBe('completed');

    const dislikeRes = mockRes();
    await app.routes['POST /api/memory/telemetry']({
      body: { event: 'dislike', title: '太吵的歌', artist: '噪音乐队' },
    }, dislikeRes);
    expect(dislikeRes.body.ok).toBe(true);
  });

  it('切换不同 Agent 调用方时，Claudio 记忆连续保留且正确跟踪 activeAgent', async () => {
    const runtime = { queue: [{ title: '旧', artist: '旧' }], index: 0, paused: false, volume: 35 };
    const app = mockApp();
    mountMemoryRoutes(app, { db: dbApi, rootDir: process.cwd(), runtime });
    mountExternalQueueRoutes(app, {
      runtime,
      db: dbApi,
      resolveTrack: async w => ({
        kugouId: 'h-agent',
        title: w.title,
        artist: w.artist,
        album: '',
        duration: 210,
        upstreamUrl: 'https://cdn.kugou.com/a.mp3',
        score: 100,
      }),
    });
    mountControlRoute(app, { runtime, db: dbApi });

    const tRes = mockRes();
    await app.routes['POST /api/memory/traits']({
      body: { summary: '跨 Agent 测试记忆条', status: 'pinned' },
    }, tRes);

    const qRes = mockRes();
    await app.routes['POST /api/queue/external']({
      body: {
        agentId: 'hermes',
        agentName: 'Hermes DJ',
        tracks: [{ title: '晴天', artist: '周杰伦' }],
      },
    }, qRes);
    expect(qRes.body.ok).toBe(true);
    expect(runtime.activeAgent.id).toBe('hermes');
    expect(runtime.activeAgent.name).toBe('Hermes DJ');

    const ctrlRes = mockRes();
    await app.routes['POST /api/control']({
      body: { command: 'volume', value: 42, agentId: 'alma', agentName: 'Alma Assistant' },
    }, ctrlRes);
    expect(ctrlRes.body.ok).toBe(true);
    expect(ctrlRes.body.activeAgent.id).toBe('alma');

    const briefRes = mockRes();
    await app.routes['GET /api/memory/brief']({ query: {} }, briefRes);
    expect(briefRes.body.activeAgent.id).toBe('alma');
    expect(briefRes.body.traits.some(t => t.summary === '跨 Agent 测试记忆条')).toBe(true);
  });

  it('session_end 达标晋升 queued -> played，skipped 写不重复的 skip 反馈', async () => {
    const runtime = { queue: [], index: 0, volume: 30 };
    const app = mockApp();
    mountMemoryRoutes(app, { db: dbApi, rootDir: process.cwd(), runtime });

    const queuedId = Number(dbApi.addPlay({
      kugouId: 'h-promo-1',
      title: '晴天',
      artist: '周杰伦',
      source: 'bot',
      quality: 'queued',
    }));

    const s1 = mockRes();
    await app.routes['POST /api/memory/telemetry']({
      body: { event: 'session_start', kugouId: 'h-promo-1', title: '晴天', artist: '周杰伦', source: 'external', durationSec: 269 },
    }, s1);
    const e1 = mockRes();
    await app.routes['POST /api/memory/telemetry']({
      body: { event: 'session_end', sessionId: s1.body.sessionId, listenedSec: 45, durationSec: 269, outcome: 'interrupted' },
    }, e1);
    expect(e1.body.ok).toBe(true);
    const verified = dbApi.recentVerifiedPlays(20).find(p => Number(p.id) === queuedId);
    expect(verified).toMatchObject({ title: '晴天', quality: 'played' });

    const s2 = mockRes();
    await app.routes['POST /api/memory/telemetry']({
      body: { event: 'session_start', kugouId: 'h-skip-1', title: '跳过歌', artist: '歌手甲', source: 'external', durationSec: 200 },
    }, s2);
    const e2 = mockRes();
    await app.routes['POST /api/memory/telemetry']({
      body: { event: 'session_end', sessionId: s2.body.sessionId, listenedSec: 12, durationSec: 200, outcome: 'skipped' },
    }, e2);
    expect(e2.body.ok).toBe(true);
    const skipRows = dbApi.recentFeedback(20).filter(f => f.kind === 'skip' && f.kugou_id === 'h-skip-1');
    expect(skipRows).toHaveLength(1);
  });

  it('支持 GET/PUT/POST/DELETE /api/session-note 与 GET/POST/PUT /api/scene', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-note-scene-'));
    const runtime = { queue: [{ title: 'A', artist: 'B' }], index: 0, paused: false, volume: 30 };
    const broadcast = vi.fn();
    const app = mockApp();
    mountMemoryRoutes(app, { db: dbApi, rootDir: tmpRoot, runtime, broadcast });

    const putNote = mockRes();
    await app.routes['PUT /api/session-note']({ body: { text: '今晚只听纯音乐', ttlMinutes: 180 } }, putNote);
    expect(putNote.body.ok).toBe(true);
    expect(putNote.body.note.text).toBe('今晚只听纯音乐');

    const getNote = mockRes();
    await app.routes['GET /api/session-note']({}, getNote);
    expect(getNote.body.active).toBe(true);
    expect(getNote.body.note.text).toBe('今晚只听纯音乐');

    const postScene = mockRes();
    await app.routes['POST /api/scene']({ body: { scene: 'library' } }, postScene);
    expect(postScene.body.ok).toBe(true);
    expect(postScene.body.scene.id).toBe('library');
    expect(runtime.scene.id).toBe('library');

    const briefRes = mockRes();
    await app.routes['GET /api/memory/brief']({ query: {} }, briefRes);
    expect(briefRes.body.scene.id).toBe('library');
    expect(briefRes.body.sessionNote.text).toBe('今晚只听纯音乐');

    const delNote = mockRes();
    await app.routes['DELETE /api/session-note']({}, delNote);
    expect(delNote.body.active).toBe(false);
    expect(fs.existsSync(path.join(tmpRoot, 'user', 'session-note.md'))).toBe(false);
  });
});
