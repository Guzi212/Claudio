# Claudio · 交接文档

## 当前状态（MVP 已跑通）

- ✅ PWA chat → Claude 子进程 → 酷狗匹配 → MP3 直链 → 浏览器播放，整条端到端验证通过
- ✅ 扫码登录拿到 cookie，落 `state.db.prefs.kugou_cookie`（重启免登）
- ✅ `npm test` 全绿（16/16）
- 🟢 服务还在跑：Claudio :8080，KuGouMusicApi :3000（重启电脑会丢，明天按下面命令重起）

## 明天怎么继续

```powershell
# 1) 起 KuGouMusicApi（cookie 已在 Claudio 的 state.db 里，不用再扫码）
Set-Location "D:\Claude code\works\KuGouMusicApi"
npm start                     # 监听 :3000，前台

# 另开窗口
# 2) 起 Claudio
Set-Location "D:\Claude code\works\Claudio"
npm run dev                   # 监听 :8080，前台

# 3) 浏览器
Start-Process "http://localhost:8080/"
```

如果 cookie 过期（看启动日志没有 `[kugou-login] OK`）：用 `D:\Claude code\works\KuGouMusicApi\stdout.log` 那条 `/login/qr/key` → `/login/qr/check` 流程重扫一次，再调 `dbApi.setPref('kugou_cookie', ...)` 写回。

## 今天踩过的 5 个坑（已修，别再踩）

1. **better-sqlite3 在 Win 上需要 VS C++ 工具链** → 切到 Node 22.5+ 内置 `node:sqlite`，用 `createRequire` 绕过 Vite 静态分析
2. **Vitest 默认 threads 池** 会撞 sqlite 锁 → `pool: 'forks' + fileParallelism: false`
3. **`services/kugou.js` 的 `songUrl`** 短路顺序错（数组 truthy 直接返回）→ 抽 `firstUrl` helper
4. **酷狗 search 实际字段是 `OriSongName` + `FileName`**，不是 `SongName`
5. **claude CLI 在新版安装是 `.exe` 不是 `.cmd`** → spawn 第一参用裸 `claude`，靠 `shell:true` 解析 PATH

## 下一步路线（按优先级）

### P0 · 完善 MVP 体验
- [ ] **/api/proxy 偶发 super timeout**：长跑时第一首中断 → 排查 axios stream 是否需要更长 timeout / 重连
- [ ] **runtime.queue 切歌不同步**：浏览器 audio.ended 调了 `/api/runtime/advance`，但服务端 index 跟前端不一致时会错位 → 改成前端推完整 `{queue, index}` 而不是只发 advance
- [ ] **首次 chat autoplay 被浏览器拦**：加一个"开始聆听"按钮先消费一个用户手势，再启动队列
- [ ] **PWA icons**：`manifest.json` 的 `icons:[]` 空着，能装但桌面图标丑

### P1 · 还原施工图被砍的模块
- [ ] **`server/scheduler.js`**：cron · 07:00 规划 / 09:00 早间 / 小时情绪检查 / 日历 hook（用 node-cron）
- [ ] **`server/tts.js` + Fish Audio**：合成 `say` 串场 → `cache/tts/<hash>.mp3` → 队列里插语音条
- [ ] **天气注入**：`context.js` 第 3 片接 OpenWeather，按用户所在城市
- [ ] **飞书日历**：context 第 3 片接 lark API 读今日日程（lark-cli skills 都已装好可调）

### P2 · 客厅扩展
- [ ] **UPnP 推 Naim**：用 node-upnp 在 PWA `<audio>` 旁边并存输出 adapter
- [ ] **多设备同步**：state.db 加 device_id，WS 区分 client

### P3 · 体验打磨
- [ ] PWA 三视图（Player / Profile / Settings）目前只有 Player
- [ ] Settings 视图：编辑 taste.md / 看 unmatched 表 / 重扫码
- [ ] 歌词显示（`/lyric?hash=...` 接口已就绪，前端没接）

## 关键文件 / 路径

| 位置 | 内容 |
|---|---|
| `D:\Claude code\works\Claudio\` | 项目主体 |
| `D:\Claude code\works\KuGouMusicApi\` | 上游酷狗 API 服务（独立跑） |
| `state.db` | SQLite 持久化：messages / plays / prefs / unmatched |
| `user/taste.md` | **空模板·明天填一填，Claude 推荐才能真的个性化** |
| `user/routines.md` | 同上 |
| `prompts/dj-persona.md` | DJ 人格 + JSON 输出硬约束 |
| `C:\Users\13479\.claude\plans\claudio-...goose.md` | 原始 plan 文档（完整设计） |
| `C:\Users\13479\.claude\projects\D--Claude-code-works-Claudio\memory\` | 跨会话记忆（user_profile / project_claudio） |

## 给明天的 Claude 的提示

读这份 + plan 文件 + `memory/` 就有完整 context。**架构忠实施工图分层**是用户的硬约束（他想学这种写法），不要为了快把 router/context/claude 揉一坨。所有数据源是**酷狗**（不是网易云），用 KuGouMusicApi。
