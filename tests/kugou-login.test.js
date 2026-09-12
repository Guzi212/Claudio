import { describe, it, expect, vi } from 'vitest';
import {
  refreshCookie,
  refreshLogin,
  ensureLogin,
  startAutoRefresh,
  refreshIntervalMs,
  isCookieAlive,
  beginQrLogin,
} from '../server/services/kugou-login.js';

function fakeDb(initial = {}) {
  const store = { ...initial };
  return {
    getPref: (k) => store[k],
    setPref: vi.fn((k, v) => { store[k] = v; }),
    _store: store,
  };
}

describe('refreshCookie', () => {
  it('status=1 → 合并 Set-Cookie 与 body 内字段', async () => {
    const httpGet = async () => ({
      data: { status: 1, data: { token: 'NEW', t1: 'T1', vip_token: 'V' } },
      cookies: { userid: '5', dfid: 'DF' },
    });
    const out = await refreshCookie('token=OLD; userid=5; dfid=OLDDF', { httpGet });
    expect(out).toBe('token=NEW; userid=5; t1=T1; dfid=DF; vip_token=V');
  });

  it('status != 1 → null', async () => {
    const httpGet = async () => ({ data: { status: 0, error_code: 20002 }, cookies: {} });
    expect(await refreshCookie('token=OLD; userid=5', { httpGet })).toBeNull();
  });

  it('请求异常 → null（不抛）', async () => {
    const httpGet = async () => { throw new Error('boom'); };
    expect(await refreshCookie('token=OLD; userid=5', { httpGet })).toBeNull();
  });

  it('空 cookie → null，且不发请求', async () => {
    const httpGet = vi.fn();
    expect(await refreshCookie('', { httpGet })).toBeNull();
    expect(httpGet).not.toHaveBeenCalled();
  });
});

describe('refreshLogin', () => {
  it('无 cookie → no-cookie', async () => {
    const db = fakeDb({});
    const out = await refreshLogin({ db, env: {}, refresh: async () => 'x' });
    expect(out).toMatchObject({ ok: false, reason: 'no-cookie' });
  });

  it('成功 → 写回 db', async () => {
    const db = fakeDb({ kugou_cookie: 'token=OLD; userid=1' });
    const out = await refreshLogin({ db, env: {}, refresh: async () => 'token=NEW; userid=1' });
    expect(out.ok).toBe(true);
    expect(db.getPref('kugou_cookie')).toBe('token=NEW; userid=1');
  });

  it('刷新失败 → 不动 db', async () => {
    const db = fakeDb({ kugou_cookie: 'token=OLD; userid=1' });
    const out = await refreshLogin({ db, env: {}, refresh: async () => null });
    expect(out).toMatchObject({ ok: false, reason: 'refresh-failed' });
    expect(db.getPref('kugou_cookie')).toBe('token=OLD; userid=1');
    expect(db.setPref).not.toHaveBeenCalled();
  });
});

describe('ensureLogin', () => {
  const noopQr = async () => {};

  it('db cookie 存活 → 续期成功并写库（不再重登）', async () => {
    const db = fakeDb({ kugou_cookie: 'token=OK; userid=1' });
    const passwordLogin = vi.fn(async () => { throw new Error('should not login by password'); });
    const out = await ensureLogin({
      db,
      env: {},
      aliveCheck: async () => true,
      refresh: async () => 'token=FRESH; userid=1',
      passwordLogin,
      qrHint: noopQr,
    });
    expect(out).toEqual({ ok: true, source: 'refresh' });
    expect(db.getPref('kugou_cookie')).toBe('token=FRESH; userid=1');
    expect(passwordLogin).not.toHaveBeenCalled();
  });

  it('存活但续期失败 → 仍可用于播放', async () => {
    const db = fakeDb({ kugou_cookie: 'token=OK; userid=1' });
    const out = await ensureLogin({
      db,
      env: {},
      aliveCheck: async () => true,
      refresh: async () => null,
      qrHint: noopQr,
    });
    expect(out).toEqual({ ok: true, source: 'db' });
  });

  it('db cookie 优先于 env（续期写入 db 后以 db 为准）', async () => {
    const db = fakeDb({ kugou_cookie: 'token=DB; userid=1' });
    const seen = [];
    const out = await ensureLogin({
      db,
      env: { KUGOU_COOKIE: 'token=ENV; userid=2' },
      aliveCheck: async (c) => { seen.push(c); return true; },
      refresh: async (c) => c,
      qrHint: noopQr,
    });
    expect(out).toEqual({ ok: true, source: 'refresh' });
    expect(seen[0]).toBe('token=DB; userid=1');
  });

  it('db 为空时回退 env cookie', async () => {
    const db = fakeDb({});
    const seen = [];
    const out = await ensureLogin({
      db,
      env: { KUGOU_COOKIE: 'token=ENV; userid=2' },
      aliveCheck: async (c) => { seen.push(c); return true; },
      refresh: async (c) => c,
      qrHint: noopQr,
    });
    expect(out).toEqual({ ok: true, source: 'refresh' });
    expect(seen[0]).toBe('token=ENV; userid=2');
  });

  it('全部失效且无账密 → ok:false 并打印扫码提示', async () => {
    const db = fakeDb({});
    const qrHint = vi.fn(noopQr);
    const out = await ensureLogin({
      db,
      env: {},
      aliveCheck: async () => false,
      qrHint,
    });
    expect(out.ok).toBe(false);
    expect(qrHint).toHaveBeenCalled();
  });

  it('cookie 失效但账密可用 → 账密登录结果落库', async () => {
    const db = fakeDb({});
    const out = await ensureLogin({
      db,
      env: { KUGOU_USERNAME: 'u', KUGOU_PASSWORD: 'p' },
      aliveCheck: async () => true,
      passwordLogin: async () => 'token=PWD; userid=7',
      qrHint: noopQr,
    });
    expect(out).toEqual({ ok: true, source: 'fresh' });
    expect(db.getPref('kugou_cookie')).toBe('token=PWD; userid=7');
  });
});

describe('startAutoRefresh', () => {
  it('定时触发续期，stop 清理定时器', async () => {
    let fired;
    const unref = vi.fn();
    const timer = vi.fn((fn, ms) => { fired = fn; return { unref }; });
    const clear = vi.fn();
    const log = vi.fn();
    const refresh = vi.fn(async () => ({ ok: true }));

    const { stop } = startAutoRefresh({ intervalMs: 1000, timer, clear, log, refresh });
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 1000);
    expect(unref).toHaveBeenCalled();

    await fired();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('自动续期成功');

    stop();
    expect(clear).toHaveBeenCalled();
  });

  it('refreshIntervalMs 支持环境变量覆盖', () => {
    expect(refreshIntervalMs({ KUGOU_REFRESH_INTERVAL_HOURS: '6' })).toBe(6 * 3600 * 1000);
    expect(refreshIntervalMs({ KUGOU_REFRESH_INTERVAL_HOURS: 'abc' })).toBe(12 * 3600 * 1000);
  });
});

describe('查活 / 续期：带 timestamp 穿透上游 2 分钟缓存', () => {
  it('isCookieAlive 请求带 timestamp', async () => {
    let captured;
    const httpGet = async (url, opts) => { captured = opts; return { data: { status: 1 } }; };
    const alive = await isCookieAlive('token=X; userid=1', { httpGet, now: () => 777 });
    expect(alive).toBe(true);
    expect(captured).toMatchObject({ Cookie: 'token=X; userid=1', params: { timestamp: 777 } });
  });

  it('refreshCookie 请求带 timestamp', async () => {
    let captured;
    const httpGet = async (url, opts) => { captured = opts; return { data: { status: 0 }, cookies: {} }; };
    await refreshCookie('token=X; userid=1', { httpGet, now: () => 888 });
    expect(captured).toMatchObject({ cookie: 'token=X; userid=1', params: { timestamp: 888 } });
  });
});

describe('beginQrLogin（终端扫码兜底）', () => {
  it('打印二维码 + 后台轮询成功 → 回调日志，且返回不阻塞', async () => {
    const db = fakeDb({});
    const start = vi.fn(async () => ({ key: 'K', qrUrl: 'https://h5.kugou.com/x' }));
    const log = vi.fn();
    let polledKey;
    const poll = vi.fn((key, { db: innerDb, onStatus }) => {
      polledKey = key;
      expect(innerDb).toBe(db);
      onStatus({ status: 1, statusText: '等扫码' });
      onStatus({ status: 4, statusText: '成功', savedCookie: true });
      return Promise.resolve({ status: 4, savedCookie: true });
    });

    const out = await beginQrLogin({ db, start, poll, log });
    expect(out).toMatchObject({ ok: true, key: 'K' });
    expect(typeof out.task?.then).toBe('function');

    await out.task;
    expect(polledKey).toBe('K');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('扫码登录成功'));
  });

  it('start 抛错 → ok:false，不轮询', async () => {
    const start = vi.fn(async () => { throw new Error('boom'); });
    const poll = vi.fn();
    const out = await beginQrLogin({ start, poll, log: vi.fn() });
    expect(out.ok).toBe(false);
    expect(poll).not.toHaveBeenCalled();
  });

  it('key 为空 → ok:false，不轮询', async () => {
    const start = vi.fn(async () => ({ key: '', qrUrl: '' }));
    const poll = vi.fn();
    const out = await beginQrLogin({ start, poll, log: vi.fn() });
    expect(out.ok).toBe(false);
    expect(poll).not.toHaveBeenCalled();
  });
});
