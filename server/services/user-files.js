import fs from 'node:fs';
import path from 'node:path';

/**
 * 将相对路径转换为对应的 `.local` 文件路径（如 `user/taste.md` -> `user/taste.local.md`）。
 */
export function localCounterpartPath(relPath) {
  const normalized = String(relPath || '').replace(/\\/g, '/');
  if (!normalized || normalized.includes('.local.')) return normalized;
  const parsed = path.posix.parse(normalized);
  if (!parsed.ext) return `${normalized}.local`;
  const base = parsed.dir ? `${parsed.dir}/${parsed.name}` : parsed.name;
  return `${base}.local${parsed.ext}`;
}

/**
 * 判断文本是否包含除空白、HTML 注释与纯标题占位外的有效内容。
 */
export function hasMeaningfulContent(text) {
  if (typeof text !== 'string') return false;
  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, '');
  const withoutHeadings = withoutComments.replace(/^#{1,6}\s+.*$/gm, '');
  return withoutHeadings.trim().length > 0;
}

function readUtf8Safe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function statMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function isLocalFreshEnough(localAbs, baseAbs) {
  const localMtime = statMtimeMs(localAbs);
  if (localMtime == null) return false;
  const baseMtime = statMtimeMs(baseAbs);
  if (baseMtime == null) return true;
  // 容忍 1s 误差，保证同毫秒创建的文件依然按 .local 优先处理。
  return localMtime >= baseMtime - 1000;
}

/**
 * 按 `.local.md` 优先规则读取用户或认知语料文件。
 * 若 `.local` 文件存在、有实质内容且不比基础文件陈旧，则优先返回；否则回退到基础文件。
 */
export function resolveReadUserFile(rootDir, relPath) {
  const localRel = localCounterpartPath(relPath);
  const localAbs = path.resolve(rootDir, localRel);
  const baseAbs = path.resolve(rootDir, relPath);

  const localText = localRel !== relPath ? readUtf8Safe(localAbs) : null;
  const baseText = readUtf8Safe(baseAbs);
  const localMeaningful = localText !== null && hasMeaningfulContent(localText);
  const baseMeaningful = baseText !== null && hasMeaningfulContent(baseText);

  if (localMeaningful && (!baseMeaningful || isLocalFreshEnough(localAbs, baseAbs))) {
    return {
      path: localAbs,
      relPath: localRel,
      isLocal: true,
      content: localText,
    };
  }

  if (baseText !== null) {
    return {
      path: baseAbs,
      relPath,
      isLocal: false,
      content: baseText,
    };
  }

  if (localText !== null) {
    return {
      path: localAbs,
      relPath: localRel,
      isLocal: true,
      content: localText,
    };
  }

  return {
    path: baseAbs,
    relPath,
    isLocal: false,
    content: '',
  };
}

/**
 * 解析写入目标并写入用户语料：当 `.local` 文件有效且不比基础文件旧（或显式 `preferLocal`）时写入 `.local` 文件，
 * 否则写入基础文件（兼容仅含基础文件的测试临时目录与用户直接更新基础文件的场景）。
 */
export function writeUserFile(rootDir, relPath, content, { preferLocal = false } = {}) {
  const localRel = localCounterpartPath(relPath);
  const localAbs = path.resolve(rootDir, localRel);
  const baseAbs = path.resolve(rootDir, relPath);
  const useLocal = Boolean(
    localRel !== relPath
    && (preferLocal || (fs.existsSync(localAbs) && (!fs.existsSync(baseAbs) || isLocalFreshEnough(localAbs, baseAbs)))),
  );
  const targetAbs = useLocal ? localAbs : baseAbs;

  fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
  fs.writeFileSync(targetAbs, content, 'utf8');

  return {
    path: targetAbs,
    relPath: useLocal ? localRel : relPath,
    isLocal: useLocal,
  };
}
