// 酷狗 cookie jar 的纯函数工具箱。
//
// 登录、续期、扫码三条路径都要「读一份 cookie → 合并新字段 → 写回 state.db」，
// 把解析/合并/序列化收口在这里，避免各处手写字符串拼接导致字段丢失
// （历史 bug：扫码只存了 token + userid，dfid/t1/vip_token 全丢，续期参数不齐）。
//
// 约定：
// - cookie 字符串形如 "token=abc; userid=1; dfid=xx"
// - Set-Cookie 头形如 "token=abc; Path=/; HttpOnly"
// - 合并时后写覆盖先写；空值不落库，避免 KUGOU_API_PLATFORM= 这类噪声。

const DEFAULT_ORDER = ['token', 'userid', 't1', 'dfid', 'vip_token', 'vip_type'];

export const COOKIE_ORDER = DEFAULT_ORDER;

// "a=1; b=2" → { a: '1', b: '2' }
export function cookieStringToMap(str) {
  const map = {};
  if (!str) return map;
  for (const pair of String(str).split(/;\s*/)) {
    if (!pair) continue;
    const idx = pair.indexOf('=');
    if (idx < 1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) map[key] = value;
  }
  return map;
}

// axios response.headers['set-cookie']（字符串数组）→ { token: '...', dfid: '...' }
export function parseSetCookie(headers) {
  const list = Array.isArray(headers) ? headers : headers ? [headers] : [];
  const map = {};
  for (const raw of list) {
    if (!raw) continue;
    const [pair] = String(raw).split(';');
    const idx = pair.indexOf('=');
    if (idx < 1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) map[key] = value;
  }
  return map;
}

// 合并多个 map（或 cookie 字符串），忽略 null/undefined/空值。
export function mergeCookieMaps(...sources) {
  const out = {};
  for (const src of sources) {
    if (!src) continue;
    const map = typeof src === 'string' ? cookieStringToMap(src) : src;
    for (const [key, value] of Object.entries(map)) {
      if (value == null || value === '') continue;
      out[key] = String(value);
    }
  }
  return out;
}

// map/字符串 → 确定性顺序的 cookie 字符串（便于断言与稳定落库）。
export function buildCookieString(input, { order = DEFAULT_ORDER } = {}) {
  const map = mergeCookieMaps(input);
  const known = order.filter((k) => k in map);
  const rest = Object.keys(map).filter((k) => !order.includes(k)).sort();
  return [...known, ...rest].map((k) => `${k}=${map[k]}`).join('; ');
}

// base 字符串 + updates（map/字符串）→ 合并后的 cookie 字符串，updates 覆盖 base。
export function mergeCookies(baseStr, updates) {
  return buildCookieString(mergeCookieMaps(baseStr, updates));
}

export default {
  COOKIE_ORDER,
  cookieStringToMap,
  parseSetCookie,
  mergeCookieMaps,
  buildCookieString,
  mergeCookies,
};
