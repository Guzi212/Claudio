import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const indexHtml = fs.readFileSync(path.resolve('pwa/index.html'), 'utf8');
const playerJs = fs.readFileSync(path.resolve('pwa/views/player.js'), 'utf8');
const stylesCss = fs.readFileSync(path.resolve('pwa/styles.css'), 'utf8');

describe('player console controls', () => {
  it('播放页使用银色电台壳，不再内嵌旧控制台和聊天框', () => {
    const playerStart = indexHtml.indexOf('id="view-player"');
    const playerEnd = indexHtml.indexOf('id="view-playlists"', playerStart);
    const playerHtml = indexHtml.slice(playerStart, playerEnd);

    expect(playerHtml).toContain('id="now-playing"');
    expect(playerHtml).toContain('id="host-line"');
    expect(playerHtml).toContain('id="queue-list"');
    expect(playerHtml).toContain('id="np-vol"');
    expect(playerHtml).not.toContain('id="composer"');
    expect(playerHtml).not.toContain('class="radio-console"');
    expect(indexHtml).not.toContain('class="np-controls"');
  });

  it('主题切换不再放在播放页上', () => {
    const playerStart = indexHtml.indexOf('id="view-player"');
    const playerEnd = indexHtml.indexOf('id="view-playlists"', playerStart);
    const playerHtml = indexHtml.slice(playerStart, playerEnd);
    expect(playerHtml).not.toContain('data-studio-theme=');
  });

  it('播放控制是上一首、暂停和下一首', () => {
    for (const control of ['prev', 'play-pause', 'next']) {
      expect(indexHtml).toContain(`data-console-control="${control}"`);
      expect(indexHtml).toMatch(new RegExp(`<button[^>]+data-console-control="${control}"`));
    }
    expect(indexHtml).not.toContain('data-console-control="favorite"');
    expect(indexHtml).not.toContain('data-console-control="queue"');
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
