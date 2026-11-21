# Claudio

> **给 AI 主持人准备的本地个人音乐电台** —— 酷狗音乐检索引擎 + 宣纸水墨 / 像素数码双主题 PWA 与 Electron 桌面播放器，支持外部 Agent 点歌、常驻 DJ 自动续歌与品味学习。

Claudio 把「选歌的大脑」和「出声的播放器」解耦：
- 你可以把它交给 **外部 AI Agent**（Claude Code、Codex、OpenClaw、Grok Bot 等）通过 HTTP API 远程点歌、播报串词、管理续播池；
- 也可以开启 **内置 AI / 常驻 DJ**，让它根据你的品味档案、播放反馈和时段自动续歌；
- 或者不配任何 AI，直接当作清爽的 **本地酷狗播放器与歌单工具** 使用。

**核心特性：**
- **零编译安装**：纯 JS 后端 + Node 22 内置 `node:sqlite`，不需要 VS Build Tools 或 C++ 编译环境
- **开箱即用的播放器**：支持浏览器 PWA 与 Electron 桌面原生窗口（免浏览器自动播放限制），内置宣纸水墨与像素数码主题、实时滚动歌词、断线自动重连
- **Agent 友好 API**：完整 REST + WebSocket 控制接口（点歌、播控、搜歌、酷狗歌单读写、红心待分类队列、续播池、TTS 语音串词）
- **常驻 DJ & 品味学习**：按队列余量自动补歌，定期把播放与跳过/红心记录蒸馏成品味画像

---

## 🤖 方式一：让 AI 一键帮你安装（推荐）

如果你正在使用 **Claude Code、Codex、Cursor、OpenCode、Antigravity** 等任意 AI 编程助手，直接复制下面这段话发给它，AI 会自动完成环境检测、克隆仓库与上游、安装依赖、引导填写 `.env` 并验证启动：

```text
请阅读 https://raw.githubusercontent.com/Guzi212/Claudio/main/docs/ai-install.md 并严格按照里面的步骤，帮我在本机安装、配置并验证启动 Claudio。
遇到需要填写酷狗账号或可选 API Key 时再问我，不要把明文凭据打印到对话或提交到 Git。
```

> 如果你已经手动 `git clone` 了本仓库，直接对 AI 说：**「按本仓库 `docs/ai-install.md` 帮我完成安装、配置和启动验证」** 即可。

---

## 🚀 方式二：3 分钟手动上手

### 环境要求

- **Node.js `>= 22.12.0`**（使用内置 `node:sqlite`）
- **Git** 与 **npm**
- 一个 **酷狗音乐账号**（手机号 + 密码，或浏览器登录后的 Cookie）

### 第 1 步：克隆 Claudio 与上游 KuGouMusicApi

Claudio 依赖社区版 `KuGouMusicApi` 获取搜索、直链与歌单数据，建议放在**同一父目录**下（`npm run dev` 会自动一起拉起）：

**macOS / Linux：**
```bash
git clone https://github.com/Guzi212/Claudio.git
git clone https://github.com/MakcRe/KuGouMusicApi.git

cd KuGouMusicApi && npm install
cd ../Claudio && npm install
```

**Windows (PowerShell)：**
```powershell
git clone https://github.com/Guzi212/Claudio.git
git clone https://github.com/MakcRe/KuGouMusicApi.git

cd KuGouMusicApi; npm install
cd ..\Claudio; npm install
```

### 第 2 步：配置 `.env`

在 `Claudio` 目录复制模板：

```bash
# macOS / Linux
cp .env.example .env

# Windows (PowerShell)
Copy-Item .env.example .env
```

打开 `.env`，**最少只需填写酷狗登录信息（二选一）**：

```env
# 推荐：手机号 + 密码（自动登录与后台续期）
KUGOU_USERNAME=你的手机号
KUGOU_PASSWORD=你的密码

# 或者：手动粘贴浏览器登录 kugou.com 后的 Cookie
# KUGOU_COOKIE=...
```

其他常用可选项（按需填写，留空也能正常启动）：
- `DEEPSEEK_API_KEY`：想用内置 AI 点歌或常驻 DJ 时建议填写（比本机 `claude -p` 快 3–5 倍）
- `KUGOU_PROXY`：Windows 开启 Clash `fake-ip` 导致酷狗连不上时，填 `http://127.0.0.1:<Clash端口>`
- `FISH_API_KEY` / `FISH_VOICE_ID`：配置后，主持人口播 `say` 会自动合成语音播报

> 可选：在 `user/taste.md` 写几行你喜欢的歌手和听歌场景，AI 选歌会更贴合你的口味。

### 第 3 步：启动服务与播放器

```bash
npm run dev
```

看到如下输出即表示启动成功（`npm run dev` 会自动先拉起 `../KuGouMusicApi` 在 `33400` 端口，再启动 Claudio）：

```text
[dev] starting KuGouMusicApi: npm start (.../KuGouMusicApi)
[dev] starting Claudio: ...
[kugou-login] OK · ...
[claudio] 8080 ready · http://127.0.0.1:8080
```

然后选择你喜欢的播放界面打开：

| 打开方式 | 命令 / 地址 | 特点 |
| --- | --- | --- |
| **Electron 桌面端（推荐）** | `npm run desktop` | 原生桌面窗口，免浏览器自动播放限制，自动托管后端 |
| **浏览器 PWA** | 打开 `http://127.0.0.1:8080` | 轻量即开，手机 / 电脑浏览器通用 |
| **Windows 启动脚本** | `powershell -ExecutionPolicy Bypass -File scripts\open-player.ps1` | 优先拉起桌面端；加 `-Browser` 或 `-Tab` 用免静音限制的 Chrome 独立配置打开 |

> 桌面端可在设置页「酷狗与桌面窗口 → 点歌窗口」选择被唤起时的行为：默认「后台播放（最小化留任务栏）」不抢焦点，也可切回「弹出窗口」。

### 第 4 步：快速验证

- 终端确认出现 `[kugou-login] OK` 与 `8080 ready`
- 访问 `http://127.0.0.1:8080/api/status` 返回正常 JSON 状态
- 在页面里搜一首歌或播放酷狗歌单确认正常出声
- 可选运行 `npm test` 确认全部单测通过

---

## 🎛️ 三种使用模式

| 模式 | `.env` 配置 | 适用场景 | 是否需要 LLM Key |
| --- | --- | --- | --- |
| **外部 AI 主持（默认）** | `CLAUDIO_BRAIN=external` | 由外部 Agent（Claude Code / OpenClaw / Grok Bot 等）通过 API 点歌、播报串词、维护续播池 | 不需要 |
| **内置 AI / 常驻 DJ** | `CLAUDIO_BRAIN=internal` 和/或 `CLAUDIO_DJ=1` | 开箱聊天点歌、定时推歌，或让常驻 DJ 按队列余量自动补歌与学习品味 | 需要 `DEEPSEEK_API_KEY` 或本机 `claude` CLI |
| **纯本地播放器** | 保持默认 | 直接在界面搜索、播放酷狗歌单、红心收藏 | 不需要 |

---

## 🔌 外部 Agent 接入速览

本机默认监听 `127.0.0.1:8080`（回环免鉴权；跨机器调用见 [远程鉴权配置](./docs/advanced.md#监听地址与鉴权)）。

| 动作 | 接口 | 说明 |
| --- | --- | --- |
| 点歌 / 写歌单 | `POST /api/queue/external` | 传入 `tracks[]`、`say`（串词）、`reason`、`mode`（`replace`/`append`） |
| 播放控制 | `POST /api/control` | `command`: `play` / `pause` / `toggle` / `next` / `prev` / `volume` / `jump` |
| 查询状态 | `GET /api/status` | 获取当前曲目、队列、进度、音量、是否在线 |
| 搜歌 | `GET /api/kugou/search?title=晴天&artist=周杰伦` | 返回候选曲目与匹配打分 |
| 清空队列 | `POST /api/queue/clear` | 清空队列并暂停自动续播（不删续播池） |
| 设置续播池 | `PUT /api/continue-pool` | 队尾自然播完后自动顺序/随机续播，不消耗 AI token |

极简点歌示例：

```bash
curl -X POST http://127.0.0.1:8080/api/queue/external \
  -H "Content-Type: application/json" \
  -d '{
    "tracks": [{ "title": "晴天", "artist": "周杰伦" }],
    "say": "下雨天，先听首周杰伦热热身。",
    "mode": "replace"
  }'
```

完整接口参数、响应格式、常驻 DJ、红心待分类队列与 PowerShell 示例请看 **[docs/api.md](./docs/api.md)**。

---

## ❓ 常见问题速查

- **为什么上游 `KuGouMusicApi` 默认用 `33400` 而不是 `3000`？**
  Windows 开启 Hyper-V / WSL / Docker 时常把 3000 附近划入系统排除端口，非管理员启动会报 `EACCES`。`npm run dev` 会自动传入 `PORT=33400`。如需自定义，修改 `.env` 中的 `KUGOU_API_BASE` 和 `KUGOU_API_DIR`。
- **开了 Clash 后搜歌或登录超时怎么办？**
  在 `.env` 里填 `KUGOU_PROXY=http://127.0.0.1:<Clash端口>` 后重启 `npm run dev`，或在 Clash 规则里将 `kugou.com`、`kgimg.com` 设为 `DIRECT` 并加入 `fake-ip-filter`。详见 [Clash / 代理配置](./docs/advanced.md#clash--代理配置)。
- **浏览器打开后不出声，提示「点击开声」？**
  这是浏览器的自动播放策略限制，点击遮罩即可开声；想要打开即播，推荐使用 `npm run desktop` 或 Windows 下的 `scripts/open-player.ps1`。
- **只想重启 Claudio，不想重启 KuGouMusicApi？**
  运行 `npm run dev:app`。

---

## 📚 完整文档导航

- 🤖 **[AI 一键安装剧本（docs/ai-install.md）](./docs/ai-install.md)**：给 Claude Code / Codex / Cursor / OpenCode 等 Agent 执行的标准化安装 SOP
- 🔌 **[主持人 API、常驻 DJ 与续播池手册（docs/api.md）](./docs/api.md)**：所有 HTTP / WebSocket 接口、字段约束、续播池与 PowerShell 示例
- 🛠️ **[进阶配置与排障手册（docs/advanced.md）](./docs/advanced.md)**：远程鉴权与反代、Host/代理白名单、Clash 代理、酷狗口味导入、Windows 全局快捷键（`Ctrl+Alt+K`）

---

## 📁 目录结构

```text
.
├── server/                    # Node 后端（Express + WS + 音频代理 + node:sqlite）
│   ├── app.js                 # 主入口与路由装配
│   ├── api/                   # 外部点歌、歌单、播控、运行时状态等 API
│   ├── dj/                    # 常驻 DJ 自动续歌与品味蒸馏
│   └── services/              # 酷狗检索/登录续期、设置、TTS 等服务
├── pwa/                       # Progressive Web App（宣纸水墨 / 像素数码主题）
│   ├── index.html
│   ├── app.js
│   ├── views/ & components/   # 播放页、歌单页、品味页、设置页与歌词组件
│   └── assets/                # 主题背景、纹理与图标资源
├── desktop/                   # Electron 桌面原生壳与进程托管
├── scripts/                   # 开发启动（dev.js）、口味导入、桌面/快捷键脚本
├── prompts/                   # 内置 AI DJ 人格与输出约束
├── user/                      # 个人品味语料（taste.md / routines.md）
├── docs/                      # AI 安装剧本、API 手册与进阶配置文档
├── tests/                     # Vitest 单元测试
├── .env.example               # 环境变量模板
└── package.json
```
