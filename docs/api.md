# Claudio · 主持人 API、常驻 DJ 与续播池手册

本文档面向外部 AI 主持人（如 Claude Code、OpenClaw、Grok Bot 或任意脚本）以及想深入使用 Claudio 自动化能力的开发者。

> 鉴权说明：本机回环（`127.0.0.1` / `localhost`）在 `CLAUDIO_REQUIRE_TOKEN` 关闭时无需令牌；跨机器调用或开启 `CLAUDIO_REQUIRE_TOKEN=1` 时，请求头需带 `Authorization: Bearer <token>` 或 `X-Claudio-Token: <token>`。详见 [进阶配置 · 监听地址与鉴权](./advanced.md#监听地址与鉴权)。

---

## 一、核心工具接口一览

| 用途 | 方法 + 路径 | 参数 | 返回 |
| --- | --- | --- | --- |
| 点歌 / 写歌单 | `POST /api/queue/external` | JSON：`tracks[]`（`title` 必填，`artist` / `hint` / `reason` 可选），`say`（最多 500 字），`reason`（最多 200 字），`source`（默认 `bot`，最多 40 字），`mode`=`replace`\|`append`，`target`=`queue`\|`kugou_playlist`\|`both`，`playlistName`（默认 `Claudio推荐`），`playlistMode`=`append`\|`rewrite`。超长截断，不报错。不带 `volume`（缺省或 `null`）不会改已保存的音量 | `ok`，`matched[]`，`failed[]`，`queue`（`mode` / `added` / `length`），`playlist`。成功写入播放队列时记下 `queuedAt`。返回的 `say` / `reason` 已是截断后的文本 |
| 清空播放列表 | `POST /api/queue/clear`（等价：`DELETE /api/queue`） | 可选 JSON：`reason`（最多 200 字，只做记录）；`clientId` 会被忽略，不产生回声 | `ok`，`cleared`，`alreadyEmpty`，`queueLen`，`index`，`paused`，`currentTime`，`duration`，`nowPlaying`，`queue`，`queueEpoch`，`continueSuppressed`，`continuePool`，`volume`。成功时队列为空、`paused=true`、进度归零；续播池保留但暂停续播。重复调用幂等成功 |
| 播放控制 | `POST /api/control` | JSON：`command`=`next`\|`prev`\|`pause`\|`play`\|`toggle`\|`volume`\|`jump`，`value`（音量 0–100，或 jump 的从 0 开始的序号） | `ok`，`command`，`say`，`nowPlaying`，`queue`，`index`，`paused`，`volume`。`volume` 会立刻记住。`next` 真正切到下一首时，把刚离开的那首记成 `feedback.kind=skip`。`toggle` 播放中就暂停，暂停中就继续。最后一首已经结束时，状态算作已停，`toggle` 和 `play` 都从队列第一首重新开始。队列是空的就停在暂停。这些命令不改音量 |
| 状态查询 | `GET /api/status`（`GET /api/now` 相同） | 无 | `brain`，`nowPlaying`，`queue`，`index`，`paused`，`volume`（0–100，会记住；没存过默认 30），`currentTime`（秒），`duration`（秒），`active`（有没有页面连着 WebSocket），`listeners`，`lastSay`，`reason`，`queuedAt`（最近一次外部点歌的 ISO 时间，没有则 `null`），`source`（那一次请求的 `source`，没有则空字符串），`queueEpoch`（队列版本，clear 后递增），`continueSuppressed`（clear 后为 `true`，下一次明确点歌解除）。队列里的歌若带了自己的 `reason` / `cover` / `queuedAt`，会原样出现在 `queue[]` |
| 进度上报 | WebSocket `/stream`（客户端发） | `{ "type":"progress", "currentTime", "duration", "volume", "paused", "index", "queueOffset" }`，页面大约每 2 秒一次 | 服务端更新内存里的进度，不广播。音量有变化才写入，短时间连续拖动合并成一次。bot 用 `GET /api/status` 读 |
| 搜歌 | `GET /api/kugou/search` | Query：`title` 或 `q`（自由文本）必填一个，`artist`，`hint` | `ok`，`tracks[]`：`hash`，`title`，`artist`，`album`，`duration`，`cover`，`score` |
| 酷狗歌单列表 | `GET /api/kugou/playlists` | Query：`page`，`pagesize` | `ok`，`playlists[]`：`id`，`listid`，`globalCollectionId`，`name`，`songCount`，`isPrivate`，`type`，`writable`（`type=0` 自建可写，`type=1` 收藏别人的只读） |
| 歌单曲目 | `GET /api/kugou/playlists/tracks` | Query：`listid` 或 `gcid`，可选 `pagesize` | `ok`，以及曲目结果（含 `tracks`） |
| 播放历史 | `GET /api/plays` | Query：`limit`（默认 20，最大 100） | `ok`，`plays[]`：`id`，`kugouId`，`title`，`artist`，`reason`，`source`，`ts`；`feedback[]`：`kind`（`skip` / `like` / `unlike`），`title`，`artist`，`kugouId`，`ts` |
| 喜欢 / 不喜欢 | `POST /api/feedback` | JSON：`kind`=`like`\|`unlike`\|`skip`，`title` 或 `kugouId`，`artist` | `ok`，`id`，`kind`。页面上的 ♡ 也会写这里 |
| 整单播放 | `POST /api/kugou/playlists/play` | JSON：`playlist`（要有 `listid` 或 `globalCollectionId`） | `ok`，`count`，`queue`。明确替换当前队列 |
| 单曲播放 | `POST /api/kugou/play` | JSON：`track`（`hash` 和 `title` 必填，`artist` / `album` / `duration` / `cover` 可选），`mode`=`replace`\|`append`（默认 `replace`） | `ok`，`mode`，`queue`，`index`。按选中的 hash 精确进队列，不再重新搜索打分；`append` 不打断当前曲目 |
| 直链 | `GET /api/kugou/track-url` | Query：`hash` | `ok`，`url`（已经是 `/api/proxy?u=...`） |
| 红心状态 | `GET /api/kugou/favorite` | Query：`hash` | `ok`，`liked` |
| 红心收藏 | `POST /api/kugou/favorite` | JSON：`action`=`add`\|`remove`，`track`（`hash` 和 `title` 必填，`artist` / `album` / `albumId` / `mixsongid` 可选） | `ok`，`liked`，`duplicate`，`playlist`，`pendingId`（仅 add 且是新歌） |
| 待分类列表 | `GET /api/likes/pending` | Query：`limit`（默认 100，最大 200） | `ok`，`items[]`：`id`，`kugouId`，`title`，`artist`，`album`，`albumId`，`mixsongid`，`status`，`createdAt` |
| 分类到歌单 | `POST /api/likes/:id/classify` | JSON：`playlist`（`listid` 或 `name`） | `ok`，`item`，`playlist`，`duplicate`。只写 `type=0` 自建歌单，不自动新建 |
| 跳过分类 | `POST /api/likes/:id/skip` | JSON：`note`（可选，最多 200 字） | `ok`，`item` |
| 聊天（external） | `POST /api/chat` | JSON：`message` | 控制命令（`/skip` `/pause` `/play` `/toggle` `/vol N` `/prev` `/now` `/queue`）照常执行。普通文字返回提示，不调用 Claude |
| 开机（external） | `POST /api/boot` | 无 | 不调用 Claude。返回当前 `queue` 和 `index`，`brain: "external"`，`skipped: true` |

---

## 二、外部歌单（`POST /api/queue/external`）

`POST /api/queue/external` 接收外部 Agent 提供的歌单。Claudio 只做酷狗匹配（沿用打分规则：未点名的 DJ 版直接 0 分，现场 / live / remix 等降权，阈值 60），**不调用内部 LLM**，也**不限制在账号歌单候选池里**。搜不到的歌写入 `unmatched` 表。

匹配成功后可以放进 Claudio 播放队列（WebSocket 通知页面播放），也可以写进酷狗账号歌单，或两件都做。写歌单调用本机 KuGouMusicApi 的 `user/playlist`、`playlist/add`、`playlist/tracks/add`，重写时先 `playlist/tracks/del`。播放队列里的歌记入播放历史，`source` 默认为 `bot`；只写酷狗歌单时不记播放历史。

请求示例：

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

字段说明：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `tracks` | 必填 | `{ title, artist, hint?, reason? }`，至少一首有 `title`。单首 `reason` 有内容才写进这一首；没写就不带该字段 |
| `say` / `reason` | 空 | `say` 是主持人口播，显示在头像旁边，最多 500 字。整轮 `reason` 最多 200 字，当前单曲没有 `reason` 时用于补一行。单首 `tracks[].reason` 最多 200 字。超长截断，不报错。已配置 Fish Audio 时，`say` 会合成成队列第一条 TTS；未配置静默跳过 |
| `source` | `bot` | 本轮点歌来源标识，最多 40 字，超长截断。播放器内部 `queueSource` 仍为 `bot`，避免被开机/定时任务覆盖 |
| `mode` | `replace` | `replace` 替换当前队列并从第 0 首开始；`append` 接到队尾，正在播时不打断当前曲目。一首都没匹配上时不会清空正在播的队列 |
| `target` | `queue` | `queue` 只进播放队列；`kugou_playlist` 只写酷狗歌单；`both` 两件都做 |
| `playlistName` | `Claudio推荐` | 账号里同名歌单会复用，没有就新建 |
| `playlistMode` | `append` | `append` 追加到歌单；`rewrite` 先清空再写入 |

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

> `target` 不含播放队列时 `queue` 为 `null`；不含酷狗歌单时 `playlist` 为 `null`。歌单写入失败时 HTTP 仍是 200，请检查 `ok` 和 `playlist.ok` / `playlist.error`，避免客户端自动重试导致重复写入。

---

## 三、清空播放列表（正式接口）

`POST /api/queue/clear` 是唯一的正式清空入口，`DELETE /api/queue` 语义完全相同。不要用空 `tracks` 的 `POST /api/queue/external` 冒充清空（会被 400 拒绝），也不要拿 `DELETE /api/continue-pool` 当清空（那只删续播池）。

响应示例：

```json
{
  "ok": true,
  "cleared": true,
  "alreadyEmpty": false,
  "queueLen": 0,
  "index": 0,
  "paused": true,
  "currentTime": 0,
  "duration": 0,
  "nowPlaying": null,
  "queue": [],
  "queueEpoch": 1,
  "continueSuppressed": true,
  "continuePool": { "name": "续播池", "size": 12, "active": true },
  "volume": 37
}
```

语义与安全要点：
- 清空后 `queue` 为空、`index=0`、`paused=true`、进度归零、`nowPlaying=null`，所有连接的页面都会 `pause` 并卸载音频 `src`。
- **不删除续播池**：`continuePool` 原样保留，但置 `continueSuppressed=true`，暂停自动续播与常驻 DJ 补歌，直到下一次明确点歌自动解除。
- 每次调用递增 `queueEpoch`，在途的旧 epoch 请求（advance / progress / 补歌）会被丢弃，防止旧曲复活。
- 幂等安全：空队列再次调用仍返回 `200`，`ok: true`，`alreadyEmpty: true`。不改音量、窗口设置、收藏或播放历史。
- 主持人仅在用户明确要求「清空播放列表 / 清空队列」时调用，并以 `ok && queueLen === 0 && paused === true && continueSuppressed === true` 判断成功。

---

## 四、待分类队列（红心整理）

在播放页点击红心将新歌加入「我喜欢」后，会写入一条 `like_pending` 记录，外部 Agent 可轮询自动归类：

1. `GET /api/likes/pending` 获取待整理歌曲。
2. `GET /api/kugou/playlists` 获取分类候选，筛选 `writable: true` 的自建歌单，排除「我喜欢」「默认收藏」。
3. `POST /api/likes/:id/classify` 追加到选中的自建歌单；不确定时调用 `POST /api/likes/:id/skip`。

`classify` 幂等：已完成记录直接返回；目标歌单已存在该曲时返回 `duplicate: true` 并标记完成。仅写 `type=0` 自建歌单，不会新建歌单。

---

## 五、常驻主持人（DJ）

在 `.env` 设置 `CLAUDIO_DJ=1` 时，Claudio 会自己盯住播放队列，无需外部 Agent 持续轮询：

- 每 `CLAUDIO_DJ_TICK_MS`（默认 20 秒）检查从当前曲目到队尾的剩余时长。
- 剩余不足 `CLAUDIO_DJ_REFILL_BELOW`（默认 600 秒）→ 按当前氛围补选 `CLAUDIO_DJ_BATCH` 首（默认 5 首），以 `append` 接到队尾，不打断正在播的曲目。
- 仅在有页面连接（`active`）且未暂停时触发，没人听不消耗 token。
- 外部 bot 刚投过歌（`queuedAt` 在 `CLAUDIO_DJ_YIELD_MS` 内，默认 3 分钟）或存在活跃续播池时自动让位。
- 自动剔除最近 40 首播过的曲目；全重复则放弃本轮，90 秒后再试。
- 串词 `say` 走 Fish Audio TTS，排在新歌最前面。
- 模型走 `claude.js` 的 `complete()`：有 `DEEPSEEK_API_KEY` 优先用 DeepSeek，否则回退 `claude -p`。

### 品味自动学习

每次补歌成功后检查：新增播放满 15 条且距上次蒸馏超过 6 小时，会将近 30 天的播放与反馈蒸馏写入 `user/taste.learned.md`（常驻歌手 / 在升温 / 在退潮 / 雷区 / 时段规律 / 一句话画像）。该文件被 git 忽略，作为 `=== ② 自动学到的品味 ===` 注入选歌提示（优先级低于 `user/taste.md`）。

### 常驻 DJ 接口

| 用途 | 方法 + 路径 | 返回 |
| --- | --- | --- |
| 状态 | `GET /api/dj/status` | `enabled`、`refillCount`、`lastRefillAt`、`lastError`、`lastDecision`、`remainingSeconds`、`tasteLearnedAt`、`config` |
| 手动补一批 | `POST /api/dj/refill` | `{ ok, added, say, reason }`，不等剩余阈值（未开 `CLAUDIO_DJ` 返回 409） |
| 手动重学品味 | `POST /api/dj/learn` | `{ ok, path, stats }`（未开 `CLAUDIO_DJ` 返回 409） |

> 与 `CLAUDIO_BRAIN=internal` 的区别：`internal` 是固定时间点（07:00 / 09:00 / 每小时）cron 推歌；常驻 DJ 是按队列余量动态补歌。两者可同时开启。

---

## 六、续播池

主持人通过 `PUT /api/continue-pool`（也接受 `POST`）设置续播池，队列播完后 Claudio 会按顺序或随机从池中分批补歌，不调用 AI，最多 200 首：

```json
{
  "name": "夜间续播",
  "tracks": [{ "title": "晴天", "artist": "周杰伦", "reason": "夜里慢慢听" }],
  "shuffle": false,
  "loop": true,
  "batchSize": 5,
  "source": "claudio-host"
}
```

- 也可将 `tracks` 换成 `"playlist": { "listid": "12" }` 或 `{ "globalCollectionId": "g12" }` 导入歌单前 200 首。
- `GET /api/continue-pool` 查看当前池与曲目预览；`DELETE /api/continue-pool` 清空池（不动当前队列）。
- `/api/status` 的 `continuePool` 返回摘要字段（`name`, `size`, `cursor`, `remaining`, `loop`, `shuffle`, `batchSize`, `source`, `setAt`, `lastContinuedAt`, `continuedCount`, `active`）。
- 续播池持久化保存在 `prefs` 表中，重启保留；主持人推新队列不会清池。
- 每次续播加入新批次前，当前队列仅保留新播放位置之前最近 `CLAUDIO_QUEUE_HISTORY` 首历史（默认 20，设为 `0` 不保留），并通过 `queueOffset` 维持绝对索引一致。

---

## 七、PowerShell 调用示例

本机回环且未开 `CLAUDIO_REQUIRE_TOKEN` 时可省略 `-Headers`。

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

# 点歌（say 显示在串场面板；配好 TTS 会自动念出）
Invoke-Claudio Post '/api/queue/external' @{
  tracks = @(@{ title = '晴天'; artist = '周杰伦' })
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

# 清空播放列表（仅在用户明确要求时调用）
Invoke-Claudio Post '/api/queue/clear' @{ reason = 'host-clear' }

# 状态与播控
Invoke-Claudio Get '/api/status'
Invoke-Claudio Post '/api/control' @{ command = 'toggle' }
Invoke-Claudio Post '/api/control' @{ command = 'next' }
Invoke-Claudio Post '/api/control' @{ command = 'volume'; value = 40 }

# 搜歌、歌单、历史与反馈
Invoke-Claudio Get '/api/kugou/search?title=晴天&artist=周杰伦'
Invoke-Claudio Get '/api/kugou/playlists?page=1&pagesize=20'
Invoke-Claudio Get '/api/kugou/playlists/tracks?listid=12'
Invoke-Claudio Get '/api/plays?limit=20'
Invoke-Claudio Post '/api/feedback' @{ kind = 'like'; title = '晴天'; artist = '周杰伦' }
```
