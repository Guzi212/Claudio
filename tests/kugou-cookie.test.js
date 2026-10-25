import { describe, it, expect } from 'vitest';
import {
  parseCookie,
  serializeCookie,
  mergeCookieMap,
  cookieMapFromSetCookie,
  pickIdentity,
  hasDfid,
} from '../server/services/kugou-cookie.js';

describe('parseCookie', () => {
  it('解析常规 cookie 串并去掉空格', () => {
    expect(parseCookie('token=TOK; userid=999')).toEqual({ token: 'TOK', userid: '999' });
  });

  it('值里含 = 时只在第一个 = 处切分', () => {
    expect(parseCookie('a=b=c; d=1')).toEqual({ a: 'b=c', d: '1' });
  });

  it('重复 key 后值覆盖前值', () => {
    expect(parseCookie('token=OLD; token=NEW')).toEqual({ token: 'NEW' });
  });

  it('忽略空片段与没有 = 的片段', () => {
    expect(parseCookie(';; token=TOK ; junk ; ')).toEqual({ token: 'TOK' });
  });

  it('空 / 非字符串输入返回空对象', () => {
    expect(parseCookie('')).toEqual({});
    expect(parseCookie(null)).toEqual({});
    expect(parseCookie(undefined)).toEqual({});
    expect(parseCookie(123)).toEqual({});
  });
});

describe('serializeCookie', () => {
  it('拼回 cookie 串', () => {
    expect(serializeCookie({ token: 'TOK', userid: '999' })).toBe('token=TOK;userid=999');
  });

  it('分隔符不带空格，兼容上游 cookieToJson 的 split(";")（不 trim）', () => {
    // 反例：'token=TOK; userid=999' 经上游 split(';') 后键名是 ' userid'（前导空格），
    // 上游读 cookie.userid 会得到 undefined → 续期 / 换 dfid 失败。
    const s = serializeCookie({ token: 'TOK', userid: '999', dfid: 'abc' });
    expect(s).not.toContain('; ');
    const keys = s.split(';').map((kv) => kv.split('=')[0]);
    expect(keys).toEqual(['token', 'userid', 'dfid']);
  });

  it('跳过 null / undefined / 空字符串', () => {
    expect(serializeCookie({ a: '1', b: null, c: undefined, d: '', e: '2' })).toBe('a=1;e=2');
  });

  it('空对象返回空串', () => {
    expect(serializeCookie({})).toBe('');
  });

  it('与 parseCookie 往返一致', () => {
    const src = { token: 'T', userid: '9', dfid: 'D' };
    expect(parseCookie(serializeCookie(src))).toEqual(src);
  });
});

describe('mergeCookieMap', () => {
  it('合并字符串与对象，后者覆盖前者', () => {
    const out = mergeCookieMap('token=OLD; userid=1', { token: 'NEW' });
    expect(out).toEqual({ token: 'NEW', userid: '1' });
  });

  it('空值不覆盖已有值', () => {
    expect(mergeCookieMap({ token: 'TOK' }, { token: '' })).toEqual({ token: 'TOK' });
    expect(mergeCookieMap({ token: 'TOK' }, { token: null })).toEqual({ token: 'TOK' });
  });

  it('保留先出现的 key 顺序（便于稳定序列化）', () => {
    const out = mergeCookieMap({ token: 'T', userid: '1' }, { dfid: 'D' });
    expect(Object.keys(out)).toEqual(['token', 'userid', 'dfid']);
  });
});

describe('cookieMapFromSetCookie', () => {
  it('从数组里只取第一段，丢掉 Path/HttpOnly 等属性', () => {
    const out = cookieMapFromSetCookie([
      'dfid=abcdef; PATH=/',
      'token=TOK; Path=/; HttpOnly',
    ]);
    expect(out).toEqual({ dfid: 'abcdef', token: 'TOK' });
  });

  it('兼容单个字符串', () => {
    expect(cookieMapFromSetCookie('t1=XYZ; PATH=/')).toEqual({ t1: 'XYZ' });
  });

  it('空输入返回空对象', () => {
    expect(cookieMapFromSetCookie(undefined)).toEqual({});
    expect(cookieMapFromSetCookie([])).toEqual({});
  });
});

describe('pickIdentity', () => {
  it('只保留登录态 / 设备身份相关字段', () => {
    const out = pickIdentity({
      token: 'TOK', userid: '1', dfid: 'D', t1: 'T1', vip_type: '3', vip_token: 'V',
      nickname: 'nope', foo: 'bar', noise: '1',
    });
    expect(out).toEqual({ token: 'TOK', userid: '1', dfid: 'D', t1: 'T1', vip_type: '3', vip_token: 'V' });
  });

  it('接受字符串输入', () => {
    expect(pickIdentity('token=TOK; junk=1')).toEqual({ token: 'TOK' });
  });
});

describe('hasDfid', () => {
  it('有 dfid 时为 true', () => {
    expect(hasDfid('token=TOK; dfid=abc')).toBe(true);
    expect(hasDfid({ dfid: 'abc' })).toBe(true);
  });

  it("上游用 '-' 表示缺失，视为 false", () => {
    expect(hasDfid('token=TOK; dfid=-')).toBe(false);
  });

  it('没有 dfid / 空值时为 false', () => {
    expect(hasDfid('token=TOK; userid=1')).toBe(false);
    expect(hasDfid('dfid=')).toBe(false);
    expect(hasDfid('')).toBe(false);
    expect(hasDfid(null)).toBe(false);
  });
});
