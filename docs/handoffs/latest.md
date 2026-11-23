# 多音乐源接入交接报告（Claudio · 酷狗 + 网易云 + QQ 音乐）

- **日期**：2026-11-23
- **分支**：`feat/multisource`（基于 `2f4f2b3` 本地提交，**未 push**）
- **状态**：代码、测试、UI 校验与三平台真实点歌播放验收已全部通过

---

## 1. Provider 列表与本地部署端口

| Provider | 状态 | 本地服务与目录 | 端口 | 说明 |
| --- | --- | --- | --- | --- |
| `kugou` | 保留原有行为 | `../KuGouMusicApi`（未改动） | `33400` | 复用现有酷狗搜索 / 播放 / 歌词 / 歌单 / 红心与登录态 |
| `netease` | 新增 | `../NeteaseCloudMusicApiEnhanced`（`ENABLE_GENERAL_UNBLOCK=false`） | `33401` | 优先使用上游内置匿名会话（`/search`、`/cloudsearch`、`/song/url/v1`、`/lyric`、`/playlist/track/all`）；VIP 试听片段（`freeTrialInfo`）自动过滤回落 |
| `qq` | 新增 | `../QQMusicApi` + 本仓 `scripts/qq-music-server.py`（`.venv`） | `33402` | 未登录自动降级为搜索（`general_search` 主通道 + `search_by_type`/`quick_search` 兜底）+ 免费曲播放；VIP 曲目无阻塞返回 `unmatched`；支持可选二维码登录端点 `/api/qq/relogin/*` |
| `multi` | 默认聚合模式 | 内部统一编排（`server/services/music.js`） | — | 搜索并行拉取已启用平台并标注 `provider`；点歌解析按 `kugou → netease → qq` 顺序回落；未填写 `NETEASE_API_BASE` / `QQ_API_BASE` 时自动跳过对应平台 |

---

## 2. 核心改动摘要

1. **Provider 抽象层与多源编排**
   - `server/services/providers/base.js`、`scoring.js`、`kugou.js`、`netease.js`、`qq.js`、`server/services/music.js`
   - 统一 `search` / `trackUrl` / `lyric` / `playlist` / `resolveTrack` / `healthCheck` 接口；使用 `netease:<id>` / `qq:<mid>` 编解码区分跨平台标识，兼容原有酷狗纯 hash。
2. **HTTP 接口与防盗链代理**
   - `POST /api/queue/external`：支持批量 `provider` 与曲目级 `tracks[].provider` / `tracks[].id`，`matched` 与队列项保留 `provider`，`kugou_playlist` 写入仅筛选酷狗曲目。
   - 搜索与状态：保留 `GET /api/kugou/search`，新增 `GET /api/music/search?provider=...`、`POST /api/music/play`、`GET /api/music/track-url`、`GET /api/lyric` 多源透传；`GET /api/status` 返回 `provider`（当前曲目平台）、`musicProvider`、`providers`。
   - 可选 QQ 扫码登录路由：`POST /api/qq/relogin/start`、`GET /api/qq/relogin/status`（`server/api/qq-relogin.js`），及 `/api/health/integrations` 新增 `netease` / `qq` 健康探测。
   - `server/proxy-guard.js` 与 `/api/proxy`：`DEFAULT_ALLOWED_HOSTS` 扩展 `music.126.net`、`music.163.com`、`qqmusic.qq.com`、`tc.qq.com`、`y.qq.com`、`y.gtimg.cn`（并在 `scripts/qq-music-server.py` 过滤 QQ 下发的纯 IP CDN 节点），按目标域名设置 `Referer`。
3. **设置与 PWA UI**
   - `server/services/settings.js` & `server/api/settings.js` 新增 `music_provider`（默认 `multi`）。
   - `pwa/index.html`、`pwa/views/settings.js` 新增音源切换下拉 `#set-music-provider`，切换后立即调用 `PUT /api/settings` 生效并持久化到 `state.db`；搜索页接入 `/api/music/search` 并显示平台标签（酷狗 / 网易云 / QQ）；非酷狗曲目禁用酷狗红心按钮；`pwa/sw.js` 缓存版本升至 `claudio-shell-v30`。
4. **开发启动与文档**
   - `.env.example`、`scripts/dev.js` 支持按 `NETEASE_API_BASE` / `QQ_API_BASE` 按需拉起网易云（关停解锁灰色歌曲）与 QQ wrapper（设 `PYTHONDONTWRITEBYTECODE=1`）。
   - `README.md` 补充多音乐源安装与 API 说明；`.gitignore` 增加 Python 字节码忽略规则。

---

## 3. 自动化测试与 UI 验收结果

- **单元测试（`npm test`）**：`81` 个测试文件全绿，`798 passed (798)`（`0` failed / `0` skipped）。
- **PWA UI 隔离验收（`node scripts/verify-radio-ui.mjs`）**：无头 Chrome 校验通过（`ok: true`，`14` 张截图生成，`errors: []`）。

---

## 4. 三平台真实搜索 + 防盗链代理 + 播放进度验收

在隔离临时 `state.db`（端口 `33400` / `33401` / `33402` + Claudio `:8080`，`MUSIC_PROVIDER=multi`，挂载无头 Chrome 播放器 `active: true`）下逐一实测：

| 平台 | 测试曲目 | 搜索实测 | `/api/proxy` Range 实测 | `curl /api/status` 实测 |
| --- | --- | --- | --- | --- |
| `kugou` | `晴天` - 周杰伦（`B3A52A7A958BF0AED0EBFBA2E9A818B7`） | `200` · `15` 条 | `206` · `audio/x-flac` (`0-1023/31633244`) | `provider: "kugou"` · `source: "e2e-kugou"` · `audioQuality: "flac"` · `currentTime: 0.170464` · `duration: 269.746667` |
| `netease` | `海屿你` - 马也_Crabbit（`netease:1973665667`） | `200` · `15` 条 | `206` · `audio/mpeg; charset=UTF-8` (`0-1023/11839725`) | `provider: "netease"` · `source: "e2e-netease"` · `audioQuality: "320"` · `currentTime: 4.42106`（前序 E2E 元数据时长 `duration: 295.940063`） |
| `qq` | `起风了` - 买辣椒也用券（`qq:003hKob536i6FA`） | `200` · `5` 条 | `206` · `audio/mpeg` (`0-1023/5215076`) | `provider: "qq"` · `source: "e2e-qq"` · `audioQuality: "128"` · `currentTime: 2.344791` · `duration: 325.868118` |

附加联调实测：
- 旧入口 `GET /api/kugou/search?q=晴天&artist=周杰伦`：`200` · `15` 条。
- 聚合搜索 `GET /api/music/search?q=起风了&provider=multi`：`200` · 共 `35` 条，命中全部 3 家（`["kugou", "netease", "qq"]`）。
- 未登录 QQ VIP 降级：`POST /api/queue/external` 推 QQ VIP 曲目 `晴天` 直接快速返回 `200`、`matched: []`、`failed: [{ reason: "unmatched" }]`，不阻塞队列。
- 歌词路由：`/api/lyric?hash=netease:1973665667`（长度 `1484`）、`/api/lyric?id=003hKob536i6FA&provider=qq`（长度 `1802`）。
- 音源切换持久化：`PUT /api/settings` `{ music_provider: "netease" }` 后 `/api/status` 的 `musicProvider` 与 `/api/settings` 均实时变为 `"netease"`，恢复 `"multi"` 正常。

---

## 5. 还差什么 / 已知边界

1. **分支未推送、主仓配置未改**：改动保留在本地 `feat/multisource` 分支，未执行 `git push`；未修改生产 `.env` 或生产 `state.db`（主实例需使用时再按 `.env.example` 配置 `NETEASE_API_BASE`、`QQ_API_BASE` 并重启服务）。
2. **外置上游服务目录**：`../NeteaseCloudMusicApiEnhanced` 与 `../QQMusicApi`（及 `.venv`）克隆在工作区同级目录中，独立于本仓库版本控制，换机部署需按 `README.md` 2.1 节重新准备。
3. **QQ 音乐 VIP 曲目与设置页扫码 UI**：当前 QQ wrapper 已支持未登录搜曲与免费曲播放，后端亦提供 `/api/qq/relogin/start` 与 `/api/qq/relogin/status` 接口；但设置页仅展示 QQ 登录/降级状态，尚未增加点按扫码弹窗（若需播放 QQ VIP 曲目，可先调 `/api/qq/relogin/*` 或在 QQ wrapper 配 `.qq-credential.json`）。
4. **网易云匿名会话范围**：已关闭“解锁灰色歌曲”（`ENABLE_GENERAL_UNBLOCK=false`）并使用上游匿名会话；VIP 完整版曲目会在 `NeteaseProvider` 被过滤（不放 30 秒试听片段），在 `multi` 模式下自动回落其他源，若需网易云会员曲库可配置 `NETEASE_COOKIE`。
