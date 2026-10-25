import { describe, expect, it } from 'vitest';
import { planExternalPlayback } from '../pwa/external-playback.js';

describe('planExternalPlayback', () => {
  it('replace 从第 0 首开始', () => {
    expect(planExternalPlayback(
      { queueLength: 4, hasSrc: true, ended: false },
      { mode: 'replace', incoming: 2 },
    )).toEqual({ playIndex: 0 });
  });

  it('append 正在播时不打断', () => {
    expect(planExternalPlayback(
      { queueLength: 3, hasSrc: true, ended: false },
      { mode: 'append', incoming: 2 },
    )).toEqual({ playIndex: null });
  });

  it('append 在空队列或上一首结束后从新歌开始', () => {
    expect(planExternalPlayback(
      { queueLength: 0, hasSrc: false, ended: false },
      { mode: 'append', incoming: 2 },
    )).toEqual({ playIndex: 0 });
    expect(planExternalPlayback(
      { queueLength: 3, hasSrc: true, ended: true },
      { mode: 'append', incoming: 2 },
    )).toEqual({ playIndex: 3 });
  });

  it('没有新歌就不播', () => {
    expect(planExternalPlayback(
      { queueLength: 0, hasSrc: false },
      { mode: 'replace', incoming: 0 },
    )).toEqual({ playIndex: null });
  });
});
