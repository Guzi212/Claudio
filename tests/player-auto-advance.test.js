import fs from 'node:fs';
import { describe, it, expect } from 'vitest';

const playerJs = fs.readFileSync('./pwa/views/player.js', 'utf8');

// 截取 initPlayer 函数体，避免误匹配其他地方的代码
const initStart = playerJs.indexOf('export function initPlayer()');
const initBody  = playerJs.slice(initStart);

describe('audio 自动推进与错误处理', () => {
  it('audio.error 有事件处理器（歌曲加载失败时不静默卡死）', () => {
    // 当歌曲 URL 无效或代理失败，audio.error 触发，需要推进到下一首或提示
    expect(initBody).toMatch(/audio\.addEventListener\(\s*['"]error['"]/);
  });

  it('play 事件处理器对 TTS 轨道不调用 clearAlert（避免清除搜索失败提示）', () => {
    // TTS 开始播放时不应该清除"酷狗搜索失败"之类的错误提示
    // 必须检查 isTts，只对真实歌曲才 clearAlert
    // clearAlert 和 isTts 必须在同一个 play 监听器里共存
    expect(initBody).toContain('clearAlert');
    expect(initBody).toMatch(/isTts[\s\S]{0,60}clearAlert|clearAlert[\s\S]{0,60}isTts/);
  });
});
