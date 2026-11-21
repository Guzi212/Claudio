import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, normalizeTheme, readSavedTheme } from '../pwa/theme-store.js';

function srgbChannel(hex2) {
  const v = parseInt(hex2, 16) / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const clean = hex.replace('#', '');
  const r = srgbChannel(clean.slice(0, 2));
  const g = srgbChannel(clean.slice(2, 4));
  const b = srgbChannel(clean.slice(4, 6));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [bright, dark] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (bright + 0.05) / (dark + 0.05);
}

describe('pwa/theme-store', () => {
  let metaContent;
  let storage;

  beforeEach(() => {
    metaContent = '#f2ede1';
    storage = new Map();
    globalThis.localStorage = {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => { storage.set(k, String(v)); },
    };
    globalThis.document = {
      documentElement: { dataset: { theme: 'auto' } },
      querySelector: sel => (sel === 'meta[name="theme-color"]'
        ? { setAttribute: (_name, val) => { metaContent = val; } }
        : null),
    };
  });

  it('normalizeTheme 支持 auto / light / dark / pixel，非法值回退 auto', () => {
    expect(normalizeTheme('auto')).toBe('auto');
    expect(normalizeTheme('light')).toBe('light');
    expect(normalizeTheme('dark')).toBe('dark');
    expect(normalizeTheme('pixel')).toBe('pixel');
    expect(normalizeTheme('neon')).toBe('auto');
    expect(normalizeTheme('')).toBe('auto');
    expect(normalizeTheme(undefined)).toBe('auto');
  });

  it('applyTheme 同步 dataset.theme、theme-color、桌面图标 IPC 与 localStorage，并支持无残留来回切换', () => {
    const setThemeIcon = vi.fn(() => Promise.resolve({ ok: true }));
    globalThis.window = { claudioDesktop: { setThemeIcon } };

    expect(applyTheme('pixel')).toBe('pixel');
    expect(document.documentElement.dataset.theme).toBe('pixel');
    expect(metaContent).toBe('#0B1526');
    expect(readSavedTheme()).toBe('pixel');
    expect(setThemeIcon).toHaveBeenLastCalledWith('pixel');

    expect(applyTheme('dark')).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(metaContent).toBe('#171512');
    expect(readSavedTheme()).toBe('dark');
    expect(setThemeIcon).toHaveBeenLastCalledWith('dark');

    expect(applyTheme('light')).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(metaContent).toBe('#f2ede1');
    expect(readSavedTheme()).toBe('light');

    expect(applyTheme('pixel', { persist: false })).toBe('pixel');
    expect(document.documentElement.dataset.theme).toBe('pixel');
    expect(metaContent).toBe('#0B1526');
    expect(readSavedTheme()).toBe('light');

    delete globalThis.window;
    expect(applyTheme('invalid-theme')).toBe('auto');
    expect(document.documentElement.dataset.theme).toBe('auto');
    expect(metaContent).toBe('#f2ede1');
  });

  it('pixel 深夜蓝金主题深底文字与实色按钮均满足 WCAG AA 对比度（正文 >= 4.5:1）', () => {
    for (const bg of ['#08101D', '#0B1526', '#13233A', '#182C48']) {
      expect(contrastRatio('#F8FAFC', bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio('#CFDCEC', bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio('#839BB8', bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio('#469BE7', bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio('#88C6FA', bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio('#F4B66A', bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio('#F06E6E', bg)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio('#08101D', '#469BE7')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#08101D', '#88C6FA')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#08101D', '#F4B66A')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#08101D', '#F06E6E')).toBeGreaterThanOrEqual(4.5);
  });
});
