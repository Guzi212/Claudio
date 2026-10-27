# Claudio · 播放器壳

> 默认只负责出声和显示。选歌交给外部的 Grok Bot（Claudio主持人）。

酷狗音乐负责检索、直链和歌单读写；浏览器 PWA 播放。`CLAUDIO_BRAIN` 默认是 `external`：不调用 Claude，不开机选歌，不定时推歌，队列播完就停。设成 `internal` 才恢复原来的 Claude 选歌（开机电台、聊天点歌、定时任务）。

口味语料还在：`user/taste.md`、`user/music/kugou_taste_summary.md`、酷狗歌单导入脚本都保留，给 bot 读，不给 Claudio 自己拿来推歌。

---

## 启动（5 步走）

### 1. 选歌开关

`.env` 里：

```env
CLAUDIO_BRAIN=external
```

留空也是 `external`。这个模式下不用装 Claude Code CLI。

只有要恢复 Claudio 自己选歌时才改成 `internal`，并保证本机能跑 `claude -p`（或配好 DeepSeek key）。`internal` 下，外部点歌还没放完时，开机电台和定时任务不会把队列换掉。

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
- 反代或内网穿透转到本机时，打开 `CLAUDIO_REQUIRE_TOKEN`，并用 `CLAUDIO_ALLOWED_HOSTS` 放行穿透域名
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

- [ ] 控制台显示 `KuGou login OK · 8080 ready`，以及 `CLAUDIO_BRAIN=external，跳过定时推歌`
- [ ] 浏览器加载 PWA。允许自动播放时会直接出声；只有浏览器拒绝时才出现「点击开声」
- [ ] `POST /api/queue/external` 点一首歌，页面开始播，串场面板显示 `say`
- [ ] 队列最后一首结束后停下，不再自己续歌
- [ ] 控制台 `npm test` 全绿

## 调试小技巧

- `state.db` 是 SQLite。装 [DB Browser for SQLite](https://sqlitebrowser.org/) 直接看 `messages` / `plays` / `feedback` / `unmatched` / `prefs` 表
- 酷狗匹配不到的歌都在 `unmatched` 表里
- `CLAUDIO_BRAIN=internal` 时，Claude 输出 JSON 失败，PWA 仍会把原文当作 say。检查 `prompts/dj-persona.md`

## internal 模式才有的旧能力

- `POST /api/boot`：开机让 Claude 选开播曲目。外部队列还没放完时返回当前队列，`skipped: true`，`preserved: "external"`，不改 `runtime.queue` / `index`
- `POST /api/chat`：自然语言交给 Claude 选歌，可以覆盖外部队列
- `server/scheduler.js`：07:00 / 09:00 / 每小时。外部队列还没放完就跳过并记日志
- 页面上的聊天框、自动推歌按钮、DeepSeek 设置。external 模式下这些不显示
- 队列在「自动推歌」模式下播完会再向 Claude 要下一批。external 模式播完就停

## 监听地址与鉴权

默认只听 `127.0.0.1`（`CLAUDIO_HOST`）。本机浏览器打开 `http://127.0.0.1:8080` 时，PWA、`<audio>` 和 WebSocket 都走回环。`CLAUDIO_REQUIRE_TOKEN` 默认关闭，这时回环不需要 token。

`/api/*`、`/tts/*`（Fish 合成的 mp3）和 WebSocket `/stream` 对非回环来源要令牌。静态页面（HTML / JS / CSS）保持公开，里面不写密钥。

令牌放在 `.env` 的 `CLAUDIO_API_TOKEN`。调用方任选一种：

```http
Authorization: Bearer <token>
X-Claudio-Token: <token>
```

`<audio>` 和部分 WebSocket 客户端加不了 Header，也可以把 `?token=` 放在 URL 上。这个值会出现在访问日志里，bot 优先用 Header。

不看 `X-Forwarded-For`。前面再套一层反代、而反代本身跑在本机时，所有人都会被当成回环，等于鉴权失效。把外网穿透或反代转到 `127.0.0.1` 之前，先打开令牌开关：

```env
CLAUDIO_API_TOKEN=一段足够长的随机串
CLAUDIO_REQUIRE_TOKEN=1
```

`1` / `true` / `on` / `yes` 都算打开，其它值（包括空）算关闭。打开后回环也要凭证。令牌还没填就打开开关的话，连本机也会 401。

本机 PWA 仍然不用把密钥写进静态文件。浏览器打开一次：

```text
http://127.0.0.1:8080/?token=你的令牌
```

页面会做这几步：

1. 用这个令牌 `POST /api/session`（`Authorization: Bearer`，`credentials: same-origin`）。这一下必须是令牌本身：回环免检和已经种下的 cookie 都不能签发新会话，避免开关打开之前有人先种一张以后拿来用。
2. 服务端核过后种下 cookie：名字 `claudio_session`，`HttpOnly`、`SameSite=Strict`、`Path=/`，大约 30 天。值是随机会话 id，不是 `CLAUDIO_API_TOKEN` 本身。本机是 HTTP，所以不加强制 `Secure`；只有连接本身是 TLS 时才加。
3. 成功后用 `history.replaceState` 把地址栏里的 `token` 去掉，`view` 之类的其它参数还在。
4. 之后同一站点上的 `fetch`、`<audio>`、WebSocket 都会带上这个 cookie。

会话记在进程内存里。Claudio 重启后要再打开一次带 `?token=` 的地址。`SameSite=Strict` 让别的网站带不走这张 cookie。不要把带 token 的地址转给别人；它只在地址栏里待到换 cookie 完成。

`CLAUDIO_API_TOKEN` 留空且开关关闭时，非回环请求一律 401。要让另一台机器上的 bot 调用：

```env
CLAUDIO_HOST=0.0.0.0
CLAUDIO_API_TOKEN=一段足够长的随机串
```

手机或局域网里的浏览器不是回环。开关关闭时，页面能打开，但接口会 401，除非请求自己带上 token，或者先用 `?token=` 换过 cookie。局域网或穿透域名还要写进下面的 Host 白名单，否则直接 403。

### Host 白名单（DNS 重绑定）

每个 HTTP 请求和每次 WebSocket 升级都会看 `Host`。默认只放行 `localhost`、`127.0.0.1`、`[::1]`，带不带端口都行。对不上返回 403 `{ "ok": false, "error": "forbidden host" }`，响应里不回显 Host。

用局域网 IP 或穿透域名时：

```env
CLAUDIO_ALLOWED_HOSTS=192.168.1.20,radio.example.com
```

逗号分隔。只写主机名表示任意端口。写成 `radio.example.com:8443` 则只放行这个端口（浏览器访问默认的 80/443 时，Host 往往不带端口，这种时候只写主机名）。`0x7f.0.0.1`、带前导零的 IPv4 这类写法不会被当成 `127.0.0.1`。IPv6 带端口要写成 `[::1]:8080`，不要写成 `::1:8080`。

WebSocket 还会看 `Origin`。没有 Origin（非浏览器的 bot）放行，鉴权仍然要过。`Origin: null`、解析不了、不是 `http`/`https`，或主机不在同一份白名单里，返回 403。浏览器从 `evil.com` 连本机回环的 WebSocket 会被拒绝。

反代如果把 Host 改写成 `127.0.0.1`，Host 检查会把它当成本机，这时要靠 `CLAUDIO_REQUIRE_TOKEN` 挡住穿透进来的流量。反代如果原样转发外部 Host，这个名字必须在 `CLAUDIO_ALLOWED_HOSTS` 里。WebSocket 的 Origin 是页面自己的源：即使 Host 被改写，穿透域名不在白名单里，PWA 的 WebSocket 也会 403。

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
| `tracks` | 必填 | `{ title, artist, hint?, reason? }`，至少一首有 title。单首 `reason` 有内容才写进这一首；没写就不带这个字段，页面上那一行也不显示 |
| `say` / `reason` | 空 | `say` 是主持人口播，完整显示在头像旁边，最多 500 字。整轮 `reason` 最多 200 字，记在状态里；当前这首自己没有 `reason` 时，播放区用它补一行。单首 `tracks[].reason` 同样最多 200 字。超出的部分直接截掉，不报错。Fish Audio 已配置时，`say` 会合成成队列第一条 TTS；没配置就静默跳过，歌照常进队列 |
| `source` | `bot` | 这一轮是谁点的，最多 40 字，超出截断、不报错。写在队列条目和 `GET /api/status` 的 `source` 上。播放器内部的 `queueSource` 仍是 `bot`，开机和定时任务不会把这批歌清掉 |
| `mode` | `replace` | 播放队列：`replace` 换掉当前队列，`append` 接到队尾。一首都没匹配上时不会把正在播的队列清空 |
| `target` | `queue` | `queue` 只进 Claudio 队列；`kugou_playlist` 只写酷狗歌单；`both` 两件都做 |
| `playlistName` | `Claudio推荐` | 账号里同名歌单会复用，没有就新建 |
| `playlistMode` | `append` | `append` 往歌单里加；`rewrite` 先清空再写入 |

`append` 时如果 PWA 正在播，只把新歌接上，不打断当前这首。队列是空的或上一首已经结束，才从新歌开始播。`replace` 从第 0 首开始。TTS 音轨如果有，排在这批新歌的最前面。

下面这张表是给 Claudio主持人（Grok Bot）的说明书。鉴权沿用现有令牌和 Host 白名单：本机回环在 `CLAUDIO_REQUIRE_TOKEN` 关闭时不用带 token；从另一台机器调用要带 `Authorization: Bearer <token>`。

## Claudio主持人工具接口

| 用途 | 方法 + 路径 | 参数 | 返回 |
| --- | --- | --- | --- |
| 点歌 / 写歌单 | `POST /api/queue/external` | JSON：`tracks[]`（`title` 必填，`artist` / `hint` / `reason` 可选），`say`（最多 500 字），`reason`（最多 200 字），`source`（默认 `bot`，最多 40 字），`mode`=`replace`\|`append`，`target`=`queue`\|`kugou_playlist`\|`both`，`playlistName`（默认 `Claudio推荐`），`playlistMode`=`append`\|`rewrite`。超长截断，不报错。不带 `volume`（缺省或 `null`）不会改已保存的音量 | `ok`，`matched[]`，`failed[]`，`queue`（`mode` / `added` / `length`），`playlist`。成功写入播放队列时记下 `queuedAt`。返回的 `say` / `reason` 已是截断后的文本 |
| 播放控制 | `POST /api/control` | JSON：`command`=`next`\|`prev`\|`pause`\|`play`\|`toggle`\|`volume`\|`jump`，`value`（音量 0–100，或 jump 的从 0 开始的序号） | `ok`，`command`，`say`，`nowPlaying`，`queue`，`index`，`paused`，`volume`。`volume` 会立刻记住。`next` 真正切到下一首时，把刚离开的那首记成 `feedback.kind=skip`。`toggle` 播放中就暂停，暂停中就继续。最后一首已经结束时，状态算作已停，`toggle` 和 `play` 都从队列第一首重新开始。队列是空的就停在暂停。这些命令不改音量 |
| 状态 | `GET /api/status`（`GET /api/now` 相同） | 无 | `brain`，`nowPlaying`，`queue`，`index`，`paused`，`volume`（0–100，会记住；没存过默认 30），`currentTime`（秒），`duration`（秒），`active`（有没有页面连着 WebSocket），`listeners`，`lastSay`，`reason`，`queuedAt`（最近一次外部点歌的 ISO 时间，没有则 `null`），`source`（那一次请求的 `source`，没有则空字符串）。队列里的歌若带了自己的 `reason` / `cover` / `queuedAt`，会原样出现在 `queue[]` |
| 进度上报 | WebSocket `/stream`，客户端发 | `{ "type":"progress", "currentTime", "duration", "volume", "paused", "index" }`，页面大约每 2 秒一次 | 服务端更新内存里的进度，不广播。音量有变化才写入，短时间连续拖动合并成一次。bot 用 `GET /api/status` 读 |
| 搜歌 | `GET /api/kugou/search` | Query：`title` 必填，`artist`，`hint` | `ok`，`tracks[]`：`hash`，`title`，`artist`，`album`，`duration`，`score` |
| 酷狗歌单列表 | `GET /api/kugou/playlists` | Query：`page`，`pagesize` | `ok`，`playlists[]`：`id`，`listid`，`globalCollectionId`，`name`，`songCount`，`isPrivate` |
| 歌单曲目 | `GET /api/kugou/playlists/tracks` | Query：`listid` 或 `gcid`，可选 `pagesize` | `ok`，以及曲目结果（含 `tracks`） |
| 播放历史 | `GET /api/plays` | Query：`limit`（默认 20，最大 100） | `ok`，`plays[]`：`id`，`kugouId`，`title`，`artist`，`reason`，`source`，`ts`；`feedback[]`：`kind`（`skip` / `like` / `unlike`），`title`，`artist`，`kugouId`，`ts` |
| 喜欢 / 不喜欢 | `POST /api/feedback` | JSON：`kind`=`like`\|`unlike`\|`skip`，`title` 或 `kugouId`，`artist` | `ok`，`id`，`kind`。页面上的 ♡ 也会写这里 |
| 整单播放 | `POST /api/kugou/playlists/play` | JSON：`playlist`（要有 `listid` 或 `globalCollectionId`） | `ok`，`count`，`queue`。这是明确换队列 |
| 直链 | `GET /api/kugou/track-url` | Query：`hash` | `ok`，`url`（已经是 `/api/proxy?u=...`） |
| 聊天（external） | `POST /api/chat` | JSON：`message` | 控制命令（`/skip` `/pause` `/play` `/toggle` `/vol N` `/prev` `/now` `/queue`）照常执行。普通文字返回「选歌请在 Grok Bot 里找 Claudio主持人。」，不调用 Claude |
| 开机（external） | `POST /api/boot` | 无 | 不调用 Claude。返回当前 `queue` 和 `index`，`brain: "external"`，`skipped: true` |

页面在 external 模式下只出声和显示。加载时，以及主持人投下新队列时，会先直接 `play()`。成功就不出遮罩；只有浏览器返回 `NotAllowedError` 才显示「点击开声」，点一下从当前队列和进度接着放。队列是空的就显示「等主持人点歌」，不盖遮罩。服务器记着暂停时，打开页面不会自己播；主持人用 replace 或 append 投下新队列，或者发 play，会再直接播。一首播完会放到队列里的下一首，整个队列播完就停。聊天框和自动推歌按钮不在播放页上。设置里的 DeepSeek 卡片只在 external 模式隐藏，internal 模式仍显示。播放页右上角有一个小图标，点开可以进歌单和设置。主持人口播显示外部点歌的 `say`，点歌时间显示在名字旁边。音量沿用已保存的值，滑块旁边有数字。

`GET /api/weather` 在 external 模式下直接返回 `{}`，不调用 OpenWeather。播放页也不再每 5 分钟去拉天气。internal 模式这条路由仍返回当前天气；选歌提示里的天气还是在 `buildSystemPrompt` 里取，和这条路由无关。设置页里的「测试天气」按钮仍然会真的请求 OpenWeather。

### PowerShell 示例

本机回环、没开 `CLAUDIO_REQUIRE_TOKEN` 时可以不带 `-Headers`。下面按 bot 在另一台 Windows 上调用来写。

```powershell
$base = 'http://127.0.0.1:8080'
$headers = @{ Authorization = 'Bearer <token>' }

function Invoke-Claudio($Method, $Path, $Body) {
  $params = @{
    Method = $Method
    Uri = "$base$Path"
    Headers = $headers
  }
  if ($Body) {
    $json = $Body | ConvertTo-Json -Depth 6
    $params.ContentType = 'application/json; charset=utf-8'
    $params.Body = [System.Text.Encoding]::UTF8.GetBytes($json)
  }
  Invoke-RestMethod @params
}

# 点歌。say 会显示在串场面板；TTS 配好了会当成第一条音轨念出来
Invoke-Claudio Post '/api/queue/external' @{
  tracks = @(
    @{ title = '晴天'; artist = '周杰伦' }
  )
  say = '今晚先听这轮'
  reason = '雨天'
  mode = 'replace'
  target = 'queue'
}

# 同时写进酷狗账号里的「Claudio推荐」
Invoke-Claudio Post '/api/queue/external' @{
  tracks = @(@{ title = '晴天'; artist = '周杰伦' })
  target = 'both'
  playlistName = 'Claudio推荐'
  playlistMode = 'append'
}

Invoke-Claudio Get '/api/status'
Invoke-Claudio Post '/api/control' @{ command = 'pause' }
Invoke-Claudio Post '/api/control' @{ command = 'play' }
Invoke-Claudio Post '/api/control' @{ command = 'toggle' }
Invoke-Claudio Post '/api/control' @{ command = 'next' }
Invoke-Claudio Post '/api/control' @{ command = 'prev' }
Invoke-Claudio Post '/api/control' @{ command = 'volume'; value = 40 }
Invoke-Claudio Post '/api/control' @{ command = 'jump'; value = 0 }

Invoke-Claudio Get '/api/kugou/search?title=晴天&artist=周杰伦'
Invoke-Claudio Get '/api/kugou/playlists?page=1&pagesize=20'
Invoke-Claudio Get '/api/kugou/playlists/tracks?listid=12'
Invoke-Claudio Get '/api/plays?limit=20'
Invoke-Claudio Post '/api/feedback' @{ kind = 'like'; title = '晴天'; artist = '周杰伦' }
```

点歌响应示例：

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

## 快捷键

默认只用常驻监听器（推荐）：`Ctrl+Alt+K` 由 Windows 全局注册，窗口在后台也能暂停或继续。只用系统自带的 PowerShell 5 和 .NET Framework，不需要安装软件。键盘媒体键也可以继续走浏览器的 Media Session。

桌面快捷方式和常驻监听器对同一组合键互斥，二选一。已有 `.lnk` 热键时，先清除绑定，再使用监听器：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\claudio-hotkey.ps1 -Action Remove
```

### 媒体键

播放页在播放运行时注册了 `navigator.mediaSession`（不写在某个视图里，换播放页界面也不影响）。下面这些会控制 Claudio，窗口在后台时也有效，只要这个页面曾经出过声、系统还把它当成当前媒体会话：

- 键盘上的播放 / 暂停、上一首、下一首
- Windows 音量弹窗里的媒体按钮

歌名、歌手和封面会写进系统的媒体信息。曲目自己带了 `cover` / `pic` / `image` 就用那张图，否则用页面的 `/icon.svg`。

页面在前台时，空格切换播放 / 暂停。焦点在输入框、文本区域、下拉框，或可编辑区域（含 `role="textbox"`）里时，空格仍留给输入。后台窗口不会收到空格。

这些动作都是 `POST /api/control`（`play` / `pause` / `prev` / `next`，空格是 `toggle`），不另开一条播放路径。请求不带 `clientId`，服务端广播也就没有 `origin`，页面会把它当成外部命令来播放或暂停。自己报上去的进度回声仍然会被认出来，不会把歌打断。音量沿用已经记住的值，这些命令不会改它。

整队放完（停在最后一首，并且这首已经自然结束）时，状态算作已停，不再当成正在播放。这时按一次媒体键的播放，或按一次空格，都会从队列第一首重新开始。中途暂停再按，仍从当前这首继续。

### Ctrl+Alt+K：常驻监听器（推荐）

监听器只在启动时编译一次，之后按键直接在后台线程向本机 `/api/control` 发送 `{"command":"toggle"}`，复用 HTTP 连接。目标是按下到暂停低于 300 ms；实际延迟还受服务和浏览器响应影响，可看日志里的 `elapsedMs` 核对接口耗时，不把它当成声音已经停下的证明。

在 Claudio 目录执行（PowerShell 5 即可）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\claudio-hotkey-listener.ps1 -Action Start
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\claudio-hotkey-listener.ps1 -Action Status
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\claudio-hotkey-listener.ps1 -Action Stop
```

不写 `-Action` 时默认 `Start`。它启动隐藏的常驻 `powershell.exe`，短暂等待注册结果后返回一行 `started`、`already running` 或 `failed: 原因`；重复启动不会创建第二个监听器。`Stop` 通过命名事件退出循环并释放热键，不会停止 Node 服务。本地启动器 `start-claudio.ps1`（在仓库外）会在服务启动后调用 `scripts\claudio-hotkey-listener.ps1 -Action Start`。退出登录或重启电脑后需要重新启动监听器。

Claudio 页面要开着，服务要在跑。播放中按一次暂停，暂停时继续当前曲目；整队自然播完后再按一次，从第一首重新开始。空队列仍保持暂停。服务没启动或请求失败时会记日志，监听器继续工作，不自动重试 `toggle`。

更换热键或端口前先 `Stop`，再启动。支持 `CTRL`、`ALT`、`SHIFT`、`WIN` 的组合，加一个字母、数字或 F1–F12：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\claudio-hotkey-listener.ps1 -Action Start -Hotkey CTRL+ALT+F11 -BaseUrl http://127.0.0.1:9090
```

注册失败时，`Start` 会返回失败状态，日志也会记录原因，并尝试显示 Windows 气泡通知。错误 `1409` 表示组合键已被其他程序或桌面快捷方式占用：`already registered by another program (or by a desktop shortcut). Pick another with -Hotkey ...`。换组合键，或清除旧快捷方式绑定后再启动；不要同时保留绑定相同组合键的 `.lnk` 和监听器。

媒体键默认**不注册**。Chrome 的 Media Session 已经能处理播放 / 暂停媒体键，再让监听器接管可能双重切换或抢走其他应用的媒体键。确实需要监听器接管时，停止后加 `-MediaKey` 启动；任一热键冲突都会让这次启动失败并释放已注册的键。

日志：`%LOCALAPPDATA%\Claudio\hotkey-listener.log`。记录毫秒时间戳、注册、按键时间、HTTP 返回状态和 `paused`（响应中有该字段时），超过 256 KB 时截断。旁边的 `hotkey-listener.json` 只存 PID、热键和运行状态，不存令牌。

只检查参数和 C# 编译，不注册热键、不写运行文件、不发送请求：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\claudio-hotkey-listener.ps1 -Action Check -Hotkey CTRL+ALT+F11 -BaseUrl http://127.0.0.1:9
```

只有启动进程的环境变量 `CLAUDIO_REQUIRE_TOKEN` 为 `1`、`true`、`yes` 或 `on` 时，脚本才读取同一环境中的 `CLAUDIO_API_TOKEN` 并发送 Bearer 认证；令牌只留在内存，不写入日志、运行文件、快捷方式或子进程命令行。开关关闭时不读取也不发送令牌。服务器 `.env` 不会自动传给另一个 PowerShell；启用认证时，启动器需要为监听器提供相应环境。更换令牌后重启监听器。Host 白名单和服务端鉴权仍照常检查。

### 桌面快捷方式（慢速备选）

旧方式每按一次都冷启动 PowerShell，可能约 3 秒才响应。默认组合键也改为 `Ctrl+Alt+K`，只支持 Ctrl+Alt 加字母、数字或 F1–F12。要改用快捷方式，先停止监听器：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\claudio-hotkey-listener.ps1 -Action Stop
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\claudio-hotkey.ps1 -Action Install
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\claudio-hotkey.ps1 -Action Remove
```

`Install` 在桌面创建 `Claudio Play-Pause.lnk`；可用 `-Hotkey CTRL+ALT+F11` 或 `-BaseUrl http://127.0.0.1:9090`。脚本先探测占用：遇到 1409，只有该路径上的自有 Claudio 快捷方式已绑定同一组合键时，才保留热键并更新目标和参数；大小写和空格不影响比较。其他占用（包括监听器）会警告并以非零状态退出，不创建或修改快捷方式。请换一个 `-Hotkey`；若要从监听器切换过来，先执行上面的 `Stop`。快捷方式要留在桌面或开始菜单里，Windows 才会接管其热键。

`Remove` 只清除自有快捷方式的「快捷键」字段，保留文件，便于切换到常驻监听器。旧版如果使用过 `-Token` 创建快捷方式，请重新 `Install` 来覆盖旧参数；新版改用上述环境变量，不再接受或保存 `-Token`。

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
│   ├── claude.js              # 仅 CLAUDIO_BRAIN=internal 时调用
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
