// 候选歌曲打分与名称归一化（酷狗 / 网易云 / QQ 共用）

export function normalizeForMatch(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[【】\[\]()（）·・\-_,，.。!！?？'"]/g, '');
}

// DJ 版硬排除标记：目标没有指定时直接返回 0 分
const DJ_MARKERS = ['dj', 'dj版', 'dj mix', 'djmix'];

// 非原版变体标记：目标没有指定时扣分
const VERSION_MARKERS = [
  '现场', '演唱会', 'concert', 'live', 'remix', '混音', '钢琴', 'piano',
  'cover', '翻唱', '演奏版', '纯音乐', 'instrumental', 'acoustic', 'unplugged',
  '清唱', '无伴奏', '伴奏版',
];

// 专辑名里常见的演出/合集/伴奏变体标记
const ALBUM_VARIANT_MARKERS = [
  '现场', '演唱会', 'concert', 'live', '巡回', '音乐汇', 'remix', '混音', '伴奏', '翻唱', 'cover',
];

// 用户上传的杂项条目常把文件名当歌名：`说散就散.mp3`。这类条目音质和元数据都不可靠。
const AUDIO_FILE_EXT = /\.(mp3|flac|wav|m4a|ape|ogg|aac|wma)$/i;

function hasDjMarker(normalizedTitle) {
  return DJ_MARKERS.some(kw => normalizedTitle.includes(kw));
}

function hasVersionMarker(normalizedTitle) {
  return VERSION_MARKERS.some(kw => normalizedTitle.includes(kw));
}

export function scoreCandidate(target, cand) {
  const t = normalizeForMatch(target.title);
  const a = normalizeForMatch(target.artist || '');
  const th = normalizeForMatch(target.hint || '');
  const ct = normalizeForMatch(cand.title);
  const ca = normalizeForMatch(cand.artist);
  const calbum = normalizeForMatch(cand.album || '');

  // 歌名就是文件名（带 .mp3 之类）→ 用户上传的杂项，直接排除
  if (AUDIO_FILE_EXT.test(String(cand.title || '').trim())) return 0;

  // 目标没有指定 DJ 版，候选是 DJ 版 → 直接 0 分
  if (!hasDjMarker(t) && !hasDjMarker(th) && hasDjMarker(ct)) return 0;

  let score = 0;
  if (ct === t) score += 100;
  else if (ct.includes(t) || t.includes(ct)) score += 60;
  else if ([...t].filter(c => ct.includes(c)).length / Math.max(t.length, 1) > 0.7) score += 30;

  if (a) {
    if (ca === a) score += 50;
    else if (ca.includes(a) || a.includes(ca)) score += 30;
    // 指定了歌手却完全对不上：多半是张冠李戴，别再只靠歌名过关
    else score -= 50;
  } else {
    score += 10;
  }

  // 目标没有指定版本类型，但歌名或专辑名带有现场/巡回/合集/混音等变体标记 → 扣分，让录音室原版优先
  const targetWantsVariant = hasVersionMarker(t) || hasVersionMarker(th);
  if (!targetWantsVariant && (hasVersionMarker(ct) || ALBUM_VARIANT_MARKERS.some(kw => calbum.includes(kw)))) {
    score -= 40;
  }

  // 未指定变体时，对过短或无专辑名的残缺片段扣分（duration=0 视为未知，不影响）
  const dur = Number(cand.duration) || 0;
  if (!targetWantsVariant && dur > 0) {
    if (dur < 90) score -= 35;
    else if (dur < 145 && !calbum) score -= 25;
  }

  return score;
}
