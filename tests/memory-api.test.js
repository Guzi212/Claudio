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
});
