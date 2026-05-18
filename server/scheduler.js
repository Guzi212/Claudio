import cron from 'node-cron';
import { ask as defaultAsk } from './claude.js';
import { buildSystemPrompt as defaultBuildSystemPrompt } from './context.js';

// 施工图第 2 层 · 节律调度
//
// JOBS 是静态约定:cron 表达式 + 触发时投给 Claude 的 prompt + 是否需要 PWA 在线门禁。
// 把它从函数体里抽出来,测试可以直接断言形状,prompt 文案也能集中维护。
export const JOBS = [
  {
    name: 'morning-plan',
    cron: '0 7 * * *',
    prompt: '早安,规划今天的播放氛围',
    gated: false,
  },
  {
    name: 'morning-commute',
    cron: '0 9 * * *',
    prompt: '到上班路上了,给我点提气的',
    gated: false,
  },
  {
    name: 'hourly-mood',
    cron: '0 * * * *',
    prompt: '当前氛围合适吗?需要换吗?',
    gated: true,
  },
];

/**
 * 启动调度器。
 *
 * 所有外部依赖都通过参数注入,默认值指向真实模块。
 * 这样测试可以塞 fake cronLib / ask / buildSystemPrompt,
 * 既不真起 cron,也不真 spawn claude CLI。
 *
 * @param {object} opts
 * @param {object} opts.runtime  共享运行时状态(参见 server/app.js 的 runtime)
 * @param {(event: object) => void} opts.broadcast  WS 广播
 * @param {(msg: string) => void} [opts.log]  日志
 * @param {Function} [opts.ask]  默认走 claude.ask
 * @param {Function} [opts.buildSystemPrompt]  默认走 context.buildSystemPrompt
 * @param {object} [opts.cronLib]  默认 node-cron
 * @returns {{ stop: () => void, addCalendarHook: Function, fireCalendarEvent: Function }}
 */
export function start({
  runtime,
  broadcast,
  log = (...args) => console.log('[scheduler]', ...args),
  ask = defaultAsk,
  buildSystemPrompt = defaultBuildSystemPrompt,
  cronLib = cron,
} = {}) {
  if (!runtime || typeof broadcast !== 'function') {
    throw new Error('scheduler.start 需要 { runtime, broadcast }');
  }

  const tasks = [];
  const calendarHooks = [];

  async function runJob(job) {
    if (job.gated && !runtime.active) {
      log(`${job.name} skipped (PWA not active)`);
      return;
    }
    try {
      const sys = buildSystemPrompt();
      const { say, queue, reason } = await ask(sys, job.prompt);
      if (Array.isArray(queue) && queue.length > 0) {
        runtime.queue = queue;
        runtime.index = 0;
        runtime.paused = false;
      }
      runtime.lastSay = say ?? '';
      broadcast({ type: 'state', runtime, trigger: job.name, reason });
      log(`${job.name} done: ${queue?.length ?? 0} tracks · say="${(say ?? '').slice(0, 40)}"`);
    } catch (err) {
      log(`${job.name} failed: ${err.message}`);
    }
  }

  for (const job of JOBS) {
    const task = cronLib.schedule(job.cron, () => runJob(job));
    tasks.push({ name: job.name, task });
  }

  function addCalendarHook(eventCb) {
    if (typeof eventCb !== 'function') {
      throw new TypeError('addCalendarHook 需要传入函数');
    }
    calendarHooks.push(eventCb);
    return function remove() {
      const i = calendarHooks.indexOf(eventCb);
      if (i >= 0) calendarHooks.splice(i, 1);
    };
  }

  async function fireCalendarEvent(event) {
    for (const cb of calendarHooks) {
      try {
        await cb(event);
      } catch (err) {
        log(`calendar hook error: ${err.message}`);
      }
    }
  }

  function stop() {
    for (const { task } of tasks) {
      if (task && typeof task.stop === 'function') task.stop();
    }
  }

  return { stop, addCalendarHook, fireCalendarEvent };
}

export default { start, JOBS };
