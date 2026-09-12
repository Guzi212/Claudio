import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// 递归收集 pwa 下的 .js 源文件
function collectJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJs(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const pwaRoot = path.resolve('pwa');

// 判断某次 innerHTML 赋值是否安全：只允许清空（'' / ""），其余（模板串、拼接、变量）都算不安全
function offendingAssignment(line) {
  const m = line.match(/\.innerHTML\s*=\s*(.*)$/);
  if (!m) return null;
  const rhs = m[1].trim().replace(/;\s*$/, '').trim();
  return (rhs === "''" || rhs === '""') ? null : line.trim();
}

describe('PWA 无 innerHTML XSS 注入点', () => {
  it('所有 .innerHTML 赋值只能是清空（= \'\'）', () => {
    const offenders = [];
    for (const file of collectJs(pwaRoot)) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        const bad = offendingAssignment(line);
        if (bad) offenders.push(`${path.relative(pwaRoot, file)}:${i + 1}: ${bad}`);
      });
    }
    expect(offenders, `发现未转义的 innerHTML 赋值:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('不再用模板字符串把服务端数据拼进 innerHTML', () => {
    const offenders = [];
    for (const file of collectJs(pwaRoot)) {
      const src = fs.readFileSync(file, 'utf8');
      if (/innerHTML\s*=\s*`/.test(src)) offenders.push(path.relative(pwaRoot, file));
    }
    expect(offenders).toEqual([]);
  });
});
