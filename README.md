# Claudio · 个人 Claude AI 电台

> 个人 AI 电台 · Claudio · 读懂听歌习惯 → 规划声音 → 像 DJ 那样播报

Claude 做大脑，根据你的品味语料 + 当前时间 + 历史播放，推荐 3-5 首歌；酷狗音乐负责检索 + 直链；浏览器播放。

参考施工图复刻分层架构：`router → context → claude → state.db → services/kugou`。后续往里插 TTS / scheduler / 飞书 / 天气 / UPnP 都是顺手的事，不动核心。

---

## 启动（5 步走）

### 1. 装 Claude Code CLI

需要本机能运行 `claude -p`。验证：
```powershell
claude --version
```
若无，去 https://claude.com/claude-code 装一下（Max 订阅无需 API key）。

### 2. 准备 KuGouMusicApi 上游

`npm run dev` 会自动和 Claudio 一起启动 KuGouMusicApi。先把社区版 fork 放在 Claudio 同级目录：
```powershell
git clone https://github.com/MakcRe/KuGouMusicApi.git ../KuGouMusicApi
cd ../KuGouMusicApi
npm install
```
回到 Claudio 目录：`cd ../Claudio`。

默认上游目录是 `../KuGouMusicApi`，默认监听 `http://localhost:3000`。如果你的目录或端口不同，在 `.env` 里设置 `KUGOU_API_DIR` / `KUGOU_API_BASE`。

> 不同 fork 接口路径会有差异。如果搜歌返回 404，去 `server/services/kugou.js` 顶部的 `ENDPOINTS` / `LOGIN_PATH` 改路径。

### 3. 装 Claudio 依赖

```powershell
npm install
```

依赖全是纯 JS，零编译。SQLite 用 Node 22.5+ 内置的 `node:sqlite` 模块，不需要 VS Build Tools。

### 4. 配置 .env + 填语料

```powershell
copy .env.example .env
```
打开 `.env` 填：
- `KUGOU_USERNAME` / `KUGOU_PASSWORD`（推荐自动登录）
- 或者 `KUGOU_COOKIE`（手动从浏览器抓 cookie 粘贴）

填一下 `user/taste.md` —— 至少几行"喜欢的歌手"和"一两个场景偏好"。Claudio 才不会推荐通用电台。

### 4.1 导入酷狗口味数据（可选）

如果你手头是酷狗截图、分享链接或复制出来的歌单，不需要登录抓取私有接口：

```powershell
# 1. 把酷狗 OCR 文本 / 分享链接 / 歌单复制文本粘到这里
notepad user\music\kugou_input.txt

# 2. 生成歌曲级原始清单 + 口味摘要
npm run music:import:kugou

# 3. 检查 user\music\kugou_raw.md 歌名/歌手没错后，写入 taste.md
node scripts\import-kugou-data.js --apply-taste
```

建议输入格式：

```text
https://www.kugou.com/playlist/xxxxx

# 红心 3
晴天 - 周杰伦
夜曲 周杰伦 《十一月的萧邦》

# 最近循环
Sweet Soul Revue - Pizzicato Five

# 雷区
土嗨电音 - 某某DJ
```

脚本会生成：
- `user/music/kugou_raw.md`：歌曲级原始数据，方便回看和校对。
- `user/music/kugou_taste_summary.md`：可读口味摘要。
- `user/taste.md` 的酷狗蒸馏区：Claudio 每次推荐时会读到。

### 5. 跑起来

```powershell
npm run dev
```
看到：
```
[dev] starting KuGouMusicApi: npm start (.../KuGouMusicApi)
[dev] starting Claudio: ...
[kugou-login] OK · ...
[claudio] 8080 ready · http://localhost:8080
```
浏览器打开 http://localhost:8080，跟 Claudio 说一句"来点雨天聆听的"。

如果只想调试 Claudio 本体、不启动 KuGouMusicApi，可用：
```powershell
npm run dev:app
```

---

## 验证（end-to-end）

- [ ] 控制台显示 `KuGou login OK · 8080 ready`
- [ ] 浏览器加载 PWA
- [ ] chat 输入"来点雨天聆听的" → 5s 内看到 say + 3-5 首 queue
- [ ] 第一首自动播放，能听到声音
- [ ] 点 ⏭ 切下一首；点 ⏸ 暂停；拖进度条正常（Range 工作）
- [ ] 重启服务 + 刷新浏览器 → 对话历史 + 播放历史还在
- [ ] 控制台 `npm test` 全绿

## 调试小技巧

- `state.db` 是 SQLite。装 [DB Browser for SQLite](https://sqlitebrowser.org/) 直接看 `messages` / `plays` / `unmatched` / `prefs` 表
- Claude 输出 JSON 失败时，PWA 仍会显示原文（被当作 say）。检查 `dj-persona.md` 的硬约束是否被守住
- 酷狗匹配不到的歌都在 `unmatched` 表里。可以观察自己 taste 里哪些歌酷狗版找不到

## MVP 之后

- `server/scheduler.js` —— cron 任务（07:00 早间规划 / 09:00 早安播报）
- `server/tts.js` —— Fish Audio 合成 say，让 Claudio 真的"开口说话"
- 飞书 / 天气 在 `server/context.js` 的环境注入填进去
- UPnP（推 Naim 音响）—— 在 PWA `<audio>` 旁边并存一条输出 adapter

这些在当前架构下都是"插进去就行"。

## 目录

```
.
├── server/                    # Node 后端
│   ├── app.js                 # Express + WS + 音频代理
│   ├── router.js              # intent 分流
│   ├── context.js             # 6 片粘成 system prompt
│   ├── claude.js              # spawn claude -p · 解析 DJ JSON
│   ├── db.js                  # better-sqlite3 包装
│   └── services/
│       ├── kugou.js           # search / song_url / lyric
│       └── kugou-login.js     # cookie 自动续约
├── pwa/                       # Progressive Web App
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   ├── sw.js                  # service worker
│   └── manifest.json
├── prompts/
│   └── dj-persona.md          # Claudio 的人格 + JSON schema 硬约束
├── user/
│   ├── taste.md               # 你的品味语料（填我）
│   └── routines.md            # 你的日常节奏（可填）
├── tests/                     # vitest
├── state.db                   # SQLite（首次启动自动建）
├── .env.example
└── package.json
```
