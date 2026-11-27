# Claudio 开发规划

> 最近更新：2026-11-23（同步已合并项；方向与优先级改由 [`roadmap.md`](roadmap.md) 管）

## 当前阶段：多音源落地

### 阶段一：跑通网易云 + QQ 音乐 ✅ 已合并 main，待生产配置

`feat/multisource` 已合并进 main（PR #46，CI 通过；交接单 `docs/handoffs/latest.md`）。
代码侧本地 dev 也实测过：三源聚合搜索 35 条、网易云 320k / QQ 128k 直链与防盗链
代理流均正常、外部点歌 API 推网易云曲目真实推进播放。剩生产上线：
- [ ] 生产 `.env` 补 `NETEASE_API_BASE`（:33401）、`QQ_API_BASE`（:33402）
- [ ] 生产侧把 `../NeteaseCloudMusicApiEnhanced`、QQ wrapper（`scripts/qq-music-server.py` + `.venv`）常驻拉起
- [ ] 生产重启后用真机点歌验收（网易、QQ 各一首）
- [x] **登录态三统一（loic 2026-11-24 定，PR #47 已合并）**：网易云/QQ 做成跟酷狗一样的扫码登录 UI + 凭证落盘 + 自动续期保活，目标长期不掉线。QQ 需调研 qqmusic-api 的 refreshkey 续期能力；网易云可落 MUSIC_U cookie 到 .env/state.db（MUSIC_U 本来长命）。酷狗现有 cookie 过期需重新扫码

> 现实预期：QQ 风控比酷狗/网易云严，手机端互踢、二次设备验证这类平台行为做不到 100% 不掉，目标是「尽量长效 + 掉了能一键扫码回来」

### 阶段 1.5：播放体验补齐（loic 2026-11-23 提出）✅ 已合并 main

- [x] **播放页显示来源平台**（PR #48）：当前曲目歌名旁加小字标「酷狗音乐/网易云/QQ音乐」
  （nowPlaying.provider 已有，PWA player 渲染即可）

#### 单点播放

现状问题：Electron 窗口拉起播放时，已连着的 PWA 网页端会同步播放同一流，
两个端同时出声。要改成「同一时刻只有一个端出音频」：

已由 PR #48 实现（服务端权威 leader 选举）：

- [x] 播放权（leader）归属：本地窗口（Electron）在场时由它独占播放，PWA 转为只读跟随（同步队列/歌词/进度显示，audio 静音或停流）
- [x] 窗口不在时，PWA 可接管播放；窗口一回来播放权要交回
- [x] 交接时进度无缝：切端不重头，currentTime 连续
- [x] `/api/status` 暴露当前播放端（哪个 client 在出声），健康检查可核对

#### 输入校验加固（2026-11-23 踩坑补）

已由 `7294965` 实现：含 `�` 返回 400，`cover` 缺失在响应里给 warning（未改为必填）。

- [x] `/api/kugou/play` / `/api/music/play` / `/api/queue/external` 对 `track.title`/`artist`/`album` 做 UTF-8 健壮性检查：
  Windows curl 发 GBK 会产出 `EF BF BD`（�）烂数据入队列，服务端应检测 `\uFFFD` 占比 >0 直接 400 拒收
  （或 Content-Type 无 `charset=utf-8` 时警告）；同时把 `cover` 列为必填或明确文档化，避免封面字段静默丢失。

### 阶段 1.6：移动端远程访问 MVP ✅ 本机已通（2026-11-25）

- [x] **Tailscale HTTPS 远程接入已打通**：`tailscale serve` 把本机 :8080 暴露为 `https://<机器>.<tailnet>.ts.net`，
  手机浏览器打开 `?token=` 地址后换 HttpOnly cookie，PWA 可装到主屏。
- [x] 生产 `.env` 已配 `CLAUDIO_HOST=0.0.0.0` + `CLAUDIO_API_TOKEN` + `CLAUDIO_ALLOWED_HOSTS`（含 tailnet 域名/IP），
  完整手机访问 URL 保存在 `D:\works\claudio-runtime\mobile-access.txt`（不入库）。
- [x] 实测回执：tailnet IP 打 `/api/health/integrations` 带 token 200 / 不带 401；`/api/proxy` 转发 kugou 音频流 206 + `audio/flac`。
- [x] loic 真机验收（2026-11-25）：手机能打开 HTTPS 页面并点歌——但**出声仍在电脑**。原因：#48 防双声
  机制让 Electron 客户端固定当播放 leader，手机被压成 follower 静音。修复在 PR #57（「在此设备播放」认领）。
- [ ] 手机端出声待 #57 合并后复验；移动端 UI 适配视图（进度/按钮排布）列为下一阶段。

### 阶段二：补源 + 适配层抽象（待评估）

前提：阶段一在生产环境稳定跑一段时间后再动。

可接的源（服务端能拿直链，bot 可调）：

| 源 | 接入方式 | 备注 |
|---|---|---|
| 酷我 / 咪咕 | `lx-music-api-server`（洛雪音源服务端）或直接写 provider | 咪咕是版权洼地，优先级高 |
| B站 | yt-dlp / bilibili-api | 官方 MV、现场、音源投稿 |
| YouTube Music | `ytmusicapi`（Python wrapper，类似现有 QQ 方案）| 海外/英文曲库 |

明确不接：

- **Apple Music / Spotify / Tidal / Deezer**：官方 API 只有元数据（Spotify 连
  30s 试听已于 2024-11 砍掉），播放强制走各自 SDK + 用户登录态，服务端拿不到
  直链，bot 无人值守播放架构上不可行。
- **汽水音乐 / SoundCloud**：无可用公开接口或社区方案极脆。

适配层方向：现有 `server/services/providers/base.js` 已是雏形；阶段二重点是把
外部音源服务（lx-music-api-server、ytmusicapi wrapper）统一成同一 provider 接口，
并让点歌回落顺序可配置，而不是每接一个源就堆一个特判。

## 历史阶段（已完成）

- 2026-10 ~ 11：纯播放器重构（选歌交给外部 bot）、水墨 UI、外部点歌 API、多音源 provider 架构
