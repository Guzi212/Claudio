import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const prefMem = vi.hoisted(() => new Map());

// 让 server/tts.js 拿到的 axios 是 mock
vi.mock('axios', () => ({
  default: { post: vi.fn() },
}));

vi.mock('../server/db.js', () => ({
  dbApi: {
    getPref: k => (prefMem.has(k) ? prefMem.get(k) : null),
    setPref: (k, v) => { prefMem.set(k, String(v)); },
    delPref: k => { prefMem.delete(k); },
  },
}));

let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-tts-'));
  process.env.TTS_CACHE_DIR = tempDir;
  process.env.FISH_API_KEY = 'fake-key';
  process.env.FISH_VOICE_ID = 'fake-voice';
  prefMem.clear();
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.TTS_CACHE_DIR;
  delete process.env.FISH_API_KEY;
  delete process.env.FISH_VOICE_ID;
  vi.resetAllMocks();
});

describe('synthesize', () => {
  it('空字符串 / 纯空白 / null 都返回 null', async () => {
    const { synthesize } = await import('../server/tts.js');
    expect(await synthesize('')).toBeNull();
    expect(await synthesize('   ')).toBeNull();
    expect(await synthesize(null)).toBeNull();
    expect(await synthesize(undefined)).toBeNull();
  });

  it('没有 FISH_API_KEY 时返回 null 并 console.warn', async () => {
    const { synthesize } = await import('../server/tts.js');
    delete process.env.FISH_API_KEY;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await synthesize('早安')).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('第一次合成写缓存，第二次同样输入直接命中（无网络请求）', async () => {
    const axios = (await import('axios')).default;
    axios.post.mockResolvedValue({ data: Buffer.from('FAKE_MP3_BYTES') });

    const { synthesize } = await import('../server/tts.js');

    const first = await synthesize('早安');
    expect(first).not.toBeNull();
    expect(first.hash).toMatch(/^[a-f0-9]{40}$/);
    expect(first.url).toBe(`/tts/${first.hash}.mp3`);
    expect(fs.existsSync(first.filePath)).toBe(true);
    expect(fs.readFileSync(first.filePath).toString()).toBe('FAKE_MP3_BYTES');
    expect(axios.post).toHaveBeenCalledTimes(1);

    const second = await synthesize('早安');
    expect(second).toEqual(first);
    expect(axios.post).toHaveBeenCalledTimes(1); // 命中缓存，没再发请求
  });

  it('不同 text 或不同 voiceId 落到不同的 hash', async () => {
    const axios = (await import('axios')).default;
    axios.post.mockResolvedValue({ data: Buffer.from('x') });
    const { synthesize } = await import('../server/tts.js');

    const a = await synthesize('早安');
    const b = await synthesize('晚安');
    expect(a.hash).not.toBe(b.hash);

    process.env.FISH_VOICE_ID = 'another-voice';
    const c = await synthesize('早安');
    expect(c.hash).not.toBe(a.hash);
  });

  it('Fish Audio 调用失败时返回 null 并 console.error', async () => {
    const axios = (await import('axios')).default;
    axios.post.mockRejectedValue(new Error('network down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { synthesize } = await import('../server/tts.js');
    expect(await synthesize('hello')).toBeNull();
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  it('调用 Fish Audio 时带 Bearer + 正确 body 字段', async () => {
    const axios = (await import('axios')).default;
    axios.post.mockResolvedValue({ data: Buffer.from('x') });

    const { synthesize } = await import('../server/tts.js');
    await synthesize('hi');

    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url, body, config] = axios.post.mock.calls[0];
    expect(url).toBe('https://api.fish.audio/v1/tts');
    expect(body).toMatchObject({ text: 'hi', reference_id: 'fake-voice', format: 'mp3' });
    expect(config.headers.Authorization).toBe('Bearer fake-key');
    expect(config.responseType).toBe('arraybuffer');
  });

  it('prefs.fish_api_key / fish_voice_id 优先于 .env', async () => {
    const axios = (await import('axios')).default;
    axios.post.mockResolvedValue({ data: Buffer.from('x') });
    prefMem.set('fish_api_key', 'pref-key');
    prefMem.set('fish_voice_id', 'pref-voice');

    const { synthesize } = await import('../server/tts.js');
    await synthesize('hello');

    expect(axios.post).toHaveBeenCalledTimes(1);
    const [, body, config] = axios.post.mock.calls[0];
    expect(body.reference_id).toBe('pref-voice');
    expect(config.headers.Authorization).toBe('Bearer pref-key');
  });
});

describe('mountTtsRoutes', () => {
  it('在 app 上注册 GET /tts/:hash.mp3', async () => {
    const { mountTtsRoutes } = await import('../server/tts.js');
    const app = { get: vi.fn() };
    mountTtsRoutes(app);
    expect(app.get).toHaveBeenCalledWith('/tts/:hash.mp3', expect.any(Function));
  });

  it('handler 拒绝非法 hash（防路径穿越）', async () => {
    const { mountTtsRoutes } = await import('../server/tts.js');
    let handler;
    mountTtsRoutes({ get: (_p, h) => { handler = h; } });

    const r = mockRes();
    handler({ params: { hash: '../etc/passwd' } }, r);
    expect(r.statusCode).toBe(400);
  });

  it('handler 对合法但不存在的 hash 返回 404', async () => {
    const { mountTtsRoutes } = await import('../server/tts.js');
    let handler;
    mountTtsRoutes({ get: (_p, h) => { handler = h; } });

    const r = mockRes();
    handler({ params: { hash: 'a'.repeat(40) } }, r);
    expect(r.statusCode).toBe(404);
  });
});

function mockRes() {
  const headers = {};
  return {
    statusCode: 200,
    headers,
    status(code) { this.statusCode = code; return this; },
    send() { return this; },
    setHeader(k, v) { headers[k] = v; },
  };
}
