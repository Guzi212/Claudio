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
  const m = line.match(/(?:红心|喜欢|like|level)?\s*([123])\s*(?:心|星|级)?/i);
  return m ? Number(m[1]) : null;
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
    '| 分组 | 歌名 | 歌手 | 专辑 | 喜欢等级 | 来源 | 备注 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(row => `| ${row.map(cleanCell).join(' | ')} |`),
    '',
    '## 原始来源',
    '',
    sources.length ? sources.map(s => `- ${s}`).join('\n') : '- （待补充截图、分享链接或复制文本来源）',
    '',
  ].join('\n');
}

export function buildTasteSummary(tracks, { maxItems = 8 } = {}) {
  const longTerm = tracks.filter(t => t.bucket === 'long_term');
  const recent = tracks.filter(t => t.bucket === 'recent_mood');
  const avoid = tracks.filter(t => t.bucket === 'avoid');
  const topArtists = countBy(longTerm, t => t.artist).slice(0, maxItems);
  const strongLikes = longTerm
    .filter(t => Number(t.likeLevel) >= 3)
    .slice(0, maxItems);

  const lines = [
    '## 酷狗导入后的口味蒸馏',
    '',
    '> 由酷狗截图/分享链接/复制文本离线整理。近期播放只当作当前 mood，红心和收藏歌单权重更高。',
    '',
    '### 长期喜欢',
  ];

  if (topArtists.length) {
    lines.push(`- 高频歌手：${topArtists.map(a => `${a.name}${a.count > 1 ? `（${a.count} 首）` : ''}`).join('、')}。`);
  }
  if (strongLikes.length) {
    lines.push(`- 高喜欢等级：${strongLikes.map(formatTrack).join('；')}。`);
  }
  if (!topArtists.length && !strongLikes.length) {
    lines.push('- （待从“我的喜欢”、红心或收藏歌单补充。）');
  }

  lines.push('', '### 最近在循环');
  lines.push(recent.length
    ? `- ${recent.slice(0, maxItems).map(formatTrack).join('；')}。这些只代表近期 mood，不要覆盖长期偏好。`
    : '- （待从最近播放或最近循环截图补充。）');

  lines.push('', '### 不喜欢 / 雷区');
  lines.push(avoid.length
    ? `- 不要主动推荐：${avoid.slice(0, maxItems).map(formatTrack).join('；')}。除非用户当下明确指定。`
    : '- （待补充跳过、删掉、不想再听的歌曲或类型。）');

  lines.push(
    '',
    '### 播放规则',
    '- 同一个艺人不要连续 3 首以上。',
    '- 写代码/专注场景优先少歌词或不抢注意力的歌；中文歌词只在用户明确想听歌时提高权重。',
    '- 最近播放降权处理，除非同一歌手或风格同时出现在红心、收藏歌单和最近循环里。',
    '- 原始歌曲级数据保存在 `user/music/kugou_raw.md`，蒸馏不准时回看来源修正。',
    '',
  );

  return lines.join('\n');
}

export default {
  parseKugouInput,
  buildRawMarkdown,
  buildTasteSummary,
};
