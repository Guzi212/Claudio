import { describe, it, expect, vi } from 'vitest';
import {
  queueRemainingSeconds,
  shouldRefill,
  buildRefillPrompt,
  pickFreshTracks,
  startResidentDj,
  djEnabled,
  isFaithfulMatch,
  DJ_SOURCE,
} from '../server/dj/resident.js';
import { trackKey } from '../server/dj/taste-memory.js';

function fakeRuntime(overrides = {}) {
  return {
    queue: [],
    index: 0,
    paused: false,
    active: true,
    currentTime: 0,
    queuedAt: null,
    queuedSource: '',
    ...overrides,
  };
}

function fakeDb({ plays = [] } = {}) {
  const prefs = new Map();
  return {
    plays,
    added: [],
    getPref: key => prefs.get(key) ?? null,
    setPref: (key, value) => prefs.set(key, String(value)),
    delPref: key => prefs.delete(key),
    recentPlays: n => plays.slice(0, n),
    addPlay: vi.fn(p => { plays.unshift({ id: plays.length + 1, ...p }); }),
  };
}

const track = (title, artist = 'A', duration = 200) => ({
  title, artist, duration, kugouId: `hash-${title}`, audioUrl: `/api/proxy?u=${title}`,
});

describe('dj · queueRemainingSeconds', () => {
  it('从当前索引往后累加，再扣掉已播时间', () => {
    const rt = fakeRuntime({ queue: [track('a'), track('b'), track('c')], index: 1, currentTime: 50 });
    expect(queueRemainingSeconds(rt)).toBe(350);
  });

  it('空队列是 0', () => {
    expect(queueRemainingSeconds(fakeRuntime())).toBe(0);
  });

  it('没时长的条目（TTS）不计入', () => {
    const rt = fakeRuntime({ queue: [{ title: '🔊 串词', duration: 0 }, track('a')], index: 0 });
    expect(queueRemainingSeconds(rt)).toBe(200);
  });

  it('索引越界不报错', () => {
    const rt = fakeRuntime({ queue: [track('a')], index: 5 });
    expect(queueRemainingSeconds(rt)).toBe(0);
  });
});

describe('dj · shouldRefill', () => {
  const now = Date.parse('2026-11-09T21:00:00Z');

  it('没页面连着不补', () => {
    const rt = fakeRuntime({ active: false, queue: [track('a')] });
    expect(shouldRefill(rt, { now }).reason).toBe('inactive');
  });

  it('手动暂停时不补', () => {
    const rt = fakeRuntime({ paused: true, queue: [track('a')] });
    expect(shouldRefill(rt, { now }).reason).toBe('paused');
  });

  it('外部刚投过歌就让位', () => {
    const rt = fakeRuntime({
      queue: [track('a')],
      queuedAt: new Date(now - 30_000).toISOString(),
      queuedSource: 'claudio-host',
    });
    expect(shouldRefill(rt, { now, yieldMs: 180_000 }).reason).toBe('external-active');
  });

  it('自己刚投过的不算外部，可以继续补', () => {
    const rt = fakeRuntime({
      queue: [track('a')],
      queuedAt: new Date(now - 30_000).toISOString(),
      queuedSource: DJ_SOURCE,
    });
    expect(shouldRefill(rt, { now, yieldMs: 180_000 }).ok).toBe(true);
  });

  it('剩得够多就不动', () => {
    const rt = fakeRuntime({ queue: [track('a', 'A', 1800)], index: 0 });
    expect(shouldRefill(rt, { now, refillBelowSeconds: 600 }).reason).toBe('enough');
  });

  it('剩不到阈值就补', () => {
    const rt = fakeRuntime({ queue: [track('a', 'A', 400)], index: 0 });
    const d = shouldRefill(rt, { now, refillBelowSeconds: 600 });
    expect(d.ok).toBe(true);
    expect(d.reason).toBe('low');
    expect(d.remaining).toBe(400);
  });

  it('空队列直接补', () => {
    expect(shouldRefill(fakeRuntime(), { now }).reason).toBe('empty');
  });
});

describe('dj · buildRefillPrompt', () => {
  it('带上剩余分钟、批量数和最近播放', () => {
    const p = buildRefillPrompt({
      remainingSeconds: 240,
      batchSize: 5,
      recent: [{ title: '晴天', artist: '周杰伦' }],
    });
    expect(p).toContain('还剩 4 分钟');
    expect(p).toContain('接着排 5 首');
    expect(p).toContain('晴天 — 周杰伦');
  });
});

describe('dj · pickFreshTracks', () => {
  it('剔掉最近播过的，批内也去重', () => {
    const out = pickFreshTracks(
      [track('晴天', '周杰伦'), track('晴天', '周杰伦'), track('七里香', '周杰伦')],
      new Set([trackKey('晴天', '周杰伦')]),
    );
    expect(out.map(t => t.title)).toEqual(['七里香']);
  });

  it('没有重复就原样返回', () => {
    const out = pickFreshTracks([track('a'), track('b')], new Set());
    expect(out).toHaveLength(2);
  });
});

describe('dj · startResidentDj', () => {
  const baseOptions = { tickMs: 1e9, cooldownMs: 0, batchSize: 3 };

  it('没有页面连着时一次模型都不调', async () => {
    const ask = vi.fn();
    const dj = startResidentDj({
      runtime: fakeRuntime({ active: false }),
      ask,
      db: fakeDb(),
      buildSystemPrompt: async () => 'sys',
      options: baseOptions,
    });
    await dj.tick();
    expect(ask).not.toHaveBeenCalled();
    dj.stop();
  });

  it('剩余不足时补歌，接在队尾，不动当前索引', async () => {
    const runtime = fakeRuntime({
      queue: [track('旧歌', 'B', 300)],
      index: 0,
      currentTime: 100,
      queueSource: 'bot',
    });
    const db = fakeDb();
    const ask = vi.fn(async () => ({
      say: '接着来几首',
      reason: '夜间续播',
      queue: [track('新歌一'), track('新歌二'), track('新歌三')],
    }));
    const broadcast = vi.fn();
    const dj = startResidentDj({
      runtime,
      ask,
      db,
      broadcast,
      buildSystemPrompt: async () => 'sys',
      synthesize: async () => null,
      options: baseOptions,
    });

    await dj.tick();

    expect(ask).toHaveBeenCalledTimes(1);
    expect(runtime.queue).toHaveLength(4);
    expect(runtime.index).toBe(0);
    expect(runtime.queue[3].title).toBe('新歌三');
    expect(runtime.queue[3].source).toBe(DJ_SOURCE);
    expect(runtime.queuedSource).toBe(DJ_SOURCE);
    expect(runtime.lastSay).toBe('接着来几首');
    expect(db.addPlay).toHaveBeenCalledTimes(3);
    expect(dj.state.refillCount).toBe(1);
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'external-queue', mode: 'append' }));
    dj.stop();
  });

  it('模型给的全是最近播过的就不写队列', async () => {
    const runtime = fakeRuntime({ queue: [track('旧歌', 'B', 100)] });
    const db = fakeDb({ plays: [{ id: 1, title: '新歌一', artist: 'A' }] });
    const ask = vi.fn(async () => ({ say: '', queue: [track('新歌一')], reason: '' }));
    const dj = startResidentDj({
      runtime,
      ask,
      db,
      buildSystemPrompt: async () => 'sys',
      synthesize: async () => null,
      options: baseOptions,
    });

    const result = await dj.tick();

    expect(runtime.queue).toHaveLength(1);
    expect(dj.state.lastError).toBe('no-fresh-tracks');
    expect(result).toBeUndefined();
    dj.stop();
  });

  it('模型报错记进 lastError，不炸进程', async () => {
    const runtime = fakeRuntime({ queue: [track('旧歌', 'B', 100)] });
    const dj = startResidentDj({
      runtime,
      ask: async () => { throw new Error('boom'); },
      db: fakeDb(),
      buildSystemPrompt: async () => 'sys',
      options: baseOptions,
    });

    await dj.tick();

    expect(dj.state.lastError).toBe('boom');
    expect(dj.status().lastError).toBe('boom');
    dj.stop();
  });

  it('手动 refill 不等阈值', async () => {
    const runtime = fakeRuntime({ queue: [track('长歌', 'B', 3600)] });
    const ask = vi.fn(async () => ({ say: '', queue: [track('手动补')], reason: '' }));
    const dj = startResidentDj({
      runtime,
      ask,
      db: fakeDb(),
      buildSystemPrompt: async () => 'sys',
      synthesize: async () => null,
      options: baseOptions,
    });

    const result = await dj.refill({ trigger: 'manual' });

    expect(result.ok).toBe(true);
    expect(runtime.queue).toHaveLength(2);
    dj.stop();
  });

  it('status 带剩余时长和配置', () => {
    const runtime = fakeRuntime({ queue: [track('a', 'A', 600)] });
    const dj = startResidentDj({
      runtime,
      ask: vi.fn(),
      db: fakeDb(),
      buildSystemPrompt: async () => 'sys',
      options: baseOptions,
    });
    const st = dj.status();
    expect(st.enabled).toBe(true);
    expect(st.remainingSeconds).toBe(600);
    expect(st.config.batchSize).toBe(3);
    dj.stop();
  });
});

describe('dj · isFaithfulMatch', () => {
  it('歌名和歌手都对得上就通过', () => {
    expect(isFaithfulMatch({
      title: 'Spiegel im Spiegel', artist: 'Arvo Pärt',
      requested: { title: 'Spiegel im Spiegel', artist: 'Arvo Pärt' },
    })).toBe(true);
  });

  it('解析成完全不同的歌就拦下', () => {
    expect(isFaithfulMatch({
      title: '说散就散.mp3', artist: '袁娅维TIA RAY',
      requested: { title: 'Spiegel im Spiegel', artist: 'Arvo Pärt' },
    })).toBe(false);
  });

  it('歌名对但歌手完全不对也拦下', () => {
    expect(isFaithfulMatch({
      title: 'Experience', artist: '某个翻唱歌手',
      requested: { title: 'Experience', artist: 'Ludovico Einaudi' },
    })).toBe(false);
  });

  it('模型没给歌手时只看歌名', () => {
    expect(isFaithfulMatch({
      title: 'Experience', artist: 'Ludovico Einaudi',
      requested: { title: 'Experience', artist: '' },
    })).toBe(true);
  });

  it('没有 requested 信息时放行（兼容旧调用）', () => {
    expect(isFaithfulMatch({ title: 'Experience', artist: 'X' })).toBe(true);
  });
});

describe('dj · djEnabled', () => {
  it('认 1/true/on/yes', () => {
    for (const v of ['1', 'true', 'on', 'yes', ' TRUE ']) {
      expect(djEnabled({ CLAUDIO_DJ: v })).toBe(true);
    }
    for (const v of ['', '0', 'off', 'no', undefined]) {
      expect(djEnabled({ CLAUDIO_DJ: v })).toBe(false);
    }
  });
});
