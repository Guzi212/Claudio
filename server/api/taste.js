import fs from 'node:fs';
import { resolveReadUserFile, writeUserFile } from '../services/user-files.js';

const DISTILLED_RE = /<!--\s*kugou-distilled:start\s*-->[\s\S]*?<!--\s*kugou-distilled:end\s*-->/;

function mergeTaste(incoming, existing) {
  // 用户回传内容里已经含蒸馏区 → 直接按用户给的写
  if (DISTILLED_RE.test(incoming)) return incoming;
  // 原文件有蒸馏区 → 提取出来追加在新内容末尾
  const match = existing.match(DISTILLED_RE);
  if (!match) return incoming;
  const tail = incoming.endsWith('\n') ? '' : '\n\n';
  return incoming + tail + match[0] + '\n';
}

export function mountTasteRoutes(app, { rootDir }) {
  app.put('/api/taste', (req, res) => {
    try {
      const body = req.body || {};

      if (typeof body.taste === 'string') {
        const existing = resolveReadUserFile(rootDir, 'user/taste.md').content;
        writeUserFile(rootDir, 'user/taste.md', mergeTaste(body.taste, existing));
      }
      if (typeof body.routines === 'string') {
        writeUserFile(rootDir, 'user/routines.md', body.routines);
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('[api/taste] PUT failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}

export default { mountTasteRoutes };
