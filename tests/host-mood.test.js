import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  PIXEL_HOST_KEY,
  PIXEL_HOST_SPRITES,
  applyPixelHostSetting,
  hostSprite,
  readPixelHostEnabled,
} from '../pwa/host-mood.js';

describe('pwa/host-mood', () => {
  let storage;

  beforeEach(() => {
    storage = new Map();
    globalThis.localStorage = {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => { storage.set(k, String(v)); },
    };
    globalThis.document = {
      documentElement: { dataset: {} },
    };
  });

  it('hostSprite 按优先级映射播放、暂停、空队列、加载和短暂反馈', () => {
    expect(hostSprite({ playing: true })).toBe('assets/pixel/host-listen.webp');
    expect(hostSprite({ playing: false })).toBe('assets/pixel/host-wave.webp');
    expect(hostSprite({ playing: true, loading: true })).toBe('assets/pixel/host-conductor.webp');
    expect(hostSprite({ playing: false, loading: true, queueEmpty: true })).toBe('assets/pixel/host-wave.webp');
    expect(hostSprite({ playing: true, loading: true, queueEmpty: true, flash: 'like' })).toBe('assets/pixel/host-thumbsup.webp');
    expect(hostSprite({ playing: true, flash: 'dislike' })).toBe('assets/pixel/host-overwhelmed.webp');
    expect(hostSprite({})).toBe('assets/pixel/host-wave.webp');
  });

  it('全部像素小人 WebP 素材文件均存在且可访问', () => {
    for (const rel of Object.values(PIXEL_HOST_SPRITES)) {
      expect(fs.existsSync(path.resolve('pwa', rel))).toBe(true);
    }
  });

  it('显示数码小人开关默认开启并正确持久化到 localStorage 与 dataset', () => {
    expect(readPixelHostEnabled()).toBe(true);

    expect(applyPixelHostSetting(false)).toBe(false);
    expect(document.documentElement.dataset.pixelHost).toBe('off');
    expect(storage.get(PIXEL_HOST_KEY)).toBe('false');
    expect(readPixelHostEnabled()).toBe(false);

    expect(applyPixelHostSetting(true)).toBe(true);
    expect(document.documentElement.dataset.pixelHost).toBe('on');
    expect(storage.get(PIXEL_HOST_KEY)).toBe('true');
    expect(readPixelHostEnabled()).toBe(true);
  });
});
