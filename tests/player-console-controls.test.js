import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const indexHtml = fs.readFileSync(path.resolve('pwa/index.html'), 'utf8');
const playerJs = fs.readFileSync(path.resolve('pwa/views/player.js'), 'utf8');
const stylesCss = fs.readFileSync(path.resolve('pwa/styles.css'), 'utf8');

describe('player console controls', () => {
  it('播放条和输入框直接合并在电台控制台内部', () => {
    const consoleStart = indexHtml.indexOf('<div class="radio-console"');
    const consoleEnd = indexHtml.indexOf('<div id="env-strip"', consoleStart);
    const consoleHtml = indexHtml.slice(consoleStart, consoleEnd);

    expect(consoleHtml).toContain('id="now-playing"');
    expect(consoleHtml).toContain('id="composer"');
    expect(indexHtml).not.toContain('class="np-controls"');
  });

  it('主题模式使用可交互按钮，并暴露主题值', () => {
    expect(indexHtml).not.toMatch(/<div class="console-modes"[^>]*aria-hidden="true"/);

    for (const mode of ['dark', 'poetry', 'focus']) {
      expect(indexHtml).toContain(`data-studio-theme="${mode}"`);
      expect(indexHtml).toMatch(new RegExp(`<button[^>]+data-studio-theme="${mode}"`));
    }
  });

  it('电台控制台使用可交互按钮而不是装饰性文本', () => {
    expect(indexHtml).not.toMatch(/<div class="console-actions"[^>]*aria-hidden="true"/);

    for (const control of ['prev', 'play-pause', 'next', 'favorite', 'queue']) {
      expect(indexHtml).toContain(`data-console-control="${control}"`);
      expect(indexHtml).toMatch(new RegExp(`<button[^>]+data-console-control="${control}"`));
    }
  });

  it('player 逻辑绑定电台控制台按钮', () => {
    expect(playerJs).toContain('data-console-control');
    expect(playerJs).toContain('bindConsoleControls');
  });

  it('player 逻辑绑定主题切换按钮', () => {
    expect(playerJs).toContain('data-studio-theme');
    expect(playerJs).toContain('bindStudioThemes');
  });

  it('样式定义了不同主题色', () => {
    expect(stylesCss).toContain('.studio-stage[data-theme="dark"]');
    expect(stylesCss).toContain('.studio-stage[data-theme="poetry"]');
    expect(stylesCss).toContain('.studio-stage[data-theme="focus"]');
    expect(stylesCss).toContain('--theme-accent-rgb');
  });
});
