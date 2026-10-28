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
- `fix: correct google-calendar mock path in context.test.js` — tests/context.test.js
- `feat: add journal service (signal detection + auto-append)` — server/services/journal.js, tests/journal.test.js
- `fix: detect loop signal for any song, not just first in playlist` — server/services/journal.js, tests/journal.test.js
- `fix: wrap writeFileSync in try/catch to match read's silent-fail contract` — server/services/journal.js
- `feat: auto-append journal entries after each Claude response` — server/app.js
- `fix: stabilize player loop and auto recommendations` — pwa/index.html, pwa/views/player.js, tests/player-auto-advance.test.js

## 2026-10-25
- `feat: 给外部 bot 开放点歌，并加上接口鉴权与出站代理` — .env.example, .gitignore, README.md, pwa/app.js, pwa/external-playback.js, pwa/sw.js, pwa/views/player.js, scripts/dev.js, server/api/external-queue.js, server/api/health.js, server/api/kugou-relogin.js, server/app.js, server/auth.js, server/db.js, server/listen.js, server/music/kugou-share-url.js, server/outbound-proxy.js, server/services/kugou-login.js, server/services/kugou-playlist-write.js, server/services/kugou.js, tests/auth.test.js, tests/dev-script.test.js, tests/external-playback.test.js, tests/external-queue.test.js, tests/kugou-playlist-write.test.js, tests/kugou-share-url.test.js, tests/kugou.test.js, tests/listen-host.test.js, tests/outbound-proxy.test.js, tests/plays-source.test.js
- `feat: 回环也可要求令牌，并校验 Host 防 DNS 重绑定` — .env.example, README.md, pwa/app.js, pwa/session-url.js, pwa/sw.js, server/app.js, server/auth.js, server/host-guard.js, server/session.js, tests/auth.test.js, tests/host-guard.test.js, tests/session-url.test.js, tests/session.test.js
- `refactor: 默认把 Claudio 做成纯播放器，选歌交给外部 bot` — .env.example, README.md, pwa/app.js, pwa/boot-playback.js, pwa/index.html, pwa/player-mode.js, pwa/runtime-sync.js, pwa/styles.css, pwa/views/player.js, server/api/boot.js, server/api/chat.js, server/api/control.js, server/api/external-queue.js, server/api/playlists.js, server/api/plays.js, server/api/search.js, server/app.js, server/brain.js, server/db.js, server/playback-control.js, server/queue-source.js, server/scheduler.js, tests/boot-api.test.js, tests/brain.test.js, tests/chat-brain.test.js, tests/control-api.test.js, tests/external-queue.test.js, tests/player-mode.test.js, tests/plays-api.test.js, tests/scheduler.test.js, tests/search-api.test.js
- `fix: 记住播放音量，默认 30` — .env.example, README.md, pwa/index.html, pwa/sw.js, pwa/views/player.js, pwa/volume-memory.js, server/api/chat.js, server/api/control.js, server/api/external-queue.js, server/app.js, server/playback-control.js, server/volume-store.js, tests/chat-brain.test.js, tests/control-api.test.js, tests/external-queue.test.js, tests/session-url.test.js, tests/volume-memory.test.js, tests/volume-store.test.js
- `fix: 直接开声，并停下播完重播的回声循环` — README.md, pwa/app.js, pwa/client-id.js, pwa/external-playback.js, pwa/player-mode.js, pwa/runtime-sync.js, pwa/sw.js, pwa/views/player.js, server/app.js, server/runtime-events.js, tests/external-playback.test.js, tests/player-mode.test.js, tests/replay-echo.test.js, tests/session-url.test.js
- `feat: 按银色晴天稿重做播放页` — README.md, pwa/app.js, pwa/index.html, pwa/styles.css, pwa/sw.js, pwa/views/player.js, server/api/external-queue.js, server/api/weather.js, server/app.js, server/playback-control.js, server/services/kugou.js, tests/control-api.test.js, tests/external-queue.test.js, tests/kugou.test.js, tests/player-console-controls.test.js, tests/session-url.test.js, tests/weather-route.test.js
- `fix: 播放页能进歌单和设置，并截断过长的点歌字段` — README.md, pwa/app.js, pwa/index.html, pwa/styles.css, server/api/external-queue.js, tests/external-queue.test.js, tests/player-console-controls.test.js
- `feat: 媒体键和 Ctrl+Alt+P 都能暂停或继续播放` — README.md, pwa/app.js, pwa/media-session.js, pwa/sw.js, scripts/claudio-hotkey.ps1, server/api/chat.js, server/playback-control.js, server/router.js, tests/control-api.test.js, tests/hotkey-script.test.js, tests/media-session.test.js, tests/router.test.js, tests/session-url.test.js
- `fix: 队列放完后再按一次就从第一首重新播放` — README.md, pwa/media-session.js, server/playback-control.js, tests/control-api.test.js, tests/media-session.test.js

## 2026-10-27
- `merge main (#16) into silver-player; sw v11` — README.md, docs/devlog.md, pwa/app.js, pwa/media-session.js, pwa/sw.js, scripts/claudio-hotkey.ps1, server/api/chat.js, server/playback-control.js, server/router.js, tests/control-api.test.js, tests/dev-script.test.js, tests/hotkey-script.test.js, tests/media-session.test.js, tests/router.test.js, tests/session-url.test.js
- `feat: 用常驻全局热键即时切换播放，并检测快捷键冲突` — README.md, docs/devlog.md, scripts/claudio-hotkey-listener.ps1, scripts/claudio-hotkey.ps1, tests/hotkey-script.test.js
  - PR #18 修正：重复安装保留同一自有热键，其他 1409 冲突不写快捷方式；默认只用监听器，文档补齐互斥切换和清除绑定命令。

## 2026-10-28
- `feat: 打磨 Grokbot 主持的暗色个人电台` — docs/superpowers/plans/2026-10-27-radio-ui-polish.md, pwa/components/lyrics.js, pwa/icon.svg, pwa/index.html, pwa/manifest.json, pwa/styles.css, pwa/sw.js, pwa/views/player.js, pwa/views/settings.js, scripts/verify-radio-ui.mjs, tests/lyrics.test.js, tests/media-session.test.js, tests/player-auto-advance.test.js, tests/player-console-controls.test.js, tests/player-motion.test.js, tests/pwa-safe-dom.test.js, tests/radio-ui.test.js, tests/session-url.test.js
- `docs: 同步电台界面用法与验收范围` — README.md, docs/devlog.md, docs/superpowers/plans/2026-10-27-radio-ui-polish.md
