import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localVariant, resolveUserFile, readUserFile, localUserPath } from '../server/user-files.js';

let rootDir;

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-user-files-'));
  fs.mkdirSync(path.join(rootDir, 'user'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('user-files', () => {
  it('localVariant 支持 .md 和 .txt', () => {
    expect(localVariant('user/taste.md')).toBe('user/taste.local.md');
    expect(localVariant('user/music/kugou_input.txt')).toBe('user/music/kugou_input.local.txt');
  });

  it('没有 .local 文件时读模板', () => {
    fs.writeFileSync(path.join(rootDir, 'user', 'taste.md'), 'TEMPLATE');
    expect(resolveUserFile(rootDir, 'user/taste.md')).toBe(path.join(rootDir, 'user', 'taste.md'));
    expect(readUserFile(rootDir, 'user/taste.md')).toBe('TEMPLATE');
  });

  it('存在 .local 文件时优先读个人覆盖', () => {
    fs.writeFileSync(path.join(rootDir, 'user', 'taste.md'), 'TEMPLATE');
    fs.writeFileSync(path.join(rootDir, 'user', 'taste.local.md'), 'PERSONAL');
    expect(resolveUserFile(rootDir, 'user/taste.md')).toBe(path.join(rootDir, 'user', 'taste.local.md'));
    expect(readUserFile(rootDir, 'user/taste.md')).toBe('PERSONAL');
  });

  it('文件都不存在时返回 fallback', () => {
    expect(readUserFile(rootDir, 'user/taste.md', 'FALLBACK')).toBe('FALLBACK');
  });

  it('localUserPath 始终指向 .local 文件', () => {
    expect(localUserPath(rootDir, 'user/music/kugou_raw.md'))
      .toBe(path.join(rootDir, 'user/music/kugou_raw.local.md'));
  });
});
