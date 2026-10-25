import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ensureLogin,
  ensureDfid,
  fetchDfid,
  renewToken,
  needsRenew,
  runRefreshTick,
  refreshIntervalMs,
  COOKIE_PREF,
  REFRESHED_AT_PREF,
} from '../server/services/kugou-login.js';

const HOUR = 60 * 60 * 1000;

function fakeDb(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getPref: (k) => (store.has(k) ? store.get(k) : null),
    setPref: vi.fn((k, v) => { store.set(k, String(v)); }),
    _store: store,
  };
}

afterEach(() => {
  delete process.env.KUGOU_REFRESH_INTERVAL_HOURS;
});

describe('refreshIntervalMs', () => {
  it('默认 24h', () => {
    expect(refreshIntervalMs()).toBe(24 * HOUR);
  });

  it('可用 KUGOU_REFRESH_INTERVAL_HOURS 覆盖', () => {
    process.env.KUGOU_REFRESH_INTERVAL_HOURS = '6';
    expect(refreshIntervalMs()).toBe(6 * HOUR);
  });

  it('非法值回退到默认 24h', () => {
    process.env.KUGOU_REFRESH_INTERVAL_HOURS = 'abc';
    expect(refreshIntervalMs()).toBe(24 * HOUR);
    process.env.KUGOU_REFRESH_INTERVAL_HOURS = '0';
    expect(refreshIntervalMs()).toBe(24 * HOUR);
  });
});

describe('fetchDfid', () => {
  it('优先取 Set-Cookie 里的 dfid', async () => {
    const httpGet = vi.fn(async () => ({ data: {}, cookies: { dfid: 'D1' } }));
    expect(await fetchDfid('token=T; userid=1', { httpGet })).toBe('D1');
  });

  it('回退取 body.data.dfid', async () => {
    const httpGet = vi.fn(async () => ({ data: { data: { dfid: 'D2' } }, cookies: {} }));
    expect(await fetchDfid('token=T; userid=1', { httpGet })).toBe('D2');
  });

  it('上游报错时返回空串而不是抛错', async () => {
    const httpGet = vi.fn(async () => { throw new Error('boom'); });
    expect(await fetchDfid('token=T; userid=1', { httpGet })).toBe('');
  });

  it('cookie 为空时不请求', async () => {
    const httpGet = vi.fn();
    expect(await fetchDfid('', { httpGet })).toBe('');
    expect(httpGet).not.toHaveBeenCalled();
  });
});

describe('ensureDfid', () => {
  it('已有 dfid → 原样返回，不发请求', async () => {
    const db = fakeDb();
    const httpGet = vi.fn();
    const out = await ensureDfid('token=T; userid=1; dfid=D1', { httpGet, db });
    expect(out).toEqual({ ok: true, cookie: 'token=T; userid=1; dfid=D1' });
    expect(httpGet).not.toHaveBeenCalled();
    expect(db.setPref).not.toHaveBeenCalled();
  });

  it("'-' 视为缺失，会去补 dfid 并写回 db", async () => {
    const db = fakeDb();
    const httpGet = vi.fn(async () => ({ data: {}, cookies: { dfid: 'D9' } }));
    const out = await ensureDfid('token=T; userid=1; dfid=-', { httpGet, db });
    expect(out.ok).toBe(true);
    expect(out.cookie).toContain('dfid=D9');
    expect(db.setPref).toHaveBeenCalledWith(COOKIE_PREF, 'token=T;userid=1;dfid=D9');
  });

  it('补 dfid 失败 → 静默降级，不写库', async () => {
    const db = fakeDb();
    const httpGet = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const out = await ensureDfid('token=T; userid=1', { httpGet, db });
    expect(out).toEqual({ ok: false, cookie: 'token=T; userid=1' });
    expect(db.setPref).not.toHaveBeenCalled();
  });
});

describe('renewToken', () => {
  it('续期成功 → 合并新 token/t1/vip_*，保留原 dfid，并记录续期时间', async () => {
    const db = fakeDb();
    const httpGet = vi.fn(async () => ({
      data: { data: { token: 'NEW', t1: 'T1', vip_type: 3, vip_token: 'V' } },
      cookies: { token: 'NEW', userid: '1', t1: 'T1' },
    }));
    const now = 1_700_000_000_000;
    const out = await renewToken('token=OLD; userid=1; dfid=D1', { httpGet, db, now });

    expect(out.ok).toBe(true);
    const saved = db._store.get(COOKIE_PREF);
    expect(saved).toContain('token=NEW');
    expect(saved).toContain('dfid=D1');
    expect(saved).toContain('t1=T1');
    expect(saved).toContain('vip_type=3');
    expect(db.setPref).toHaveBeenCalledWith(REFRESHED_AT_PREF, String(now));
  });

  it('不会把上游响应里的无关字段写进 cookie', async () => {
    const db = fakeDb();
    const httpGet = vi.fn(async () => ({
      data: { data: { token: 'NEW', secu_params: 'SHOULD_NOT_PERSIST', noise: 1 } },
      cookies: {},
    }));
    await renewToken('token=OLD; userid=1', { httpGet, db });
    expect(db._store.get(COOKIE_PREF)).not.toContain('secu_params');
    expect(db._store.get(COOKIE_PREF)).not.toContain('noise');
  });

  it('本地 cookie 没有 token → 不请求、不写库', async () => {
    const db = fakeDb();
    const httpGet = vi.fn();
    const out = await renewToken('userid=1', { httpGet, db });
    expect(out.ok).toBe(false);
    expect(httpGet).not.toHaveBeenCalled();
    expect(db.setPref).not.toHaveBeenCalled();
  });

  it('上游没返回 token → 视为失败，不写库', async () => {
    const db = fakeDb();
    const httpGet = vi.fn(async () => ({ data: { data: {} }, cookies: {} }));
    const out = await renewToken('token=OLD; userid=1', { httpGet, db });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('未返回 token');
    expect(db.setPref).not.toHaveBeenCalled();
  });

  it('网络异常 → 返回失败原因而不是抛错', async () => {
    const db = fakeDb();
    const httpGet = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const out = await renewToken('token=OLD; userid=1', { httpGet, db });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('ECONNREFUSED');
  });
});

describe('needsRenew', () => {
  it('从未续期过 → true', () => {
    expect(needsRenew({ db: fakeDb() })).toBe(true);
  });

  it('刚续期过 → false', () => {
    const now = 1_700_000_000_000;
    const db = fakeDb({ [REFRESHED_AT_PREF]: String(now - 1_000) });
    expect(needsRenew({ db, now })).toBe(false);
  });

  it('超过间隔 → true', () => {
    const now = 1_700_000_000_000;
    const db = fakeDb({ [REFRESHED_AT_PREF]: String(now - 25 * HOUR) });
    expect(needsRenew({ db, now })).toBe(true);
  });

  it('尊重自定义间隔', () => {
    const now = 1_700_000_000_000;
    const db = fakeDb({ [REFRESHED_AT_PREF]: String(now - 2 * HOUR) });
    expect(needsRenew({ db, now, intervalMs: 6 * HOUR })).toBe(false);
    expect(needsRenew({ db, now, intervalMs: 1 * HOUR })).toBe(true);
  });
});

describe('runRefreshTick', () => {
  it('没有 cookie → 不联网', async () => {
    const httpGet = vi.fn();
    const out = await runRefreshTick({ db: fakeDb(), httpGet, log: () => {} });
    expect(out).toEqual({ ok: false, reason: 'cookie 缺失' });
    expect(httpGet).not.toHaveBeenCalled();
  });

  it('未到续期时间 → 不联网（这是「低频」的关键）', async () => {
    const now = 1_700_000_000_000;
    const db = fakeDb({ [COOKIE_PREF]: 'token=T; userid=1', [REFRESHED_AT_PREF]: String(now - 5 * 60 * 1000) });
    const httpGet = vi.fn();
    const out = await runRefreshTick({ db, httpGet, isAlive: async () => true, log: () => {}, now });
    expect(out).toEqual({ ok: false, reason: '未到续期时间' });
    expect(httpGet).not.toHaveBeenCalled();
  });

  it('到点 → 续期一次', async () => {
    const now = 1_700_000_000_000;
    const db = fakeDb({ [COOKIE_PREF]: 'token=OLD; userid=1', [REFRESHED_AT_PREF]: String(now - 25 * HOUR) });
    const httpGet = vi.fn(async () => ({ data: { data: { token: 'NEW' } }, cookies: {} }));
    const out = await runRefreshTick({ db, httpGet, isAlive: async () => true, log: () => {}, now });
    expect(out.ok).toBe(true);
    expect(httpGet).toHaveBeenCalledTimes(1);
    expect(db._store.get(COOKIE_PREF)).toContain('token=NEW');
  });
});

describe('ensureLogin', () => {
  it('db 里的 cookie 有效 → source=db，且不会立刻续期', async () => {
    const now = 1_700_000_000_000;
    const db = fakeDb({
      [COOKIE_PREF]: 'token=T; userid=1; dfid=D1',
      [REFRESHED_AT_PREF]: String(now - 1 * HOUR),
    });
    const httpGet = vi.fn();
    const out = await ensureLogin({ db, httpGet, isAlive: async () => true, hint: vi.fn(), now });
    expect(out).toEqual({ ok: true, source: 'db' });
    expect(httpGet).not.toHaveBeenCalled();
  });

  it('新增：cookie 有效但缺 dfid → 启动时自动补上', async () => {
    const now = 1_700_000_000_000;
    const db = fakeDb({
      [COOKIE_PREF]: 'token=T; userid=1',
      [REFRESHED_AT_PREF]: String(now - 1 * HOUR),
    });
    const httpGet = vi.fn(async (url) => {
      if (url.endsWith('/register/dev')) return { data: {}, cookies: { dfid: 'DEV1' } };
      throw new Error(`unexpected ${url}`);
    });
    const out = await ensureLogin({ db, httpGet, isAlive: async () => true, hint: vi.fn(), now });
    expect(out).toEqual({ ok: true, source: 'db' });
    expect(db._store.get(COOKIE_PREF)).toContain('dfid=DEV1');
  });

  it('新增：本地 cookie 已失效时先用 /login/token 自愈，免扫码', async () => {
    const now = 1_700_000_000_000;
    const db = fakeDb({
      [COOKIE_PREF]: 'token=OLD; userid=1; dfid=D1',
      [REFRESHED_AT_PREF]: String(now - 40 * HOUR),
    });
    // 第一次存活探测（旧 cookie）失败；续期后再探测成功
    let calls = 0;
    const isAlive = async () => (++calls > 1);
    const httpGet = vi.fn(async (url) => {
      if (url.endsWith('/login/token')) {
        return { data: { data: { token: 'NEW', userid: '1' } }, cookies: { token: 'NEW' } };
      }
      throw new Error(`unexpected ${url}`);
    });
    const out = await ensureLogin({ db, httpGet, isAlive, hint: vi.fn(), now });
    expect(out).toEqual({ ok: true, source: 'renewed' });
    expect(db._store.get(COOKIE_PREF)).toContain('token=NEW');
  });

  it('全部失败 → ok:false 且给出扫码提示（不抛错）', async () => {
    const db = fakeDb();
    const httpGet = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const hint = vi.fn();
    const out = await ensureLogin({ db, httpGet, isAlive: async () => false, hint, now: Date.now() });
    expect(out).toEqual({ ok: false, source: null });
    expect(hint).toHaveBeenCalledTimes(1);
  });
});
