#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRawMarkdown,
  buildTasteSummary,
  importFromShareUrl,
  parseKugouInput,
} from '../server/music/kugou-import.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] || fallback : fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function abs(relOrAbs) {
  return path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs);
}

function upsertGeneratedTaste(tastePath, summary) {
  const start = '<!-- kugou-distilled:start -->';
  const end = '<!-- kugou-distilled:end -->';
  const block = `${start}\n${summary.trim()}\n${end}`;
  const existing = fs.existsSync(tastePath) ? fs.readFileSync(tastePath, 'utf8') : '';

  if (existing.includes(start) && existing.includes(end)) {
    return existing.replace(new RegExp(`${start}[\\s\\S]*?${end}`), block);
  }

  return `${existing.trimEnd()}\n\n${block}\n`;
}

const fromUrl = argValue('--from-url', '');
const inputPath = argValue('--input', 'user/music/kugou_input.txt');
const rawOutputPath = argValue('--raw-output', 'user/music/kugou_raw.md');
const summaryOutputPath = argValue('--summary-output', 'user/music/kugou_taste_summary.md');
const tastePath = argValue('--taste', 'user/taste.md');
const bucketArg = argValue('--bucket', 'long_term');
const likeLevelArg = argValue('--like-level', '');
const playlistName = argValue('--name', '');
const dryRun = hasArg('--dry-run');
const appendToInput = hasArg('--append-to-input');

const VALID_BUCKETS = new Set(['long_term', 'recent_mood', 'avoid']);
if (!VALID_BUCKETS.has(bucketArg)) {
  console.error(`--bucket 必须是 long_term / recent_mood / avoid 之一，收到：${bucketArg}`);
  process.exit(1);
}

async function loadTracks() {
  if (fromUrl) {
    const likeLevel = likeLevelArg ? Number(likeLevelArg) : null;
    console.log(`从分享链接拉取：${fromUrl}`);
    const result = await importFromShareUrl(fromUrl, {
      bucket: bucketArg,
      likeLevel,
      playlistName,
    });
    console.log(`歌单：${result.playlistName}`);
    console.log(`拉取：${result.fetchedCount} / ${result.totalCount} 首`);
    if (result.truncated) {
      console.warn(`⚠️ 未拉全，可能因分页中断或限流，已落盘的是 ${result.fetchedCount} 首`);
    }
    return { tracks: result.tracks, importResult: result };
  }

  const inputAbs = abs(inputPath);
  if (!fs.existsSync(inputAbs)) {
    console.error(`找不到输入文件：${inputPath}`);
    console.error('请先把酷狗截图 OCR 文本、分享链接、复制出来的歌单粘到这个文件里。');
    console.error('或者使用：--from-url <share-url> 直接从分享链接抓取。');
    process.exit(1);
  }
  const input = fs.readFileSync(inputAbs, 'utf8');
  const tracks = parseKugouInput(input);
  if (!tracks.length) {
    console.error('没有识别到歌曲。建议使用格式：歌名 - 歌手，或：歌名 歌手 《专辑》');
    process.exit(1);
  }
  return { tracks, importResult: null };
}

async function main() {
  const { tracks, importResult } = await loadTracks();

  if (dryRun) {
    console.log(`识别歌曲：${tracks.length} 首（--dry-run 不写文件）`);
    console.log('前 10 首预览：');
    for (const t of tracks.slice(0, 10)) {
      console.log(`  - ${t.title} - ${t.artist}`);
    }
    return;
  }

  const rawAbs = abs(rawOutputPath);
  const summaryAbs = abs(summaryOutputPath);
  fs.mkdirSync(path.dirname(rawAbs), { recursive: true });
  fs.mkdirSync(path.dirname(summaryAbs), { recursive: true });

  fs.writeFileSync(rawAbs, buildRawMarkdown(tracks), 'utf8');
  fs.writeFileSync(summaryAbs, buildTasteSummary(tracks), 'utf8');

  if (hasArg('--apply-taste')) {
    const tasteAbs = abs(tastePath);
    const nextTaste = upsertGeneratedTaste(tasteAbs, buildTasteSummary(tracks));
    fs.writeFileSync(tasteAbs, nextTaste, 'utf8');
  }

  if (appendToInput && importResult) {
    const inputAbs = abs(inputPath);
    fs.mkdirSync(path.dirname(inputAbs), { recursive: true });
    const header = `\n# ${importResult.playlistName} · 来自 ${fromUrl} · ${tracks.length} 首\n`;
    const lines = tracks.map(t => `${t.title} - ${t.artist}`).join('\n');
    fs.appendFileSync(inputAbs, header + lines + '\n', 'utf8');
    console.log(`已追加到：${path.relative(ROOT, inputAbs)}`);
  }

  console.log(`识别歌曲：${tracks.length} 首`);
  console.log(`原始清单：${path.relative(ROOT, rawAbs)}`);
  console.log(`口味摘要：${path.relative(ROOT, summaryAbs)}`);
  if (hasArg('--apply-taste')) {
    console.log(`已更新：${tastePath}`);
  }
}

main().catch(err => {
  console.error('导入失败：', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
