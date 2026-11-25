import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import {
  createStreamRegistry,
  leaderBroadcast,
  progressBroadcast,
} from '../server/runtime-events.js';
import { applyProgress, playbackStatus } from '../server/playback-control.js';
import { mountRuntimeRoutes } from '../server/api/runtime.js';
import { TRACK_PROVIDER_LABELS, trackProviderLabel } from '../pwa/player-mode.js';

function startTestStreamServer(initialRuntime = {}) {
  const app = express();
  app.use(express.json());
  const runtime = {
    queue: [
      { title: '晴天', artist: '周杰伦', provider: 'qq', kugouId: 'qq:0039MnYb0qxYhV', duration: 269 },
      { title: '夜曲', artist: '周杰伦', provider: 'netease', kugouId: 'netease:185811', duration: 226 },
    ],
    index: 0,
    queueOffset: 0,
    paused: false,
    volume: 35,
    volumeExplicit: true,
    currentTime: 0,
    duration: 269,
    active: false,
    ...initialRuntime,
  };

  const wss = new WebSocketServer({ noServer: true });
  const registry = createStreamRegistry();

  function broadcast(event) {
    const payload = JSON.stringify(event);
    for (const ws of registry.clients()) {
      if (ws.readyState === 1) ws.send(payload);
    }
  }

  mountRuntimeRoutes(app, {
    runtime,
    broadcast,
    db: {},
    canReportState: clientId => registry.canReportState(clientId),
    statusOptions: () => ({
      listeners: registry.size(),
      playback: registry.snapshot(),
      brain: 'external',
      provider: 'multi',
      providers: ['kugou', 'netease', 'qq'],
    }),
  });

  const server = http.createServer(app);
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, ws => {
      const { leader } = registry.connect(ws);
      runtime.active = true;
      ws.send(JSON.stringify({ type: 'hello', runtime }));
      broadcast(leaderBroadcast(leader));
      ws.on('message', raw => {
        const msg = JSON.parse(raw.toString());
        if (msg?.type === 'identify') {
          const nextLeader = registry.identify(ws, msg);
          broadcast(leaderBroadcast(nextLeader));
          return;
        }
        if (msg?.type === 'progress') {
          if (!registry.isLeader(ws)) return;
          if (!applyProgress(runtime, msg)) return;
          const entry = registry.getClient(ws);
          const origin = (typeof msg.clientId === 'string' && msg.clientId.trim()) || entry?.clientId || '';
          broadcast(progressBroadcast(runtime, origin));
        }
      });
      ws.on('close', () => {
        const nextLeader = registry.disconnect(ws);
        runtime.active = registry.size() > 0;
        broadcast(leaderBroadcast(nextLeader));
      });
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        runtime,
        registry,
        baseUrl: `http://127.0.0.1:${port}`,
        wsUrl: `ws://127.0.0.1:${port}/stream`,
        close: () => new Promise(done => {
          for (const ws of registry.clients()) {
            try { ws.terminate(); } catch { /* ignore */ }
          }
          server.close(() => done());
        }),
      });
    });
  });
}

function connectClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const events = [];
  const waiters = [];

  ws.on('message', raw => {
    const evt = JSON.parse(raw.toString());
    events.push(evt);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].predicate(evt)) {
        const w = waiters.splice(i, 1)[0];
        w.resolve(evt);
      }
    }
  });

  const waitFor = (predicate, timeoutMs = 2000) => {
    const hit = events.find(predicate);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitFor timeout')), timeoutMs);
      waiters.push({
        predicate,
        resolve: val => {
          clearTimeout(timer);
          resolve(val);
        },
      });
    });
  };

  const waitNext = (predicate, timeoutMs = 2000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitNext timeout')), timeoutMs);
    waiters.push({
      predicate,
      resolve: val => {
        clearTimeout(timer);
        resolve(val);
      },
    });
  });

  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, events, waitFor, waitNext }));
    ws.once('error', reject);
  });
}

describe('单点播放服务端选举与广播', () => {
  it('选举规则：有 electron 选最新连接的 electron，否则选最早连接的 pwa；未 identify 默认 pwa', () => {
    const reg = createStreamRegistry();
    const s1 = {};
    const s2 = {};
    const s3 = {};
    const s4 = {};

    // 未 identify 默认 pwa
    expect(reg.connect(s1).leader).toEqual({ clientId: 'anon-1', kind: 'pwa', claimed: false });
    expect(reg.identify(s1, { clientId: 'pwa-1', kind: 'pwa' })).toEqual({ clientId: 'pwa-1', kind: 'pwa', claimed: false });

    // 第二个 pwa 连入，leader 仍是最早的 pwa-1
    reg.connect(s2);
    expect(reg.identify(s2, { clientId: 'pwa-2', kind: 'pwa' })).toEqual({ clientId: 'pwa-1', kind: 'pwa', claimed: false });

    // electron 连入并 identify → 立即抢占 leader
    reg.connect(s3);
    expect(reg.identify(s3, { clientId: 'elec-1', kind: 'electron' })).toEqual({ clientId: 'elec-1', kind: 'electron', claimed: false });

    // 第二个 electron 连入 → 最新连接的 electron 当 leader
    reg.connect(s4);
    expect(reg.identify(s4, { clientId: 'elec-2', kind: 'electron' })).toEqual({ clientId: 'elec-2', kind: 'electron', claimed: false });

    // 最新 electron 断开 → 回落到仍在场的 elec-1
    expect(reg.disconnect(s4)).toEqual({ clientId: 'elec-1', kind: 'electron', claimed: false });

    // 所有 electron 断开 → 回落到最早连接的 pwa-1
    expect(reg.disconnect(s3)).toEqual({ clientId: 'pwa-1', kind: 'pwa', claimed: false });

    // pwa-1 断开 → 切换到 pwa-2
    expect(reg.disconnect(s1)).toEqual({ clientId: 'pwa-2', kind: 'pwa', claimed: false });

    // 全部断开 → null
    expect(reg.disconnect(s2)).toBeNull();
    expect(reg.snapshot()).toEqual({ leader: null, listeners: [] });
  });

  it('显式认领（claim）优先于 electron；归还或断开后回落默认选举', () => {
    const reg = createStreamRegistry();
    const desk = {};
    const phone = {};
    const laptop = {};

    reg.connect(desk);
    expect(reg.identify(desk, { clientId: 'desktop', kind: 'electron' }))
      .toEqual({ clientId: 'desktop', kind: 'electron', claimed: false });

    // 手机连入：不抢权，desktop 仍是 leader
    reg.connect(phone);
    expect(reg.identify(phone, { clientId: 'phone', kind: 'pwa' }))
      .toEqual({ clientId: 'desktop', kind: 'electron', claimed: false });

    // 手机点「在此设备播放」→ 立即接管
    expect(reg.identify(phone, { clientId: 'phone', kind: 'pwa', claim: true }))
      .toEqual({ clientId: 'phone', kind: 'pwa', claimed: true });

    // 另一台网页再认领 → 后到者接管（独占只有一个）
    reg.connect(laptop);
    reg.identify(laptop, { clientId: 'laptop', kind: 'pwa' });
    expect(reg.identify(laptop, { clientId: 'laptop', kind: 'pwa', claim: true }))
      .toEqual({ clientId: 'laptop', kind: 'pwa', claimed: true });

    // laptop 归还 → 回落到仍认领着 的 phone（不是 electron）
    expect(reg.identify(laptop, { clientId: 'laptop', kind: 'pwa', claim: false }))
      .toEqual({ clientId: 'phone', kind: 'pwa', claimed: true });

    // 手机断开 → 没有认领者了，回到默认选举：desktop（electron）
    expect(reg.disconnect(phone))
      .toEqual({ clientId: 'desktop', kind: 'electron', claimed: false });

    // laptop 断开只剩 desktop
    expect(reg.disconnect(laptop))
      .toEqual({ clientId: 'desktop', kind: 'electron', claimed: false });
    expect(reg.snapshot()).toEqual({
      leader: { clientId: 'desktop', kind: 'electron', claimed: false },
      listeners: [{ clientId: 'desktop', kind: 'electron', claimed: false, leader: true }],
    });
  });

  it('真实 WS 双客户端（pwa + electron）连接、进度连续广播、follower progress 被拒与断开恢复', async () => {
    const srv = await startTestStreamServer();
    try {
      const pwa = await connectClient(srv.wsUrl);
      await pwa.waitFor(e => e.type === 'hello');
      const pwaLeaderReady = pwa.waitNext(e => e.type === 'leader' && e.leader?.clientId === 'pwa-client');
      pwa.ws.send(JSON.stringify({ type: 'identify', clientId: 'pwa-client', kind: 'pwa' }));
      await pwaLeaderReady;

      // PWA 作为 leader 上报进度到 42.5 秒
      const pwaSelfProgress = pwa.waitNext(e => e.type === 'progress' && e.origin === 'pwa-client');
      pwa.ws.send(JSON.stringify({
        type: 'progress',
        currentTime: 42.5,
        duration: 269,
        paused: false,
        index: 0,
        clientId: 'pwa-client',
      }));
      const pEvt = await pwaSelfProgress;
      expect(pEvt).toEqual({
        type: 'progress',
        currentTime: 42.5,
        duration: 269,
        paused: false,
        index: 0,
        origin: 'pwa-client',
      });

      // Electron 连入：hello 拿到 42.5 秒进度，identify 后接管 leader，两边都收到广播
      const elec = await connectClient(srv.wsUrl);
      const elecHello = await elec.waitFor(e => e.type === 'hello');
      expect(elecHello.runtime.currentTime).toBe(42.5);

      const pwaSawElecLeader = pwa.waitNext(e => e.type === 'leader' && e.leader?.clientId === 'elec-client');
      const elecSawSelfLeader = elec.waitNext(e => e.type === 'leader' && e.leader?.clientId === 'elec-client');
      elec.ws.send(JSON.stringify({ type: 'identify', clientId: 'elec-client', kind: 'electron' }));
      await Promise.all([pwaSawElecLeader, elecSawSelfLeader]);

      // 核对 /api/status 的 playback 结构与兼容计数
      const statusRes = await fetch(`${srv.baseUrl}/api/status`);
      const statusJson = await statusRes.json();
      expect(statusJson.listeners).toBe(2);
      expect(statusJson.playback).toEqual({
        leader: { clientId: 'elec-client', kind: 'electron', claimed: false },
        listeners: [
          { clientId: 'pwa-client', kind: 'pwa', claimed: false, leader: false },
          { clientId: 'elec-client', kind: 'electron', claimed: false, leader: true },
        ],
      });

      // Follower（pwa）误发 progress 或 POST /api/runtime/state 均不能覆盖 leader 状态
      pwa.ws.send(JSON.stringify({
        type: 'progress',
        currentTime: 1,
        duration: 269,
        paused: true,
        index: 1,
        clientId: 'pwa-client',
      }));
      const staleStateRes = await fetch(`${srv.baseUrl}/api/runtime/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index: 0, queueOffset: 0, paused: true, ended: false, clientId: 'pwa-client' }),
      }).then(r => r.json());
      expect(staleStateRes.stale).toBe(true);
      expect(srv.runtime.currentTime).toBe(42.5);
      expect(srv.runtime.paused).toBe(false);
      expect(srv.runtime.index).toBe(0);

      // Electron 继续播到 58.2 秒，follower 收到 progress 广播
      const pwaGotElecProgress = pwa.waitNext(e => e.type === 'progress' && e.origin === 'elec-client');
      elec.ws.send(JSON.stringify({
        type: 'progress',
        currentTime: 58.2,
        duration: 269,
        paused: false,
        index: 0,
        clientId: 'elec-client',
      }));
      expect(await pwaGotElecProgress).toMatchObject({
        type: 'progress',
        currentTime: 58.2,
        paused: false,
        index: 0,
        origin: 'elec-client',
      });

      // 关闭 Electron → PWA 重新选为 leader，服务端进度保持在 58.2 秒
      const pwaRegained = pwa.waitNext(e => e.type === 'leader' && e.leader?.clientId === 'pwa-client');
      elec.ws.close();
      expect(await pwaRegained).toEqual({
        type: 'leader',
        leader: { clientId: 'pwa-client', kind: 'pwa', claimed: false },
      });
      const afterCloseStatus = await fetch(`${srv.baseUrl}/api/status`).then(r => r.json());
      expect(afterCloseStatus.listeners).toBe(1);
      expect(afterCloseStatus.currentTime).toBe(58.2);
      expect(afterCloseStatus.playback).toEqual({
        leader: { clientId: 'pwa-client', kind: 'pwa', claimed: false },
        listeners: [{ clientId: 'pwa-client', kind: 'pwa', claimed: false, leader: true }],
      });

      pwa.ws.close();
    } finally {
      await srv.close();
    }
  });

  it('真实 WS 双 PWA（pwa + pwa）连接与断开切换：先连者当 leader，断开后次连者接任', async () => {
    const srv = await startTestStreamServer();
    try {
      const pwa1 = await connectClient(srv.wsUrl);
      await pwa1.waitFor(e => e.type === 'hello');
      const l1 = pwa1.waitNext(e => e.type === 'leader' && e.leader?.clientId === 'pwa-1');
      pwa1.ws.send(JSON.stringify({ type: 'identify', clientId: 'pwa-1', kind: 'pwa' }));
      await l1;

      const pwa2 = await connectClient(srv.wsUrl);
      await pwa2.waitFor(e => e.type === 'hello');
      const l2 = pwa2.waitNext(e => e.type === 'leader' && e.leader?.clientId === 'pwa-1');
      pwa2.ws.send(JSON.stringify({ type: 'identify', clientId: 'pwa-2', kind: 'pwa' }));
      await l2;

      const promoted = pwa2.waitNext(e => e.type === 'leader' && e.leader?.clientId === 'pwa-2');
      pwa1.ws.close();
      expect(await promoted).toEqual({
        type: 'leader',
        leader: { clientId: 'pwa-2', kind: 'pwa', claimed: false },
      });
      pwa2.ws.close();
    } finally {
      await srv.close();
    }
  });

  it('真实 WS：桌面 electron 在播时手机 claim 接管、归还回落、断开自动回收', async () => {
    const srv = await startTestStreamServer();
    try {
      // 桌面 electron 先连上并当 leader
      const desk = await connectClient(srv.wsUrl);
      await desk.waitFor(e => e.type === 'hello');
      const deskLeader = desk.waitNext(e => e.type === 'leader' && e.leader?.clientId === 'desktop');
      desk.ws.send(JSON.stringify({ type: 'identify', clientId: 'desktop', kind: 'electron' }));
      await deskLeader;

      // 手机连入：不带 claim → desktop 仍是 leader，手机只收到 desktop 的领导广播
      const phone = await connectClient(srv.wsUrl);
      await phone.waitFor(e => e.type === 'hello');
      const phoneSeesDesk = phone.waitNext(e => e.type === 'leader' && e.leader?.clientId === 'desktop');
      phone.ws.send(JSON.stringify({ type: 'identify', clientId: 'phone', kind: 'pwa' }));
      await phoneSeesDesk;

      // 手机点「在此设备播放」→ claim=true，两端都收到 phone 为 leader
      const deskSawPhone = desk.waitNext(e => e.type === 'leader' && e.leader?.clientId === 'phone');
      const phoneSawSelf = phone.waitNext(e => e.type === 'leader' && e.leader?.clientId === 'phone');
      phone.ws.send(JSON.stringify({ type: 'identify', clientId: 'phone', kind: 'pwa', claim: true }));
      const [dl, pl] = await Promise.all([deskSawPhone, phoneSawSelf]);
      expect(pl.leader).toEqual({ clientId: 'phone', kind: 'pwa', claimed: true });
      expect(dl.leader.claimed).toBe(true);

      // 手机作为 leader 上报进度 → 广播带 origin
      const deskGotPhoneProgress = desk.waitNext(e => e.type === 'progress' && e.origin === 'phone');
      phone.ws.send(JSON.stringify({
        type: 'progress', currentTime: 10, duration: 269, paused: false, index: 0, clientId: 'phone',
      }));
      expect(await deskGotPhoneProgress).toMatchObject({ currentTime: 10, origin: 'phone' });

      // /api/status 的 playback 里 phone 标记为 claimed leader
      const st = await fetch(`${srv.baseUrl}/api/status`).then(r => r.json());
      expect(st.playback.leader).toEqual({ clientId: 'phone', kind: 'pwa', claimed: true });

      // 手机点「返回电脑播放」→ claim=false，两端都收到 desktop 复任
      const deskRegained = desk.waitNext(e => e.type === 'leader' && e.leader?.clientId === 'desktop');
      const phoneSawDeskBack = phone.waitNext(e => e.type === 'leader' && e.leader?.clientId === 'desktop');
      phone.ws.send(JSON.stringify({ type: 'identify', clientId: 'phone', kind: 'pwa', claim: false }));
      await Promise.all([deskRegained, phoneSawDeskBack]);

      // 手机再认领一次后直接断开 → 认领随连接回收，desktop 接回
      const phoneClaimedAgain = desk.waitNext(e => e.type === 'leader' && e.leader?.clientId === 'phone');
      phone.ws.send(JSON.stringify({ type: 'identify', clientId: 'phone', kind: 'pwa', claim: true }));
      await phoneClaimedAgain;
      const deskBackAfterClose = desk.waitNext(e => e.type === 'leader' && e.leader?.clientId === 'desktop');
      phone.ws.close();
      const evt = await deskBackAfterClose;
      expect(evt.leader).toEqual({ clientId: 'desktop', kind: 'electron', claimed: false });

      desk.ws.close();
    } finally {
      await srv.close();
    }
  });

  it('前端 follower 角色下 reportProgress 与 syncToServer 直接短路，不向外发进度或改暂停', async () => {
    const player = fs.readFileSync(path.resolve('pwa/views/player.js'), 'utf8');
    const appJs = fs.readFileSync(path.resolve('pwa/app.js'), 'utf8');

    // app.js 在收到 hello 时发 identify，并监听 leader / progress 事件
    expect(appJs).toContain("type: 'identify'");
    expect(appJs).toContain('claudioDesktop?.isDesktop');
    expect(appJs).toContain("evt.type === 'leader'");
    expect(appJs).toContain("evt.type === 'progress'");

    // follower 模式下 reportProgress 不派发 claudio:progress
    const progressStart = player.indexOf('function reportProgress(');
    const progressEnd = player.indexOf('\n// 把服务端', progressStart);
    const dispatchEvent = vi.fn();
    const report = new Function('state', 'audio', 'window', 'CustomEvent', `
      let lastProgressAt = 0;
      const npVol = { value: '35' }, getClientId = () => 'follower-1';
      ${player.slice(progressStart, progressEnd)}
      return reportProgress;
    `)({ index: 0, offset: 0, isFollower: true }, { currentTime: 12, duration: 200, paused: true }, { dispatchEvent }, class {});
    report(true);
    expect(dispatchEvent).not.toHaveBeenCalled();

    // follower 模式下 syncToServer 不发起 POST
    const syncSrc = extractFunctionSource(player, 'syncToServer');
    const fetchMock = vi.fn();
    const sync = new Function('state', 'fetch', 'getClientId', `${syncSrc}; return syncToServer;`)(
      { index: 0, offset: 0, isFollower: true },
      fetchMock,
      () => 'follower-1',
    );
    await sync(0, { paused: true, ended: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function extractFunctionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found`);
  let i = source.indexOf('(', start);
  let parens = 0;
  for (; i < source.length; i += 1) {
    if (source[i] === '(') parens += 1;
    else if (source[i] === ')') {
      parens -= 1;
      if (parens === 0) break;
    }
  }
  i = source.indexOf('{', i);
  let braces = 0;
  let quote = null;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') braces += 1;
    else if (ch === '}') {
      braces -= 1;
      if (braces === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`function ${name} body not closed`);
}

describe('播放页来源平台小标签', () => {
  it('映射 kugou / netease / qq 到指定短文案，TTS 与空曲目隐藏', () => {
    expect(TRACK_PROVIDER_LABELS).toEqual({
      kugou: '酷狗音乐',
      netease: '网易云',
      qq: 'QQ 音乐',
    });
    expect(trackProviderLabel({ title: 'A', provider: 'kugou' })).toBe('酷狗音乐');
    expect(trackProviderLabel({ title: 'B', provider: 'netease' })).toBe('网易云');
    expect(trackProviderLabel({ title: 'C', provider: 'qq' })).toBe('QQ 音乐');
    expect(trackProviderLabel({ title: 'D', kugouId: 'qq:123' })).toBe('QQ 音乐');
    expect(trackProviderLabel({ title: 'E', kugouId: 'netease:456' })).toBe('网易云');
    expect(trackProviderLabel({ title: 'F', kugouId: 'PLAINHASH' })).toBe('酷狗音乐');
    expect(trackProviderLabel({ title: '🔊 串场', isTts: true, provider: 'kugou' })).toBe('');
    expect(trackProviderLabel(null)).toBe('');

    const html = fs.readFileSync(path.resolve('pwa/index.html'), 'utf8');
    expect(html).toContain('id="np-provider"');
    expect(html).toContain('class="badge track-provider"');
  });

  it('playbackStatus 默认带空 playback 结构且保留原 listeners 计数', () => {
    const s = playbackStatus({ queue: [] });
    expect(s.listeners).toBe(0);
    expect(s.playback).toEqual({ leader: null, listeners: [] });
  });
});
