# Claudio 开发规划

> 最近更新：2026-11-24（小晚整理，loic 拍板）

## 当前阶段：多音源落地

### 阶段一：跑通网易云 + QQ 音乐 ✅ 已合并 main，待生产配置

`feat/multisource` 已合并进 main（PR #46，CI 通过；交接单 `docs/handoffs/latest.md`）。
代码侧本地 dev 也实测过：三源聚合搜索 35 条、网易云 320k / QQ 128k 直链与防盗链
代理流均正常、外部点歌 API 推网易云曲目真实推进播放。剩生产上线：
- [ ] 生产 `.env` 补 `NETEASE_API_BASE`（:33401）、`QQ_API_BASE`（:33402）
- [ ] 生产侧把 `../NeteaseCloudMusicApiEnhanced`、QQ wrapper（`scripts/qq-music-server.py` + `.venv`）常驻拉起
- [ ] 生产重启后用真机点歌验收（网易、QQ 各一首）
- [ ] **登录态三统一（loic 2026-11-24 定）**：网易云/QQ 做成跟酷狗一样的扫码登录 UI + 凭证落盘 + 自动续期保活，目标长期不掉线。QQ 需调研 qqmusic-api 的 refreshkey 续期能力；网易云可落 MUSIC_U cookie 到 .env/state.db（MUSIC_U 本来长命）。酷狗现有 cookie 过期需重新扫码

> 现实预期：QQ 风控比酷狗/网易云严，手机端互踢、二次设备验证这类平台行为做不到 100% 不掉，目标是「尽量长效 + 掉了能一键扫码回来」

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
