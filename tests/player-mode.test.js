import { describe, expect, it } from 'vitest';
import {
  allowsAutoRefill,
  externalUnlockPlan,
  planExternalBoot,
  planPlayCommand,
  planPlayError,
} from '../pwa/player-mode.js';
import { planRuntimeSync } from '../pwa/runtime-sync.js';

describe('external 开机解锁', () => {
  it('有队列就从服务器的 index 播', () => {
    expect(externalUnlockPlan({
      queue: [{ title: 'A' }, { title: 'B' }],
      index: 1,
    })).toEqual({ playIndex: 1, dialog: null });
  });

  it('空队列不播，提示等待点歌', () => {
    expect(externalUnlockPlan({ queue: [], index: 0 })).toEqual({
      playIndex: null,
      dialog: '等待点歌',
    });
  });
});

describe('external 打开页面', () => {
  it('空队列不盖遮罩，只提示等待点歌', () => {
    expect(planExternalBoot({ queue: [], paused: false })).toEqual({
      play: false,
      showOverlay: false,
      dialog: '等待点歌',
    });
  });

  it('服务器暂停着就不自动播，也不先盖遮罩', () => {
    expect(planExternalBoot({ queue: [{ title: 'A' }], paused: true })).toEqual({
      play: false,
      showOverlay: false,
      dialog: null,
    });
  });

  it('有队列且没暂停时直接试播', () => {
    expect(planExternalBoot({ queue: [{ title: 'A' }], paused: false })).toEqual({
      play: true,
      showOverlay: false,
      dialog: null,
    });
  });
});

describe('play() 的结果', () => {
  it('成功就把遮罩拿掉', () => {
    expect(planPlayError(null)).toEqual({ ok: true, userActivated: true, showOverlay: false });
  });

  it('只有 NotAllowedError 才显示点击开声', () => {
    expect(planPlayError({ name: 'NotAllowedError' })).toEqual({
      ok: false,
      userActivated: false,
      showOverlay: true,
    });
    expect(planPlayError({ name: 'AbortError' }).showOverlay).toBe(false);
  });

  it('出过声之后的 play 命令直接播，不弹遮罩', () => {
    expect(planPlayCommand({ queueLength: 1, paused: true, userActivated: true })).toEqual({
      play: true,
      showOverlay: false,
    });
    expect(planPlayCommand({ queueLength: 0, userActivated: true })).toEqual({
      play: false,
      showOverlay: false,
    });
  });
});

describe('自动续播只在 internal', () => {
  it('external 即使 loop 是 auto 也不续播', () => {
    expect(allowsAutoRefill('external', 'auto')).toBe(false);
    expect(allowsAutoRefill('internal', 'auto')).toBe(true);
    expect(allowsAutoRefill('internal', 'list')).toBe(false);
  });
});

describe('planRuntimeSync', () => {
  const song = { title: '晴天', artist: '周杰伦', kugouId: 'h1' };

  it('同一首正在播时不打断，但可以改暂停和音量', () => {
    expect(planRuntimeSync(
      { queue: [song], index: 0, hasSrc: true, ended: false },
      { queue: [song], index: 0, paused: true, volume: 30 },
    )).toMatchObject({ playIndex: null, applyQueue: false, pause: true, volume: 30 });
  });

  it('同一首已经播完时，暂停广播不重新加载', () => {
    expect(planRuntimeSync(
      { queue: [song], index: 0, hasSrc: true, ended: true },
      { queue: [song], index: 0, paused: true, volume: 30 },
    )).toMatchObject({ playIndex: null, restart: false, pause: true });
  });

  it('队列后面接了歌但还是这一首时不打断', () => {
    const next = { title: '夜曲', artist: '周杰伦', kugouId: 'h2' };
    expect(planRuntimeSync(
      { queue: [song], index: 0, hasSrc: true, ended: false },
      { queue: [song, next], index: 0, paused: false, volume: 30 },
    )).toMatchObject({ playIndex: null, applyQueue: true, pause: false });
  });

  it('bot 跳到另一首时采用新的 index', () => {
    const next = { title: '夜曲', artist: '周杰伦', kugouId: 'h2' };
    expect(planRuntimeSync(
      { queue: [song], index: 0, hasSrc: true, ended: false },
      { queue: [song, next], index: 1, paused: false, volume: 100 },
    )).toMatchObject({ applyQueue: true, playIndex: 1, pause: false });
  });
});
