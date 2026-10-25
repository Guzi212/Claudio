import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { claimPlayLoad, isOwnEcho, planRuntimeSync } from '../pwa/runtime-sync.js';
import { stateBroadcast } from '../server/runtime-events.js';

const song = { title: '尾声', artist: '本地', kugouId: 'h1' };

function drive(events, clientId) {
  const local = { queue: [song], index: 0, hasSrc: true, ended: true };
  let loading = null;
  let playIndexCalls = 0;
  let pauseCalls = 0;
  for (const event of events) {
    if (isOwnEcho(event.origin, clientId)) continue;
    const plan = planRuntimeSync(local, event.runtime);
    if (plan.playIndex != null) {
      const claim = claimPlayLoad(loading, plan.playIndex);
      loading = claim.loading;
      if (!claim.accept) continue;
      playIndexCalls += 1;
      // 直链还没回来，ended 仍是 true，和 playIndex 里的 await 一样。
    } else if (plan.pause === true) {
      pauseCalls += 1;
    }
  }
  return { playIndexCalls, pauseCalls };
}

describe('播完重播的回声', () => {
  const clientId = 'page-a';

  it('最后一首 ended 之后，外部 play 只重播一次，自己的回声不再 pause', () => {
    const play = { queue: [song], index: 0, paused: false, volume: 30 };
    const echoPause = { queue: [song], index: 0, paused: true, volume: 30 };
    expect(drive([
      { origin: undefined, runtime: play },
      { origin: clientId, runtime: play },
      { origin: clientId, runtime: echoPause },
      { origin: clientId, runtime: play },
      { origin: clientId, runtime: echoPause },
      { origin: clientId, runtime: play },
    ], clientId)).toEqual({ playIndexCalls: 1, pauseCalls: 0 });
  });

  it('ended 本身不会因为队列没变就换歌；外部 play 才从头重播', () => {
    const local = { queue: [song], index: 0, hasSrc: true, ended: true };
    expect(planRuntimeSync(local, { queue: [song], index: 0, paused: true })).toMatchObject({
      playIndex: null,
      pause: true,
      restart: false,
    });
    expect(planRuntimeSync(local, { queue: [song], index: 0, paused: false })).toMatchObject({
      playIndex: 0,
      pause: false,
      restart: true,
    });
  });

  it('同一个 index 还在加载时，重复 playIndex 被丢掉', () => {
    const first = claimPlayLoad(null, 0);
    const second = claimPlayLoad(first.loading, 0);
    const other = claimPlayLoad(first.loading, 1);
    expect(first.accept).toBe(true);
    expect(second.accept).toBe(false);
    expect(other.accept).toBe(true);
  });

  it('别的页面的 id 不算自己的回声，空 origin 算外部命令', () => {
    expect(isOwnEcho('page-a', 'page-a')).toBe(true);
    expect(isOwnEcho('page-b', 'page-a')).toBe(false);
    expect(isOwnEcho(undefined, 'page-a')).toBe(false);
    expect(isOwnEcho('', 'page-a')).toBe(false);
  });

  it('页面报上来的状态广播带 origin，控制命令不带', () => {
    const runtime = { queue: [song], index: 0, paused: false };
    expect(stateBroadcast(runtime, 'page-a')).toEqual({
      type: 'state',
      runtime,
      origin: 'page-a',
    });
    expect(stateBroadcast(runtime, '  page-a  ').origin).toBe('page-a');
    expect(stateBroadcast(runtime, '')).toEqual({ type: 'state', runtime });
    expect(stateBroadcast(runtime, null)).toEqual({ type: 'state', runtime });
  });
});

describe('页面把 clientId 带上，并且不再用 userActivated 挡住 play()', () => {
  const player = fs.readFileSync(new URL('../pwa/views/player.js', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../pwa/app.js', import.meta.url), 'utf8');
  const server = fs.readFileSync(new URL('../server/app.js', import.meta.url), 'utf8');

  it('sync 和 progress 都带 clientId，自己的 origin 不驱动播放', () => {
    expect(player).toContain('clientId: getClientId()');
    expect(player).toContain('isOwnEcho');
    expect(player).not.toContain('autoplay && userActivated');
    expect(player).not.toMatch(/syncToServer\(state\.index\)\s*;/);
    expect(app).toContain('origin: evt.origin');
    expect(server).toContain('stateBroadcast');
  });
});
