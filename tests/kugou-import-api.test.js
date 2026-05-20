import { describe, it, expect, vi } from 'vitest';
import { upsertDistilled, mountKugouImportApiRoute } from '../server/api/kugou-import-api.js';

function mockApp() {
  const routes = {};
  return {
    routes,
    post(p, h) { routes[`POST ${p}`] = h; },
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

describe('upsertDistilled', () => {
  const start = '<!-- kugou-distilled:start -->';
  const end   = '<!-- kugou-distilled:end -->';

  it('无现有区块 → 追加', () => {
    const out = upsertDistilled('# 我的偏好', '## 蒸馏内容');
    expect(out).toContain('# 我的偏好');
    expect(out).toContain(start);
    expect(out).toContain('## 蒸馏内容');
    expect(out).toContain(end);
  });

  it('已有区块 → 替换', () => {
    const existing = `前缀\n${start}\n旧内容\n${end}\n后缀`;
    const out = upsertDistilled(existing, '新蒸馏');
    expect(out).toContain('前缀');
    expect(out).toContain('新蒸馏');
    expect(out).not.toContain('旧内容');
    expect(out).toContain('后缀');
  });

  it('summary trim 掉首尾空白', () => {
    const out = upsertDistilled('', '  内容  ');
    expect(out).toContain(`${start}\n内容\n${end}`);
  });
});

describe('mountKugouImportApiRoute', () => {
  it('注册 POST /api/kugou/import', () => {
    const app = mockApp();
    mountKugouImportApiRoute(app, { importFromShareUrl: async () => ({}), rootDir: '/tmp' });
    expect(app.routes['POST /api/kugou/import']).toBeTypeOf('function');
  });

  it('url 缺失 → 400', async () => {
    const app = mockApp();
    mountKugouImportApiRoute(app, { importFromShareUrl: async () => ({}), rootDir: '/tmp' });
    const res = mockRes();
    await app.routes['POST /api/kugou/import']({ body: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('url 仅空白 → 400', async () => {
    const app = mockApp();
    mountKugouImportApiRoute(app, { importFromShareUrl: async () => ({}), rootDir: '/tmp' });
    const res = mockRes();
    await app.routes['POST /api/kugou/import']({ body: { url: '   ' } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('非法 bucket → 400', async () => {
    const app = mockApp();
    mountKugouImportApiRoute(app, { importFromShareUrl: async () => ({}), rootDir: '/tmp' });
    const res = mockRes();
    await app.routes['POST /api/kugou/import']({ body: { url: 'http://x.com', bucket: 'bad' } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('成功：调 importFromShareUrl 并写文件 → ok + 计数', async () => {
    const fakeResult = {
      tracks: [
        { title: 'T1', artist: 'A1', album: '', bucket: 'long_term', likeLevel: null, source: '', note: '', language: '', publishDate: '', bpm: null, hash: '' },
      ],
      fetchedCount: 1,
      totalCount: 1,
      truncated: false,
    };
    const importFn = vi.fn(async () => fakeResult);

    // 用临时目录，applyImport 会写文件
    const os = await import('node:os');
    const rootDir = os.tmpdir();

    const app = mockApp();
    mountKugouImportApiRoute(app, { importFromShareUrl: importFn, rootDir });
    const res = mockRes();
    await app.routes['POST /api/kugou/import']({ body: { url: 'http://t1.kugou.com/abc' } }, res);

    expect(importFn).toHaveBeenCalledWith('http://t1.kugou.com/abc', { bucket: 'long_term', playlistName: '' });
    expect(res.body.ok).toBe(true);
    expect(res.body.tracksCount).toBe(1);
    expect(res.body.truncated).toBe(false);
  });

  it('importFromShareUrl 抛错 → 500', async () => {
    const app = mockApp();
    mountKugouImportApiRoute(app, {
      importFromShareUrl: async () => { throw new Error('net fail'); },
      rootDir: '/tmp',
    });
    const res = mockRes();
    await app.routes['POST /api/kugou/import']({ body: { url: 'http://x.com' } }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('net fail');
  });
});
