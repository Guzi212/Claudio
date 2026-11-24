// 外部 Agent 公开接口契约测试：经由 server/app.js 真实路由注册与模式配置发进程内请求，
// 锁住 README.md「外部 Agent 接入」和「Claudio主持人工具接口」写明的公开字段与行为。
// 使用临时 CLAUDIO_DB_PATH，不碰网络、不读真实 .env 或 state.db，不启动端口或后台服务。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Duplex, Writable } from 'node:stream';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockExec = vi.hoisted(() => vi.fn());
const mockAxiosGet = vi.hoisted(() => vi.fn());

vi.mock('dotenv/config', () => ({}));
vi.mock('node:child_process', () => ({ exec: mockExec }));
vi.mock('axios', () => ({
  default: {
    get: mockAxiosGet,
    create: (cfg = {}) => ({
      get: (url, opts) => mockAxiosGet(cfg.baseURL ? `${cfg.baseURL}${url}` : url, opts),
    }),
  },
}));

const EXTERNAL_CHAT_HINT = '当前为外部主持模式，请通过已接入的 Agent 或常驻 DJ 点歌。';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-contract-'));
let dbCounter = 0;
let activeDb = null;

function createInProcessSockets() {
  const reqSocket = new Duplex({
    autoDestroy: false,
    read() {},
    write(_chunk, _encoding, cb) { cb(); },
  });
  reqSocket.remoteAddress = '127.0.0.1';
  reqSocket.encrypted = false;
  reqSocket.setTimeout = () => reqSocket;
  reqSocket.setNoDelay = () => reqSocket;
  reqSocket.setKeepAlive = () => reqSocket;

  const resSocket = new Writable({
    autoDestroy: false,
    write(_chunk, _encoding, cb) { cb(); },
  });
  resSocket.remoteAddress = '127.0.0.1';
  resSocket.setTimeout = () => resSocket;
  resSocket.setNoDelay = () => resSocket;
  resSocket.setKeepAlive = () => resSocket;
  return { reqSocket, resSocket };
}

// 进程内驱动真实的 Express app，不监听任何端口，完整经过 hostGuard / express.json / authMiddleware / 路由表。
function requestApp(app, method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const { reqSocket, resSocket } = createInProcessSockets();
    const req = new http.IncomingMessage(reqSocket);
    req.method = method.toUpperCase();
    req.url = urlPath;
    req.headers = { host: '127.0.0.1:8080', ...headers };

    let payload = null;
    if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body), 'utf8');
      req.headers['content-type'] = 'application/json; charset=utf-8';
      req.headers['content-length'] = String(payload.length);
    }

    const res = new http.ServerResponse(req);
    res.assignSocket(resSocket);

    const chunks = [];
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    res.write = (chunk, encoding, cb) => {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8'));
      }
      return origWrite(chunk, encoding, cb);
    };
    res.end = (chunk, encoding, cb) => {
      if (chunk && typeof chunk !== 'function') {
        chunks.push(Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8'));
      }
      return origEnd(chunk, encoding, cb);
    };

    res.on('finish', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let json;
      try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
      resolve({ statusCode: res.statusCode, headers: res.getHeaders(), text, body: json });
    });
    res.on('error', reject);

    app(req, res);
    process.nextTick(() => {
      if (payload) req.push(payload);
      req.push(null);
    });
  });
}

function makeFakeResolveTrack() {
  return vi.fn(async want => {
    if (want.title === '找不到') return null;
    return {
      provider: want.provider || 'kugou',
      providerTrackId: want.id || `id-${want.title}`,
      kugouId: `hash-${want.title}`,
      title: want.title,
      artist: want.artist || '歌手',
      album: '专辑',
      duration: 210,
      cover: 'https://img.example/cover.jpg',
      upstreamUrl: `https://cdn.kugou.com/${encodeURIComponent(want.title)}.mp3`,
      score: 120,
    };
  });
}

async function bootTestApp(overrides = {}) {
  const { createApp } = await import('../server/app.js');
  const { dbApi } = await import('../server/db.js');
  activeDb = dbApi;
  const resolveTrack = overrides.resolveTrack || makeFakeResolveTrack();
  const synthesize = overrides.synthesize || vi.fn(async () => null);
  const instance = createApp({
    resolveTrack,
    synthesize,
    ...(overrides.multiSearch ? { multiSearch: overrides.multiSearch } : {}),
  });
  return {
    ...instance,
    dbApi,
    resolveTrack,
    synthesize,
    createFreshApp: (extra = {}) => createApp({
      resolveTrack,
      synthesize,
      ...extra,
    }),
  };
}

beforeEach(() => {
  dbCounter += 1;
  const dbPath = path.join(tmpRoot, `state-${dbCounter}.db`);
  mockExec.mockReset();
  mockExec.mockImplementation((_cmd, _opts, cb) => {
    const err = new Error('not installed');
    err.code = 'ENOENT';
    cb(err);
  });
  mockAxiosGet.mockReset();
  // 清空 VITEST 并指向临时 CLAUDIO_DB_PATH，让 server/db.js 真正落盘到隔离临时 SQLite 文件
  vi.stubEnv('VITEST', '');
  vi.stubEnv('CLAUDIO_DB_PATH', dbPath);
  vi.stubEnv('CLAUDIO_BRAIN', 'external');
  vi.stubEnv('BRAIN_MODE', '');
  vi.stubEnv('CLAUDIO_DJ', '');
  vi.stubEnv('DJ_ENABLED', '');
  vi.stubEnv('CLAUDIO_REQUIRE_TOKEN', '');
  vi.stubEnv('CLAUDIO_API_TOKEN', '');
  vi.stubEnv('CLAUDIO_ALLOWED_HOSTS', '');
  vi.stubEnv('CLAUDIO_DEFAULT_VOLUME', '');
  vi.stubEnv('MUSIC_PROVIDER', '');
  vi.stubEnv('KUGOU_COOKIE', '');
  vi.stubEnv('NETEASE_API_BASE', 'http://127.0.0.1:33401');
  vi.stubEnv('NETEASE_COOKIE', '');
  vi.stubEnv('QQ_API_BASE', 'http://127.0.0.1:33402');
  vi.stubEnv('OPENWEATHER_API_KEY', '');
  vi.stubEnv('FISH_API_KEY', '');
  vi.resetModules();
});

afterEach(() => {
  try { activeDb?.raw?.close?.(); } catch { /* ignore */ }
  activeDb = null;
  vi.unstubAllEnvs();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('外部 Agent 公开接口契约', () => {
  // 对应 README.md:29-30（自检：GET /api/health/integrations 含 kugou/netease/qq 与 loggedIn）
  it('GET /api/health/integrations 返回 kugou / netease / qq 三个键且各带布尔 loggedIn', async () => {
    mockAxiosGet.mockImplementation(async url => {
      if (url.includes('/user/detail')) {
        return { data: { status: 1, data: { userid: '1001', nickname: 'Tester' } } };
      }
      if (url.includes('/login/status')) {
        return {
          data: {
            data: {
              code: 200,
              account: { id: 2002, anonimousUser: false },
              profile: { userId: 2002, nickname: 'TesterNE' },
            },
          },
        };
      }
      if (url.includes('/health')) {
        return { data: { ok: true, loggedIn: false, musicid: 0 } };
      }
      return { data: {} };
    });

    const { app, dbApi } = await bootTestApp();
    dbApi.setPref('kugou_cookie', 'token=MOCK_KG;userid=1001');
    dbApi.setPref('netease_cookie', 'MUSIC_U=MOCK_NE');

    const res = await requestApp(app, 'GET', '/api/health/integrations');
    expect(res.statusCode).toBe(200);
    // README.md:29-30：检查三个音乐源（kugou/netease/qq）的 loggedIn 字段
    for (const provider of ['kugou', 'netease', 'qq']) {
      expect(res.body).toHaveProperty(provider);
      expect(typeof res.body[provider].loggedIn).toBe('boolean');
    }
    expect(res.body.kugou.loggedIn).toBe(true);
    expect(res.body.netease.loggedIn).toBe(true);
    expect(res.body.qq.loggedIn).toBe(false);
  });

  // 对应 README.md:43, 386（多源搜歌：GET /api/music/search）
  it('GET /api/music/search 返回 ok、provider、providersUsed 与 tracks[] 契约字段', async () => {
    const multiSearch = vi.fn(async () => ({
      provider: 'multi',
      providersUsed: ['kugou', 'netease'],
      tracks: [
        {
          provider: 'kugou',
          id: 'KG-1',
          hash: 'KG-1',
          title: '晴天',
          artist: '周杰伦',
          album: '叶惠美',
          duration: 269,
          cover: 'https://img.example/1.jpg',
          score: 140,
        },
        {
          provider: 'netease',
          id: 'NE-2',
          hash: 'netease:NE-2',
          title: '晴天',
          artist: '周杰伦',
          album: '叶惠美',
          duration: 269,
          cover: 'https://img.example/2.jpg',
          score: 130,
        },
      ],
    }));

    const { app } = await bootTestApp({ multiSearch });
    const res = await requestApp(app, 'GET', `/api/music/search?q=${encodeURIComponent('晴天 周杰伦')}`);
    expect(res.statusCode).toBe(200);
    // README.md:386：返回 ok、provider、providersUsed、tracks[] 字段形状
    expect(res.body.ok).toBe(true);
    expect(res.body.provider).toBe('multi');
    expect(Array.isArray(res.body.providersUsed)).toBe(true);
    expect(Array.isArray(res.body.tracks)).toBe(true);
    expect(res.body.tracks).toHaveLength(2);
    for (const track of res.body.tracks) {
      expect(track).toEqual(expect.objectContaining({
        provider: expect.any(String),
        id: expect.any(String),
        hash: expect.any(String),
        title: expect.any(String),
        artist: expect.any(String),
        album: expect.any(String),
        duration: expect.any(Number),
        cover: expect.any(String),
      }));
      expect('score' in track).toBe(true);
    }
  });

  // 对应 README.md:44-47, 364-374, 382（点歌：POST /api/queue/external replace 与 append）
  it('POST /api/queue/external 支持 replace 与 append，返回 say / matched[] / failed[] / queue', async () => {
    const { app } = await bootTestApp();

    // README.md:44-47, 382：replace 模式 + say + matched[]（含 provider/id）+ failed[] + queue(mode/added/length)
    const replaceRes = await requestApp(app, 'POST', '/api/queue/external', {
      body: {
        tracks: [
          { title: '晴天', artist: '周杰伦', id: 'KG-1', provider: 'kugou' },
          { title: '找不到', artist: '未知' },
        ],
        mode: 'replace',
        source: 'grok',
        agentId: 'grok-bot',
        say: '来了一首应景的',
        reason: '雨天·听歌',
      },
    });
    expect(replaceRes.statusCode).toBe(200);
    expect(replaceRes.body.ok).toBe(true);
    expect(replaceRes.body.say).toBe('来了一首应景的');
    expect(replaceRes.body.reason).toBe('雨天·听歌');
    expect(replaceRes.body.matched).toHaveLength(1);
    expect(replaceRes.body.matched[0]).toEqual(expect.objectContaining({
      provider: 'kugou',
      id: 'KG-1',
      title: '晴天',
    }));
    expect(replaceRes.body.failed).toHaveLength(1);
    expect(replaceRes.body.failed[0]).toEqual(expect.objectContaining({ title: '找不到' }));
    expect(replaceRes.body.queue).toEqual({ mode: 'replace', added: 1, length: 1 });

    // README.md:369, 374, 382：append 模式接到队尾，不打断当前曲目
    const appendRes = await requestApp(app, 'POST', '/api/queue/external', {
      body: {
        tracks: [{ title: '七里香', artist: '周杰伦', id: 'NE-2', provider: 'netease' }],
        mode: 'append',
        say: '再补一首',
      },
    });
    expect(appendRes.statusCode).toBe(200);
    expect(appendRes.body.ok).toBe(true);
    expect(appendRes.body.say).toBe('再补一首');
    expect(appendRes.body.matched).toHaveLength(1);
    expect(appendRes.body.matched[0]).toEqual(expect.objectContaining({
      provider: 'netease',
      id: 'NE-2',
      title: '七里香',
    }));
    expect(appendRes.body.failed).toEqual([]);
    expect(appendRes.body.queue).toEqual({ mode: 'append', added: 1, length: 2 });
  });

  // 对应 README.md:48-49, 570-572（队列播完自动续：PUT/GET/DELETE /api/continue-pool）
  it('PUT / GET / DELETE /api/continue-pool 完整读写与清空契约', async () => {
    const { app } = await bootTestApp();

    // README.md:48-49, 570-572：PUT /api/continue-pool 设置续播池并支持 shuffle
    const putRes = await requestApp(app, 'PUT', '/api/continue-pool', {
      body: {
        tracks: [
          { title: '晴天', artist: '周杰伦' },
          { title: '稻香', artist: '周杰伦' },
        ],
        shuffle: true,
      },
    });
    expect(putRes.statusCode).toBe(200);
    expect(putRes.body.ok).toBe(true);
    expect(putRes.body.matched).toHaveLength(2);
    expect(putRes.body.failed).toEqual([]);
    expect(putRes.body.continuePool).toEqual(expect.objectContaining({
      size: 2,
      shuffle: true,
      active: true,
    }));

    // README.md:570：GET /api/continue-pool 读取当前续播池及曲目预览
    const getRes = await requestApp(app, 'GET', '/api/continue-pool');
    expect(getRes.statusCode).toBe(200);
    expect(getRes.body.ok).toBe(true);
    expect(getRes.body.continuePool).toEqual(expect.objectContaining({
      size: 2,
      shuffle: true,
    }));
    expect(Array.isArray(getRes.body.continuePool.tracks)).toBe(true);
    expect(getRes.body.continuePool.tracks).toHaveLength(2);

    // README.md:570：DELETE /api/continue-pool 清空续播池
    const delRes = await requestApp(app, 'DELETE', '/api/continue-pool');
    expect(delRes.statusCode).toBe(200);
    expect(delRes.body).toEqual({ ok: true, continuePool: null });

    const afterDel = await requestApp(app, 'GET', '/api/continue-pool');
    expect(afterDel.body.continuePool).toBeNull();
  });

  // 对应 README.md:383, 390（播放控制：POST /api/control 的 next / pause / toggle / volume）
  it('POST /api/control 支持 next / pause / toggle / volume 并通过状态与存储验证持久化', async () => {
    const { app, createFreshApp } = await bootTestApp();

    await requestApp(app, 'POST', '/api/queue/external', {
      body: {
        tracks: [
          { title: '第一首', artist: 'A', id: 'h1', provider: 'kugou' },
          { title: '第二首', artist: 'B', id: 'h2', provider: 'netease' },
        ],
        mode: 'replace',
      },
    });

    // README.md:383：next 切下一首并记为 feedback.kind=skip
    const nextRes = await requestApp(app, 'POST', '/api/control', { body: { command: 'next' } });
    expect(nextRes.statusCode).toBe(200);
    expect(nextRes.body).toEqual(expect.objectContaining({
      ok: true,
      command: 'next',
      say: expect.any(String),
      index: 1,
      paused: false,
      volume: 30,
    }));
    expect(nextRes.body.nowPlaying).toEqual(expect.objectContaining({ title: '第二首' }));
    expect(Array.isArray(nextRes.body.queue)).toBe(true);

    // README.md:390：经由公开接口 GET /api/plays 核对 skip 反馈落库
    const playsRes = await requestApp(app, 'GET', '/api/plays');
    expect(playsRes.statusCode).toBe(200);
    expect(playsRes.body.feedback).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'skip', title: '第一首' }),
    ]));

    // README.md:383：pause 暂停且不改音量
    const pauseRes = await requestApp(app, 'POST', '/api/control', { body: { command: 'pause' } });
    expect(pauseRes.statusCode).toBe(200);
    expect(pauseRes.body).toEqual(expect.objectContaining({
      ok: true,
      command: 'pause',
      say: expect.any(String),
      paused: true,
      volume: 30,
    }));

    // README.md:383：toggle 暂停中恢复播放，播放中再次暂停，且不改音量
    const toggleResume = await requestApp(app, 'POST', '/api/control', { body: { command: 'toggle' } });
    expect(toggleResume.statusCode).toBe(200);
    expect(toggleResume.body).toEqual(expect.objectContaining({
      ok: true,
      command: 'toggle',
      paused: false,
      volume: 30,
    }));
    const togglePause = await requestApp(app, 'POST', '/api/control', { body: { command: 'toggle' } });
    expect(togglePause.body).toEqual(expect.objectContaining({
      ok: true,
      command: 'toggle',
      paused: true,
      volume: 30,
    }));

    // README.md:383-384：volume 0-100 生效并立刻记住（用 GET /api/status 与新实例重启读回验证持久化）
    const volRes = await requestApp(app, 'POST', '/api/control', { body: { command: 'volume', value: 45 } });
    expect(volRes.statusCode).toBe(200);
    expect(volRes.body).toEqual(expect.objectContaining({
      ok: true,
      command: 'volume',
      say: expect.any(String),
      volume: 45,
    }));

    const statusRes = await requestApp(app, 'GET', '/api/status');
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.body.volume).toBe(45);

    const reloaded = createFreshApp();
    const reloadedStatus = await requestApp(reloaded.app, 'GET', '/api/status');
    expect(reloadedStatus.statusCode).toBe(200);
    expect(reloadedStatus.body.volume).toBe(45);
  });

  // 对应 README.md:384（状态：GET /api/status 与 GET /api/now）
  it('GET /api/status 与 GET /api/now 返回 README 列出的状态字段且 brain 经真实配置为 external', async () => {
    const { app } = await bootTestApp();

    await requestApp(app, 'POST', '/api/queue/external', {
      body: {
        tracks: [
          { title: '晴天', artist: '周杰伦', provider: 'kugou', reason: '雨天单曲' },
        ],
        mode: 'replace',
        say: '今晚听这个',
        reason: '雨天',
        source: 'grok',
      },
    });

    // README.md:384：GET /api/status 与 GET /api/now 字段一致
    const snapshots = [];
    for (const urlPath of ['/api/status', '/api/now']) {
      const res = await requestApp(app, 'GET', urlPath);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual(expect.objectContaining({
        brain: 'external',
        provider: 'kugou',
        musicProvider: 'multi',
        providers: expect.arrayContaining(['kugou', 'netease', 'qq']),
        nowPlaying: expect.objectContaining({
          title: '晴天',
          artist: '周杰伦',
          reason: '雨天单曲',
          cover: 'https://img.example/cover.jpg',
          queuedAt: expect.any(String),
        }),
        index: 0,
        paused: false,
        volume: 30,
        currentTime: expect.any(Number),
        duration: expect.any(Number),
        active: false,
        listeners: 0,
        lastSay: '今晚听这个',
        reason: '雨天',
        queuedAt: expect.any(String),
        source: 'grok',
      }));
      expect(Array.isArray(res.body.queue)).toBe(true);
      expect(res.body.queue[0]).toEqual(expect.objectContaining({
        reason: '雨天单曲',
        cover: 'https://img.example/cover.jpg',
        queuedAt: res.body.queuedAt,
      }));
      snapshots.push(res.body);
    }
    const statusContractFields = [
      'brain', 'provider', 'musicProvider', 'providers', 'nowPlaying',
      'queue', 'index', 'paused', 'volume', 'currentTime', 'duration',
      'active', 'listeners', 'lastSay', 'reason', 'queuedAt', 'source',
    ];
    const pickContractFields = body => Object.fromEntries(
      statusContractFields.map(key => [key, body[key]]),
    );
    expect(pickContractFields(snapshots[1])).toEqual(pickContractFields(snapshots[0]));
  });

  // 对应 README.md:400（聊天 external：8 个斜杠命令表驱动验证公开效果）
  describe('POST /api/chat（external 模式）', () => {
    const slashCases = [
      {
        name: '/skip 切到下一首并记录 skip 反馈',
        message: '/skip',
        async verify({ app, res }) {
          expect(res.body.say).toContain('第二首');
          const status = await requestApp(app, 'GET', '/api/status');
          expect(status.body.index).toBe(1);
          expect(status.body.nowPlaying).toEqual(expect.objectContaining({ title: '第二首' }));
          expect(status.body.paused).toBe(false);
          const plays = await requestApp(app, 'GET', '/api/plays');
          expect(plays.body.feedback).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'skip', title: '第一首' }),
          ]));
        },
      },
      {
        name: '/prev 切回上一首',
        message: '/prev',
        async setup(app) {
          await requestApp(app, 'POST', '/api/control', { body: { command: 'next' } });
        },
        async verify({ app, res }) {
          expect(res.body.say).toContain('第一首');
          const status = await requestApp(app, 'GET', '/api/status');
          expect(status.body.index).toBe(0);
          expect(status.body.nowPlaying).toEqual(expect.objectContaining({ title: '第一首' }));
          expect(status.body.paused).toBe(false);
        },
      },
      {
        name: '/pause 暂停播放',
        message: '/pause',
        async verify({ app, res }) {
          expect(typeof res.body.say).toBe('string');
          expect(res.body.say.length).toBeGreaterThan(0);
          const status = await requestApp(app, 'GET', '/api/status');
          expect(status.body.paused).toBe(true);
        },
      },
      {
        name: '/play 从暂停恢复播放',
        message: '/play',
        async setup(app) {
          await requestApp(app, 'POST', '/api/control', { body: { command: 'pause' } });
        },
        async verify({ app, res }) {
          expect(typeof res.body.say).toBe('string');
          expect(res.body.say.length).toBeGreaterThan(0);
          const status = await requestApp(app, 'GET', '/api/status');
          expect(status.body.paused).toBe(false);
        },
      },
      {
        name: '/toggle 在播放与暂停间切换',
        message: '/toggle',
        async verify({ app, res }) {
          expect(typeof res.body.say).toBe('string');
          const afterPause = await requestApp(app, 'GET', '/api/status');
          expect(afterPause.body.paused).toBe(true);

          const second = await requestApp(app, 'POST', '/api/chat', { body: { message: '/toggle' } });
          expect(second.statusCode).toBe(200);
          const afterResume = await requestApp(app, 'GET', '/api/status');
          expect(afterResume.body.paused).toBe(false);
        },
      },
      {
        name: '/vol N 设置音量并持久化',
        message: '/vol 40',
        async verify({ app, createFreshApp, res }) {
          expect(res.body.say).toContain('40');
          const status = await requestApp(app, 'GET', '/api/status');
          expect(status.body.volume).toBe(40);
          const reloaded = createFreshApp();
          const reloadedStatus = await requestApp(reloaded.app, 'GET', '/api/status');
          expect(reloadedStatus.body.volume).toBe(40);
        },
      },
      {
        name: '/now 返回当前曲目信息且不改变播放状态',
        message: '/now',
        async verify({ app, res }) {
          expect(res.body.say).toContain('第一首');
          expect(res.body.say).toContain('歌手A');
          const status = await requestApp(app, 'GET', '/api/status');
          expect(status.body.index).toBe(0);
          expect(status.body.paused).toBe(false);
        },
      },
      {
        name: '/queue 列出当前队列曲目且不改变播放状态',
        message: '/queue',
        async verify({ app, res }) {
          expect(res.body.say).toContain('第一首');
          expect(res.body.say).toContain('第二首');
          const status = await requestApp(app, 'GET', '/api/status');
          expect(status.body.index).toBe(0);
          expect(status.body.paused).toBe(false);
        },
      },
    ];

    it.each(slashCases)('斜杠命令 $name', async ({ message, setup, verify }) => {
      const { app, createFreshApp } = await bootTestApp();
      await requestApp(app, 'POST', '/api/queue/external', {
        body: {
          tracks: [
            { title: '第一首', artist: '歌手A', id: 'h1', provider: 'kugou' },
            { title: '第二首', artist: '歌手B', id: 'h2', provider: 'netease' },
          ],
          mode: 'replace',
        },
      });
      if (setup) await setup(app);

      const res = await requestApp(app, 'POST', '/api/chat', { body: { message } });
      expect(res.statusCode).toBe(200);
      await verify({ app, createFreshApp, res });
    });

    // 对应 README.md:400：普通文字返回固定提示原文，不调用 Claude（不锁未公开字段）
    it('普通文字返回外部主持模式提示原文且不调用模型', async () => {
      const { app } = await bootTestApp();

      const textRes = await requestApp(app, 'POST', '/api/chat', {
        body: { message: '帮我放点雨天的歌' },
      });
      expect(textRes.statusCode).toBe(200);
      expect(textRes.body.say).toBe(EXTERNAL_CHAT_HINT);
    });
  });

  // 对应 README.md:401（开机 external：不调用模型，返回当前 queue/index、brain: "external"、skipped: true）
  it('POST /api/boot 在 external 下不调用模型，返回当前 queue/index、brain: "external" 与 skipped: true', async () => {
    const { app } = await bootTestApp();

    await requestApp(app, 'POST', '/api/queue/external', {
      body: {
        tracks: [{ title: '晴天', artist: '周杰伦', id: 'h1', provider: 'kugou' }],
        mode: 'replace',
        say: '主持人已点歌',
      },
    });

    // README.md:401：返回当前 queue 和 index，brain: "external"，skipped: true
    const res = await requestApp(app, 'POST', '/api/boot');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      brain: 'external',
      skipped: true,
      index: 0,
    }));
    expect(res.body.queue).toHaveLength(1);
    expect(res.body.queue[0]).toEqual(expect.objectContaining({
      title: '晴天',
      artist: '周杰伦',
    }));
  });
});
