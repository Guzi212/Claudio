import fs from 'node:fs';
import path from 'node:path';
import { localUserPath } from '../user-files.js';

const DISTILLED_RE = /<!--\s*kugou-distilled:start\s*-->[\s\S]*?<!--\s*kugou-distilled:end\s*-->/;

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

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
  const userDir = path.join(rootDir, 'user');
  // 页面上的编辑写入 .local 覆盖文件，不碰仓库里的模板。
  const tastePath = localUserPath(rootDir, 'user/taste.md');
  const routinesPath = localUserPath(rootDir, 'user/routines.md');

  app.put('/api/taste', (req, res) => {
    try {
      const body = req.body || {};
      fs.mkdirSync(userDir, { recursive: true });

      if (typeof body.taste === 'string') {
        const existing = readIfExists(tastePath);
        fs.writeFileSync(tastePath, mergeTaste(body.taste, existing));
      }
      if (typeof body.routines === 'string') {
        fs.writeFileSync(routinesPath, body.routines);
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('[api/taste] PUT failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}

export default { mountTasteRoutes };
