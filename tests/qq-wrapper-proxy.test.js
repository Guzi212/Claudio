import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRAPPER_PATH = path.join(ROOT, 'scripts', 'qq-music-server.py');

describe('qq-music-server 代理剥离回归（niquests 走 env 代理会 502/风控）', () => {
  const source = readFileSync(WRAPPER_PATH, 'utf8');

  it('剥 env 代码在 import aiohttp / qqmusic_api 之前', () => {
    const stripIdx = source.indexOf('QQ_WRAPPER_ALLOW_PROXY');
    const aiohttpIdx = source.indexOf('from aiohttp import web');
    const qqmusicIdx = source.indexOf('from qqmusic_api');
    expect(stripIdx).toBeGreaterThan(-1);
    expect(aiohttpIdx).toBeGreaterThan(-1);
    expect(qqmusicIdx).toBeGreaterThan(-1);
    // 剥 env 必须先于一切可能读 env 的网络库 import
    expect(stripIdx).toBeLessThan(aiohttpIdx);
    expect(stripIdx).toBeLessThan(qqmusicIdx);
  });

  it('剥的是全部六种代理 env 变量', () => {
    expect(source).toContain('"HTTP_PROXY"');
    expect(source).toContain('"HTTPS_PROXY"');
    expect(source).toContain('"ALL_PROXY"');
    expect(source).toContain('"http_proxy"');
    expect(source).toContain('"https_proxy"');
    expect(source).toContain('"all_proxy"');
  });

  it('QQ_WRAPPER_ALLOW_PROXY=1 时跳过剥离（逃生门）', () => {
    expect(source).toMatch(/QQ_WRAPPER_ALLOW_PROXY.*!= *["']1["']/);
  });
});
