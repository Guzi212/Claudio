// UTF-8 乱码挡板：Windows curl --data 直接嵌中文时按 GBK 编码，
// Express 按 UTF-8 解析会产出 U+FFFD (�)，歌名/专辑烂成乱码、cover 静默丢。
// 见 docs/dev-plan「输入校验加固」。

const MOJIBAKE = '�';

// title/artist/album 任一字段含 U+FFFD → 返回字段名（判 400），否则 null。
export function mojibakeField(track = {}) {
  for (const key of ['title', 'artist', 'album']) {
    if (String(track[key] ?? '').includes(MOJIBAKE)) return key;
  }
  return null;
}

export function mojibakeError(field) {
  return {
    ok: false,
    error: `track.${field} 含 U+FFFD 乱码，疑似非 UTF-8 编码（如 GBK）。请以 UTF-8 编码重新发送。`,
  };
}

// cover 缺失不拦，但响应里返回 warning 提醒发送方封面会丢。
export const COVER_MISSING_WARNING =
  'track.cover 未提供，封面将丢失；建议传 cover 字段保证播放页显示。';
