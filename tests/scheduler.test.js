import { describe, it, expect, vi } from 'vitest';
import cron from 'node-cron';

// 测试通过 DI 注入假的 cronLib / ask / buildSystemPrompt,
// 这样测试既不会真起 cron,也不会真 spawn claude CLI.
function fakeCronLib() {
  const captured = [];
  const tasks = [];
  return {
    captured,
    tasks,
    schedule(expr, cb) {
      const t = { stop: vi.fn(), start: vi.fn() };
      tasks.push(t);
      captured.push({ expr, cb });
      return t;
    },
  };
}

function fakeRuntime(overrides = {}) {
  return { queue: [], index: 0, paused: false, lastSay: '', active: false, ...overrides };
}

describe('scheduler · JOBS 静态约定', () => {
  it('暴露 morning-plan / morning-commute / hourly-mood 三个 job', async () => {
    const { JOBS } = await import('../server/scheduler.js');
    const byName = Object.fromEntries(JOBS.map(j => [j.name, j]));
    expect(byName['morning-plan']).toBeDefined();
    expect(byName['morning-commute']).toBeDefined();
    expect(byName['hourly-mood']).toBeDefined();
  });

  it('cron 表达式对齐 07:00 / 09:00 / 每小时 :00', async () => {
    const { JOBS } = await import('../server/scheduler.js');
    const byName = Object.fromEntries(JOBS.map(j => [j.name, j]));
    expect(byName['morning-plan'].cron).toBe('0 7 * * *');
    expect(byName['morning-commute'].cron).toBe('0 9 * * *');
    expect(byName['hourly-mood'].cron).toBe('0 * * * *');
  });

  it('每个 cron 表达式都能通过 node-cron 校验', async () => {
    const { JOBS } = await import('../server/scheduler.js');
    for (const job of JOBS) {
      expect(cron.validate(job.cron)).toBe(true);
    }
  });

  it('hourly-mood 标记为 gated · 其它两个不 gated', async () => {
    const { JOBS } = await import('../server/scheduler.js');
    const byName = Object.fromEntries(JOBS.map(j => [j.name, j]));
    expect(byName['hourly-mood'].gated).toBe(true);
    expect(byName['morning-plan'].gated).toBeFalsy();
    expect(byName['morning-commute'].gated).toBeFalsy();
  });
});

describe('scheduler · start / stop 接口', () => {
  it('start 返回带 stop / addCalendarHook / fireCalendarEvent 的 handle', async () => {
    const { start, JOBS } = await import('../server/scheduler.js');
    const cronLib = fakeCronLib();
    const handle = start({
      runtime: fakeRuntime(),
      broadcast: () => {},
      log: () => {},
      ask: async () => ({ say: '', queue: [], reason: '' }),
      buildSystemPrompt: () => '',
      cronLib,
    });
    expect(typeof handle.stop).toBe('function');
    expect(typeof handle.addCalendarHook).toBe('function');
    expect(typeof handle.fireCalendarEvent).toBe('function');
    expect(cronLib.captured).toHaveLength(JOBS.length);
  });

  it('stop() 调用所有 task 的 stop', async () => {
    const { start } = await import('../server/scheduler.js');
    const cronLib = fakeCronLib();
    const handle = start({
      runtime: fakeRuntime(),
      broadcast: () => {},
      log: () => {},
      ask: async () => ({ say: '', queue: [], reason: '' }),
      buildSystemPrompt: () => '',
      cronLib,
    });
    handle.stop();
    for (const t of cronLib.tasks) {
      expect(t.stop).toHaveBeenCalled();
    }
  });

  it('start 缺 runtime 或 broadcast 时抛错', async () => {
    const { start } = await import('../server/scheduler.js');
    expect(() => start({ broadcast: () => {} })).toThrow();
    expect(() => start({ runtime: fakeRuntime() })).toThrow();
  });
});

describe('scheduler · job 触发行为', () => {
  it('morning-plan 触发 ask(systemPrompt, "早安...") 并把 queue 写回 runtime', async () => {
    const { start } = await import('../server/scheduler.js');
    const cronLib = fakeCronLib();
    const runtime = fakeRuntime();
    const broadcast = vi.fn();
    const askFn = vi.fn(async () => ({
      say: '早安',
      queue: [{ title: 'A', artist: 'B', kugouId: 'k1', audioUrl: '/x' }],
      reason: 'taste',
    }));

    start({
      runtime, broadcast, log: () => {},
      ask: askFn,
      buildSystemPrompt: () => 'SYS',
      cronLib,
    });

    const plan = cronLib.captured.find(c => c.expr === '0 7 * * *');
    await plan.cb();

    expect(askFn).toHaveBeenCalledTimes(1);
    const [sysArg, msgArg] = askFn.mock.calls[0];
    expect(sysArg).toBe('SYS');
    expect(msgArg).toMatch(/早安/);
    expect(runtime.lastSay).toBe('早安');
    expect(runtime.queue).toHaveLength(1);
    expect(runtime.index).toBe(0);
    expect(runtime.paused).toBe(false);
    expect(broadcast).toHaveBeenCalled();
  });

  it('morning-commute 触发的 prompt 跟上班路上有关', async () => {
    const { start } = await import('../server/scheduler.js');
    const cronLib = fakeCronLib();
    const askFn = vi.fn(async () => ({ say: '', queue: [], reason: '' }));

    start({
      runtime: fakeRuntime(),
      broadcast: () => {}, log: () => {},
      ask: askFn,
      buildSystemPrompt: () => '',
      cronLib,
    });

    const commute = cronLib.captured.find(c => c.expr === '0 9 * * *');
    await commute.cb();

    expect(askFn).toHaveBeenCalled();
    expect(askFn.mock.calls[0][1]).toMatch(/上班|路上|提气/);
  });

  it('hourly-mood 在 runtime.active=false 时不触发 ask', async () => {
    const { start } = await import('../server/scheduler.js');
    const cronLib = fakeCronLib();
    const askFn = vi.fn(async () => ({ say: 'x', queue: [], reason: '' }));

    start({
      runtime: fakeRuntime({ active: false }),
      broadcast: () => {}, log: () => {},
      ask: askFn,
      buildSystemPrompt: () => '',
      cronLib,
    });

    const hourly = cronLib.captured.find(c => c.expr === '0 * * * *');
    await hourly.cb();

    expect(askFn).not.toHaveBeenCalled();
  });

  it('hourly-mood 在 runtime.active=true 时触发 ask', async () => {
    const { start } = await import('../server/scheduler.js');
    const cronLib = fakeCronLib();
    const askFn = vi.fn(async () => ({ say: 'ok', queue: [], reason: '' }));

    start({
      runtime: fakeRuntime({ active: true }),
      broadcast: () => {}, log: () => {},
      ask: askFn,
      buildSystemPrompt: () => '',
      cronLib,
    });

    const hourly = cronLib.captured.find(c => c.expr === '0 * * * *');
    await hourly.cb();

    expect(askFn).toHaveBeenCalledTimes(1);
    expect(askFn.mock.calls[0][1]).toMatch(/氛围|换/);
  });

  it('ask 抛错时 job 不崩,记日志', async () => {
    const { start } = await import('../server/scheduler.js');
    const cronLib = fakeCronLib();
    const log = vi.fn();
    const askFn = vi.fn(async () => { throw new Error('claude down'); });

    start({
      runtime: fakeRuntime({ active: true }),
      broadcast: () => {}, log,
      ask: askFn,
      buildSystemPrompt: () => '',
      cronLib,
    });

    // 触发 morning-plan,内部抛错,不应往外冒
    const plan = cronLib.captured.find(c => c.expr === '0 7 * * *');
    await expect(plan.cb()).resolves.toBeUndefined();

    const logged = log.mock.calls.map(c => String(c[0])).join('|');
    expect(logged).toMatch(/morning-plan/);
    expect(logged).toMatch(/claude down|failed|error/i);
  });

  it('ask 返回空 queue 时不动 runtime.queue 但仍刷新 lastSay', async () => {
    const { start } = await import('../server/scheduler.js');
    const cronLib = fakeCronLib();
    const runtime = fakeRuntime({ queue: [{ title: '旧', artist: 'X' }], index: 0 });
    const askFn = vi.fn(async () => ({ say: '随便聊聊', queue: [], reason: '' }));

    start({
      runtime, broadcast: () => {}, log: () => {},
      ask: askFn,
      buildSystemPrompt: () => '',
      cronLib,
    });

    const plan = cronLib.captured.find(c => c.expr === '0 7 * * *');
    await plan.cb();

    expect(runtime.queue).toHaveLength(1);
    expect(runtime.queue[0].title).toBe('旧');
    expect(runtime.lastSay).toBe('随便聊聊');
  });
});

describe('scheduler · 日历 hook 预留接口', () => {
  it('addCalendarHook 注册的回调能被 fireCalendarEvent 触发', async () => {
    const { start } = await import('../server/scheduler.js');
    const cronLib = fakeCronLib();
    const handle = start({
      runtime: fakeRuntime(),
      broadcast: () => {}, log: () => {},
      ask: async () => ({ say: '', queue: [], reason: '' }),
      buildSystemPrompt: () => '',
      cronLib,
    });

    const cb = vi.fn();
    handle.addCalendarHook(cb);
    await handle.fireCalendarEvent({ id: 'evt1', summary: '会议' });

    expect(cb).toHaveBeenCalledWith({ id: 'evt1', summary: '会议' });
  });

  it('addCalendarHook 返回的解注册函数能移除回调', async () => {
    const { start } = await import('../server/scheduler.js');
    const cronLib = fakeCronLib();
    const handle = start({
      runtime: fakeRuntime(),
      broadcast: () => {}, log: () => {},
      ask: async () => ({ say: '', queue: [], reason: '' }),
      buildSystemPrompt: () => '',
      cronLib,
    });

    const cb = vi.fn();
    const remove = handle.addCalendarHook(cb);
    remove();
    await handle.fireCalendarEvent({ id: 'evt2' });
    expect(cb).not.toHaveBeenCalled();
  });

  it('多个 hook 都会被依次触发,单个失败不影响其它', async () => {
    const { start } = await import('../server/scheduler.js');
    const cronLib = fakeCronLib();
    const log = vi.fn();
    const handle = start({
      runtime: fakeRuntime(),
      broadcast: () => {}, log,
      ask: async () => ({ say: '', queue: [], reason: '' }),
      buildSystemPrompt: () => '',
      cronLib,
    });

    const cb1 = vi.fn(() => { throw new Error('boom'); });
    const cb2 = vi.fn();
    handle.addCalendarHook(cb1);
    handle.addCalendarHook(cb2);

    await handle.fireCalendarEvent({ id: 'e' });
    expect(cb1).toHaveBeenCalled();
    expect(cb2).toHaveBeenCalled();
    expect(log.mock.calls.some(c => /calendar/i.test(String(c[0])))).toBe(true);
  });

  it('addCalendarHook 传非函数时抛错', async () => {
    const { start } = await import('../server/scheduler.js');
    const cronLib = fakeCronLib();
    const handle = start({
      runtime: fakeRuntime(),
      broadcast: () => {}, log: () => {},
      ask: async () => ({ say: '', queue: [], reason: '' }),
      buildSystemPrompt: () => '',
      cronLib,
    });

    expect(() => handle.addCalendarHook('not a fn')).toThrow();
    expect(() => handle.addCalendarHook(null)).toThrow();
  });
});

describe('scheduler · 默认状态', () => {
  it('仅 import 模块不调用任何 cron.schedule', async () => {
    // 通过断言 cron.getTasks() 在 import 后仍为空来近似验证
    // (注意: 其它测试可能注入了 task,所以读 task 数前先校验数量稳定性即可)
    const before = cron.getTasks().size;
    await import('../server/scheduler.js');
    const after = cron.getTasks().size;
    expect(after).toBe(before);
  });
});
