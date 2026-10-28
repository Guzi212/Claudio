import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const playerJs = fs.readFileSync(path.resolve('pwa/views/player.js'), 'utf8');

describe('player motion state', () => {
  it('播放与暂停通过同一个真实音频事件入口同步声波状态', () => {
    // 没有 is-playing 时，CSS 无法区分真实播放与暂停，会让 Grokbot 假装说话。
    const update = playerJs.match(/function updatePlayButtons\(isPlaying\) \{([\s\S]*?)\n\}/)?.[1] || '';
    expect(update).toContain("classList.toggle('is-playing', isPlaying)");
    expect(update).toContain("classList.toggle('paused', state.queue.length > 0 && !isPlaying)");
    expect(playerJs).toContain("audio.addEventListener('play'");
    expect(playerJs).toContain("audio.addEventListener('pause'");
  });

  it('internal 冷启动预加载歌词所需元数据，但不自动播放', () => {
    const coldLoad = playerJs.match(/cold-load 不自动播放[\s\S]*?renderQueuePanel\(\);/)?.[0] || '';
    // 只赋 src 不 load，preload=none 时 loadedmetadata 不会触发，歌词组件拿不到当前曲目。
    expect(coldLoad).toContain("audio.preload = 'metadata'");
    expect(coldLoad).toContain('audio.load()');
    expect(coldLoad).not.toContain('playIndex(');
    expect(coldLoad).not.toContain('attemptPlay(');
  });
});
