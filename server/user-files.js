import fs from 'node:fs';
import path from 'node:path';

// 个人覆盖文件：user/taste.md -> user/taste.local.md
// 仓库里只提交模板；.local.* 已被 .gitignore 忽略。
export function localVariant(relativePath) {
  return relativePath.replace(/\.(md|txt)$/, '.local.$1');
}

export function resolveUserFile(rootDir, relativePath) {
  const localPath = path.join(rootDir, localVariant(relativePath));
  if (fs.existsSync(localPath)) return localPath;
  return path.join(rootDir, relativePath);
}

export function readUserFile(rootDir, relativePath, fallback = '') {
  try {
    return fs.readFileSync(resolveUserFile(rootDir, relativePath), 'utf8');
  } catch {
    return fallback;
  }
}

export function localUserPath(rootDir, relativePath) {
  return path.join(rootDir, localVariant(relativePath));
}
