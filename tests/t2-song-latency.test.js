import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { mountExternalQueueRoutes } from '../server/api/external-queue.js';
import { mountRuntimeRoutes } from '../server/api/runtime.js';
import { mountQueueClearRoutes } from '../server/api/queue-clear.js';
import { applyMediaEvent, applyProgress, playbackStatus } from '../server/playback-control.js';

function makeTrack(title, artist = '周杰伦', extra = {}) {
  return {
    kugouId: extra.kugouId || `hash-${title}`,
    title,
    artist,
    album: extra.album || '',
    duration: extra.duration ?? 240,
    upstreamUrl: extra.upstreamUrl || `https://cdn.kugou.com/${encodeURIComponent(title)}.mp3`,
    score: 150,
    albumId: '9',
    mixsongid: '100',
  };
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

function mockApp() {
  const routes = {};
  return {
    routes,
    get(path, handler) { routes[`GET ${path}`] = handler; },
    post(path, handler) { routes[`POST ${path}`] = handler; },
  };
}

describe('T-2: replace 进度清理与真实 playing 事件观测', () => {
  it('replace 归零 currentTime/duration/playbackEvent，不改音量，并广播 queueEpoch + anchor + timing', async () => {
    const runtime = {
      queue: [{ title: '旧歌', artist: '旧人', kugouId: 'old-1', queuedAt: '2026-11-21T00:00:00.000Z' }],
      index: 0,
      queueOffset: 0,
      paused: false,
      volume: 42,
      volumeExplicit: true,
      currentTime: 137.5,
      duration: 245,
      playbackEvent: {
        stage: 'playing',
        layer: 'player_media_event',
        queueEpoch: 3,
        index: 0,
        queueOffset: 0,
        kugouId: 'old-1',
        title: '旧歌',
        currentTime: 137.5,
        at: '2026-11-21T00:02:17.000Z',
      },
      queueEpoch: 3,
      runtimeInstanceId: 'inst-t2',
      lastSay: '',
    };
    const broadcasts = [];
    const app = mockApp();
    mountExternalQueueRoutes(app, {
      runtime,
      broadcast: evt => broadcasts.push(evt),
      resolveTrack: vi.fn(async want => makeTrack(want.title, want.artist)),
      db: { addPlay: vi.fn() },
    });

    const res = mockRes();
    await app.routes['POST /api/queue/external']({
      body: {
        mode: 'replace',
        source: 'play-now',
        tracks: [{ title: '晴天', artist: '周杰伦' }],
      },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(runtime.currentTime).toBe(0);
    expect(runtime.duration).toBe(0);
    expect(runtime.playbackEvent).toBeNull();
    expect(runtime.volume).toBe(42);
    expect(runtime.volumeExplicit).toBe(true);
    expect(runtime.queueEpoch).toBe(4);
    expect(res.body.anchor).toMatchObject({
      title: '晴天',
      artist: '周杰伦',
      kugouId: 'hash-晴天',
      queueEpoch: 4,
    });
    expect(res.body.anchor.queuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.body.timing).toMatchObject({
      resolveMs: expect.any(Number),
      ttsMs: 0,
      totalMs: expect.any(Number),
    });

    const extEvt = broadcasts.find(e => e.type === 'external-queue');
    expect(extEvt).toMatchObject({
      type: 'external-queue',
      mode: 'replace',
      queueEpoch: 4,
      runtimeInstanceId: 'inst-t2',
    });
    expect(playbackStatus(runtime)).toMatchObject({
      currentTime: 0,
      duration: 0,
      playbackEvent: null,
      queueEpoch: 4,
    });
  });

  it('append 到非空队列保留当前进度与 playbackEvent；append 到空队列归零残留', async () => {
    const playingEvt = {
      stage: 'playing',
      layer: 'player_media_event',
      queueEpoch: 1,
      index: 0,
      queueOffset: 0,
      kugouId: 'hash-晴天',
      title: '晴天',
      currentTime: 25,
      at: '2026-11-21T00:00:25.000Z',
    };
    const runtime = {
      queue: [{ title: '晴天', artist: '周杰伦', kugouId: 'hash-晴天' }],
      index: 0,
      queueOffset: 0,
      paused: false,
      currentTime: 25,
      duration: 260,
      playbackEvent: playingEvt,
      queueEpoch: 1,
      lastSay: '',
    };
    const app = mockApp();
    mountExternalQueueRoutes(app, {
      runtime,
      broadcast: vi.fn(),
      resolveTrack: vi.fn(async want => makeTrack(want.title, want.artist)),
      db: { addPlay: vi.fn() },
    });

    const res = mockRes();
    await app.routes['POST /api/queue/external']({
      body: { mode: 'append', tracks: [{ title: '七里香', artist: '周杰伦' }] },
    }, res);
    expect(res.statusCode).toBe(200);
    expect(runtime.currentTime).toBe(25);
    expect(runtime.playbackEvent).toEqual(playingEvt);

    // 空队列 append 视作新一轮开播，清理旧残留
    runtime.queue = [];
    runtime.currentTime = 99;
    runtime.duration = 200;
    runtime.playbackEvent = playingEvt;
    const res2 = mockRes();
    await app.routes['POST /api/queue/external']({
      body: { mode: 'append', tracks: [{ title: '夜曲', artist: '周杰伦' }] },
    }, res2);
    expect(res2.statusCode).toBe(200);
    expect(runtime.currentTime).toBe(0);
    expect(runtime.duration).toBe(0);
    expect(runtime.playbackEvent).toBeNull();
  });

  it('applyMediaEvent 区分 player_media_event，拒绝旧 epoch/错曲目/clear 锁定期，且不让 loaded 倒退 playing', () => {
    const runtime = {
      queue: [{ title: '晴天', artist: '周杰伦', kugouId: 'kg-1', queuedAt: '2026-11-21T14:00:00.000Z' }],
      index: 0,
      queueOffset: 0,
      paused: true,
      currentTime: 0,
      duration: 0,
      playbackEvent: null,
      queueEpoch: 5,
      continueSuppressed: false,
    };

    // 旧 epoch 必须被拒
    const staleEpoch = applyMediaEvent(runtime, { stage: 'playing', queueEpoch: 4, index: 0, kugouId: 'kg-1' });
    expect(staleEpoch.ok).toBe(false);
    expect(staleEpoch.stale).toBe(true);
    expect(runtime.playbackEvent).toBeNull();

    // 错曲目 hash 必须被拒
    const wrongTrack = applyMediaEvent(runtime, { stage: 'playing', queueEpoch: 5, index: 0, kugouId: 'kg-other' });
    expect(wrongTrack.ok).toBe(false);
    expect(wrongTrack.stale).toBe(true);
    expect(runtime.playbackEvent).toBeNull();

    // loaded -> playing 正常推进
    const loaded = applyMediaEvent(runtime, {
      stage: 'loaded',
      queueEpoch: 5,
      index: 0,
      kugouId: 'kg-1',
      readyState: 2,
      currentTime: 0,
      clientId: 'tab-1',
    }, { now: () => '2026-11-21T14:00:00.400Z' });
    expect(loaded.ok).toBe(true);
    expect(runtime.playbackEvent).toMatchObject({
      stage: 'loaded',
      layer: 'player_media_event',
      queueEpoch: 5,
      kugouId: 'kg-1',
      readyState: 2,
    });

    const playing = applyMediaEvent(runtime, {
      stage: 'playing',
      queueEpoch: 5,
      index: 0,
      kugouId: 'kg-1',
      readyState: 4,
      currentTime: 0.12,
      duration: 269,
      clientId: 'tab-1',
    }, { now: () => '2026-11-21T14:00:00.650Z' });
    expect(playing.ok).toBe(true);
    expect(runtime.paused).toBe(false);
    expect(runtime.currentTime).toBeCloseTo(0.12, 2);
    expect(runtime.playbackEvent).toMatchObject({
      stage: 'playing',
      layer: 'player_media_event',
      queueEpoch: 5,
      kugouId: 'kg-1',
      queuedAt: '2026-11-21T14:00:00.000Z',
      readyState: 4,
    });

    // 晚到的 loaded 不得把 playing 倒退回 loaded
    const lateLoaded = applyMediaEvent(runtime, {
      stage: 'loaded',
      queueEpoch: 5,
      index: 0,
      kugouId: 'kg-1',
      readyState: 2,
    });
    expect(lateLoaded.ok).toBe(true);
    expect(lateLoaded.ignored).toBe(true);
    expect(runtime.playbackEvent.stage).toBe('playing');

    // clear 锁定期间一律拒绝
    runtime.queue = [];
    runtime.continueSuppressed = true;
    runtime.playbackEvent = null;
    const locked = applyMediaEvent(runtime, { stage: 'playing', queueEpoch: 5, index: 0 });
    expect(locked.ok).toBe(false);
    expect(locked.stale).toBe(true);
    expect(runtime.playbackEvent).toBeNull();
  });

  it('resolveTrack 传 hash + title 时并行拉取直链与元数据', async () => {
    vi.resetModules();
    let inFlight = 0;
    let maxInFlight = 0;
    const get = vi.fn(async path => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 25));
      inFlight -= 1;
      if (String(path).includes('/song/url')) {
        return { data: { url: 'https://cdn.kugou.com/exact.mp3' } };
      }
      return {
        data: {
          data: {
            lists: [{ FileHash: 'EXACT-H', OriSongName: '晴天', SingerName: '周杰伦', Duration: 269 }],
          },
        },
      };
    });
    vi.doMock('axios', () => ({ default: { create: () => ({ get, post: vi.fn() }) } }));
    vi.doMock('../server/db.js', () => ({ dbApi: { getPref: () => '', addUnmatched: vi.fn() } }));

    const { resolveTrack } = await import('../server/services/kugou.js');
    const track = await resolveTrack({ title: '晴天', artist: '周杰伦', hash: 'EXACT-H' });
    expect(track).toMatchObject({
      kugouId: 'EXACT-H',
      title: '晴天',
      artist: '周杰伦',
      upstreamUrl: 'https://cdn.kugou.com/exact.mp3',
    });
    expect(maxInFlight).toBe(2);

    vi.doUnmock('axios');
    vi.doUnmock('../server/db.js');
  });

  it('PWA 契约：external-queue 同步 queueEpoch、replace 强制从 0 重播并上报 loadeddata/playing', () => {
    const playerJs = fs.readFileSync(new URL('../pwa/views/player.js', import.meta.url), 'utf8');
    const appJs = fs.readFileSync(new URL('../pwa/app.js', import.meta.url), 'utf8');
    expect(playerJs).toContain("audio.addEventListener('loadeddata', () => reportMediaEvent('loaded'))");
    expect(playerJs).toContain("audio.addEventListener('playing', () => reportMediaEvent('playing'))");
    expect(playerJs).toContain("mediaEvent: 'playing'");
    expect(playerJs).toContain('isStaleRemoteSnapshot(state, { queueEpoch, runtimeInstanceId }');
    expect(playerJs).toContain('playIndex(plan.playIndex, { autoplay: true, restart: isReplace, startAt: 0 })');
    expect(appJs).toContain("window.addEventListener('claudio:media-event'");
    expect(appJs).toContain("type: 'media-event'");
  });

  it('隔离端到端仿真（随机端口 Express+WS + 模拟播放器 playing 事件，绝不触碰 8080/33400）', async () => {
    const runtime = {
      queue: [{ title: '旧歌', artist: '旧人', kugouId: 'old-0', queuedAt: '2026-11-21T00:00:00.000Z' }],
      index: 0,
      queueOffset: 0,
      paused: false,
      volume: 35,
      volumeExplicit: true,
      currentTime: 88.4,
      duration: 210,
      playbackEvent: null,
      queueEpoch: 1,
      continueSuppressed: false,
      runtimeInstanceId: 'isolated-e2e',
      lastSay: '',
      active: false,
    };
    const app = express();
    app.use(express.json());
    const server = http.createServer(app);
    const wss = new WebSocketServer({ noServer: true });
    const wsClients = new Set();
    const broadcast = evt => {
      const payload = JSON.stringify(evt);
      for (const ws of wsClients) {
        if (ws.readyState === 1) ws.send(payload);
      }
    };

    app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
    mountRuntimeRoutes(app, {
      runtime,
      broadcast,
      db: { addPlay: vi.fn() },
      statusOptions: () => ({ listeners: wsClients.size, brain: 'external' }),
    });
    mountExternalQueueRoutes(app, {
      runtime,
      broadcast,
      resolveTrack: async want => {
        await new Promise(resolve => setTimeout(resolve, 15)); // 模拟酷狗上游搜索 RTT
        return makeTrack(want.title, want.artist || '周杰伦');
      },
      db: { addPlay: vi.fn() },
    });
    mountQueueClearRoutes(app, { runtime, broadcast, db: { addPlay: vi.fn() } });

    server.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, ws => {
        wsClients.add(ws);
        runtime.active = true;
        ws.send(JSON.stringify({ type: 'hello', runtime }));
        ws.on('message', raw => {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'progress') applyProgress(runtime, msg);
          if (msg.type === 'media-event') applyMediaEvent(runtime, msg);
        });
        ws.on('close', () => {
          wsClients.delete(ws);
          runtime.active = wsClients.size > 0;
        });
      });
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    expect(port).not.toBe(8080);
    expect(port).not.toBe(33400);
    const baseUrl = `http://127.0.0.1:${port}`;

    // 模拟浏览器播放器客户端：连接 WS，收到 external-queue replace 后按真实顺序上报 loaded -> playing
    const playerWs = new WebSocket(`ws://127.0.0.1:${port}/stream`);
    await new Promise(resolve => playerWs.once('open', resolve));

    playerWs.on('message', raw => {
      const evt = JSON.parse(raw.toString());
      if (evt.type === 'external-queue' && evt.mode === 'replace') {
        const first = evt.tracks[0];
        const epoch = evt.queueEpoch;
        setTimeout(() => {
          playerWs.send(JSON.stringify({
            type: 'media-event',
            stage: 'loaded',
            index: 0,
            queueOffset: 0,
            queueEpoch: epoch,
            kugouId: first.kugouId,
            title: first.title,
            currentTime: 0,
            readyState: 2,
            clientId: 'sim-player',
          }));
        }, 10);
        setTimeout(() => {
          playerWs.send(JSON.stringify({
            type: 'media-event',
            stage: 'playing',
            index: 0,
            queueOffset: 0,
            queueEpoch: epoch,
            kugouId: first.kugouId,
            title: first.title,
            currentTime: 0.05,
            duration: 240,
            readyState: 4,
            clientId: 'sim-player',
          }));
        }, 25);
      }
    });

    try {
      const t0 = Date.now();
      const postRes = await fetch(`${baseUrl}/api/queue/external`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'replace',
          source: 'play-now',
          tracks: [{ title: '晴天', artist: '周杰伦' }],
        }),
      });
      const postBody = await postRes.json();
      expect(postRes.status).toBe(200);
      expect(postBody.ok).toBe(true);
      expect(postBody.anchor.kugouId).toBe('hash-晴天');

      // E: 刚接管时 currentTime 必须已归零（不再残留旧歌的 88.4s）
      const stAfterReplace = await fetch(`${baseUrl}/api/status`).then(r => r.json());
      expect(stAfterReplace.nowPlaying.title).toBe('晴天');
      expect(stAfterReplace.currentTime).toBeLessThan(1);
      expect(stAfterReplace.volume).toBe(35);

      // F: 轮询直到观测到播放器 playing 事件（明确是 player_media_event，非硬件音频输出）
      let observed = null;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const st = await fetch(`${baseUrl}/api/status`).then(r => r.json());
        if (st.playbackEvent?.stage === 'playing' && st.playbackEvent?.queueEpoch === postBody.queueEpoch) {
          observed = st.playbackEvent;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      const totalMs = Date.now() - t0;
      expect(observed).not.toBeNull();
      expect(observed).toMatchObject({
        stage: 'playing',
        layer: 'player_media_event',
        queueEpoch: postBody.queueEpoch,
        kugouId: 'hash-晴天',
        readyState: 4,
      });
      expect(totalMs).toBeLessThan(1500);

      // 再验证：连续第二次 replace 后，旧歌晚到的 playing 事件绝不会污染新歌
      const oldEpoch = postBody.queueEpoch;
      const postRes2 = await fetch(`${baseUrl}/api/queue/external`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'replace',
          source: 'play-now',
          tracks: [{ title: '稻香', artist: '周杰伦' }],
        }),
      }).then(r => r.json());

      // 故意注入一条旧 epoch 的 playing 事件
      const staleResp = await fetch(`${baseUrl}/api/runtime/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          index: 0,
          queueOffset: 0,
          paused: false,
          queueEpoch: oldEpoch,
          mediaEvent: 'playing',
          kugouId: 'hash-晴天',
        }),
      }).then(r => r.json());
      expect(staleResp.stale).toBe(true);

      // 等新歌自己的 playing 到达
      let observed2 = null;
      const deadline2 = Date.now() + 2000;
      while (Date.now() < deadline2) {
        const st = await fetch(`${baseUrl}/api/status`).then(r => r.json());
        if (st.playbackEvent?.stage === 'playing' && st.playbackEvent?.queueEpoch === postRes2.queueEpoch) {
          observed2 = st.playbackEvent;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      expect(observed2?.kugouId).toBe('hash-稻香');
    } finally {
      playerWs.close();
      await new Promise(resolve => server.close(resolve));
    }
  });
});
