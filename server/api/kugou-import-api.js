import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  importFromShareUrl as defaultImport,
  buildRawMarkdown,
  buildTasteSummary,
} from '../music/kugou-import.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const VALID_BUCKETS = new Set(['long_term', 'recent_mood', 'avoid']);

export function upsertDistilled(existing, summary) {
  const start = '<!-- kugou-distilled:start -->';
  const end   = '<!-- kugou-distilled:end -->';
  const block = `${start}\n${summary.trim()}\n${end}`;
  if (existing.includes(start) && existing.includes(end)) {
    return existing.replace(new RegExp(`${start}[\\s\\S]*?${end}`), block);
  }
  return `${existing.trimEnd()}\n\n${block}\n`;
}

export function applyImport(tracks, rootDir) {
  const musicDir = path.join(rootDir, 'user', 'music');
  fs.mkdirSync(musicDir, { recursive: true });

  fs.writeFileSync(path.join(musicDir, 'kugou_raw.md'), buildRawMarkdown(tracks), 'utf8');

  const summary = buildTasteSummary(tracks);
  fs.writeFileSync(path.join(musicDir, 'kugou_taste_summary.md'), summary, 'utf8');

  const tastePath = path.join(rootDir, 'user', 'taste.md');
  const existing = fs.existsSync(tastePath) ? fs.readFileSync(tastePath, 'utf8') : '';
  fs.mkdirSync(path.dirname(tastePath), { recursive: true });
  fs.writeFileSync(tastePath, upsertDistilled(existing, summary), 'utf8');
}

export function mountKugouImportApiRoute(app, {
  importFromShareUrl = defaultImport,
  rootDir = ROOT,
} = {}) {
  app.post('/api/kugou/import', async (req, res) => {
    const { url, bucket = 'long_term', playlistName = '' } = req.body || {};

    if (!url || typeof url !== 'string' || !url.trim()) {
      res.status(400).json({ ok: false, error: 'url 必填' });
      return;
    }
    if (!VALID_BUCKETS.has(bucket)) {
      res.status(400).json({ ok: false, error: 'bucket 必须是 long_term / recent_mood / avoid' });
      return;
    }

    try {
      const result = await importFromShareUrl(url.trim(), { bucket, playlistName });
      applyImport(result.tracks, rootDir);
      res.json({
        ok: true,
        fetchedCount: result.fetchedCount,
        totalCount: result.totalCount,
        truncated: result.truncated ?? false,
        tracksCount: result.tracks.length,
      });
    } catch (err) {
      console.error('[kugou-import-api]', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
