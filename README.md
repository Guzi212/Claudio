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
- 本机升级后如果要给外部 bot 用，再补 `CLAUDIO_API_TOKEN`（见下面「监听地址与鉴权」）
- 开着 Clash 且酷狗直连被挡时，补 `KUGOU_PROXY`（见下面「Clash / 代理」）

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

## 监听地址与鉴权

默认只听 `127.0.0.1`（`CLAUDIO_HOST`）。本机浏览器打开 `http://127.0.0.1:8080` 时，PWA、`<audio>` 和 WebSocket 都走回环，**不需要 token**。

`/api/*`、`/tts/*`（Fish 合成的 mp3）和 WebSocket `/stream` 对非回环来源要令牌。静态页面（HTML / JS / CSS）保持公开，里面不写密钥。

令牌放在 `.env` 的 `CLAUDIO_API_TOKEN`。调用方任选一种：

```http
Authorization: Bearer <token>
X-Claudio-Token: <token>
```

`<audio>` 和部分 WebSocket 客户端加不了 Header，也可以把 `?token=` 放在 URL 上。这个值会出现在访问日志里，bot 优先用 Header。

不看 `X-Forwarded-For`。前面再套一层反代、而反代本身跑在本机时，所有人都会被当成回环，等于鉴权失效。

`CLAUDIO_API_TOKEN` 留空时，非回环请求一律 401。要让另一台机器上的 bot 调用：

```env
CLAUDIO_HOST=0.0.0.0
CLAUDIO_API_TOKEN=一段足够长的随机串
```

本机 PWA 仍然不用带这个串。手机或局域网里的浏览器不是回环，页面能打开，但接口会 401，除非请求自己带上 token。

## 外部歌单（Bot）

`POST /api/queue/external` 接收 bot 给的歌单。Claudio 只做酷狗匹配（沿用现有打分：未点名的 DJ 版直接 0 分，现场 / live / remix 等降权，阈值 60），**不调用 Claude**，也**不限制在账号歌单候选池里**。搜不到的歌按原方式写入 `unmatched`。

匹配成功后可以放进 Claudio 播放队列（WebSocket 通知本机 PWA 播），也可以写进酷狗账号里的歌单，或两件都做。写歌单只调用本机 KuGouMusicApi 的 `user/playlist`、`playlist/add`、`playlist/tracks/add`，重写时先 `playlist/tracks/del`。酷狗客户端不能被远程拉起播放，这条路径不会去按播放。

播放队列里的歌会记入播放历史，`source` 为 `bot`。只写酷狗歌单、不进 Claudio 队列时不记播放历史。

```http
POST /api/queue/external
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "tracks": [
    { "title": "晴天", "artist": "周杰伦" },
    { "title": "没有这首", "artist": "无名氏" }
  ],
  "say": "今晚先听这轮",
  "reason": "雨天",
  "mode": "replace",
  "target": "both",
  "playlistName": "Claudio推荐",
  "playlistMode": "rewrite"
}
```

字段：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `tracks` | 必填 | `{ title, artist, hint? }`，至少一首有 title |
| `say` / `reason` | 空 | 串场和理由。`say` 在进播放队列时会变成 PWA 上的一句话 |
| `mode` | `replace` | 播放队列：`replace` 换掉当前队列，`append` 接到队尾。一首都没匹配上时不会把正在播的队列清空 |
| `target` | `queue` | `queue` 只进 Claudio 队列；`kugou_playlist` 只写酷狗歌单；`both` 两件都做 |
| `playlistName` | `Claudio推荐` | 账号里同名歌单会复用，没有就新建 |
| `playlistMode` | `append` | `append` 往歌单里加；`rewrite` 先清空再写入 |

`append` 时如果 PWA 正在播，只把新歌接上，不打断当前这首。队列是空的或上一首已经结束，才从新歌开始播。`replace` 从第 0 首开始。

响应示例：

```json
{
  "ok": true,
  "target": "both",
  "say": "今晚先听这轮",
  "reason": "雨天",
  "matched": [
    {
      "title": "晴天",
      "artist": "周杰伦",
      "kugouId": "HASH",
      "score": 150,
      "requested": { "title": "晴天", "artist": "周杰伦" }
    }
  ],
  "failed": [
    { "title": "没有这首", "artist": "无名氏", "reason": "unmatched" }
  ],
  "queue": { "mode": "replace", "added": 1, "length": 1 },
  "playlist": {
    "ok": true,
    "id": "12",
    "listid": "12",
    "globalCollectionId": "",
    "name": "Claudio推荐",
    "mode": "rewrite",
    "created": false,
    "added": [
      { "title": "晴天", "artist": "周杰伦", "kugouId": "HASH" }
    ],
    "failed": []
  }
}
```

`target` 不含播放队列时 `queue` 为 `null`。不含酷狗歌单时 `playlist` 为 `null`。歌单写入失败时 HTTP 仍是 200，看 `ok` 和 `playlist.ok` / `playlist.error`，避免客户端自动重试造成重复写入。

## Clash / 代理

Windows 上 Clash 开 fake-ip 时，Node 直连酷狗网关可能被拦。有两种解法，用一种即可。

### 走 Clash 本地端口

在 Claudio 的 `.env` 里：

```env
KUGOU_PROXY=http://127.0.0.1:7890
```

端口改成你 Clash 的 HTTP / mixed 端口。留空则直连。

这会影响两处：

- Claudio 自己的出站：`/api/proxy` 拉酷狗 CDN，以及直接请求 `kugou.com` 的地方（例如歌单短链）。目标是 `127.0.0.1`、`localhost` 或 `::1` 时永远不走代理，本机 KuGouMusicApi（默认 `localhost:3000`）不受影响。
- `npm run dev` 拉起的 KuGouMusicApi 进程。真正访问酷狗网关的是它。上游 axios **不读** `HTTP_PROXY` / `HTTPS_PROXY`，只在 `util/runtime.js` 的 `resolveProxy()` 里读 `KUGOU_API_PROXY`（或启动参数 `--proxy`）。dev 脚本会把 `KUGOU_PROXY` 抄进子进程的 `KUGOU_API_PROXY`。

如果 KuGouMusicApi 已经在跑，这次不会改它的环境。关掉后用 `npm run dev` 重新拉起，或在那个进程里自己设 `KUGOU_API_PROXY`。上游版本需要带 `KUGOU_API_PROXY` 支持（当前 MakcRe/KuGouMusicApi 的 `main` 已支持）。

### 让酷狗域名直连

在 Clash 规则里把酷狗域名设为 `DIRECT`，并加进 `fake-ip-filter`，避免这些域名被分配假 IP：

```yaml
dns:
  fake-ip-filter:
    - '+.kugou.com'
    - '+.kgimg.com'

rules:
  - DOMAIN-SUFFIX,kugou.com,DIRECT
  - DOMAIN-SUFFIX,kgimg.com,DIRECT
```

音频 CDN 如果还有别的主机名，从 Claudio 日志里的直链补上同样的规则。

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
