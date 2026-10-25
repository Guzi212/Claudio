import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readLocalVolume, writeLocalVolume } from '../pwa/volume-memory.js';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      data[key] = String(value);
    },
  };
}

describe('页面本地音量', () => {
  it('没有记录时用 30，写进去之后能读回来', () => {
    const storage = memoryStorage();
    expect(readLocalVolume(storage)).toBe(30);
    expect(writeLocalVolume(42, storage)).toBe(42);
    expect(storage.data['claudio:volume']).toBe('42');
    expect(readLocalVolume(storage)).toBe(42);
  });

  it('0 是合法音量，坏值回 30', () => {
    expect(readLocalVolume(memoryStorage({ 'claudio:volume': '0' }))).toBe(0);
    expect(readLocalVolume(memoryStorage({ 'claudio:volume': 'nope' }))).toBe(30);
    expect(writeLocalVolume(140, memoryStorage())).toBe(100);
  });

  it('存储不可用时仍返回 30', () => {
    const storage = {
      getItem() { throw new Error('denied'); },
      setItem() { throw new Error('denied'); },
    };
    expect(readLocalVolume(storage)).toBe(30);
    expect(writeLocalVolume(20, storage)).toBe(20);
  });

  it('进页面时先用本地音量，再让服务端状态覆盖；滑块默认不是 100', () => {
    const html = fs.readFileSync(new URL('../pwa/index.html', import.meta.url), 'utf8');
    const player = fs.readFileSync(new URL('../pwa/views/player.js', import.meta.url), 'utf8');
    const slider = html.match(/<input[^>]*id="np-vol"[^>]*>/)?.[0] || '';
    expect(slider).toContain('value="30"');
    expect(slider).not.toContain('value="100"');

    const init = player.slice(player.indexOf('export function initPlayer'));
    const boot = init.indexOf('bootCurrent()');
    expect(init.indexOf('applyLocalVolume()')).toBeGreaterThan(-1);
    expect(init.indexOf('applyLocalVolume()')).toBeLessThan(boot);
    expect(init).toContain('writeLocalVolume');
    expect(player).toContain('applyHeardVolume');
  });
});
