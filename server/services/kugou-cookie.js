// 酷狗 cookie 的解析 / 序列化 / 合并工具（纯函数，无副作用，便于单测）。
//
// 背景：酷狗把「设备身份」编码在 cookie 里（token / userid / dfid / t1 /
// vip_type / vip_token）。之前的实现只往 state.db 存了 "token=..; userid=.."，
// 少了 dfid，于是每次请求都被上游当成一台新设备：
//   · 轻则 song_url 报「本次请求需要验证」
//   · 重则被风控判定为异常登录，把手机 / 电脑端挤下线
// 这里统一负责整段 cookie 的保存与合并，是所有登录相关模块的唯一出口。

// 与登录态 / 设备身份相关的字段。合并 / 续期时只保留这些，避免把上游响应里
// 无关的字段写回 cookie。
export const IDENTITY_KEYS = ['token', 'userid', 'dfid', 't1', 'vip_type', 'vip_token'];

/**
 * "a=1; b=2" → { a: '1', b: '2' }
 * 重复 key 后值覆盖前值；忽略空片段 / 没有 '=' 的片段。
 */
export function parseCookie(str) {
  const out = {};
  if (!str || typeof str !== 'string') return out;
  for (const segment of str.split(';')) {
    const s = segment.trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    const k = s.slice(0, eq).trim();
    const v = s.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/**
 * { a: '1', b: null, c: '' } → "a=1"
 * 空值 / 空 key 跳过。
 *
 * 分隔符用 ';'（不带空格）——这是刻意的，不是手滑：
 * 我们把 cookie 当作 query 参数传给 KuGouMusicApi（?cookie=token=..;userid=..），
 * 而上游 util/util.js 的 cookieToJson() 是 `cookie.split(';')` 且**不做 trim**，
 * 所以用 '; ' 连接会让除第一段外的所有键变成 " userid" / " dfid"（前导空格），
 * 上游读 userid / dfid 时全部取不到 → /login/token 续期与 /register/dev 换 dfid 必失败。
 * 之前只存 token 时恰好没暴露（token 是第一个字段，不带前导空格）。
 * Cookie 请求头用 ';' 连接同样合法，所以两种用途都安全。
 */
export function serializeCookie(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (!k || v == null || v === '') continue;
    parts.push(`${k}=${v}`);
  }
  return parts.join(';');
}

/**
 * 合并任意个 cookie（字符串或对象）→ 对象。
 * 后者覆盖前者；空值不参与覆盖，避免把已有字段抹掉。
 */
export function mergeCookieMap(...sources) {
  const out = {};
  for (const src of sources) {
    const map = typeof src === 'string' ? parseCookie(src) : (src || {});
    for (const [k, v] of Object.entries(map)) {
      if (!k || v == null || v === '') continue;
      out[k] = String(v);
    }
  }
  return out;
}

/**
 * axios 的 set-cookie 响应头（字符串或数组）→ { token: '..', dfid: '..' }
 * 只取每段的第一部分，丢掉 Path / HttpOnly / SameSite 等属性。
 */
export function cookieMapFromSetCookie(setCookie) {
  const out = {};
  const list = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  for (const raw of list) {
    const first = String(raw).split(';')[0];
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const k = first.slice(0, eq).trim();
    const v = first.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/** 只保留 IDENTITY_KEYS 里的字段，其余丢弃。 */
export function pickIdentity(map) {
  const src = typeof map === 'string' ? parseCookie(map) : (map || {});
  const out = {};
  for (const k of IDENTITY_KEYS) {
    const v = src[k];
    if (v != null && v !== '') out[k] = String(v);
  }
  return out;
}

/** cookie 里是否已有可用的设备漫游 id（'-' 是上游的「缺失」占位符，不算）。 */
export function hasDfid(cookie) {
  const map = typeof cookie === 'string' ? parseCookie(cookie) : (cookie || {});
  const v = map.dfid;
  return !!v && v !== '-';
}
