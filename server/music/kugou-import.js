import { parseShareUrl as defaultParseShareUrl } from './kugou-share-url.js';
import { fetchSharedPlaylist as defaultFetchSharedPlaylist } from '../services/kugou.js';

const BUCKET_LABELS = {
  long_term: '长期喜欢',
  recent_mood: '最近 mood',
  avoid: '雷区',
};

function cleanCell(value = '') {
  return String(value)
    .replace(/\|/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectBucket(line, currentBucket = 'long_term') {
  if (/雷区|不喜欢|跳过|删除|删掉|不要|黑名单/.test(line)) return 'avoid';
  if (/最近|循环|播放|短期|mood/i.test(line)) return 'recent_mood';
  if (/红心|喜欢|收藏|歌单|我的喜欢/.test(line)) return 'long_term';
  return currentBucket;
}

function detectLikeLevel(line) {
  const m = line.match(/(?:红心|喜欢|like|level)\s*([123])\s*(?:心|星|级)?|([123])\s*(?:心|星|级)/i);
  return m ? Number(m[1] || m[2]) : null;
}

function extractAlbum(line) {
  const m = line.match(/《([^》]+)》/);
  if (!m) return { album: '', line };
  return {
    album: m[1].trim(),
    line: line.replace(m[0], '').trim(),
  };
}

function parseTrackLine(line) {
  const { album, line: withoutAlbum } = extractAlbum(line);
  const stripped = withoutAlbum
    .replace(/^\d+[.)、\s]+/, '')
    .replace(/^[-*·]\s*/, '')
    .trim();

  const delimiterMatch = stripped.match(/^(.+?)\s+(?:-|—|–|－)\s+(.+)$/);
  if (delimiterMatch) {
    return {
      title: delimiterMatch[1].trim(),
      artist: delimiterMatch[2].trim(),
      album,
    };
  }

  const parts = stripped.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return {
      title: parts[0].trim(),
      artist: parts.slice(1).join(' ').trim(),
      album,
    };
  }

  return null;
}

export function parseKugouInput(input) {
  const tracks = [];
  let bucket = 'long_term';
  let likeLevel = null;
  let source = '';

  for (const rawLine of String(input || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const urlMatch = line.match(/https?:\/\/\S+/i);
    if (urlMatch) {
      source = urlMatch[0];
      continue;
    }

    const looksLikeHeading = /^#{1,6}\s+/.test(line) || /^【.+】$/.test(line);
    if (looksLikeHeading) {
      bucket = detectBucket(line, bucket);
      likeLevel = detectLikeLevel(line);
      source = line.replace(/^#{1,6}\s+/, '').trim();
      continue;
    }

    const track = parseTrackLine(line);
    if (!track || !track.title || !track.artist) continue;

    tracks.push({
      title: track.title,
      artist: track.artist,
      album: track.album || '',
      bucket,
      likeLevel,
      source,
      note: '',
    });
  }

  return tracks;
}

function countBy(items, getKey) {
  const counts = new Map();
  for (const item of items) {
    const key = getKey(item);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
    .map(([name, count]) => ({ name, count }));
}

function formatTrack(track) {
  return `${track.title} - ${track.artist}`;
}

export function buildRawMarkdown(tracks, { generatedAt = new Date() } = {}) {
  const rows = tracks.map(track => [
    BUCKET_LABELS[track.bucket] || track.bucket,
    track.title,
    track.artist,
    track.album || '',
    track.likeLevel || '',
    track.source || '',
    track.language || '',
    yearOf(track.publishDate) || '',
    track.bpm || '',
    track.note || '',
  ]);

  const sources = [...new Set(tracks.map(t => t.source).filter(Boolean))];

  return [
    '# 酷狗原始音乐数据',
    '',
    '> 这里保存从酷狗截图、分享链接、复制文本整理出来的歌曲级数据。先保留原始线索，再蒸馏进 `user/taste.md`。',
    '',
    `生成时间：${generatedAt.toISOString()}`,
    '',
    '## 歌曲清单',
    '',
    '| 分组 | 歌名 | 歌手 | 专辑 | 喜欢等级 | 来源 | 语言 | 年代 | BPM | 备注 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(row => `| ${row.map(cleanCell).join(' | ')} |`),
    '',
    '## 原始来源',
    '',
    sources.length ? sources.map(s => `- ${s}`).join('\n') : '- （待补充截图、分享链接或复制文本来源）',
    '',
  ].join('\n');
}

function yearOf(publishDate) {
  if (!publishDate) return null;
  const m = String(publishDate).match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

function decadeLabel(year) {
  if (!year) return '';
  if (year < 1980) return '80 前';
  if (year < 1990) return '80s';
  if (year < 2000) return '90s';
  if (year < 2010) return '00s';
  if (year < 2020) return '10s';
  if (year < 2030) return '20s';
  return '';
}

function bpmBucketLabel(bpm) {
  const b = Number(bpm);
  if (!b || b < 30) return '';
  if (b < 80) return '抒情慢 (<80)';
  if (b < 110) return '中速 (80–110)';
  if (b < 140) return '快 (110–140)';
  return '高速 (>140)';
}

function pctDistribution(items, getKey, { total, mergeBelowPct = 2 } = {}) {
  const counts = countBy(items, getKey);
  const sum = total || items.length;
  if (!sum) return [];
  const enriched = counts.map(c => ({ ...c, pct: Math.round((c.count / sum) * 100) }));
  const visible = enriched.filter(e => e.pct >= mergeBelowPct);
  const tail = enriched.filter(e => e.pct < mergeBelowPct);
  const tailSum = tail.reduce((s, t) => s + t.count, 0);
  if (tailSum > 0) {
    visible.push({ name: '其他', count: tailSum, pct: Math.round((tailSum / sum) * 100) });
  }
  return visible;
}

function formatPctRow(rows) {
  return rows.map(r => `${r.name} ${r.pct}%`).join(' · ');
}

function topAlbumsFor(tracks, artistName, n = 2) {
  const albums = countBy(
    tracks.filter(t => t.artist === artistName),
    t => t.album,
  ).filter(a => a.name && a.count > 1);
  return albums.slice(0, n);
}

function yearSpanFor(tracks, artistName) {
  const years = tracks
    .filter(t => t.artist === artistName)
    .map(t => yearOf(t.publishDate))
    .filter(Boolean);
  if (!years.length) return '';
  const min = Math.min(...years);
  const max = Math.max(...years);
  if (min === max) return `${min}`;
  return `${min}–${max}`;
}

function describeArtist(tracks, { name, count }) {
  const albums = topAlbumsFor(tracks, name);
  const span = yearSpanFor(tracks, name);
  const bits = [];
  if (albums.length) {
    bits.push(`代表专辑《${albums.map(a => a.name).join('》《')}》`);
  }
  if (span) {
    bits.push(`${span} 期`);
  }
  const tail = bits.length ? ` — ${bits.join('，')}` : '';
  return `**${name}**（${count} 首）${tail}`;
}

function pickRepresentativeSongs(tracks, { headCount = 15, tailCount = 4 } = {}) {
  const byArtist = countBy(tracks, t => t.artist);
  const topArtists = byArtist.slice(0, headCount).map(a => a.name);
  const seen = new Set();
  const picks = [];

  for (const artist of topArtists) {
    const pick = tracks.find(t => t.artist === artist && !seen.has(`${t.title}@${t.artist}`));
    if (pick) {
      picks.push(pick);
      seen.add(`${pick.title}@${pick.artist}`);
    }
  }

  const oneShot = new Set(byArtist.filter(a => a.count === 1).map(a => a.name));
  const longTailCandidates = tracks.filter(
    t =>
      oneShot.has(t.artist)
      && !seen.has(`${t.title}@${t.artist}`)
      && t.language
      && !MAINSTREAM_LANGUAGES.has(t.language),
  );
  for (const t of longTailCandidates.slice(0, tailCount)) {
    picks.push(t);
    seen.add(`${t.title}@${t.artist}`);
  }
  return picks;
}

// 酷狗对中文歌实际返回 "国语"（不是 "华语"），长尾里把它当主流跳过。粤语保留 — 在这个用户的
// 收藏里只占小比例，长尾里的粤语艺人是真实的身份信号。
const MAINSTREAM_LANGUAGES = new Set(['国语', '华语', '中文']);

// 长尾歌手字符串去重 key：
// - 小写、归一化全/半角，去掉空白和括号备注
// - 按合作分隔符 [,，、&] 切开 → 排序 → 重新 join，
//   让 "Tanir, Tyomcha" 和 "Tyomcha, Tanir" 视为同一组合艺人
function normalizeArtistKey(name) {
  const cleaned = String(name || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[（(][^)）]*[)）]/g, '')
    .replace(/[\s　 ·・]/g, '');
  return cleaned
    .split(/[,，、&\/]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .sort()
    .join(',');
}

function longTailByLanguage(tracks, {
  maxArtistsPerLang = 10,
  excludeTopArtists = new Set(),
} = {}) {
  const byArtist = countBy(tracks, t => t.artist);
  const oneToTwo = new Set(byArtist.filter(a => a.count <= 2).map(a => a.name));
  const excludeKeys = new Set([...excludeTopArtists].map(normalizeArtistKey));

  const byLang = new Map();
  const seenKeyPerLang = new Map();
  for (const track of tracks) {
    if (!oneToTwo.has(track.artist)) continue;
    const lang = track.language || '未标注';
    if (MAINSTREAM_LANGUAGES.has(lang)) continue;

    const key = normalizeArtistKey(track.artist);
    if (!key) continue;
    if (excludeKeys.has(key)) continue; // 头部歌手的合作版本不重复进长尾

    if (!seenKeyPerLang.has(lang)) seenKeyPerLang.set(lang, new Set());
    if (seenKeyPerLang.get(lang).has(key)) continue;
    seenKeyPerLang.get(lang).add(key);

    if (!byLang.has(lang)) byLang.set(lang, []);
    byLang.get(lang).push(track.artist);
  }

  return [...byLang.entries()]
    .map(([language, artists]) => ({
      language,
      artists: artists.slice(0, maxArtistsPerLang),
      total: artists.length,
    }))
    .sort((a, b) => b.total - a.total);
}

function buildTLDR(longTerm, { langDist, decadeDist, bpmDist, topArtists }) {
  if (!longTerm.length) return '（还没拉到任何歌曲，等数据。）';

  const bits = [];
  const topLang = langDist[0];
  if (topLang) {
    bits.push(`${topLang.name}重度听众（${topLang.pct}%）`);
  }
  if (topArtists.length) {
    const heads = topArtists.slice(0, 3).map(a => a.name).join(' / ');
    bits.push(`${heads} 是宗教级核心`);
  }
  if (decadeDist.length) {
    const top2 = decadeDist.filter(d => d.name && d.name !== '其他').slice(0, 2);
    if (top2.length) bits.push(`听音时代以 ${top2.map(d => d.name).join(' / ')} 为主`);
  }
  if (bpmDist.length) {
    const dominant = bpmDist.filter(b => b.name && b.name !== '其他').sort((a, b) => b.pct - a.pct)[0];
    if (dominant) bits.push(`节奏偏${dominant.name.split(' ')[0]}`);
  }
  // 突出小众语种执念
  const minorityHook = langDist.find(l => l.pct >= 3 && l.pct < 15 && !['华语', '其他'].includes(l.name));
  if (minorityHook) {
    bits.push(`对${minorityHook.name}有一块独立的偏好（${minorityHook.pct}%）`);
  }

  return bits.join('，') + '。';
}

export function buildTasteSummary(tracks, { maxTopArtists = 20, maxRepresentative = 18 } = {}) {
  const longTerm = tracks.filter(t => t.bucket === 'long_term');
  const recent = tracks.filter(t => t.bucket === 'recent_mood');
  const avoid = tracks.filter(t => t.bucket === 'avoid');

  const topArtists = countBy(longTerm, t => t.artist).slice(0, maxTopArtists);
  const langDist = pctDistribution(longTerm, t => t.language);
  const decadeDist = pctDistribution(longTerm, t => decadeLabel(yearOf(t.publishDate)));
  const bpmDist = pctDistribution(longTerm, t => bpmBucketLabel(t.bpm));
  const representative = pickRepresentativeSongs(longTerm, {
    headCount: Math.min(15, maxRepresentative - 3),
    tailCount: 4,
  }).slice(0, maxRepresentative);
  // 用来从长尾里过滤掉头部歌手的合作版本污染（"汪苏泷、林俊杰"会被 countBy 当独立 artist 算）。
  // 只把有 ≥3 首的歌手当"真头部"，小数据（测试 fixture）下 Top 20 包含全部 artist 不会误伤长尾。
  const headArtistNames = new Set(
    countBy(longTerm, t => t.artist).filter(a => a.count >= 3).map(a => a.name),
  );
  const longTail = longTailByLanguage(longTerm, { excludeTopArtists: headArtistNames });

  const tldr = buildTLDR(longTerm, { langDist, decadeDist, bpmDist, topArtists });
  const totalLongTerm = longTerm.length;

  const lines = [
    `## 酷狗导入后的口味蒸馏（${totalLongTerm} 首长期收藏）`,
    '',
    '> 这是 Claudio 推歌时的最高优先级证据，从用户酷狗「长期红心 / 收藏」歌单整体蒸馏。下面所有比例都基于这 1686 首样本。',
    '',
    '### 你是什么样的听众 · TL;DR',
    '',
    tldr,
    '',
  ];

  if (topArtists.length) {
    lines.push(`### 核心歌手 · Top ${topArtists.length}`, '');
    topArtists.forEach((a, i) => {
      lines.push(`${i + 1}. ${describeArtist(longTerm, a)}`);
    });
    lines.push('');
  }

  if (langDist.length || decadeDist.length || bpmDist.length) {
    lines.push('### 听音指纹', '');
    if (langDist.length) lines.push(`- **语言**：${formatPctRow(langDist)}`);
    if (decadeDist.length) lines.push(`- **年代**：${formatPctRow(decadeDist)}`);
    if (bpmDist.length) lines.push(`- **节奏 (BPM)**：${formatPctRow(bpmDist)}`);
    lines.push('');
  }

  if (representative.length) {
    lines.push('### 代表曲目 · 可以放心拿来推', '');
    representative.forEach(t => {
      const lang = t.language && t.language !== '华语' ? `（${t.language}）` : '';
      lines.push(`- ${t.title} - ${t.artist}${lang}`);
    });
    lines.push('');
  }

  if (longTail.length) {
    lines.push('### 长尾标签 · 这些 1–2 首小众艺人才是身份特征', '');
    longTail.forEach(group => {
      // 合作艺人字符串里本来用 「、」 分隔，会和列表分隔符撞 → 内层换成 「·」 避免歧义
      const items = group.artists.map(a => a.replace(/、/g, '·'));
      lines.push(`- **${group.language}**：${items.join('、')}`);
    });
    lines.push('', '（长尾比 Top 歌手更能定义口味 — Top 是流行氛围，长尾是身份。）', '');
  }

  lines.push('### 最近在循环', '');
  lines.push(
    recent.length
      ? `${recent.slice(0, 8).map(formatTrack).join('；')}。这些只代表近期 mood，不要覆盖长期偏好。`
      : '（待从最近播放或最近循环截图补充。）',
  );
  lines.push('');

  lines.push('### 不喜欢 / 雷区', '');
  lines.push(
    avoid.length
      ? `不要主动推荐：${avoid.slice(0, 8).map(formatTrack).join('；')}。除非用户当下明确指定。`
      : '（待补充跳过、删掉、不想再听的歌曲或类型。）',
  );
  lines.push('');

  // 数据驱动的播放规则 —— 比通用规则更贴脸
  lines.push('### 推歌时记住', '');
  const rules = ['同一个艺人不要连续 3 首以上。'];
  const dominantBpm = bpmDist
    .filter(b => b.name && b.name !== '其他')
    .sort((a, b) => b.pct - a.pct)[0];
  if (dominantBpm) {
    rules.push(`节奏偏好集中在「${dominantBpm.name}」(${dominantBpm.pct}%)，快歌 / 高 BPM 谨慎穿插。`);
  }
  const topLang = langDist[0];
  if (topLang) {
    rules.push(`${topLang.name}是骨干（${topLang.pct}%），跨语种穿插 1–2 首能让单子有层次。`);
  }
  rules.push(
    '写代码/专注场景优先少歌词或不抢注意力的歌；中文歌词只在用户明确想听歌时提高权重。',
    '原始歌曲级数据保存在 `user/music/kugou_raw.md`，蒸馏不准时回看来源修正。',
  );
  rules.forEach(r => lines.push(`- ${r}`));
  lines.push('');

  return lines.join('\n');
}

// 把 KuGouMusicApi 抓回来的歌单转成 parseKugouInput 输出同形态的 tracks，让 buildRawMarkdown
// / buildTasteSummary 不需要任何改动就能消费。bucket / likeLevel 由调用方语义注入（API 不知道
// 这个歌单是"红心"还是"循环"还是"雷区"）。
export async function importFromShareUrl(
  url,
  { bucket = 'long_term', likeLevel = null, playlistName = '' } = {},
  {
    parseShareUrl = defaultParseShareUrl,
    fetchSharedPlaylist = defaultFetchSharedPlaylist,
  } = {},
) {
  const info = await parseShareUrl(url);
  if (!info.globalCollectionId) {
    throw new Error(`importFromShareUrl: 无法从分享链接抽出 global_collection_id：${url}`);
  }

  const { tracks: songs, totalCount, fetchedCount, truncated } =
    await fetchSharedPlaylist({ globalCollectionId: info.globalCollectionId });

  const resolvedName = playlistName
    || `kugou_share_${info.chain || info.globalCollectionId}`;
  const source = url;

  const tracks = songs.map(song => ({
    title: song.title,
    artist: song.artist,
    album: song.album || '',
    bucket,
    likeLevel,
    source,
    note: '',
    // 从 KuGouMusicApi 透传过来的元数据，buildTasteSummary 会读
    publishDate: song.publishDate || '',
    language: song.language || '',
    bpm: song.bpm || null,
    hash: song.hash || '',
  }));

  return {
    tracks,
    playlistName: resolvedName,
    totalCount,
    fetchedCount,
    truncated,
    chain: info.chain,
    globalCollectionId: info.globalCollectionId,
    resolvedUrl: info.resolvedUrl,
  };
}

export default {
  parseKugouInput,
  buildRawMarkdown,
  buildTasteSummary,
  importFromShareUrl,
};
