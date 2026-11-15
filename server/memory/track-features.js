// 曲目轻量特征推断：纯本地启发式，零外部请求、零硬编码时段规则。

const AUDIO_FILE_EXT_RE = /\.(mp3|flac|wav|m4a|ape|ogg|aac|wma)$/i;
const CLI_ERROR_RE = /^claude CLI exited/i;

const INSTRUMENTAL_RE = /\b(inst(?:rumental)?|piano|violin|cello|guitar\s+solo|lofi|lo-fi|ambient|soundtrack|ost|bgm|nocturne|prelude|sonata|orchestra|symphony|classical|acoustic\s+inst)\b|纯音乐|伴奏|钢琴|大提琴|小提琴|轻音乐|冥想|助眠|白噪音|器乐|独奏/i;
const VOCAL_HINT_RE = /\b(feat\.?|ft\.?|vocal|singer|ballad|pop|rap|hip[- ]?hop|r&b|indie\s+pop|cantopop|mandopop)\b|人声|合唱|演唱|主唱|唱腔|女声|男声|流行|民谣|说唱|摇滚|抒情歌/i;
const CALM_RE = /舒缓|安静|平静|温柔|夜晚|晚安|轻柔|治愈|木吉他|催眠|睡眠|放松|微风|晨光|慵懒|安静向|\b(chill|calm|soft|slow|lullaby|ambient|sleep|quiet|gentle|peaceful|ballad|acoustic)\b/i;
const ENERGETIC_RE = /活力|燃|节奏|鼓点|快节奏|动感|振奋|元气|电音|摇滚|狂欢|电子|律动|蹦迪|运动|派对|\b(disco|funk|dance|upbeat|rock|electronic|edm|hip[- ]?hop|rap|energetic|groove|pop|house|synthpop|punk)\b/i;

const TAG_RULES = [
  ['instrumental', INSTRUMENTAL_RE],
  ['vocal', VOCAL_HINT_RE],
  ['calm', CALM_RE],
  ['energetic', ENERGETIC_RE],
  ['pop', /\bpop\b|流行/i],
  ['rock', /\brock\b|摇滚/i],
  ['electronic', /\b(edm|electronic|synth|house|techno|disco)\b|电音|电子/i],
  ['folk', /\bfolk\b|民谣/i],
  ['jazz', /\bjazz\b|爵士/i],
  ['classical', /\b(classical|piano|cello|violin|nocturne|sonata)\b|古典|钢琴/i],
  ['rnb', /\br&b\b|\brnb\b|灵魂/i],
  ['ost', /\b(ost|soundtrack|bgm)\b|原声|配乐/i],
];

/**
 * 判断曲目是否合法，适合参与学习与记忆统计。
 */
export function isValidLearnTrack({ title, quality } = {}) {
  if (quality === 'invalid') return false;
  const clean = String(title || '').trim();
  if (!clean) return false;
  if (CLI_ERROR_RE.test(clean)) return false;
  if (AUDIO_FILE_EXT_RE.test(clean)) return false;
  return true;
}

/**
 * 判断歌词文本是否包含真实可唱段落（而非单纯元信息或“纯音乐”提示）。
 */
export function hasMeaningfulLyrics(lyric = '') {
  const text = String(lyric || '').trim();
  if (!text) return false;
  if (/纯音乐[,，、\s]*请欣赏|no\s+lyrics|instrumental/i.test(text)) return false;
  const lines = text
    .split(/\r?\n/)
    .map(l => l.replace(/\[\d{2}:\d{2}(?:\.\d{2,3})?\]/g, '').trim())
    .filter(l => l && !/^\[(ti|ar|al|by|offset):/i.test(l));
  return lines.length >= 3;
}

/**
 * 从歌名、歌手、推荐理由与歌词中提取极轻量特征标签。
 * @returns {{ vocal: 'vocal'|'instrumental'|'unknown', energy: 'calm'|'moderate'|'energetic'|'unknown', tags: string[] }}
 */
export function inferTrackFeatures({ title = '', artist = '', reason = '', lyric = '' } = {}) {
  const combined = `${title} ${artist} ${reason}`.trim();

  let vocal = 'unknown';
  if (INSTRUMENTAL_RE.test(combined)) {
    vocal = 'instrumental';
  } else if (hasMeaningfulLyrics(lyric) || VOCAL_HINT_RE.test(combined)) {
    vocal = 'vocal';
  }

  let energy = 'unknown';
  const isCalm = CALM_RE.test(combined);
  const isEnergetic = ENERGETIC_RE.test(combined);
  if (isCalm && !isEnergetic) energy = 'calm';
  else if (isEnergetic && !isCalm) energy = 'energetic';
  else if (vocal === 'instrumental') energy = 'calm';

  const tags = [];
  for (const [tag, re] of TAG_RULES) {
    if (re.test(combined) || (tag === 'vocal' && vocal === 'vocal')) {
      if (!tags.includes(tag)) tags.push(tag);
    }
  }

  return { vocal, energy, tags };
}
