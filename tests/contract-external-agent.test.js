// 外部 Agent 公开接口契约测试：锁住 README.md「外部 Agent 接入」和「Claudio主持人工具接口」
// 写明的对外字段与行为，不碰网络、不读真实 .env 或 state.db。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prefMem = vi.hoisted(() => new Map());
const mockExec = vi.hoisted(() => vi.fn());
const mockAxiosGet = vi.hoisted(() => vi.fn());

vi.mock('dotenv/config', () => ({}));

vi.mock('../server/db.js', () => ({
  dbApi: {
    getPref: k => (prefMem.has(k) ? prefMem.get(k) : null),
    setPref: (k, v) => { prefMem.set(k, String(v)); },
    delPref: k => { prefMem.delete(k); },
    addPlay: vi.fn(),
    addFeedback: vi.fn(() => 1),
    addMessage: vi.fn(),
  },
}));

vi.mock('node:child_process', () => ({ exec: mockExec }));

vi.mock('axios', () => ({
  default: {
    get: mockAxiosGet,
    create: (cfg = {}) => ({
      get: (url, opts) => mockAxiosGet(cfg.baseURL ? `${cfg.baseURL}${url}` : url, opts),
    }),
  },
}));

function createMockApp() {
  const routes = {};
  const app = { routes };
  for (const method of ['get', 'post', 'put', 'delete']) {
    app[method] = (path, handler) => {
      routes[`${method.toUpperCase()} ${path}`] = handler;
    };
  }
  async function invoke(methodAndPath, { body = {}, query = {} } = {}) {
    const handler = routes[methodAndPath];
    if (!handler) throw new Error(`Route not registered: ${methodAndPath}`);
    const res = {
      statusCode: 200,
      body: undefined,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = structuredClone(payload); return this; },
    };
    await handler({ body, query }, res);
    return res;
  }
  return { app, invoke };
}

beforeEach(() => {
  prefMem.clear();
  mockExec.mockReset();
  mockExec.mockImplementation((_cmd, _opts, cb) => {
    const err = new Error('not installed');
    err.code = 'ENOENT';
    cb(err);
  });
  mockAxiosGet.mockReset();
  vi.stubEnv('KUGOU_COOKIE', '');
  vi.stubEnv('NETEASE_API_BASE', 'http://127.0.0.1:33401');
  vi.stubEnv('NETEASE_COOKIE', '');
  vi.stubEnv('QQ_API_BASE', 'http://127.0.0.1:33402');
  vi.stubEnv('OPENWEATHER_API_KEY', '');
  vi.stubEnv('FISH_API_KEY', '');
  vi.stubEnv('CLAUDIO_BRAIN', 'external');
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('外部 Agent 公开接口契约', () => {
  // 对应 README.md:29-30（自检：GET /api/health/integrations 含 kugou/netease/qq 与 loggedIn）
  it('GET /api/health/integrations 返回 kugou / netease / qq 三个键且各带布尔 loggedIn', async () => {
    prefMem.set('kugou_cookie', 'token=MOCK_KG;userid=1001');
    prefMem.set('netease_cookie', 'MUSIC_U=MOCK_NE');

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

    const { mountHealthRoute } = await import('../server/api/health.js');
    const { app, invoke } = createMockApp();
    mountHealthRoute(app);

    const res = await invoke('GET /api/health/integrations');
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
    const { mountSearchRoute } = await import('../server/api/search.js');
    const { app, invoke } = createMockApp();
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
    mountSearchRoute(app, { multiSearch });

    const res = await invoke('GET /api/music/search', { query: { q: '晴天 周杰伦' } });
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
    const { mountExternalQueueRoutes } = await import('../server/api/external-queue.js');
    const { app, invoke } = createMockApp();
    const runtime = { queue: [], index: 0, paused: true, volume: 35, lastSay: '', lastReason: '' };
    const resolveTrack = vi.fn(async want => {
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
    mountExternalQueueRoutes(app, {
      runtime,
      resolveTrack,
      synthesize: vi.fn(async () => null),
      broadcast: vi.fn(),
      db: { addPlay: vi.fn() },
    });

    // README.md:44-47, 382：replace 模式 + say + matched[]（含 provider/id）+ failed[] + queue(mode/added/length)
    const replaceRes = await invoke('POST /api/queue/external', {
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
    const appendRes = await invoke('POST /api/queue/external', {
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

  // 对应 README.md:48-49（队列播完自动续：PUT/GET/DELETE /api/continue-pool）
  it('PUT / GET / DELETE /api/continue-pool 完整读写与清空契约', async () => {
    const { mountContinuePoolRoutes } = await import('../server/api/continue-pool.js');
    const { app, invoke } = createMockApp();
    const prefs = new Map();
    const db = {
      getPref: k => prefs.get(k) ?? null,
      setPref: (k, v) => prefs.set(k, String(v)),
      delPref: k => prefs.delete(k),
    };
    const runtime = { queue: [], index: 0, continuePool: null };
    const resolveTrack = vi.fn(async want => ({
      provider: 'kugou',
      kugouId: `hash-${want.title}`,
      title: want.title,
      artist: want.artist || '',
      album: '专辑',
      duration: 200,
      cover: 'https://img.example/cover.jpg',
    }));
    mountContinuePoolRoutes(app, { runtime, db, resolveTrack, broadcast: vi.fn() });

    // README.md:48-49：PUT /api/continue-pool 设置续播池并支持 shuffle
    const putRes = await invoke('PUT /api/continue-pool', {
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

    // GET /api/continue-pool 读取当前续播池
    const getRes = await invoke('GET /api/continue-pool');
    expect(getRes.statusCode).toBe(200);
    expect(getRes.body.ok).toBe(true);
    expect(getRes.body.continuePool).toEqual(expect.objectContaining({
      size: 2,
      shuffle: true,
    }));
    expect(Array.isArray(getRes.body.continuePool.tracks)).toBe(true);
    expect(getRes.body.continuePool.tracks).toHaveLength(2);

    // DELETE /api/continue-pool 清空续播池
    const delRes = await invoke('DELETE /api/continue-pool');
    expect(delRes.statusCode).toBe(200);
    expect(delRes.body).toEqual({ ok: true, continuePool: null });

    const afterDel = await invoke('GET /api/continue-pool');
    expect(afterDel.body.continuePool).toBeNull();
  });

  // 对应 README.md:383（播放控制：POST /api/control 的 next / pause / toggle / volume）
  it('POST /api/control 支持 next / pause / toggle / volume 并返回契约字段', async () => {
    const { mountControlRoute } = await import('../server/api/control.js');
    const { app, invoke } = createMockApp();
    const runtime = {
      queue: [
        { title: '第一首', artist: 'A', kugouId: 'h1', provider: 'kugou' },
        { title: '第二首', artist: 'B', kugouId: 'h2', provider: 'netease' },
      ],
      index: 0,
      paused: false,
      volume: 30,
    };
    const db = { addFeedback: vi.fn(() => 1) };
    const rememberVolume = vi.fn();
    mountControlRoute(app, { runtime, broadcast: vi.fn(), db, rememberVolume });

    // README.md:383：next 切下一首并记录 skip
    const nextRes = await invoke('POST /api/control', { body: { command: 'next' } });
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
    expect(db.addFeedback).toHaveBeenCalledWith(expect.objectContaining({ kind: 'skip', title: '第一首' }));

    // README.md:383：pause 暂停且不改音量
    const pauseRes = await invoke('POST /api/control', { body: { command: 'pause' } });
    expect(pauseRes.statusCode).toBe(200);
    expect(pauseRes.body).toEqual(expect.objectContaining({
      ok: true,
      command: 'pause',
      say: expect.any(String),
      paused: true,
      volume: 30,
    }));

    // README.md:383：toggle 暂停中恢复播放，播放中再次暂停
    const toggleResume = await invoke('POST /api/control', { body: { command: 'toggle' } });
    expect(toggleResume.statusCode).toBe(200);
    expect(toggleResume.body).toEqual(expect.objectContaining({
      ok: true,
      command: 'toggle',
      paused: false,
      volume: 30,
    }));
    const togglePause = await invoke('POST /api/control', { body: { command: 'toggle' } });
    expect(togglePause.body).toEqual(expect.objectContaining({
      ok: true,
      command: 'toggle',
      paused: true,
      volume: 30,
    }));

    // README.md:383：volume 0-100 生效并立刻记住
    const volRes = await invoke('POST /api/control', { body: { command: 'volume', value: 45 } });
    expect(volRes.statusCode).toBe(200);
    expect(volRes.body).toEqual(expect.objectContaining({
      ok: true,
      command: 'volume',
      say: expect.any(String),
      volume: 45,
    }));
    expect(rememberVolume).toHaveBeenCalledWith(45, { force: true });
  });

  // 对应 README.md:384（状态：GET /api/status 与 GET /api/now）
  it('GET /api/status 返回 README 列出的状态字段且 brain 为 external', async () => {
    const { mountRuntimeRoutes } = await import('../server/api/runtime.js');
    const { app, invoke } = createMockApp();
    const queuedAt = '2026-11-23T12:00:00.000Z';
    const runtime = {
      queue: [
        {
          title: '晴天',
          artist: '周杰伦',
          provider: 'kugou',
          reason: '雨天单曲',
          cover: 'https://img.example/cover.jpg',
          queuedAt,
        },
      ],
      index: 0,
      paused: false,
      volume: 30,
      currentTime: 15,
      duration: 269,
      active: true,
      lastSay: '今晚听这个',
      lastReason: '雨天',
      queuedAt,
      queuedSource: 'grok',
    };
    mountRuntimeRoutes(app, {
      runtime,
      broadcast: vi.fn(),
      db: { getPref: () => null, setPref: () => {}, delPref: () => {} },
      statusOptions: () => ({
        brain: 'external',
        provider: 'multi',
        providers: ['kugou', 'netease'],
        listeners: 1,
      }),
    });

    // README.md:384：GET /api/status 与 GET /api/now 字段一致
    for (const path of ['/api/status', '/api/now']) {
      const res = await invoke(`GET ${path}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual(expect.objectContaining({
        brain: 'external',
        provider: 'kugou',
        musicProvider: 'multi',
        providers: ['kugou', 'netease'],
        nowPlaying: expect.objectContaining({
          title: '晴天',
          artist: '周杰伦',
          reason: '雨天单曲',
          cover: 'https://img.example/cover.jpg',
          queuedAt,
        }),
        index: 0,
        paused: false,
        volume: 30,
        currentTime: 15,
        duration: 269,
        active: true,
        listeners: 1,
        lastSay: '今晚听这个',
        reason: '雨天',
        queuedAt,
        source: 'grok',
      }));
      expect(Array.isArray(res.body.queue)).toBe(true);
      expect(res.body.queue[0]).toEqual(expect.objectContaining({
        reason: '雨天单曲',
        cover: 'https://img.example/cover.jpg',
        queuedAt,
      }));
    }
  });

  // 对应 README.md:400（聊天 external：斜杠命令照常执行，普通文字不调模型）
  it('POST /api/chat 在 external 下执行斜杠命令，普通文字不调用模型', async () => {
    const { mountChatRoute } = await import('../server/api/chat.js');
    const { app, invoke } = createMockApp();
    const runtime = {
      queue: [{ title: '晴天', artist: '周杰伦', kugouId: 'h1' }],
      index: 0,
      paused: false,
      volume: 30,
    };
    const ask = vi.fn();
    const buildSystemPrompt = vi.fn();
    const rememberVolume = vi.fn();
    mountChatRoute(app, {
      runtime,
      brain: 'external',
      ask,
      buildSystemPrompt,
      rememberVolume,
      broadcast: vi.fn(),
      db: { addMessage: vi.fn(), addFeedback: vi.fn() },
    });

    // README.md:400：控制命令 /pause、/vol 40 照常执行
    const pauseRes = await invoke('POST /api/chat', { body: { message: '/pause' } });
    expect(pauseRes.statusCode).toBe(200);
    expect(pauseRes.body.paused).toBe(true);
    expect(typeof pauseRes.body.say).toBe('string');

    const volRes = await invoke('POST /api/chat', { body: { message: '/vol 40' } });
    expect(volRes.statusCode).toBe(200);
    expect(volRes.body.volume).toBe(40);
    expect(rememberVolume).toHaveBeenCalledWith(40, { force: true });

    // README.md:400：普通文字不调用模型，返回提示且 queue 为空
    const textRes = await invoke('POST /api/chat', { body: { message: '帮我放点雨天的歌' } });
    expect(textRes.statusCode).toBe(200);
    expect(textRes.body.brain).toBe('external');
    expect(textRes.body.queue).toEqual([]);
    expect(typeof textRes.body.say).toBe('string');
    expect(textRes.body.say.length).toBeGreaterThan(0);
    expect(ask).not.toHaveBeenCalled();
    expect(buildSystemPrompt).not.toHaveBeenCalled();
  });

  // 对应 README.md:401（开机 external：不调用模型，返回当前 queue/index、brain: "external"、skipped: true）
  it('POST /api/boot 在 external 下不调用模型，返回 brain: "external" 与 skipped: true', async () => {
    const { mountBootRoute } = await import('../server/api/boot.js');
    const { app, invoke } = createMockApp();
    const runtime = {
      queue: [{ title: '晴天', artist: '周杰伦', kugouId: 'h1' }],
      index: 0,
      paused: false,
      lastSay: '主持人已点歌',
    };
    const ask = vi.fn();
    const buildSystemPrompt = vi.fn();
    mountBootRoute(app, {
      runtime,
      brain: 'external',
      ask,
      buildSystemPrompt,
      broadcast: vi.fn(),
      db: { addMessage: vi.fn(), addPlay: vi.fn() },
    });

    // README.md:401：返回当前 queue 和 index，brain: "external"，skipped: true
    const res = await invoke('POST /api/boot');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      brain: 'external',
      skipped: true,
      index: 0,
    }));
    expect(res.body.queue).toEqual(runtime.queue);
    expect(ask).not.toHaveBeenCalled();
    expect(buildSystemPrompt).not.toHaveBeenCalled();
  });
});
