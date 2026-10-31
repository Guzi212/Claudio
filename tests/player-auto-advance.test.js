import fs from 'node:fs';
import { describe, it, expect, vi } from 'vitest';

const playerJs = fs.readFileSync('./pwa/views/player.js', 'utf8');

// 截取 initPlayer 函数体，避免误匹配其他地方的代码
const initStart = playerJs.indexOf('export function initPlayer()');
const initBody  = playerJs.slice(initStart);

describe('audio 自动推进与错误处理', () => {
  it.each([
    [{ active: true }, true], [{ active: false }, false], [null, false],
    [{ loop: true, cursor: 0, tracks: [{}] }, true],
    [{ loop: false, cursor: 1, tracks: [{}] }, false],
  ])('状态视图和 WS 的续播池均能控制预取：%j', (pool, active) => {
    const start = playerJs.indexOf('function rememberQueueMeta(');
    const end = playerJs.indexOf('\nfunction paintHostChrome', start);
    const state = {};
    const remember = new Function('state', `
      let queuedAt = '', lastReason = '';
      ${playerJs.slice(start, end)}
      return rememberQueueMeta;
    `)(state);
    remember({ continuePool: pool });
    expect(state.continuePoolActive).toBe(active);
  });

  it('续播池可用时不向 AI 预取；耗尽/清除后恢复原来的预取', async () => {
    const start = playerJs.indexOf('async function autoRecommend(');
    const end = playerJs.indexOf('\nfunction requestNextBatch', start);
    const state = { continuePoolActive: true };
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ queue: [] }) }));
    const autoRecommend = new Function('state', 'fetch', `
      let autoRecommending = false, autoRecommendGen = 0, pendingPlayFrom = -1;
      ${playerJs.slice(start, end)}
      return autoRecommend;
    `)(state, fetch);
    await autoRecommend('下一批');
    expect(fetch).not.toHaveBeenCalled();
    state.continuePoolActive = false;
    await autoRecommend('下一批');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('循环按钮支持列表循环、单曲循环、自动推歌三种模式', () => {
    expect(playerJs).toContain("const LOOP_MODES = ['list', 'one', 'auto']");
    expect(playerJs).toContain("auto: { mark: '自动推歌'");
  });

  it('audio.ended 根据播放模式分别列表循环、单曲循环或自动推歌', () => {
    expect(initBody).toMatch(/state\.loopMode === 'one'[\s\S]{0,120}audio\.play/);
    expect(initBody).toMatch(/state\.loopMode === 'list'[\s\S]{0,160}playIndex\(0\)/);
    expect(initBody).toMatch(/state\.loopMode === 'auto'[\s\S]{0,180}requestNextBatch\(\{ playWhenReady: true \}\)/);
  });

  it('进入队列最后一首时只在自动推歌模式预取下一批', () => {
    expect(playerJs).toMatch(/state\.loopMode === 'auto'[\s\S]{0,120}i === state\.queue\.length - 1[\s\S]{0,160}autoRecommend/);
  });

  it('自动推歌请求即使被新一代请求废弃也会释放 in-flight 状态', () => {
    expect(playerJs).toMatch(/finally\s*\{\s*autoRecommending = false;/);
    expect(playerJs).not.toContain('if (myGen === autoRecommendGen) autoRecommending = false');
  });

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
