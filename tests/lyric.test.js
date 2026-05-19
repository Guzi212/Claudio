import { describe, it, expect, vi, beforeEach } from 'vitest';

const lyricMock = vi.hoisted(() => vi.fn());

vi.mock('../server/services/kugou.js', () => ({
  lyric: lyricMock,
  default: { lyric: lyricMock },
}));

beforeEach(() => {
  lyricMock.mockReset();
  vi.resetModules();
});

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

describe('mountLyricRoute', () => {
  it('在 app 上注册 GET /api/lyric', async () => {
    const { mountLyricRoute } = await import('../server/api/lyric.js');
    const app = { get: vi.fn() };
    mountLyricRoute(app);
    expect(app.get).toHaveBeenCalledWith('/api/lyric', expect.any(Function));
  });

  it('缺 hash 返 400', async () => {
    const { mountLyricRoute } = await import('../server/api/lyric.js');
    let handler;
    mountLyricRoute({ get: (_p, h) => { handler = h; } });

    const r = mockRes();
    await handler({ query: {} }, r);
    expect(r.statusCode).toBe(400);
  });

  it('有 hash 时透传 kugou.lyric 的结果', async () => {
    lyricMock.mockResolvedValueOnce('[00:01.00]LRC 文本');
    const { mountLyricRoute } = await import('../server/api/lyric.js');
    let handler;
    mountLyricRoute({ get: (_p, h) => { handler = h; } });

    const r = mockRes();
    await handler({ query: { hash: 'abc123' } }, r);
    expect(lyricMock).toHaveBeenCalledWith('abc123');
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ lyric: '[00:01.00]LRC 文本' });
  });

  it('上游拿不到歌词时返 { lyric: null }', async () => {
    lyricMock.mockResolvedValueOnce(null);
    const { mountLyricRoute } = await import('../server/api/lyric.js');
    let handler;
    mountLyricRoute({ get: (_p, h) => { handler = h; } });

    const r = mockRes();
    await handler({ query: { hash: 'no-such' } }, r);
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ lyric: null });
  });
});
