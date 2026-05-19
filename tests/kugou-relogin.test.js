import { describe, it, expect, vi } from 'vitest';
import { startRelogin, checkRelogin } from '../server/api/kugou-relogin.js';

function fakeGet(handlers) {
  // handlers: { '/login/qr/key': (params) => data, ... }
  return async (url, params) => {
    const path = new URL(url).pathname;
    const h = handlers[path];
    if (!h) throw new Error(`unexpected GET ${path}`);
    return h(params);
  };
}

describe('startRelogin', () => {
  it('成功路径：返回 key + qrImg + qrUrl', async () => {
    const httpGet = fakeGet({
      '/login/qr/key': () => ({ data: { qrcode: 'KEY123' }, status: 1, error_code: 0 }),
      '/login/qr/create': () => ({
        data: {
          qrcode_img: 'data:image/png;base64,AAAA',
          url: 'https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=KEY123',
        },
      }),
    });
    const out = await startRelogin({ httpGet });
    expect(out.key).toBe('KEY123');
    expect(out.qrImg).toContain('data:image/png;base64');
    expect(out.qrUrl).toContain('kugou.com');
  });

  it('key 为空时抛错', async () => {
    const httpGet = fakeGet({
      '/login/qr/key': () => ({ data: {} }),
    });
    await expect(startRelogin({ httpGet })).rejects.toThrow('QR key empty');
  });

  it('qr/create 返回结构变种也能解析', async () => {
    const httpGet = fakeGet({
      '/login/qr/key': () => ({ qrcode: 'K2' }),  // 不带 data 包裹
      '/login/qr/create': () => ({ data: { base64: 'data:image/png;base64,B' } }),
    });
    const out = await startRelogin({ httpGet });
    expect(out.key).toBe('K2');
    expect(out.qrImg).toBe('data:image/png;base64,B');
    expect(out.qrUrl).toBe('');
  });
});

describe('checkRelogin', () => {
  function fakeDb() {
    const store = {};
    return {
      setPref: vi.fn((k, v) => { store[k] = v; }),
      getPref: (k) => store[k],
      _store: store,
    };
  }

  it('等扫码 status=1 不写 cookie', async () => {
    const db = fakeDb();
    const httpGet = fakeGet({
      '/login/qr/check': () => ({ data: { status: 1 } }),
    });
    const out = await checkRelogin('K', { httpGet, db });
    expect(out).toMatchObject({ status: 1, statusText: '等扫码', savedCookie: false });
    expect(db.setPref).not.toHaveBeenCalled();
  });

  it('等确认 status=2 不写 cookie', async () => {
    const db = fakeDb();
    const httpGet = fakeGet({
      '/login/qr/check': () => ({ data: { status: 2 } }),
    });
    const out = await checkRelogin('K', { httpGet, db });
    expect(out).toMatchObject({ status: 2, statusText: '等确认', savedCookie: false });
  });

  it('成功 status=4 + token + userid → 拼 cookie 写 db', async () => {
    const db = fakeDb();
    const httpGet = fakeGet({
      '/login/qr/check': () => ({ data: { status: 4, token: 'TOK', userid: 999 } }),
    });
    const out = await checkRelogin('K', { httpGet, db });
    expect(out).toMatchObject({ status: 4, statusText: '成功', savedCookie: true });
    expect(db.setPref).toHaveBeenCalledWith('kugou_cookie', 'token=TOK; userid=999');
  });

  it('成功 status=4 但 token 缺失 → 不写 cookie，但仍返 ok', async () => {
    const db = fakeDb();
    const httpGet = fakeGet({
      '/login/qr/check': () => ({ data: { status: 4 } }),
    });
    const out = await checkRelogin('K', { httpGet, db });
    expect(out).toMatchObject({ status: 4, savedCookie: false });
    expect(db.setPref).not.toHaveBeenCalled();
  });

  it('二维码过期 status=0', async () => {
    const db = fakeDb();
    const httpGet = fakeGet({
      '/login/qr/check': () => ({ data: { status: 0 } }),
    });
    const out = await checkRelogin('K', { httpGet, db });
    expect(out).toMatchObject({ status: 0, statusText: '过期', savedCookie: false });
  });

  it('key 缺失抛错', async () => {
    const db = fakeDb();
    const httpGet = fakeGet({});
    await expect(checkRelogin('', { httpGet, db })).rejects.toThrow('key required');
  });

  it('未知 status 给出 fallback 文本', async () => {
    const db = fakeDb();
    const httpGet = fakeGet({
      '/login/qr/check': () => ({ data: { status: 99 } }),
    });
    const out = await checkRelogin('K', { httpGet, db });
    expect(out.statusText).toContain('未知');
  });
});
