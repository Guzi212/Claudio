import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExec = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ exec: mockExec }));

describe('services/lark-calendar', () => {
  beforeEach(() => {
    vi.resetModules();
    mockExec.mockReset();
  });

  it('导出 getTodayEvents', async () => {
    const mod = await import('../server/services/lark-calendar.js');
    expect(typeof mod.getTodayEvents).toBe('function');
  });

  it('lark-cli 不存在/调用失败时返回 null（不抛）', async () => {
    mockExec.mockImplementation((cmd, opts, cb) => cb(new Error("'lark-cli' is not recognized")));
    const { getTodayEvents } = await import('../server/services/lark-calendar.js');
    const r = await getTodayEvents();
    expect(r).toBeNull();
  });

  it('成功路径：解析 JSON 并规范化为 {title,start,end,location}', async () => {
    const payload = JSON.stringify({
      events: [
        {
          title: '产品评审',
          start_time: '2026-05-18T15:00:00',
          end_time: '2026-05-18T16:00:00',
          location: 'A301',
        },
        {
          summary: '午餐',
          start: { date_time: '2026-05-18T12:00:00' },
          end: { date_time: '2026-05-18T13:00:00' },
        },
      ],
    });
    mockExec.mockImplementation((cmd, opts, cb) => cb(null, { stdout: payload, stderr: '' }));
    const { getTodayEvents } = await import('../server/services/lark-calendar.js');
    const r = await getTodayEvents();
    expect(Array.isArray(r)).toBe(true);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({
      title: '产品评审',
      start: '2026-05-18T15:00:00',
      end: '2026-05-18T16:00:00',
      location: 'A301',
    });
    expect(r[1]).toMatchObject({
      title: '午餐',
      start: '2026-05-18T12:00:00',
    });
  });

  it('根为数组的 JSON 同样可解析', async () => {
    const payload = JSON.stringify([{ title: '一对一', start_time: '2026-05-18T09:00:00' }]);
    mockExec.mockImplementation((cmd, opts, cb) => cb(null, { stdout: payload, stderr: '' }));
    const { getTodayEvents } = await import('../server/services/lark-calendar.js');
    const r = await getTodayEvents();
    expect(r).toHaveLength(1);
    expect(r[0].title).toBe('一对一');
  });

  it('JSON 解析失败时返回 null（不抛）', async () => {
    mockExec.mockImplementation((cmd, opts, cb) => cb(null, { stdout: 'not-json', stderr: '' }));
    const { getTodayEvents } = await import('../server/services/lark-calendar.js');
    const r = await getTodayEvents();
    expect(r).toBeNull();
  });

  it('60s 内重复调用走缓存（exec 仅触发 1 次）', async () => {
    mockExec.mockImplementation((cmd, opts, cb) => cb(null, { stdout: '[]', stderr: '' }));
    const { getTodayEvents } = await import('../server/services/lark-calendar.js');
    await getTodayEvents();
    await getTodayEvents();
    expect(mockExec).toHaveBeenCalledTimes(1);
  });
});
