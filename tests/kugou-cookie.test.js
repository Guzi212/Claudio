import { describe, it, expect } from 'vitest';
import {
  cookieStringToMap,
  parseSetCookie,
  mergeCookieMaps,
  buildCookieString,
  mergeCookies,
} from '../server/services/kugou-cookie.js';

describe('kugou-cookie', () => {
  it('cookieStringToMap 解析多键值，容忍空格/空段', () => {
    expect(cookieStringToMap('token=abc; userid=1;  dfid=xx')).toEqual({
      token: 'abc',
      userid: '1',
      dfid: 'xx',
    });
    expect(cookieStringToMap('')).toEqual({});
    expect(cookieStringToMap(null)).toEqual({});
  });

  it('parseSetCookie 从 set-cookie 数组提取首段键值', () => {
    const map = parseSetCookie([
      'token=NEW; Path=/; HttpOnly',
      'userid=999; PATH=/',
      'dfid=DF1; PATH=/',
    ]);
    expect(map).toEqual({ token: 'NEW', userid: '999', dfid: 'DF1' });
  });

  it('parseSetCookie 兼容单字符串 / 空值', () => {
    expect(parseSetCookie('a=1; Path=/')).toEqual({ a: '1' });
    expect(parseSetCookie(undefined)).toEqual({});
  });

  it('mergeCookieMaps 后写覆盖先写，且丢弃空值', () => {
    const out = mergeCookieMaps({ token: 'OLD', keep: '1' }, { token: 'NEW', drop: '' }, null);
    expect(out).toEqual({ token: 'NEW', keep: '1' });
  });

  it('buildCookieString 顺序稳定（token/userid 在前），过滤空值', () => {
    expect(buildCookieString({ vip_token: 'V', userid: 9, token: 'T', empty: '' }))
      .toBe('token=T; userid=9; vip_token=V');
  });

  it('mergeCookies 在 base 上叠加更新，不丢原有字段', () => {
    const out = mergeCookies('token=OLD; userid=1; dfid=DF', { token: 'NEW', t1: 'T1' });
    expect(out).toBe('token=NEW; userid=1; t1=T1; dfid=DF');
  });
});
