import { describe, expect, it } from 'vitest';
import { allowsAutoRefill, externalUnlockPlan } from '../pwa/player-mode.js';
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

  it('bot 跳到另一首时采用新的 index', () => {
    const next = { title: '夜曲', artist: '周杰伦', kugouId: 'h2' };
    expect(planRuntimeSync(
      { queue: [song], index: 0, hasSrc: true, ended: false },
      { queue: [song, next], index: 1, paused: false, volume: 100 },
    )).toMatchObject({ applyQueue: true, playIndex: 1, pause: false });
  });
});
