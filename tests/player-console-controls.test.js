import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const indexHtml = fs.readFileSync(path.resolve('pwa/index.html'), 'utf8');
const playerJs = fs.readFileSync(path.resolve('pwa/views/player.js'), 'utf8');
const stylesCss = fs.readFileSync(path.resolve('pwa/styles.css'), 'utf8');

describe('player console controls', () => {
  it('播放页采用宣纸水墨舞台，保留墨团头像、水墨封面与场景胶囊', () => {
    const playerStart = indexHtml.indexOf('id="view-player"');
    const playerEnd = indexHtml.indexOf('id="view-playlists"', playerStart);
    const playerHtml = indexHtml.slice(playerStart, playerEnd);

    expect(playerHtml).toContain('id="now-playing"');
    expect(playerHtml).toContain('id="host-line"');
    expect(playerHtml).toContain('id="grokbot-avatar"');
    expect(playerHtml).toContain('id="np-cover-fallback"');
    expect(playerHtml).toContain('id="scene-pills"');
    expect(playerHtml).toContain('id="queue-list"');
    expect(playerHtml).toContain('id="np-vol"');
    expect(indexHtml).toContain('id="intent-form"');
    expect(playerHtml).not.toContain('class="radio-console"');
    expect(indexHtml).not.toContain('class="np-controls"');
  });

  it('external 保持纯电台，internal 保留点歌对话', () => {
    expect(playerJs).toContain("consoleChat.hidden = brain !== 'internal'");
    expect(stylesCss).toContain('body:not(.brain-internal) #console-chat');
  });

  it('播放控制包含上一首、播放/暂停、下一首与喜欢/不喜欢/收藏', () => {
    for (const control of ['prev', 'play-pause', 'next']) {
      expect(indexHtml).toContain(`data-console-control="${control}"`);
      expect(indexHtml).toMatch(new RegExp(`<button[^>]+data-console-control="${control}"`));
    }
    expect(indexHtml).toContain('data-feedback="like"');
    expect(indexHtml).toContain('data-feedback="dislike"');
    expect(indexHtml).toContain('data-console-control="favorite"');
    expect(indexHtml).toContain('<symbol id="heart"');
    for (const control of ['queue', 'loop']) {
      expect(indexHtml).toMatch(new RegExp(`<button[^>]+data-console-control="${control}"[^>]+data-internal-only`));
    }
    expect(stylesCss).toContain('body:not(.brain-internal) [data-internal-only]');
    expect(playerJs).toContain("btn.hidden = brain !== 'internal'");
  });

  it('点踩真实上报 dislike 遥测与 feedback 并切下一首；主动切下一首按进度报 skipped', () => {
    expect(playerJs).toContain("postFeedback('dislike', track)");
    expect(playerJs).toContain('reportDislikeTelemetry');
    expect(playerJs).toContain("event: 'dislike'");
    expect(playerJs).not.toContain("choice === 'dislike' ? 'unlike'");
    expect(playerJs).toContain('function shouldCountAsUserSkip()');
    expect(playerJs).toContain('goNext({ userInitiated: true })');
  });

  it('播放页提供极简场景胶囊并与 /api/scene 同步', () => {
    expect(indexHtml).toContain('id="scene-pills"');
    expect(indexHtml).toContain('data-scene="library"');
    expect(indexHtml).toContain('data-scene="dorm"');
    expect(playerJs).toContain('/api/scene');
    expect(playerJs).toContain('bindScenePills');
  });

  it('红心收藏按钮写酷狗「我喜欢」', () => {
    expect(indexHtml).toMatch(/<button[^>]+data-console-control="favorite"[^>]+aria-label="收藏到我喜欢"/);
    expect(playerJs).toContain('/api/kugou/favorite');
    expect(playerJs).toContain('refreshFavoriteState');
  });

  it('自适应初始音量只覆盖服务端未显式设置的音量', () => {
    expect(playerJs).toContain('data.volumeExplicit === true');
    expect(playerJs).not.toContain('hasServerVolume: Number.isFinite(data.volume)');
    expect(playerJs).toContain("['0', 'false', 'off', 'no']");
  });

  it('待播封面加载失败时移除坏图并保留备用封面', () => {
    expect(playerJs).toContain('function bindQueueCoverFallbacks()');
    expect(playerJs).toContain("img.addEventListener('error'");
    expect(playerJs).toContain('img.remove()');
  });

  it('player 逻辑绑定电台控制台按钮与当前活跃 Agent 标识', () => {
    expect(playerJs).toContain('data-console-control');
    expect(playerJs).toContain('bindConsoleControls');
    expect(playerJs).toContain('activeAgent');
    expect(indexHtml).toContain('id="host-agent-name"');
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

  it('DeepSeek 与电台模式设置项在设置页始终可见', () => {
    expect(indexHtml).toContain('id="settings-ai"');
    expect(indexHtml).toContain('id="set-brain-mode"');
    expect(stylesCss).not.toContain('#settings-ai { display: none');
    expect(playerJs).toContain("classList.toggle('brain-internal'");
  });
});
