import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_JOURNAL = path.resolve(__dirname, '../../claudio/journal.md');

const START_MARKER = '<!-- journal:entries:start -->';
const END_MARKER   = '<!-- journal:entries:end -->';
const MAX_ENTRIES  = 30;

const LIFE_RE    = /答辩|面试|上线|发布|入职|离职|生日|纪念|结束了|搞定了|通过了|没过/;
const EMOTION_RE = /很累|太累|难受|崩了|心情不好|状态很差|心情很好|很开心|超开心|好高兴|压力很大|很焦虑|睡不着|失眠/;

function pad(n) { return String(n).padStart(2, '0'); }

function formatDateTime(d) {
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function detectSignal(userMessage, recentPlays, now = new Date()) {
  const hour = now.getHours();

  if (hour >= 23 || hour <= 4) {
    return `深夜 ${pad(hour)}:${pad(now.getMinutes())}，在听歌`;
  }

  if (recentPlays.length >= 3) {
    const top = recentPlays[0]?.title;
    if (top) {
      const count = recentPlays.slice(0, 8).filter(p => p.title === top).length;
      if (count >= 3) return `循环《${top}》${count}次`;
    }
  }

  const msg = String(userMessage || '');
  const lifeMatch = msg.match(LIFE_RE);
  if (lifeMatch) return `用户提到：「${msg.slice(0, 60)}」`;

  const emotionMatch = msg.match(EMOTION_RE);
  if (emotionMatch) return `用户情绪：「${msg.slice(0, 60)}」`;

  return null;
}

export function appendJournalEntry(signal, now = new Date(), journalPath = DEFAULT_JOURNAL) {
  let content;
  try {
    content = fs.readFileSync(journalPath, 'utf8');
  } catch {
    return;
  }

  const startIdx = content.indexOf(START_MARKER);
  const endIdx   = content.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1) return;

  const entry = `- ${formatDateTime(now)} · ${signal}\n`;

  const before  = content.slice(0, startIdx + START_MARKER.length);
  const middle  = content.slice(startIdx + START_MARKER.length, endIdx);
  const after   = content.slice(endIdx);

  const existing = middle.split('\n').filter(l => l.startsWith('- '));
  const trimmed  = existing.slice(0, MAX_ENTRIES - 1);

  const newMiddle = '\n' + entry + trimmed.join('\n') + (trimmed.length ? '\n' : '');
  fs.writeFileSync(journalPath, before + newMiddle + after, 'utf8');
}
