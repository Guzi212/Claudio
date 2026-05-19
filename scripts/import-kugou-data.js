#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRawMarkdown,
  buildTasteSummary,
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

const inputPath = argValue('--input', 'user/music/kugou_input.txt');
const rawOutputPath = argValue('--raw-output', 'user/music/kugou_raw.md');
const summaryOutputPath = argValue('--summary-output', 'user/music/kugou_taste_summary.md');
const tastePath = argValue('--taste', 'user/taste.md');

const inputAbs = abs(inputPath);
if (!fs.existsSync(inputAbs)) {
  console.error(`找不到输入文件：${inputPath}`);
  console.error('请先把酷狗截图 OCR 文本、分享链接、复制出来的歌单粘到这个文件里。');
  process.exit(1);
}

const input = fs.readFileSync(inputAbs, 'utf8');
const tracks = parseKugouInput(input);
if (!tracks.length) {
  console.error('没有识别到歌曲。建议使用格式：歌名 - 歌手，或：歌名 歌手 《专辑》');
  process.exit(1);
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

console.log(`识别歌曲：${tracks.length} 首`);
console.log(`原始清单：${path.relative(ROOT, rawAbs)}`);
console.log(`口味摘要：${path.relative(ROOT, summaryAbs)}`);
if (hasArg('--apply-taste')) {
  console.log(`已更新：${tastePath}`);
}
