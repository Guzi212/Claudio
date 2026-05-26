# 开发日志

## 2026-05-22
- `feat: DeepSeek 支持 · health 实时检测 · 酷狗重登录 UX 改进` — .env.example, CLAUDE.md, pwa/views/settings.js, server/api/health.js, server/api/kugou-relogin.js, server/claude.js, server/services/settings.js, tests/health.test.js, tests/settings-api.test.js, tests/settings.test.js
- `fix: 歌词冷启动触发 + 滚动边界修复` — pwa/views/player.js
- `fix: 歌词面板改为固定高度以启用内部滚动` — pwa/styles.css

## 2026-05-25
- `feat: 新增队列展开样式与气泡点评列表样式` — pwa/styles.css
- `feat: 重写 dj-persona 为成熟电台主持人风格，加入逐首 comment` — prompts/dj-persona.md
- `fix: ask() comment 默认值改用 ?? 与 normalizeDjJson 保持一致` — server/claude.js
- `feat: ask() 把 comment 字段随 queue 透传给前端` — server/claude.js
- `feat: parseDjJson 保留每首歌的 comment 字段` — server/claude.js, tests/claude.test.js
- `feat: 聊天气泡显示逐首 comment 点评列表` — pwa/views/player.js, tests/player-send-queue.test.js
- `feat: 播放队列每首歌支持点击 ℹ 展开推荐理由` — pwa/views/player.js
- `feat: 队列耗尽时自动向 Claude 请求下一批推荐` — pwa/views/player.js
- `ci: 新增多会话工作流规则与 GitHub Actions CI` — .github/workflows/ci.yml, CLAUDE.md
- `docs: 调整 merge 流程（私有仓库不支持 auto-merge）` — CLAUDE.md
- `fix: stabilize CL flow and Kugou relogin` — .claude/agents/kugou-debug.md, .claude/hooks/block-env-write.sh, .claude/hooks/run-related-tests.sh, .claude/settings.json, .claude/skills/claudio-pr/SKILL.md, .githooks/post-commit, .gitignore, docs/competition/project-plan.md, docs/competition/project-summary.md, docs/devlog.md, docs/superpowers/plans/2026-05-25-dj-mature-host.md, docs/superpowers/plans/2026-05-25-multi-session-git-workflow.md, package.json, pwa/index.html, pwa/styles.css, pwa/views/player.js, pwa/views/settings.js, server/api/kugou-relogin.js

## 2026-05-26
- `chore: sync routines from Google Calendar (2026-04-01 to 06-30)` — user/routines.md
- `feat: add Claudio identity file (性格底色)` — claudio/identity.md
- `feat: add Claudio journal file (关系史骨架)` — claudio/journal.md
- `feat: inject Claudio identity + journal into system prompt` — server/context.js, tests/context.test.js
- `feat: add journal service (signal detection + auto-append)` — server/services/journal.js, tests/journal.test.js
- `fix: detect loop signal for any song, not just first in playlist` — server/services/journal.js, tests/journal.test.js
- `fix: wrap writeFileSync in try/catch to match read's silent-fail contract` — server/services/journal.js
