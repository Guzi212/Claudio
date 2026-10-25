import { describe, expect, it } from 'vitest';
import { planExternalPlayback } from '../pwa/external-playback.js';

const play = (playIndex, extra = {}) => ({
  playIndex,
  autoplay: extra.autoplay ?? playIndex != null,
  showOverlay: false,
  resume: extra.resume ?? false,
});

describe('planExternalPlayback', () => {
  it('replace 从第 0 首开始', () => {
    expect(planExternalPlayback(
      { queueLength: 4, hasSrc: true, ended: false },
      { mode: 'replace', incoming: 2 },
    )).toEqual(play(0));
  });

  it('append 正在播时不打断', () => {
    expect(planExternalPlayback(
      { queueLength: 3, hasSrc: true, ended: false, paused: false },
      { mode: 'append', incoming: 2 },
    )).toEqual(play(null, { autoplay: false }));
  });

  it('append 在空队列或上一首结束后从新歌开始', () => {
    expect(planExternalPlayback(
      { queueLength: 0, hasSrc: false, ended: false },
      { mode: 'append', incoming: 2 },
    )).toEqual(play(0));
    expect(planExternalPlayback(
      { queueLength: 3, hasSrc: true, ended: true },
      { mode: 'append', incoming: 2 },
    )).toEqual(play(3));
  });

  it('没有新歌就不播', () => {
    expect(planExternalPlayback(
      { queueLength: 0, hasSrc: false },
      { mode: 'replace', incoming: 0 },
    )).toEqual(play(null, { autoplay: false }));
  });

  it('先暂停，再来新队列，自动播放且不弹遮罩', () => {
    const paused = {
      queueLength: 2,
      hasSrc: true,
      ended: false,
      paused: true,
      index: 1,
      userActivated: true,
    };
    expect(planExternalPlayback(paused, { mode: 'replace', incoming: 1 })).toEqual(play(0));
    expect(planExternalPlayback(paused, { mode: 'append', incoming: 1 })).toEqual(play(1, {
      resume: true,
    }));
  });
});
