import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const indexHtml = fs.readFileSync(path.resolve('pwa/index.html'), 'utf8');
const playerJs = fs.readFileSync(path.resolve('pwa/views/player.js'), 'utf8');
const stylesCss = fs.readFileSync(path.resolve('pwa/styles.css'), 'utf8');

describe('player console controls', () => {
  it('播放页使用夜间广播台壳，不再内嵌旧控制台', () => {
    const playerStart = indexHtml.indexOf('id="view-player"');
    const playerEnd = indexHtml.indexOf('id="view-playlists"', playerStart);
    const playerHtml = indexHtml.slice(playerStart, playerEnd);

    expect(playerHtml).toContain('id="now-playing"');
    expect(playerHtml).toContain('id="host-line"');
    expect(playerHtml).toContain('id="queue-list"');
    expect(playerHtml).toContain('id="np-vol"');
    expect(playerHtml).not.toContain('class="radio-console"');
    expect(indexHtml).not.toContain('class="np-controls"');
  });

  it('external 保持纯电台，internal 保留点歌对话', () => {
    expect(playerJs).toContain("consoleChat.hidden = brain !== 'internal'");
    expect(stylesCss).toContain('body:not(.brain-internal) #console-chat');
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
    for (const control of ['queue', 'loop']) {
      expect(indexHtml).toMatch(new RegExp(`<button[^>]+data-console-control="${control}"[^>]+data-internal-only`));
    }
    expect(stylesCss).toContain('body:not(.brain-internal) [data-internal-only]');
    expect(playerJs).toContain('btn.hidden = brain !== \'internal\'');
  });

  it('待播封面加载失败时移除坏图并保留备用封面', () => {
    expect(playerJs).toContain('function bindQueueCoverFallbacks()');
    expect(playerJs).toContain("img.addEventListener('error'");
    expect(playerJs).toContain('img.remove()');
  });

  it('player 逻辑绑定电台控制台按钮', () => {
    expect(playerJs).toContain('data-console-control');
    expect(playerJs).toContain('bindConsoleControls');
  });

  it('player 逻辑绑定主题切换按钮', () => {
    expect(playerJs).toContain('data-studio-theme');
    expect(playerJs).toContain('bindStudioThemes');
  });

  it('电台主持人使用 Grokbot 身份和专属头像', () => {
    expect(indexHtml).toContain('id="grokbot-avatar"');
    expect(indexHtml).toContain('id="host-speaking"');
    expect(indexHtml).toMatch(/<span class="agent-name">Grokbot/);
    expect(indexHtml).not.toContain('id="pumpkin"');
  });

  it('播放页能直接导航到全部四个视图', () => {
    const labels = [...indexHtml.matchAll(/<button[^>]+class="tab"[^>]+data-view="([^"]+)"[^>]*>([^<]+)/g)];
    expect(labels.map(match => [match[1], match[2].trim()])).toEqual([
      ['player', '电台'],
      ['playlists', '歌单'],
      ['profile', '品味'],
      ['settings', '设置'],
    ]);
    expect(indexHtml.match(/id="view-playlists"/g)).toHaveLength(1);
    expect(indexHtml.match(/id="topbar"/g)).toHaveLength(1);
    expect(indexHtml).toContain('aria-label="电台导航"');
  });

  it('播放页角落能打开歌单和设置', () => {
    expect(indexHtml).toContain('id="corner-menu-btn"');
    expect(indexHtml).toContain('data-view-jump="playlists"');
    expect(indexHtml).toContain('data-view-jump="settings"');
    const appJs = fs.readFileSync(path.resolve('pwa/app.js'), 'utf8');
    expect(appJs).toContain('data-view-jump');
    expect(appJs).toContain('bindCornerMenu');
  });

  it('DeepSeek 设置只在 external 模式隐藏', () => {
    expect(stylesCss).toContain('body:not(.brain-internal) #settings-ai');
    expect(stylesCss).not.toContain('#settings-ai { display: none !important; }');
    expect(playerJs).toContain("classList.toggle('brain-internal'");
  });

  it('样式定义了不同主题色', () => {
    expect(stylesCss).toContain('.studio-stage[data-theme="dark"]');
    expect(stylesCss).toContain('.studio-stage[data-theme="poetry"]');
    expect(stylesCss).toContain('.studio-stage[data-theme="focus"]');
    expect(stylesCss).toContain('--theme-accent-rgb');
  });
});
