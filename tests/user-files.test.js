import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  localCounterpartPath,
  hasMeaningfulContent,
  resolveReadUserFile,
  writeUserFile,
} from '../server/services/user-files.js';
import { mountTasteRoutes } from '../server/api/taste.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-user-files-'));
}

describe('services/user-files', () => {
  it('localCounterpartPath 正确映射 .local counterpart 路径', () => {
    expect(localCounterpartPath('user/taste.md')).toBe('user/taste.local.md');
    expect(localCounterpartPath('user/routines.md')).toBe('user/routines.local.md');
    expect(localCounterpartPath('user/taste.local.md')).toBe('user/taste.local.md');
  });

  it('hasMeaningfulContent 区分空白模板和真实内容', () => {
    expect(hasMeaningfulContent('')).toBe(false);
    expect(hasMeaningfulContent('# 用户品味\n<!-- 注释 -->\n\n## 偏好\n')).toBe(false);
    expect(hasMeaningfulContent('# 用户品味\n- 喜欢陈奕迅\n')).toBe(true);
  });

  it('resolveReadUserFile 优先读取有实质内容的 .local.md', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, 'user'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'user', 'taste.md'), '# base\n- 周杰伦\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'user', 'taste.local.md'), '# local\n- 坂本龙一\n', 'utf8');

    const res = resolveReadUserFile(dir, 'user/taste.md');
    expect(res.isLocal).toBe(true);
    expect(res.content).toContain('坂本龙一');
  });

  it('resolveReadUserFile 当 .local.md 仅为占位模板时回退到基础文件', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, 'user'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'user', 'taste.md'), '# base\n- 窦唯\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'user', 'taste.local.md'), '# 标题\n<!-- 提示 -->\n', 'utf8');

    const res = resolveReadUserFile(dir, 'user/taste.md');
    expect(res.isLocal).toBe(false);
    expect(res.content).toContain('窦唯');
  });

  it('writeUserFile 无 .local.md 时写基础文件，存在时写 .local.md', () => {
    const dir = makeTmpDir();
    const r1 = writeUserFile(dir, 'user/taste.md', 'A');
    expect(r1.isLocal).toBe(false);
    expect(fs.existsSync(path.join(dir, 'user', 'taste.md'))).toBe(true);

    fs.writeFileSync(path.join(dir, 'user', 'taste.local.md'), 'OLD', 'utf8');
    const r2 = writeUserFile(dir, 'user/taste.md', 'B');
    expect(r2.isLocal).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'user', 'taste.local.md'), 'utf8')).toBe('B');
    expect(fs.readFileSync(path.join(dir, 'user', 'taste.md'), 'utf8')).toBe('A');
  });

  it('PUT /api/taste 当存在 .local.md 时直接写入 .local.md', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, 'user'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'user', 'taste.md'), 'public\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'user', 'taste.local.md'), 'local\n<!-- kugou-distilled:start -->\nold\n<!-- kugou-distilled:end -->\n', 'utf8');

    const routes = {};
    const app = { put: (p, h) => { routes[p] = h; } };
    mountTasteRoutes(app, { rootDir: dir });

    let payload;
    const res = { status: () => res, json: d => { payload = d; return res; } };
    routes['/api/taste']({ body: { taste: 'updated local\n' } }, res);

    expect(payload).toEqual({ ok: true });
    const written = fs.readFileSync(path.join(dir, 'user', 'taste.local.md'), 'utf8');
    expect(written).toContain('updated local');
    expect(written).toContain('<!-- kugou-distilled:start -->');
    expect(fs.readFileSync(path.join(dir, 'user', 'taste.md'), 'utf8')).toBe('public\n');
  });

  it('过期的 .local.md 不会盖掉更新过的基础文件', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, 'user'), { recursive: true });
    const basePath = path.join(dir, 'user', 'taste.md');
    const localPath = path.join(dir, 'user', 'taste.local.md');
    fs.writeFileSync(basePath, '# base\n- 新版品味\n', 'utf8');
    fs.writeFileSync(localPath, '# local\n- 过期旧品味\n', 'utf8');
    const nowSec = Date.now() / 1000;
    fs.utimesSync(localPath, nowSec - 60, nowSec - 60);
    fs.utimesSync(basePath, nowSec, nowSec);

    const readRes = resolveReadUserFile(dir, 'user/taste.md');
    expect(readRes.isLocal).toBe(false);
    expect(readRes.content).toContain('新版品味');

    const writeRes = writeUserFile(dir, 'user/taste.md', '# base\n- 继续更新\n');
    expect(writeRes.isLocal).toBe(false);
    expect(fs.readFileSync(basePath, 'utf8')).toContain('继续更新');
    expect(fs.readFileSync(localPath, 'utf8')).toContain('过期旧品味');
  });
});
