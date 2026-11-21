# Claudio · 进阶配置与排障手册

本文档涵盖远程鉴权、安全白名单、Clash 代理、酷狗口味导入、Windows 全局快捷键以及内部模式调试细节。

---

## 监听地址与鉴权

默认只监听 `127.0.0.1`（`CLAUDIO_HOST`），本机浏览器走回环，`CLAUDIO_REQUIRE_TOKEN` 默认关闭，回环访问无需令牌。

`/api/*`、`/tts/*`（Fish 合成音频）和 WebSocket `/stream` 对非回环来源强制要求令牌。静态页面（HTML / JS / CSS）保持公开且不含密钥。

在 `.env` 配置 `CLAUDIO_API_TOKEN` 后，调用方可使用以下任一方式鉴权：

```http
Authorization: Bearer <token>
X-Claudio-Token: <token>
```

`<audio>` 或部分 WebSocket 客户端无法附带 Header 时，可使用 URL 参数 `?token=<token>`（注意：该值会出现在访问日志中，脚本/Bot 优先用 Header）。

### 反代与内网穿透场景

服务不信任 `X-Forwarded-For`。如果前面套了本机反代或内网穿透（流量来源变成 `127.0.0.1`），务必开启强制令牌模式：

```env
CLAUDIO_API_TOKEN=一段足够长的随机串
CLAUDIO_REQUIRE_TOKEN=1
```

`1` / `true` / `on` / `yes` 均视为开启，开启后回环也必须鉴权（未填令牌直接开启会导致本机也 401）。

本机浏览器只需访问一次带 token 的地址即可换取会话 Cookie：

```text
http://127.0.0.1:8080/?token=你的令牌
```

页面会自动：
1. 用该令牌 `POST /api/session`（仅接受真实令牌，回环免检和旧 Cookie 不能签发新会话）；
2. 服务端种下 `claudio_session` Cookie（`HttpOnly`、`SameSite=Strict`、约 30 天，值为随机会话 ID 而非令牌本身）；
3. 通过 `history.replaceState` 立即清除地址栏中的 `token` 参数；
4. 后续同源 `fetch`、`<audio>` 和 WebSocket 均自动携带该 Cookie。

> 会话保存在进程内存中，Claudio 重启后需重新访问一次 `?token=` 换取 Cookie。请勿将带 `token` 的链接分享给他人。

### 局域网 / 跨机器访问

让另一台机器上的 Bot 或手机访问：

```env
CLAUDIO_HOST=0.0.0.0
CLAUDIO_API_TOKEN=一段足够长的随机串
CLAUDIO_ALLOWED_HOSTS=192.168.1.20,radio.example.com
```

---

## 安全白名单

### Host 白名单（防 DNS 重绑定）

每个 HTTP 请求和 WebSocket 升级都会校验 `Host`，默认仅放行 `localhost`、`127.0.0.1`、`[::1]`（带或不带端口均可）。不匹配返回 `403 { "ok": false, "error": "forbidden host" }`。

通过局域网 IP 或域名访问时，在 `.env` 补充白名单（逗号分隔）：

```env
CLAUDIO_ALLOWED_HOSTS=192.168.1.20,radio.example.com
```

- 只写主机名表示放行任意端口；写成 `radio.example.com:8443` 仅放行该端口。
- IPv6 带端口需写成 `[::1]:8080`。
- WebSocket 同时校验 `Origin`：非浏览器客户端（无 `Origin`）放行但仍过鉴权；浏览器来源必须在同一白名单内。

### 音频代理域名白名单

`/api/proxy` 仅转发 `kugou.com`、`kgimg.com` 及其子域，拒绝非 HTTP/HTTPS、带凭据 URL、纯 IP（含 IPv6 和整数/十六进制 IP）以及跳转到内网的重定向。

若遇到个别合法音频 CDN 被拦截（日志出现 `[proxy] blocked target host=...`），在 `.env` 追加域名（逗号分隔，不带端口和路径）：

```env
CLAUDIO_PROXY_ALLOWED_HOSTS=cdn.example.com,cdn2.example.com
```

---

## Clash / 代理配置

Windows 上 Clash 开启 `fake-ip` 时，Node 直连酷狗网关容易被拦截。以下两种方法任选其一：

### 方法一：走 Clash 本地端口（最简单）

在 `.env` 填写 Clash 的 HTTP / mixed 端口：

```env
KUGOU_PROXY=http://127.0.0.1:7890
```

这会同时生效于两处：
1. Claudio 自身出站（`/api/proxy` 拉取酷狗 CDN、请求 `kugou.com`）；访问 `127.0.0.1` / `localhost` / `::1` 永远直连。
2. `npm run dev` 拉起的 `KuGouMusicApi` 子进程（脚本会自动将 `KUGOU_PROXY` 传递为上游所需的 `KUGOU_API_PROXY`）。

> 若 `KuGouMusicApi` 已在外部独立运行，需重启或自行导出 `KUGOU_API_PROXY`。

### 方法二：Clash 规则放行酷狗直连

在 Clash 配置中把酷狗域名加入 `fake-ip-filter` 并设为 `DIRECT`：

```yaml
dns:
  fake-ip-filter:
    - '+.kugou.com'
    - '+.kgimg.com'

rules:
  - DOMAIN-SUFFIX,kugou.com,DIRECT
  - DOMAIN-SUFFIX,kgimg.com,DIRECT
```

---

## 导入酷狗口味数据（可选）

如果手头有酷狗截图 OCR 文本、分享链接或复制出来的歌单，可一键蒸馏成口味档案供 AI 选歌使用：

```powershell
# 1. 把酷狗 OCR 文本 / 分享链接 / 歌单文本粘贴到 user/music/kugou_input.txt
# 2. 生成歌曲级原始清单 + 口味摘要
npm run music:import:kugou

# 3. 核对 user/music/kugou_raw.md 无误后，写入 user/taste.md
node scripts/import-kugou-data.js --apply-taste
```

建议输入格式示例：

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

生成文件：
- `user/music/kugou_raw.md`：歌曲级原始清单，便于校对
- `user/music/kugou_taste_summary.md`：可读口味摘要
- `user/taste.md` 的酷狗蒸馏区：AI 选歌时读取

---

## 快捷键与媒体键

### 键盘媒体键与空格键（跨平台）

播放页注册了 `navigator.mediaSession`，页面出过声后即可响应键盘媒体键（播放/暂停、上一首、下一首）以及系统音量弹窗里的媒体按钮，窗口在后台也有效。页面在前台且焦点不在输入框时，按空格切换播放/暂停。

### Windows 全局热键 `Ctrl+Alt+K`（常驻监听器，推荐）

仅依赖 Windows 自带 PowerShell 5 和 .NET Framework，零额外软件，后台也能秒级暂停/继续：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\claudio-hotkey-listener.ps1 -Action Start
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\claudio-hotkey-listener.ps1 -Action Status
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\claudio-hotkey-listener.ps1 -Action Stop
```

自定义热键或端口（先 `Stop` 再 `Start`）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\claudio-hotkey-listener.ps1 -Action Start -Hotkey CTRL+ALT+F11 -BaseUrl http://127.0.0.1:9090
```

- 参数与编译预检（不注册热键）：`scripts\claudio-hotkey-listener.ps1 -Action Check`
- 日志位于 `%LOCALAPPDATA%\Claudio\hotkey-listener.log`。
- 如开启了 `CLAUDIO_REQUIRE_TOKEN=1`，需在同一环境中提供 `CLAUDIO_API_TOKEN`，监听器只在内存中读取，不落盘。
- 若遇到错误 `1409`（热键被占用），请更换 `-Hotkey`，或先移除旧版桌面快捷方式热键：
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\claudio-hotkey.ps1 -Action Remove
  ```

### Windows 桌面快捷方式（备选）

若不想常驻进程，可生成桌面快捷方式（冷启动 PowerShell，响应约 2–3 秒，与监听器互斥）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\claudio-hotkey-listener.ps1 -Action Stop
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\claudio-hotkey.ps1 -Action Install
```

---

## 浏览器播放与断线重连

- **Chrome 自动播放**：Chrome 默认拒绝无用户手势的有声自动播放，直接打开时会显示「点击开声」遮罩。推荐使用 `npm run desktop` 启动原生桌面壳，或在 Windows 上运行：
  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts\open-player.ps1
  ```
  该脚本优先拉起 Electron 桌面版；加 `-Browser` 或 `-Tab` 可用带 `--autoplay-policy=no-user-gesture-required` 的独立 Chrome Profile 打开。
- **断线重连**：页面与 `/stream` 保持 WebSocket 长连接，断线后按 `1s → 2s → 4s …`（上限 30s）自动退避重连，恢复后拉取 `/api/now` 补齐状态，无需手动刷新。

---

## `internal` 模式能力与调试技巧

### `CLAUDIO_BRAIN=internal` 专属能力

- `POST /api/boot`：开机让内部 AI 选开播曲目（外部队列未放完时保留不覆盖）。
- `POST /api/chat`：支持自然语言聊天点歌。
- `server/scheduler.js`：定时推歌（07:00 / 09:00 / 每小时；外部队列未放完时跳过）。
- 界面显示聊天框、自动推歌模式、DeepSeek 设置卡片。
- `GET /api/weather` 返回 OpenWeather 实时天气（`external` 模式下返回 `{}` 不发外部请求）。

### 调试技巧

- `state.db` 为标准 SQLite 数据库，可用 [DB Browser for SQLite](https://sqlitebrowser.org/) 查看 `messages` / `plays` / `feedback` / `unmatched` / `prefs` 表。
- 酷狗检索未匹配的歌曲都记录在 `unmatched` 表中。
- `internal` 模式下若 AI 输出非 JSON，PWA 会把原文当作 `say` 显示，可检查 `prompts/dj-persona.md`。
- 仅调试 Claudio 后端（不自动启动 KuGouMusicApi）：`npm run dev:app`。
