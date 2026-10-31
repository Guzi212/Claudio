import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { trimPlayedHistory } from '../server/queue-source.js';
import { playbackStatus } from '../server/playback-control.js';
import { planRuntimeSync } from '../pwa/runtime-sync.js';

const queue = Array.from({ length: 8 }, (_, i) => ({ title: `曲目${i}`, kugouId: `hash-${i}` }));
const player = fs.readFileSync(new URL('../pwa/views/player.js', import.meta.url), 'utf8');

describe('历史裁剪', () => {
  it('只换数组并调整相对索引，当前曲目和绝对位置不变', () => {
    const runtime = { queue, index: 5, queueOffset: 10, currentTime: 42, paused: false };
    const before = playbackStatus(runtime);
    expect(trimPlayedHistory(runtime, 2)).toBe(3);
    expect(runtime.queue).not.toBe(queue);
    expect(queue).toHaveLength(8);
    expect(runtime).toMatchObject({ index: 2, queueOffset: 13, currentTime: 42, paused: false });
    expect(playbackStatus(runtime).nowPlaying).toBe(before.nowPlaying);
    expect(runtime.index + runtime.queueOffset).toBe(15);
    expect(runtime.queue).toEqual(queue.slice(3));
  });

  it('无需裁剪也建立新数组，H=0 保留当前曲目和未播放部分', () => {
    const runtime = { queue, index: 2 };
    expect(trimPlayedHistory(runtime, 20)).toBe(0);
    expect(runtime.queue).not.toBe(queue);
    expect(runtime.queueOffset).toBe(0);
    expect(trimPlayedHistory(runtime, 0)).toBe(2);
    expect(runtime.queue).toEqual(queue.slice(2));
    expect(playbackStatus(runtime).nowPlaying).toBe(queue[2]);
  });
});

describe('PWA 裁剪同步', () => {
  it.each([false, true])('裁掉队头，追加=%s：同一绝对位置不重新加载', append => {
    const nextQueue = queue.slice(3);
    if (append) nextQueue.push({ title: '追加', kugouId: 'new' });
    expect(planRuntimeSync(
      { queue, index: 5, offset: 10, hasSrc: true, ended: false },
      { queue: nextQueue, index: 2, queueOffset: 13, paused: false },
    )).toMatchObject({ applyQueue: true, index: 2, queueOffset: 13, playIndex: null, restart: false });
  });

  it('相对索引和 trackKey 相同但绝对位置不同仍切歌', () => {
    expect(planRuntimeSync(
      { queue: [queue[0]], index: 0, offset: 1, hasSrc: true },
      { queue: [queue[0]], index: 0, queueOffset: 2, paused: false },
    )).toMatchObject({ applyQueue: true, playIndex: 0 });
  });

  it('绝对位置相同但曲目不同仍加载新曲', () => {
    expect(planRuntimeSync(
      { queue, index: 5, offset: 10, hasSrc: true },
      { queue: [queue[0]], index: 0, queueOffset: 15, paused: false },
    )).toMatchObject({ applyQueue: true, playIndex: 0 });
  });

  it('播放页实际采用裁剪后的队列/index/offset，不调用 play/load/pause', () => {
    const state = { queue, index: 5, offset: 10 };
    const remote = { queue: queue.slice(3), index: 2, queueOffset: 13, paused: false };
    const audio = { src: '/current.mp3', paused: false, ended: false, pause: vi.fn() };
    const playIndex = vi.fn();
    const renderQueuePanel = vi.fn();
    const start = player.indexOf('export function applyRuntime(');
    const end = player.indexOf('\n// 外部 bot', start);
    const apply = new Function('state', 'audio', 'planRuntimeSync', 'playIndex', 'renderQueuePanel', `
      let brain = 'external', appliedSay = '', serverProgress = 0;
      const getClientId = () => 'page-a', isOwnEcho = () => false;
      const rememberQueueMeta = () => {}, paintHostChrome = () => {}, ensurePlaybackVolume = () => {};
      ${player.slice(start, end).replace('export function', 'function')}
      return applyRuntime;
    `)(state, audio, planRuntimeSync, playIndex, renderQueuePanel);
    apply(remote);
    expect(state).toMatchObject({ queue: remote.queue, index: 2, offset: 13 });
    expect(playIndex).not.toHaveBeenCalled();
    expect(audio.pause).not.toHaveBeenCalled();
    expect(audio.src).toBe('/current.mp3');
    expect(renderQueuePanel).toHaveBeenCalledOnce();
  });

  it('PWA 上一首使用裁剪后的相对索引，0 处提示不再往前', () => {
    const state = { queue: queue.slice(3), index: 2, offset: 13 };
    const playIndex = vi.fn(index => { state.index = index; });
    const showAlert = vi.fn();
    const start = player.indexOf('function goPrev(');
    const end = player.indexOf('\nfunction goNext', start);
    const prev = new Function('state', 'playIndex', 'showAlert', `${player.slice(start, end)}; return goPrev;`)(state, playIndex, showAlert);
    prev(); prev(); prev();
    expect(playIndex.mock.calls).toEqual([[1], [0]]);
    expect(showAlert).toHaveBeenCalledWith('已经是第一首');
    expect(state.offset).toBe(13);
  });

  it('HTTP 状态和 WS 进度都携带当前 offset', async () => {
    const state = { index: 2, offset: 13 };
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    const start = player.indexOf('function syncToServer(');
    const end = player.indexOf('\nfunction addBubble', start);
    const sync = new Function('state', 'fetch', 'getClientId', `${player.slice(start, end)}; return syncToServer;`)(state, fetch, () => 'page-a');
    await sync(2, { paused: true, ended: true });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ index: 2, queueOffset: 13, paused: true, ended: true, clientId: 'page-a' });
    const dispatchEvent = vi.fn();
    const progressStart = player.indexOf('function reportProgress(');
    const progressEnd = player.indexOf('\n// 把服务端', progressStart);
    const progress = new Function('state', 'audio', 'window', 'CustomEvent', `
      let lastProgressAt = 0;
      const npVol = { value: '37' }, getClientId = () => 'page-a';
      ${player.slice(progressStart, progressEnd)}
      return reportProgress;
    `)(state, { currentTime: 9, duration: 180, paused: false }, { dispatchEvent }, class {
      constructor(type, options) { this.type = type; this.detail = options.detail; }
    });
    progress(true);
    expect(dispatchEvent.mock.calls[0][0].detail).toMatchObject({ index: 2, queueOffset: 13, currentTime: 9, clientId: 'page-a' });
  });
});
