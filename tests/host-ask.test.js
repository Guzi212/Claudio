import { describe, expect, it, vi } from 'vitest';
import { mountHostAskRoutes, buildHostPrompt } from '../server/api/host-ask.js';
import { mountControlRoute } from '../server/api/control.js';
import { mountExternalQueueRoutes } from '../server/api/external-queue.js';
import { createStreamRegistry } from '../server/runtime-events.js';
import { mountSessionRoute } from '../server/session.js';
import { detectStandaloneMobile } from '../pwa/mobile-mode.js';

function mockApp() {
  const routes = {};
  return {
    routes,
    post(path, fn) { routes[`POST ${path}`] = fn; },
    get(path, fn) { routes[`GET ${path}`] = fn; },
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(data) { this.body = data; return this; },
  };
  return res;
}

describe('POST /api/host/ask & /api/host/reply', () => {
  it('空消息返回 400', async () => {
    const app = mockApp();
    mountHostAskRoutes(app, { getSecret: () => 'secret-1234567890abcdef' });
    const res = mockRes();
    await app.routes['POST /api/host/ask']({ body: { message: '   ' }, socket: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('仅向本机 claudio 助手投递并附带 targetClientId 定向提示', async () => {
    const calls = [];
    const fakeFetch = vi.fn(async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200 };
    });
    const app = mockApp();
    mountHostAskRoutes(app, {
      fetch: fakeFetch,
      getSecret: () => 'secret-1234567890abcdef',
      webhookBase: 'http://127.0.0.1:18790',
    });
    const res = mockRes();
    await app.routes['POST /api/host/ask']({
      body: {
        message: '换点轻松的晚间 R&B',
        clientId: 'mobile-phone-001',
        standalone: true,
        nowPlaying: { title: '晴天', artist: '周杰伦' },
      },
      socket: { remoteAddress: '100.86.99.72' },
    }, res);

    expect(res.statusCode).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(res.body.targetClientId).toBe('mobile-phone-001');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:18790/webhook/assistant/claudio');
    expect(calls[0].opts.headers.Authorization).toBe('Bearer secret-1234567890abcdef');
    const payload = JSON.parse(calls[0].opts.body);
    expect(payload.text).toContain('换点轻松的晚间 R&B');
    expect(payload.text).toContain('targetClientId');
    expect(payload.text).toContain('mobile-phone-001');
  });

  it('超过单分钟限频返回 429 与 Retry-After', async () => {
    let nowMs = 1_000_000;
    const fakeFetch = vi.fn(async () => ({ ok: true, status: 200 }));
    const app = mockApp();
    mountHostAskRoutes(app, {
      fetch: fakeFetch,
      getSecret: () => 'secret-1234567890abcdef',
      rateMax: 2,
      rateWindowMs: 60_000,
      now: () => nowMs,
    });
    for (let i = 0; i < 2; i++) {
      const r = mockRes();
      await app.routes['POST /api/host/ask']({ body: { message: `msg ${i}`, clientId: 'phone-rate' }, socket: {} }, r);
      expect(r.statusCode).toBe(202);
    }
    const blocked = mockRes();
    await app.routes['POST /api/host/ask']({ body: { message: 'msg 3', clientId: 'phone-rate' }, socket: {} }, blocked);
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it('POST /api/host/reply 定向发给手机且不广播到电脑', () => {
    const sent = [];
    const broadcasted = [];
    const app = mockApp();
    mountHostAskRoutes(app, {
      sendToClient: (id, evt) => { sent.push({ id, evt }); return 1; },
      broadcast: evt => broadcasted.push(evt),
    });
    const res = mockRes();
    app.routes['POST /api/host/reply']({ body: { targetClientId: 'phone-1234', text: '收到，这就切歌' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.delivered).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].id).toBe('phone-1234');
    expect(sent[0].evt.type).toBe('host-reply');
    expect(broadcasted).toHaveLength(0);
  });

  it('buildHostPrompt 携带当前曲目与定向要求', () => {
    const prompt = buildHostPrompt({
      message: '下一首',
      clientId: 'phone-abc',
      standalone: true,
      nowPlaying: { title: '就是爱你', artist: '陶喆' },
    });
    expect(prompt).toContain('就是爱你 - 陶喆');
    expect(prompt).toContain('"targetClientId": "phone-abc"');
  });
});

describe('定向手机推歌/播控与独立播放选举', () => {
  it('/api/queue/external 带 targetClientId 时只推给目标手机，不改电脑队列', async () => {
    const desktopQueue = [{ title: 'Desktop Song', artist: 'PC', kugouId: 'pc1' }];
    const runtime = { queue: [...desktopQueue], index: 0, paused: true, volume: 20 };
    const sent = [];
    const broadcasted = [];
    const app = mockApp();
    mountExternalQueueRoutes(app, {
      runtime,
      broadcast: evt => broadcasted.push(evt),
      sendToClient: (id, evt) => { sent.push({ id, evt }); return 1; },
      resolveTrack: vi.fn(async want => ({
        title: want.title,
        artist: want.artist || 'Artist',
        kugouId: 'h-phone',
        upstreamUrl: 'http://fs.kugou.com/a.mp3',
        audioQuality: '128',
      })),
      synthesize: vi.fn(async () => null),
      db: { addPlay: vi.fn() },
    });

    const res = mockRes();
    await app.routes['POST /api/queue/external']({
      body: {
        targetClientId: 'phone-solo-1',
        mode: 'replace',
        say: '手机换上新歌啦',
        tracks: [{ title: '爱爱爱', artist: '方大同' }],
      },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.queue.targetClientId).toBe('phone-solo-1');
    expect(res.body.queue.delivered).toBe(1);
    expect(runtime.queue).toEqual(desktopQueue);
    expect(runtime.paused).toBe(true);
    expect(broadcasted).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].id).toBe('phone-solo-1');
    expect(sent[0].evt.type).toBe('external-queue');
    expect(sent[0].evt.tracks[0].title).toBe('爱爱爱');
  });

  it('/api/control 带 targetClientId 时只控制目标手机，不改电脑状态', () => {
    const runtime = { queue: [{ title: 'A' }], index: 0, paused: false, volume: 25 };
    const sent = [];
    const broadcasted = [];
    const app = mockApp();
    mountControlRoute(app, {
      runtime,
      broadcast: evt => broadcasted.push(evt),
      sendToClient: (id, evt) => { sent.push({ id, evt }); return 1; },
    });

    const res = mockRes();
    app.routes['POST /api/control']({
      body: { targetClientId: 'phone-solo-1', command: 'pause', say: '帮你暂停了' },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.delivered).toBe(1);
    expect(runtime.paused).toBe(false);
    expect(broadcasted).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].evt).toMatchObject({ type: 'client-control', command: 'pause', say: '帮你暂停了' });
  });

  it('standalone 手机连接不参与全局 leader 选举且可被 clientsForId 精准找到', () => {
    const reg = createStreamRegistry();
    const wsDesktop = { id: 'd' };
    const wsPhone = { id: 'p' };
    reg.connect(wsDesktop);
    reg.identify(wsDesktop, { clientId: 'desk-1', kind: 'electron' });
    reg.connect(wsPhone);
    const leader = reg.identify(wsPhone, { clientId: 'phone-1', kind: 'pwa', standalone: true });

    expect(leader.clientId).toBe('desk-1');
    expect(reg.clientsForId('phone-1')).toEqual([wsPhone]);
    expect(reg.snapshot().listeners.find(l => l.clientId === 'phone-1')?.standalone).toBe(true);
  });

  it('反代带 X-Forwarded-Proto: https 时 session cookie 自动带 Secure', () => {
    const app = mockApp();
    mountSessionRoute(app);
    const res = mockRes();
    app.routes['POST /api/session']({
      headers: { 'x-forwarded-proto': 'https' },
      socket: { encrypted: false },
    }, res);
    expect(res.headers['set-cookie']).toContain('HttpOnly');
    expect(res.headers['set-cookie']).toContain('SameSite=Strict');
    expect(res.headers['set-cookie']).toContain('Secure');
  });

  it('detectStandaloneMobile 自动识别手机 UA 且不误判桌面端', () => {
    expect(detectStandaloneMobile({
      navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15' },
      location: { search: '' },
    })).toBe(true);
    expect(detectStandaloneMobile({
      claudioDesktop: { isDesktop: true },
      navigator: { userAgent: 'Mozilla/5.0 (iPhone)' },
      location: { search: '' },
    })).toBe(false);
    expect(detectStandaloneMobile({
      navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0' },
      location: { search: '' },
      innerWidth: 1440,
    })).toBe(false);
    expect(detectStandaloneMobile({
      navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0)' },
      location: { search: '?mode=standalone' },
    })).toBe(true);
  });
});
