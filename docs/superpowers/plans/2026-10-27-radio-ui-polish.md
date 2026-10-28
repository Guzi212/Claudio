# Claudio 夜间广播台 UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留真实播放能力的前提下，把 Claudio 打磨成由 Grokbot 主持的舒适暗色个人电台，并统一歌单、品味与设置页面。

**Architecture:** 保持原生 HTML、CSS 和 ES modules，不重写 `pwa/views/player.js` 的播放状态机或 `media-session.js`。保留现有 DOM 契约，以共享视觉 token、重组播放页结构、Grokbot SVG 和轻量状态动画完成小范围重构。在 Chrome 中加载真实 PWA 模块，使用隔离的模拟 API、WebSocket 和本地合成音频验收交互；另用真实应用服务做启动与首页 HTTP 检查。酷狗上游和真实账号播放不属于本次沙盒验收证据。

**Tech Stack:** HTML、CSS、原生 JavaScript、Vitest、Node.js、本机 Chrome CDP；无新运行时依赖。

**Spec:** 用户 2026-10-27 的 `/goal` 指令；项目 `CLAUDE.md`、`README.md`。

## Global Constraints

- 在 `feat/radio-ui-polish` 独立 worktree 开发，从 `origin/main@7e44b9b` 出发，不碰主工作区未提交文件。
- 维持 external / internal、播放控制、进度、音量记忆、反馈、队列点击、歌词、媒体键与快捷键行为。
- 石墨暗色为主，湛蓝仅用于信号、焦点和少量主操作；原创 Grokbot 头像，不复制官方商标，不引入新框架。
- 不添加解释性副标题；保留必要表单提示、错误信息和动态主持人口播。
- 中文系统字体，320px 起无横向溢出，支持键盘焦点和 `prefers-reduced-motion`。
- 不修改、合并有冲突的旧 PR #6 / #8，不处理其依赖 PR #7。

## Review Focus

- 长歌名、长主持人口播及空队列不能挤压控制按钮或产生横向溢出。
- 暂停时声波必须静止，播放中恢复，减少动态偏好下始终静止。
- 所有主要视图均可从导航到达，external 不显示聊天与自动推歌，internal 不丢失对应功能。
- 无封面、封面加载失败与移动端长队列均有完整降级展示。
- 设置中的密钥输入不改 `type`、值与请求契约；新视觉不增加 HTML 字符串注入路径。

---

### Task 1: 界面契约与播放状态测试

**Files:**
- Modify: `tests/player-console-controls.test.js`
- Create: `tests/player-motion.test.js`
- Test: `tests/player-console-controls.test.js`, `tests/player-motion.test.js`

**Interfaces:**
- Consumes: 现有 `#now-playing`、`#host-line`、`#queue-list`、`data-console-control`、`data-feedback`、`data-view`。
- Produces: `#grokbot-avatar`、`#host-speaking`、`body.is-playing`、完整 `.tab` 导航的 DOM / 状态契约。

- [x] 添加失败测试：Grokbot 身份与原创头像、四个导航、唯一 `#view-playlists`、非装饰性播放器控件、暂停 / 播放 body 状态同步。
- [x] 运行 `corepack pnpm vitest run tests/player-console-controls.test.js tests/player-motion.test.js`，确认因功能尚未实现而失败。
- [x] 实现对应 DOM 与播放状态最小改动，不引入另一套播放控制。
- [x] 重跑聚焦测试，通过后再跑全套测试。
- [x] 经用户既定项目交付流程提交本任务相关文件。

### Task 2: 夜间广播台与响应式视觉

**Files:**
- Modify: `pwa/index.html`, `pwa/styles.css`, `pwa/manifest.json`, `pwa/icon.svg`, `pwa/sw.js`
- Modify: `pwa/views/player.js`
- Create: `tests/radio-ui.test.js`

**Interfaces:**
- Consumes: Task 1 DOM / 播放状态契约。
- Produces: 共享颜色 / 间距 / 字体 / 焦点 token，Grokbot 主持区、封面 + 歌曲舞台、接下来队列、统一辅助视图、歌词容器。

- [x] 先添加失败测试：token、Grokbot 品牌、播放 / 空状态 / 歌词布局、响应式与 reduced-motion 规则、离线壳资源列表。
- [x] 聚焦运行并确认失败原因准确。
- [x] 以 `#0b0d12` 背景、`#151922` 抬升面、`#edf0f5` 正文、`#949dad` 次级文字、`#78bfff` 信号蓝建立样式；封面是唯一强视觉元素。
- [x] 桌面：顶部品牌与导航 → Grokbot 口播 → 左封面 / 右播放信息 → 接下来 → 安静页脚。手机：紧凑导航、上下舞台、纵列待播、44px 可点区域。
- [x] 清理重复 Playlists 区段，补齐 Profile 导航；内部模式聊天与歌词使用明确容器，并维持 external 隐藏规则。
- [x] 修正后台旧波形等遗留样式，不添加持续装饰性粒子、扫光或页面级滚动驱动动画。
- [x] 聚焦测试和全套测试通过，检查 `git diff --check`。

### Task 3: 浏览器视觉与真实交互验收

**Files:**
- Create: `scripts/verify-radio-ui.mjs`（仅开发验收脚本，不进入线上运行路径）
- Modify: 仅根据验收结果修复 Task 1 / 2 文件。

**Interfaces:**
- Consumes: `POST /api/queue/external`、`POST /api/control`、`GET /api/now` 与静态 PWA。
- Produces: 1280×900、1440×900、390×844、320×760 截图，播放 / 导航 / 反馈 / 队列 / 音量 / 空状态及无横向溢出结果。

- [x] 用进程级临时用户目录启动独立端口服务，不读取、打印或改动现有敏感配置和真实 `state.db`。
- [x] 用合成曲目和本地生成的封面数据驱动界面，不访问外部音乐服务、不发送真实个人数据。
- [x] 在 Chrome CDP 中检查桌面与移动端、播放 / 暂停 / 空状态、长文本、队列点击、喜欢 / 不喜欢互斥、导航、进度、音量记忆和键盘焦点。
- [x] 实际查看截图并修正布局层级、可读性、裁切和过强装饰；重复验证。
- [x] 运行最终全套测试与 JS 语法检查，记录已验证和未验证项。

### Task 4: 独立审查与交付

**Files:**
- Review: 本分支全部改动。
- Modify: 仅修复审查确认的问题。

- [x] 请求独立 reviewer 检查播放契约、XSS、响应式和无关改动。
- [x] 修复确认问题并重跑相关测试。
- [ ] 按项目工作流测试、push、创建 PR；CI 绿后 merge。遇到冲突则停止自动处理并通知用户。
- [ ] 交付 worktree、分支、PR、改动摘要、验证结果与剩余风险；未经进一步授权不清理 worktree。
