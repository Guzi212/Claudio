---
name: kugou-debug
description: 专项诊断酷狗音乐集成问题：cookie 失效、二维码重登失败、API 连接、歌曲搜索/URL 解析错误。遇到酷狗相关 bug 时使用。
---

# 酷狗集成诊断 Agent

## 关键文件

| 文件 | 职责 |
|------|------|
| `server/services/kugou.js` | 核心客户端：search / songUrl / lyric，含 cookie 注入和模糊匹配 |
| `server/services/kugou-login.js` | 账号密码自动登录（KUGOU_USERNAME + KUGOU_PASSWORD） |
| `server/api/kugou-relogin.js` | 扫码重登流程：/start → /status 轮询，写入 state.db kugou_cookie |
| `server/db.js` | dbApi.getPref('kugou_cookie') / setPref — cookie 持久化 |
| `server/api/settings.js` | 前端触发重登的 API 入口 |

## Cookie 优先级

```
KUGOU_COOKIE env → dbApi.getPref('kugou_cookie') → ''（匿名）
```

Cookie 格式：`token=...; userid=...`（由扫码登录成功后自动写入 db）

## 常见失败模式

### 1. Cookie 失效
**症状**：搜索返回空或 403，`songUrl` 拿不到直链
**排查**：
```bash
# 查当前 cookie
node -e "import('./server/db.js').then(m => console.log(m.dbApi.getPref('kugou_cookie')))"
# 或直接查 SQLite
sqlite3 state.db "SELECT value FROM prefs WHERE key='kugou_cookie';"
```
**修复**：在 Settings 界面点击"重新登录"，扫码刷新 cookie

### 2. 上游 KuGouMusicApi 未启动
**症状**：`ECONNREFUSED` 错误，BASE = `http://localhost:3000`
**排查**：`curl http://localhost:3000/search?keywords=test`
**修复**：单独启动 KuGouMusicApi 服务

### 3. 扫码重登失败
**关键状态码**：0=过期, 1=等扫码, 2=等确认, 4=成功
**API 路径**：`POST /api/kugou/relogin/start` → `GET /api/kugou/relogin/status?key=...`
**常见问题**：
- `qrcode_img` / `base64` 字段路径差异（不同 KuGouMusicApi fork 略有不同）
- `_t` 时间戳参数用于破 max-age=120 缓存，缺少时状态轮询不更新

### 4. 搜索结果 hash 为空
**症状**：候选列表返回但 hash 字段为空，`songUrl` 无法工作
**排查**：检查 `kugou.js` 中 `candidates.filter(c => c.hash && c.title)` 前的原始数据
**常见原因**：不同 fork 的字段名差异（`FileHash` vs `hash` vs `SongHash`）

## 诊断步骤

1. **确认 KuGouMusicApi 是否在线**：`curl ${KUGOU_API_BASE}/search?keywords=test`
2. **检查 cookie 是否存在且非空**：查 db 或 env
3. **用 cookie 直接调 API**：`curl -H "Cookie: <cookie>" http://localhost:3000/search?keywords=周杰伦`
4. **运行对应测试**：`pnpm vitest run kugou.test.js kugou-relogin.test.js --reporter=verbose`
5. **检查最近的 server 日志**：关注 `axios` 错误和 HTTP 状态码

## 测试文件

- `kugou.test.js` — search / songUrl 单测
- `kugou-relogin.test.js` — 扫码登录流程（含 mock）
- `kugou-import-api.test.js` — 导入 API
