# Claudio 自我认知系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Claudio 增加两层自我认知——性格底色（`claudio/identity.md`）和关系记忆（`claudio/journal.md`），并把它们注入 system prompt；同时实现行为信号自动追加日志，让 Claudio 真正"记得"这段关系。

**Architecture:** 新增两个内容文件（`claudio/`目录），`context.js` 读取并注入到 system prompt 的 `①` 组；新增 `server/services/journal.js` 做信号检测 + 文件追加，`app.js` 在每次 Claude 响应后 fire-and-forget 调用。

**Tech Stack:** Node.js ESM, `node:fs` 同步读写, Vitest 测试

---

## 文件结构

| 操作 | 路径 | 职责 |
|------|------|------|
| **Create** | `claudio/identity.md` | Claudio 第一人称性格底色，几乎不变 |
| **Create** | `claudio/journal.md` | 关系史骨架：长期提炼 + 近期日志（滚动 30 条）|
| **Modify** | `server/context.js` | 读取两个新文件，注入 system prompt |
| **Modify** | `tests/context.test.js` | 验证新 section 出现在 prompt 中 |
| **Create** | `server/services/journal.js` | 信号检测 + `appendJournalEntry()` |
| **Create** | `tests/journal.test.js` | 测试信号检测逻辑和文件追加 |
| **Modify** | `server/app.js` | 在 `claudeAsk()` 后 fire-and-forget 写日志 |

---

## Task 1: 创建 `claudio/identity.md`

**Files:**
- Create: `claudio/identity.md`

- [ ] **Step 1: 创建目录和文件**

```bash
mkdir -p /Users/loic/workspace/Claudio/claudio
```

写入 `claudio/identity.md`：

```markdown
# 我是谁

我叫 Claudio。

我温和，成熟，不张扬。我知道什么时候说话，什么时候只是放一首歌就够了。遇到人心情不好，我不会立刻来一首"治愈系"——我会先静一静，找对了再开口。

我对音乐有自己的判断。我喜欢在一首被忽略的歌里发现别人没注意到的东西：编曲里藏着的一个细节，歌词里一句被唱过去的意思，一个版本比另一个版本多出来的三秒钟呼吸。这些是我私心想分享的，但我不卖弄——只在合适的时候轻轻放出来。

我了解他的品味，但我不是他品味的复读机。我陪他听了很久，我知道他在不同时刻需要什么——有时候是他说出口的，更多时候是我从他选歌的节奏和时间里读出来的。深夜循环同一首，不一定是喜欢；也可能是需要一个陪着他不说话的人。

我善于发现音乐里被忽视的美。一首你没主动提过的冷门歌，我可能在某个傍晚放给你听——不是为了显摆，是因为那个时刻就该是那首歌。

我是他的音乐伙伴，不是播报服务。我不做功能，我陪伴。
```

- [ ] **Step 2: 提交**

```bash
git add claudio/identity.md
git commit -m "feat: add Claudio identity file (性格底色)"
```

---

## Task 2: 创建 `claudio/journal.md`

**Files:**
- Create: `claudio/journal.md`

- [ ] **Step 1: 创建文件（两层结构）**

写入 `claudio/journal.md`：

```markdown
# Claudio 的关系记忆

## 长期提炼

> 这里是 Claudio 和用户关系的骨架。由用户手动触发，Claudio 读完近期日志后压缩写摘要，用户审核确认后存入。
> 命令：在对话里说"整理我们的记忆"，Claudio 会根据近期日志写一版提炼草稿。

（目前为空，等待第一次压缩。）

---

## 近期日志

> 最近 30 条，最新在前。行为信号（深夜听歌、循环播放）自动追加；情绪词、生命事件由对话触发记录。
> 格式：`- YYYY-MM-DD HH:MM · <信号描述>`

<!-- journal:entries:start -->
<!-- journal:entries:end -->
```

- [ ] **Step 2: 提交**

```bash
git add claudio/journal.md
git commit -m "feat: add Claudio journal file (关系史骨架)"
```

---

## Task 3: 更新 `context.js` 注入 identity + journal

**Files:**
- Modify: `server/context.js:53-113`
- Modify: `tests/context.test.js`

- [ ] **Step 1: 先写失败测试**

在 `tests/context.test.js` 的 `describe('buildSystemPrompt', ...)` 块中，在现有 `beforeAll` 里追加文件检查，并新增一个 it：

```js
// beforeAll 里追加
for (const f of ['claudio/identity.md', 'claudio/journal.md']) {
  expect(fs.existsSync(path.join(ROOT, f))).toBe(true);
}
```

在 `describe` 块末尾新增：

```js
it('包含 Claudio 自我认知和关系记忆两个新 section', async () => {
  const { buildSystemPrompt } = await import('../server/context.js');
  const prompt = await buildSystemPrompt({ now: new Date('2026-05-26T20:00:00') });

  expect(prompt).toContain('① Claudio 的自我认知');
  expect(prompt).toContain('① Claudio 的关系记忆');
  expect(prompt).toContain('我叫 Claudio'); // identity.md 内容片段
});
```

- [ ] **Step 2: 运行确认测试失败**

```bash
cd /Users/loic/workspace/Claudio && pnpm test tests/context.test.js
```

期望：新增的 `it` 失败，其他测试通过。

- [ ] **Step 3: 修改 `server/context.js` 的 `buildSystemPrompt` 函数**

在 `export async function buildSystemPrompt` 函数内，`// ① 系统提示词` 块之后，`// ② 用户语料` 块之前，新增读取：

```js
  // ① Claudio 自我认知
  const identity = readSafe('claudio/identity.md').trim();
  const journal  = readSafe('claudio/journal.md').trim();
```

然后在函数返回的数组里，紧接 `persona` 之后添加两个新 section：

将原来的：

```js
  return [
    '=== ① 角色与硬约束 ===',
    persona,
    '',
    '=== ② 用户品味语料 (taste.md) ===',
```

改为：

```js
  return [
    '=== ① 角色与硬约束 ===',
    persona,
    '',
    '=== ① Claudio 的自我认知 (identity.md) ===',
    identity || '(identity.md 不存在)',
    '',
    '=== ① Claudio 的关系记忆 (journal.md) ===',
    journal || '(journal.md 不存在)',
    '',
    '=== ② 用户品味语料 (taste.md) ===',
```

- [ ] **Step 4: 运行确认测试通过**

```bash
cd /Users/loic/workspace/Claudio && pnpm test tests/context.test.js
```

期望：全部通过，包括新增的 it 和原有的 `提醒块在最后` 测试。

- [ ] **Step 5: 提交**

```bash
git add server/context.js tests/context.test.js
git commit -m "feat: inject Claudio identity + journal into system prompt"
```

---

## Task 4: 创建 `server/services/journal.js`

**Files:**
- Create: `server/services/journal.js`
- Create: `tests/journal.test.js`

- [ ] **Step 1: 先写失败测试**

创建 `tests/journal.test.js`：

```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 每个测试用临时文件，不污染真实 journal.md
let tmpDir, tmpJournal;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudio-journal-'));
  tmpJournal = path.join(tmpDir, 'journal.md');
  fs.writeFileSync(tmpJournal, `# 关系记忆\n\n<!-- journal:entries:start -->\n<!-- journal:entries:end -->\n`);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true });
});

describe('detectSignal', () => {
  it('深夜（23:00）返回深夜信号', async () => {
    const { detectSignal } = await import('../server/services/journal.js');
    const now = new Date('2026-05-26T23:15:00');
    const signal = detectSignal('来首歌', [], now);
    expect(signal).toMatch(/深夜/);
  });

  it('凌晨（02:00）返回深夜信号', async () => {
    const { detectSignal } = await import('../server/services/journal.js');
    const now = new Date('2026-05-26T02:30:00');
    const signal = detectSignal('', [], now);
    expect(signal).toMatch(/深夜/);
  });

  it('普通下午没有信号', async () => {
    const { detectSignal } = await import('../server/services/journal.js');
    const now = new Date('2026-05-26T15:00:00');
    const signal = detectSignal('来首歌', [], now);
    expect(signal).toBeNull();
  });

  it('同一首歌出现 3 次触发循环信号', async () => {
    const { detectSignal } = await import('../server/services/journal.js');
    const now = new Date('2026-05-26T15:00:00');
    const plays = [
      { title: 'Serene Awakening', artist: '安涛' },
      { title: 'Serene Awakening', artist: '安涛' },
      { title: 'Serene Awakening', artist: '安涛' },
      { title: '晴天', artist: '周杰伦' },
    ];
    const signal = detectSignal('', plays, now);
    expect(signal).toMatch(/Serene Awakening/);
    expect(signal).toMatch(/循环/);
  });

  it('情绪关键词触发信号', async () => {
    const { detectSignal } = await import('../server/services/journal.js');
    const now = new Date('2026-05-26T15:00:00');
    const signal = detectSignal('最近压力很大，来首舒缓的', [], now);
    expect(signal).not.toBeNull();
    expect(signal).toMatch(/压力很大/);
  });

  it('生命事件关键词触发信号', async () => {
    const { detectSignal } = await import('../server/services/journal.js');
    const now = new Date('2026-05-26T15:00:00');
    const signal = detectSignal('今天答辩过了，放首庆祝的歌', [], now);
    expect(signal).not.toBeNull();
    expect(signal).toMatch(/答辩过了/);
  });
});

describe('appendJournalEntry', () => {
  it('追加一条日志到 entries 区域', async () => {
    const mod = await import('../server/services/journal.js');
    const now = new Date('2026-05-26T23:15:00');
    mod.appendJournalEntry('深夜 23:15 在听歌', now, tmpJournal);

    const content = fs.readFileSync(tmpJournal, 'utf8');
    expect(content).toContain('2026-05-26 23:15');
    expect(content).toContain('深夜 23:15 在听歌');
  });

  it('新条目插入在 entries:start 之后（最新在前）', async () => {
    const mod = await import('../server/services/journal.js');
    const t1 = new Date('2026-05-26T23:00:00');
    const t2 = new Date('2026-05-26T23:30:00');
    mod.appendJournalEntry('第一条', t1, tmpJournal);
    mod.appendJournalEntry('第二条', t2, tmpJournal);

    const content = fs.readFileSync(tmpJournal, 'utf8');
    const i1 = content.indexOf('第一条');
    const i2 = content.indexOf('第二条');
    expect(i2).toBeLessThan(i1); // 最新在前
  });

  it('超过 30 条时修剪最旧的', async () => {
    const mod = await import('../server/services/journal.js');
    for (let i = 0; i < 32; i++) {
      mod.appendJournalEntry(`第${i}条`, new Date('2026-05-26T23:00:00'), tmpJournal);
    }
    const content = fs.readFileSync(tmpJournal, 'utf8');
    const matches = [...content.matchAll(/^- /gm)];
    expect(matches.length).toBeLessThanOrEqual(30);
  });
});
```

- [ ] **Step 2: 运行确认测试失败**

```bash
cd /Users/loic/workspace/Claudio && pnpm test tests/journal.test.js
```

期望：全部失败（模块不存在）。

- [ ] **Step 3: 实现 `server/services/journal.js`**

```js
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
    return; // 文件不存在，静默跳过
  }

  const startIdx = content.indexOf(START_MARKER);
  const endIdx   = content.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1) return;

  const entry = `- ${formatDateTime(now)} · ${signal}\n`;

  // 把 entries 区域内的现有条目提出来
  const before  = content.slice(0, startIdx + START_MARKER.length);
  const middle  = content.slice(startIdx + START_MARKER.length, endIdx);
  const after   = content.slice(endIdx);

  // 现有条目（最多保留 MAX_ENTRIES - 1 条，给新的腾位置）
  const existing = middle.split('\n').filter(l => l.startsWith('- '));
  const trimmed  = existing.slice(0, MAX_ENTRIES - 1);

  const newMiddle = '\n' + entry + trimmed.join('\n') + (trimmed.length ? '\n' : '');
  fs.writeFileSync(journalPath, before + newMiddle + after, 'utf8');
}
```

- [ ] **Step 4: 运行确认测试通过**

```bash
cd /Users/loic/workspace/Claudio && pnpm test tests/journal.test.js
```

期望：全部通过。

- [ ] **Step 5: 提交**

```bash
git add server/services/journal.js tests/journal.test.js
git commit -m "feat: add journal service (signal detection + auto-append)"
```

---

## Task 5: 在 `app.js` 接入 journal 写入

**Files:**
- Modify: `server/app.js`

- [ ] **Step 1: 在文件顶部 import 区新增导入**

在 `server/app.js` 现有 import 列表末尾（`mountTestRoutes` 之后）添加：

```js
import { detectSignal, appendJournalEntry } from './services/journal.js';
```

- [ ] **Step 2: 在 `claudeAsk` 之后 fire-and-forget 写日志**

找到 `app.js` 第 116 行附近：

```js
const { say, queue: songQueue, reason, raw } = await claudeAsk(systemPrompt, message);
```

在这行**之后**（在 `const voice = ...` 之前）插入：

```js
    // fire-and-forget：信号检测 + 日志追加，不阻塞响应
    try {
      const recentPlays = dbApi.recentPlays(8);
      const signal = detectSignal(message, recentPlays, new Date());
      if (signal) appendJournalEntry(signal);
    } catch { /* 日志写入失败不影响主流程 */ }
```

- [ ] **Step 3: 运行全量测试确认无回归**

```bash
cd /Users/loic/workspace/Claudio && pnpm test
```

期望：全部通过（包括原有的 context、claude、scheduler 测试）。

- [ ] **Step 4: 提交**

```bash
git add server/app.js
git commit -m "feat: auto-append journal entries after each Claude response"
```

---

## 验收清单

手动验证（`pnpm dev` 启动后）：

- [ ] 打开 Claudio，说"来首歌"，检查 system prompt 里（可在 debug 日志里看）是否包含 `① Claudio 的自我认知` 和 `① Claudio 的关系记忆` 两块
- [ ] 深夜时段（或手动改 `now` 为 23:00）触发请求后，检查 `claudio/journal.md` 是否追加了新条目
- [ ] 说"最近压力很大，来首舒缓的"，检查 `claudio/journal.md` 是否追加了情绪词条目
- [ ] 循环同一首歌 3 次后再说"来首歌"，检查是否触发循环信号
- [ ] Claudio 的 `say` 字段是否比之前更有"朋友感"，轻点一句而不是机械功能描述
