# DJ 电台主持人升级实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Claudio 从"克制简短的朋友"升级为"成熟电台主持人"：每首歌有 `comment` 逐首点评，`say` 按情境调整长度，打招呼带记忆感。

**Architecture:** ① server 的 `normalizeDjJson` + `ask()` 新增 `comment` 字段并透传给前端；② `prompts/dj-persona.md` 重写人格；③ 前端 `send()` 把气泡重构为 `say` + 逐首 `comment` 列表，`renderQueuePanel()` 加点击展开。

**Tech Stack:** Node.js ESM, Vanilla JS ES modules, CSS custom properties

---

## 文件改动地图

| 文件 | 类型 | 改动内容 |
|------|------|---------|
| `server/claude.js` | Modify | `normalizeDjJson` 保留 `comment`；`ask()` 把 `comment` 随 queue 透传 |
| `prompts/dj-persona.md` | Modify | 重写人格、schema、示例 |
| `tests/claude.test.js` | Modify | 新增 2 个 `comment` 字段测试 |
| `pwa/views/player.js` | Modify | `send()` 重构气泡；`renderQueuePanel()` 加展开；新增 `escapeHtml` 工具函数 |
| `pwa/styles.css` | Modify | 队列条目展开样式；气泡点评列表样式 |
| `tests/player-send-queue.test.js` | Modify | 新增 1 个 comment 渲染测试 |

---

## Task 1：`parseDjJson` 保留 `comment` 字段

**Files:**
- Modify: `server/claude.js` — `normalizeDjJson` 函数（第 92-103 行）
- Modify: `tests/claude.test.js`

- [ ] **Step 1：写两个失败的测试**

在 `tests/claude.test.js` 末尾（第 63 行之前的 `});` 前）追加：

```javascript
  it('保留 play 里的 comment 字段', () => {
    const r = parseDjJson(JSON.stringify({
      say: '来了',
      play: [{ title: '蜉蝣', artist: '落日飞车', hint: '', comment: '给你今天慢热开场，city pop 节奏正好' }],
      reason: '', segue: '',
    }));
    expect(r.play[0].comment).toBe('给你今天慢热开场，city pop 节奏正好');
  });

  it('play 里没有 comment 时默认空字符串', () => {
    const r = parseDjJson(JSON.stringify({
      say: '来了',
      play: [{ title: '晴天', artist: '周杰伦' }],
      reason: '', segue: '',
    }));
    expect(r.play[0].comment).toBe('');
  });
```

- [ ] **Step 2：确认测试失败**

```bash
npx vitest run tests/claude.test.js
```

预期：2 个新测试失败，报 `Cannot read properties of undefined (reading 'comment')`

- [ ] **Step 3：更新 `normalizeDjJson`**

将 `server/claude.js` 第 92-103 行的 `normalizeDjJson` 改为：

```javascript
function normalizeDjJson(obj) {
  return {
    say: String(obj?.say ?? '').trim(),
    play: Array.isArray(obj?.play) ? obj.play.map(p => ({
      title:   String(p?.title   ?? '').trim(),
      artist:  String(p?.artist  ?? '').trim(),
      hint:    String(p?.hint    ?? '').trim(),
      comment: String(p?.comment ?? '').trim(),
    })).filter(p => p.title) : [],
    reason: String(obj?.reason ?? '').trim(),
    segue:  String(obj?.segue  ?? '').trim(),
  };
}
```

- [ ] **Step 4：确认测试全部通过**

```bash
npx vitest run tests/claude.test.js
```

预期：6 个测试全部 PASS

- [ ] **Step 5：提交**

```bash
git add server/claude.js tests/claude.test.js
git commit -m "feat: parseDjJson 保留每首歌的 comment 字段"
```

---

## Task 2：`ask()` 把 `comment` 透传给前端 queue

**Files:**
- Modify: `server/claude.js` — `ask()` 函数（第 154-193 行）

- [ ] **Step 1：更新 `ask()` 里的 resolved 映射逻辑**

将第 172-184 行的 resolved 处理改为（保持与原逻辑等价，仅加入 comment 透传）：

```javascript
  // 并发解析所有曲目（比串行快 3-4 倍）
  const resolved = await Promise.all(
    djJson.play.map(want => resolveTrack(want)),
  );
  const queue = resolved
    .map((track, i) => track ? { track, comment: djJson.play[i].comment || '' } : null)
    .filter(Boolean)
    .map(({ track, comment }) => ({
      title:    track.title,
      artist:   track.artist,
      album:    track.album,
      duration: track.duration,
      kugouId:  track.kugouId,
      audioUrl: `/api/proxy?u=${encodeURIComponent(track.upstreamUrl)}`,
      comment,
    }));
```

- [ ] **Step 2：运行相关测试确认无回归**

```bash
npx vitest run tests/claude.test.js tests/player-send-queue.test.js
```

预期：全部 PASS

- [ ] **Step 3：提交**

```bash
git add server/claude.js
git commit -m "feat: ask() 把 comment 字段随 queue 透传给前端"
```

---

## Task 3：重写 `prompts/dj-persona.md`

**Files:**
- Modify: `prompts/dj-persona.md`（完全重写）

- [ ] **Step 1：重写文件**

用以下内容替换整个 `prompts/dj-persona.md`：

```markdown
You are **Claudio** — a personal AI DJ for ONE specific listener.
You are NOT reading from a script. You are a seasoned music friend who has listened alongside this person for years — you know their taste, their moods, and what the current moment calls for.

## 人格核心

- 成熟稳重，不油腻，不卖弄——像一个真正懂音乐的老朋友，不是综艺主持人
- **每次开口都带入记忆**：主动引用最近播放历史或上一次对话，让用户感觉被记住了
  - 好："上回你听完那首之后就躺平了，今天再来一波同款"
  - 差："为您精心准备了今天的歌单"
- **`say` 字段长度看情境**：
  - 日常推歌、自动续播：1-2 句即可，简练有温度
  - 用户主动打招呼、特殊时间点（深夜/周末/节假日/长假第一天）：可以 3-5 句，说说状态、聊聊时间，再带入歌
  - 不要固定长度，写出来念着自然才对
- **每首歌写 `comment`**，说清楚为什么推这首：
  - 熟悉/常听的歌：一句就够，重点放"为什么是现在"
  - 冷门/小众/用户没听过的：两句，先说歌本身是什么，再说为什么适合
  - 不要写"这首歌很好听"——说没有人知道的那个理由

## Hard rules（违反任意一条都算失败）

1. **你的回复必须是、且仅是一个 JSON 对象**。JSON 之前 / 之后不能有任何文字、Markdown 包裹、解释。
2. JSON 必须严格匹配下面的 schema：

```json
{
  "say":   "字符串。给用户看的开场白，中文，自然口语，长度看情境（见上）。",
  "play":  [
    {
      "title":   "字符串。歌曲名，尽量用官方原名，繁/简哪种好搜用哪种。",
      "artist":  "字符串。艺人名，原名优先（英文歌别翻译成中文）。",
      "hint":    "字符串。可选。'live'/'录音室'/'原版'/'EP 版' 之类的备注，帮匹配。",
      "comment": "字符串。这首歌的推荐理由，写给用户看。熟悉的歌一句，陌生的歌两句带背景。"
    }
  ],
  "reason": "字符串。这次推荐的总体逻辑，1-2 句，debug 用，用户也能看。",
  "segue":  "字符串。承接下一首的串场词，10-20 字中文短句；若 play 只有一首或没有自然下一首，可空字符串。"
}
```

3. `play` 长度 1-5 首。除非用户**明确**说"放一首""就一首""一首就够"，否则给 **3-5 首**。
4. **不要瞎编**。如果不确定某首歌真实存在，宁可不推。已知冷门 / 小众的歌可以推，但要写对名字。
5. 同一次 `play` 里**不要连放同一个艺人 3 首以上**。
6. 用户偏好以 `taste.md` 为最高优先级；但当下输入与 taste 冲突时，**尊重当下输入**（人是会变的）。
7. 如果用户没说想听什么，参考"当前时间 + routines.md + 最近播放历史"，主动决定一个氛围。

## 示例（新风格）

**用户**："来点雨天聆听的"

```json
{
  "say": "雨天嘛，节奏就慢下来——上次你听完老王那首之后好像就直接睡了，今天再挑几首同款氛围。",
  "play": [
    {
      "title": "我还年轻 我还年轻", "artist": "老王乐队", "hint": "录音室版",
      "comment": "你常听的那首，雨天必备，吉他和人声恰好有点潮湿的质感。"
    },
    {
      "title": "Raindrops Keep Fallin' on My Head", "artist": "B.J. Thomas",
      "comment": "1969 年《虎豹小霸王》插曲，旋律有种跟雨天和解的轻盈感，不沉。"
    },
    {
      "title": "雨", "artist": "孙燕姿",
      "comment": "编曲很克制，撑伞走路时听刚好，不会跟雨声抢戏。"
    },
    {
      "title": "Listen to the Rain", "artist": "Evanescence",
      "comment": "如果你今天雨天情绪更偏沉一点，这首把那种重量接住了。"
    }
  ],
  "reason": "用户提雨天，taste 偏 indie + soul，节奏选 mid-slow，兼顾轻盈和沉静两种雨天情绪。",
  "segue": "先温柔，后面给你加一点重量。"
}
```

**用户**："早安"（周一早上 8 点）

```json
{
  "say": "周一，早。不强迫你立刻清醒——先放几首慢热的，让你自己找到节奏。",
  "play": [
    {
      "title": "Morning", "artist": "Beck",
      "comment": "Beck 罕见的温柔面，开头那段吉他像窗帘慢慢拉开。"
    },
    {
      "title": "蜉蝣", "artist": "落日飞车",
      "comment": "你 taste 里有落日飞车，这首 city pop 节奏不快不慢，上午听很对。"
    },
    {
      "title": "Banana Pancakes", "artist": "Jack Johnson",
      "comment": "周一如果能懒一点就懒一点，这首是那种情绪的配乐。"
    }
  ],
  "reason": "周一清晨，不要太吵，符合 routines.md 工作日 07:30 起床 + taste 喜欢 city pop / indie。",
  "segue": "慢慢来，不急。"
}
```

**用户**："放周杰伦的晴天"

```json
{
  "say": "好。",
  "play": [{"title": "晴天", "artist": "周杰伦", "hint": "叶惠美专辑", "comment": ""}],
  "reason": "用户明确指定单曲。",
  "segue": ""
}
```

## 当你真的没主意

仍然要出 JSON。`say` 里坦白说"我没把准你今天的脉，先随便挑几首近期你听过的"，`play` 留空，让后端从 `state.db.plays` 兜底。**绝不**输出空 JSON 之外的东西。
```

- [ ] **Step 2：提交**

```bash
git add prompts/dj-persona.md
git commit -m "feat: 重写 dj-persona 为成熟电台主持人风格，加入逐首 comment"
```

---

## Task 4：CSS — 队列展开 + 气泡点评列表

**Files:**
- Modify: `pwa/styles.css`

- [ ] **Step 1：修改 `.queue-list li` 相关样式**

找到 `pwa/styles.css` 第 451-470 行（`.queue-list li` 块），**替换**为以下内容：

```css
.queue-list li {
  padding: 5px 6px;
  border-radius: 4px;
  font-size: 12px;
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  color: rgba(232, 232, 234, 0.55);
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.queue-list li .track-row {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
}
.queue-list li .track-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.queue-list li .track-expand-btn {
  flex-shrink: 0;
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  padding: 0 3px;
  font-size: 10px;
  opacity: 0.4;
  line-height: 1;
}
.queue-list li .track-expand-btn:hover { opacity: 0.9; }
.queue-list li .track-comment {
  display: none;
  margin-top: 3px;
  font-size: 11px;
  color: var(--muted);
  white-space: pre-wrap;
  line-height: 1.4;
  font-family: inherit;
}
.queue-list li.expanded .track-comment { display: block; }
.queue-list li:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text);
}
.queue-list li.active {
  color: var(--theme-accent);
}
```

- [ ] **Step 2：在 `.bubble .meta` 样式块后追加气泡点评列表样式**

找到 `pwa/styles.css` 第 521-522 行：
```css
.bubble .meta { color: var(--muted); font-size: 11px; margin-top: 6px; }
.bubble .meta ol { margin: 4px 0 0 18px; padding: 0; }
```

**替换**为：

```css
.bubble .meta { color: var(--muted); font-size: 11px; margin-top: 6px; }
.bubble .meta ol { margin: 4px 0 0 18px; padding: 0; }
.bubble .meta .track-list { margin: 6px 0 0; padding: 0; list-style: none; }
.bubble .meta .track-list li { padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
.bubble .meta .track-list li:last-child { border-bottom: none; }
.bubble .meta .track-list .track-name { display: block; font-weight: 500; color: var(--text); }
.bubble .meta .track-list .track-comment { display: block; margin-top: 2px; color: var(--muted); line-height: 1.4; }
```

- [ ] **Step 3：提交**

```bash
git add pwa/styles.css
git commit -m "feat: 新增队列展开样式与气泡点评列表样式"
```

---

## Task 5：`send()` 重构气泡为 say + 逐首 comment 列表

**Files:**
- Modify: `pwa/views/player.js` — `send()` 函数（第 321-367 行）
- Modify: `tests/player-send-queue.test.js`

- [ ] **Step 1：写失败的测试**

在 `tests/player-send-queue.test.js` 末尾追加：

```javascript
  it('聊天气泡为每首有 comment 的歌渲染 track-comment', () => {
    // send() 生成的 metaHtml 必须包含 track-list 和 q.comment 的引用
    expect(sendFnBody).toContain('track-list');
    expect(sendFnBody).toMatch(/q\.comment/);
  });
```

- [ ] **Step 2：确认测试失败**

```bash
npx vitest run tests/player-send-queue.test.js
```

预期：新测试失败

- [ ] **Step 3：在 `player.js` 顶部添加 `escapeHtml` 工具函数**

在 `player.js` 第 6 行（`const $ = ...` 之前）添加：

```javascript
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
```

- [ ] **Step 4：重构 `send()` 中的气泡生成逻辑**

找到 `send()` 函数里第 338-347 行：

```javascript
    const songItems = (data.queue || []).filter(q => !q.isTts);
    let metaHtml = '';
    if (songItems.length) {
      const list = songItems.map(q => `<li>${q.title} — ${q.artist}</li>`).join('');
      metaHtml += `<ol>${list}</ol>`;
    }
    if (data.reason) metaHtml += `<div>${data.reason}</div>`;

    addBubble('assistant', data.say || '(无回应)', metaHtml || null);
```

**替换**为：

```javascript
    const songItems = (data.queue || []).filter(q => !q.isTts);
    let metaHtml = '';
    if (songItems.length) {
      const items = songItems.map(q => {
        const name = `<span class="track-name">${escapeHtml(q.title)} — ${escapeHtml(q.artist)}</span>`;
        const cmt  = q.comment
          ? `<span class="track-comment">${escapeHtml(q.comment)}</span>`
          : '';
        return `<li>${name}${cmt}</li>`;
      }).join('');
      metaHtml += `<ol class="track-list">${items}</ol>`;
    }

    addBubble('assistant', data.say || '(无回应)', metaHtml || null);
```

- [ ] **Step 5：确认测试全部通过**

```bash
npx vitest run tests/player-send-queue.test.js
```

预期：3 个测试全部 PASS

- [ ] **Step 6：提交**

```bash
git add pwa/views/player.js tests/player-send-queue.test.js
git commit -m "feat: 聊天气泡显示逐首 comment 点评列表"
```

---

## Task 6：`renderQueuePanel()` 加点击展开 comment

**Files:**
- Modify: `pwa/views/player.js` — `renderQueuePanel()` 函数（第 270-293 行）

- [ ] **Step 1：重构 `renderQueuePanel()`**

找到 `renderQueuePanel()` 里第 278-292 行：

```javascript
  queueList.innerHTML = state.queue.map((t, i) => {
    const active = i === state.index;
    const label = `${t.title} — ${t.artist}`;
    return `<li class="${active ? 'active' : ''}" data-idx="${i}">${active ? '▶ ' : ''}${label}</li>`;
  }).join('');
  queueList.classList.remove('hidden');
  if (dialogText) dialogText.classList.add('hidden');
  const activeEl = queueList.querySelector('li.active');
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
  queueList.querySelectorAll('li[data-idx]').forEach(li => {
    li.addEventListener('click', () => {
      markActivated();
      playIndex(Number(li.dataset.idx));
    });
  });
```

**替换**为：

```javascript
  queueList.innerHTML = state.queue.map((t, i) => {
    const active = i === state.index;
    const prefix = active ? '▶ ' : '';
    const label = `<span class="track-label">${prefix}${escapeHtml(t.title)} — ${escapeHtml(t.artist)}</span>`;
    const infoBtn = t.comment
      ? `<button class="track-expand-btn" aria-label="查看推荐理由" data-expand="${i}">ℹ</button>`
      : '';
    const comment = t.comment
      ? `<div class="track-comment">${escapeHtml(t.comment)}</div>`
      : '';
    return `<li class="${active ? 'active' : ''}" data-idx="${i}"><div class="track-row">${label}${infoBtn}</div>${comment}</li>`;
  }).join('');
  queueList.classList.remove('hidden');
  if (dialogText) dialogText.classList.add('hidden');
  const activeEl = queueList.querySelector('li.active');
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
  queueList.querySelectorAll('li[data-idx]').forEach(li => {
    li.addEventListener('click', e => {
      if (e.target.closest('[data-expand]')) {
        li.classList.toggle('expanded');
        return;
      }
      markActivated();
      playIndex(Number(li.dataset.idx));
    });
  });
```

- [ ] **Step 2：运行全量测试确认无回归**

```bash
npx vitest run
```

预期：全部通过

- [ ] **Step 3：提交**

```bash
git add pwa/views/player.js
git commit -m "feat: 播放队列每首歌支持点击 ℹ 展开推荐理由"
```

---

## 验收清单

- [ ] `npx vitest run` 全部通过
- [ ] 启动服务，发一条消息，聊天气泡显示 `say` 开场白 + 每首歌的 `comment`
- [ ] 播放队列里有 `comment` 的歌显示 `ℹ` 按钮，点击展开/收起
- [ ] 点击歌曲名仍然正常播放（不触发展开）
- [ ] 没有 `comment` 的歌（明确指定单曲）不显示 `ℹ` 按钮
- [ ] 自动续播（`autoRecommend`）生成的歌也带 `comment`（因为 `ask()` 已透传）
