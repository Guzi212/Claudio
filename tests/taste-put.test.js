import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let rootDir;
let userDir;

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-taste-'));
  userDir = path.join(rootDir, 'user');
  fs.mkdirSync(userDir);
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

function mockApp() {
  const routes = {};
  return {
    routes,
    get(p, h) { routes[`GET ${p}`] = h; },
    put(p, h) { routes[`PUT ${p}`] = h; },
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

describe('mountTasteRoutes (PUT)', () => {
  it('注册 PUT /api/taste', async () => {
    const { mountTasteRoutes } = await import('../server/api/taste.js');
    const app = mockApp();
    mountTasteRoutes(app, { rootDir });
    expect(app.routes['PUT /api/taste']).toBeTypeOf('function');
  });

  it('写入 taste.md 和 routines.md', async () => {
    const { mountTasteRoutes } = await import('../server/api/taste.js');
    const app = mockApp();
    mountTasteRoutes(app, { rootDir });

    const r = mockRes();
    await app.routes['PUT /api/taste']({
      body: { taste: '# 我喜欢民谣', routines: '07:00 早间' },
    }, r);

    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(userDir, 'taste.md'), 'utf8')).toBe('# 我喜欢民谣');
    expect(fs.readFileSync(path.join(userDir, 'routines.md'), 'utf8')).toBe('07:00 早间');
  });

  it('body 只传 taste 时只动 taste.md，不动 routines.md', async () => {
    fs.writeFileSync(path.join(userDir, 'routines.md'), 'ORIGINAL_ROUTINES');

    const { mountTasteRoutes } = await import('../server/api/taste.js');
    const app = mockApp();
    mountTasteRoutes(app, { rootDir });

    const r = mockRes();
    await app.routes['PUT /api/taste']({ body: { taste: '只改这里' } }, r);

    expect(fs.readFileSync(path.join(userDir, 'taste.md'), 'utf8')).toBe('只改这里');
    expect(fs.readFileSync(path.join(userDir, 'routines.md'), 'utf8')).toBe('ORIGINAL_ROUTINES');
  });

  it('body.taste 不含蒸馏区时，把现有蒸馏区原样拼回（追加在末尾）', async () => {
    const existing = [
      '# 老的 taste 内容',
      '',
      '<!-- kugou-distilled:start -->',
      '蒸馏出来的：晚上喜欢蓝调',
      '<!-- kugou-distilled:end -->',
    ].join('\n');
    fs.writeFileSync(path.join(userDir, 'taste.md'), existing);

    const { mountTasteRoutes } = await import('../server/api/taste.js');
    const app = mockApp();
    mountTasteRoutes(app, { rootDir });

    const r = mockRes();
    await app.routes['PUT /api/taste']({ body: { taste: '新的 taste 内容（用户编辑过）' } }, r);

    const written = fs.readFileSync(path.join(userDir, 'taste.md'), 'utf8');
    expect(written).toContain('新的 taste 内容（用户编辑过）');
    expect(written).toContain('<!-- kugou-distilled:start -->');
    expect(written).toContain('蒸馏出来的：晚上喜欢蓝调');
    expect(written).toContain('<!-- kugou-distilled:end -->');
  });

  it('body.taste 已包含蒸馏区时按 body 原样写，不重复拼接', async () => {
    const existing = [
      '# 老 taste',
      '<!-- kugou-distilled:start -->',
      '旧蒸馏',
      '<!-- kugou-distilled:end -->',
    ].join('\n');
    fs.writeFileSync(path.join(userDir, 'taste.md'), existing);

    const incoming = [
      '# 新 taste',
      '<!-- kugou-distilled:start -->',
      '旧蒸馏',
      '<!-- kugou-distilled:end -->',
    ].join('\n');

    const { mountTasteRoutes } = await import('../server/api/taste.js');
    const app = mockApp();
    mountTasteRoutes(app, { rootDir });

    const r = mockRes();
    await app.routes['PUT /api/taste']({ body: { taste: incoming } }, r);

    const written = fs.readFileSync(path.join(userDir, 'taste.md'), 'utf8');
    expect(written).toBe(incoming);
    // 不该出现两段蒸馏区
    const matches = written.match(/<!-- kugou-distilled:start -->/g) || [];
    expect(matches.length).toBe(1);
  });

  it('原 taste.md 不存在时直接写 body（不报错）', async () => {
    const { mountTasteRoutes } = await import('../server/api/taste.js');
    const app = mockApp();
    mountTasteRoutes(app, { rootDir });

    const r = mockRes();
    await app.routes['PUT /api/taste']({ body: { taste: '首次写入' } }, r);
    expect(r.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(userDir, 'taste.md'), 'utf8')).toBe('首次写入');
  });
});
