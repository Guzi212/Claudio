import { beforeEach, describe, expect, it } from 'vitest';
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

  it('applyTheme 同步 dataset.theme、theme-color 与 localStorage，并支持无残留来回切换', () => {
    expect(applyTheme('pixel')).toBe('pixel');
    expect(document.documentElement.dataset.theme).toBe('pixel');
    expect(metaContent).toBe('#0b091c');
    expect(readSavedTheme()).toBe('pixel');

    expect(applyTheme('dark')).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(metaContent).toBe('#171512');
    expect(readSavedTheme()).toBe('dark');

    expect(applyTheme('light')).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(metaContent).toBe('#f2ede1');
    expect(readSavedTheme()).toBe('light');

    expect(applyTheme('pixel', { persist: false })).toBe('pixel');
    expect(document.documentElement.dataset.theme).toBe('pixel');
    expect(metaContent).toBe('#0b091c');
    expect(readSavedTheme()).toBe('light');

    expect(applyTheme('invalid-theme')).toBe('auto');
    expect(document.documentElement.dataset.theme).toBe('auto');
    expect(metaContent).toBe('#f2ede1');
  });

  it('pixel 主题深底文字与实色按钮均满足 WCAG AA 对比度（正文 >= 4.5:1）', () => {
    for (const bg of ['#0b091c', '#140e2c', '#1d143d', '#461257']) {
      expect(contrastRatio('#f6f5ff', bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio('#c4bedc', bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio('#9c94bc', bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio('#b8f135', bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio('#38e5ff', bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio('#ffd166', bg)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio('#0b091c', '#b8f135')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#0b091c', '#38e5ff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#0b091c', '#ff4d6d')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#ffffff', '#911f7b')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#ff4d6d', '#140e2c')).toBeGreaterThanOrEqual(4.5);
  });
});
