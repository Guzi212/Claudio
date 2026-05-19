# Worktree TASK · feat/lyrics-env-strip

> 这是 git worktree 的一个分支视图。同时还有：
> - `feat/settings-api`：提供 `GET /api/lyric?hash=<file_hash>` 和环境健康端点
> - `feat/three-views`：在 Player 视图里**已经留好两个占位 div**，你只需要填它们
>   - `<div id="env-strip" class="env-strip hidden">` — 你的环境信息条
>   - `<div id="lyrics-panel" class="lyrics-panel hidden">` — 你的歌词面板
>
> 这意味着：**你不要重写 index.html 的整体布局，不要动 tab 系统**。
> 你只能改 pwa/styles.css 里这两个 class 的内部样式 + 写两个独立的 pwa 模块文件来塞内容。

## 任务

### 1. 环境信息条 · `pwa/components/env-strip.js`（新文件）

显示三件信息，紧凑一行（不要占太高）：

```
🌤  Shanghai 22℃ 多云  ·  📅 今日：15:00 产品评审 · 18:30 健身  ·  ⏰ 周一 上午
```

数据来源：现在没有专门的 PWA-facing 环境数据 API。**简单做法**：把这部分放到 `/api/now` 响应里 —— 但那是 W1 的活，**你不能改后端**。

退而求其次：
- **option A**：每 60 秒 fetch `/api/health/integrations` 顺便附加显示几个状态（如果 weather/lark 可用，调用 PWA 里你自己写的格式化逻辑展示"已接入"占位）
- **option B（推荐）**：写一个 `GET /api/env` 占位 endpoint **的客户端调用**，先 catch 404 兜底 —— 等后端有人加（不阻塞你），你的代码会自动开始工作

实际上现在你**可以**简单地：把 `/api/now` 的 `runtime.lastSay` 之类的不展示，**专心做歌词组件**；env-strip 退化为静态显示：

```
⏰ 周一 上午 · Claudio
```

只显示客户端能算的（new Date()）。等后端有 /api/env 时再升级。**这个组件保持简单，占位即可**。

### 2. 歌词面板 · `pwa/components/lyrics.js`（新文件）

这是这个分支的真正主角。

**功能：**
- 当 now-playing 切到一首新歌时：用 `runtime.queue[index].kugouId` fetch `/api/lyric?hash=<id>`
- 服务器返 `{ lyric: 'LRC 文本' }` 或 `{ lyric: null }`
- LRC 文本格式：每行 `[mm:ss.xx]歌词内容`，可能多行同时间戳，或元数据行 `[ti:歌名]`
- 解析为 `[{ time: 秒, text: '歌词' }, ...]`，按 time 排序
- 渲染到 `#lyrics-panel`：所有行竖排显示
- 监听 `audio.timeupdate`，找到当前 time 对应的行，**高亮 + 平滑滚动到中间**
- 当前歌没歌词或 lyric=null：面板隐藏（.hidden）
- TTS 串场条（isTts:true）不取歌词，面板也隐藏

**布局参考：**
```
┌─ lyrics-panel ───────────────────────────┐
│  歌词第一行（暗色）                       │
│  歌词第二行（暗色）                       │
│  ▶ 歌词第三行（高亮，当前）★ 居中            │
│  歌词第四行（暗色）                       │
│  歌词第五行（暗色）                       │
└──────────────────────────────────────────┘
```

CSS 用 flexbox 或固定高度 + overflow-hidden + 中线绝对定位实现"当前行居中"。

**触发时机：**
- 监听 audio 元素的 `loadedmetadata` 事件 → 拉新歌词
- 监听 `timeupdate` → 更新高亮（注意节流，每秒最多刷一次）

**对接 W2 的方式：**
- 你的 `lyrics.js` 在 import 时不要立刻执行；export 一个 `init({ audio, container, getCurrentTrack })` 函数
- W2 的 `views/player.js` 会在初始化时 import 你的模块并调 init
- 如果 W2 还没把 player.js 拆出来（直接放 app.js），就在 boot() 里 import + 调 init

为了不绑死 W2 的代码组织方式，给 init 函数加一个回退：在 DOMContentLoaded 时如果发现 `window.__claudioInit` 没注册你，**自动 attach 自己到 #lyrics-panel + 找到 #audio**。这样无论 W2 怎么组织都能跑起来。

### 3. LRC 解析器（拆出来便于测试）

```js
// pwa/components/lyrics.js 里 export 一个纯函数
export function parseLRC(text) {
  // 返回 [{ time: number_seconds, text: string }]
  // 跳过元数据行 [ti:] [ar:] [al:] [by:] [offset:]
  // 同一行多个时间戳要拆成多条
  // 排序按 time 升序
}
```

写一个 `tests/lyrics.test.js`，5-8 个用例覆盖：标准格式、多时间戳、元数据跳过、空文本、非法格式。

## 触碰的文件

允许：
- 新建 `pwa/components/lyrics.js`
- 新建 `pwa/components/env-strip.js`
- 修改 `pwa/styles.css`（只加这两个组件的样式 · 不动既有规则）
- 修改 `pwa/sw.js`（把两个新 js 文件加进 SHELL 数组）
- 新建 `tests/lyrics.test.js`

禁止：
- `pwa/index.html`（W2 的活，里面已经为你留好了占位 div）
- `pwa/app.js`（W2 在大改，你别动）
- server/ 任何文件
- `pwa/views/*`（W2 的活，如果它建了的话）

## 验收

- [ ] 当 Claude 推荐了能匹配上的歌 → 切到第一首 → 歌词出现，当前行随时间高亮
- [ ] 没歌词的歌 → 面板隐藏
- [ ] TTS 串场（isTts:true）不拉歌词
- [ ] `tests/lyrics.test.js` 覆盖 LRC parser 边角，全绿
- [ ] env-strip 至少显示"⏰ 时间段"，未来后端有 /api/env 时自动升级

## 起手

```powershell
Set-Location "D:\Claude code\works\Claudio-lyrics"
npm install
```

完工后：`git add -A && git commit -m "feat: lyrics + env-strip · Player 视图增量组件"`，等三路 merge。
