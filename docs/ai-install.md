# Claudio · AI 一键安装指南（Agent Runbook）

> 本文档面向 AI 编程助手（Claude Code、Codex、Cursor、OpenCode、Antigravity 等）。当你收到用户的“帮我安装 Claudio”指令时，请严格按以下步骤顺序执行，每一步都有明确的检查点与安全边界。

---

## 0. 安全与交互边界（必须遵守）

1. **绝不把明文凭据打印到对话、日志或提交到 Git**：`.env` 已被 `.gitignore` 忽略；写入酷狗密码、Cookie、DeepSeek / Fish Audio API Key 或 `CLAUDIO_API_TOKEN` 后，只汇报“已写入某字段”，不回显明文值。
2. **不自动修改用户全局环境变量、系统代理或已有 Git 分支改动**：除非用户明确同意。
3. **遇到阻塞（如 Node 版本过低、缺少酷狗账号）先向用户说明最小操作，不要静默跳过**。

---

## 1. 环境预检

执行以下命令检查基础环境：

```bash
node -v
npm -v
git --version
```

判定标准：
- **Node.js 必须 `>= 22.12.0`**（Claudio 使用 Node 内置 `node:sqlite`，零 C++ 编译依赖）。
  - 如果 `< 22.12.0`，提示用户通过 `nvm` / `fnm` / 官网升级到 Node 22 LTS 或以上，升级后再继续。
- 记录当前操作系统（Windows PowerShell / macOS / Linux），后续命令按平台适配。

---

## 2. 克隆仓库并安装依赖

约定将 `Claudio` 与上游 `KuGouMusicApi` 放在**同一父目录**下（`npm run dev` 默认读取 `../KuGouMusicApi`）。

1. 确定安装目录（若当前已在 `Claudio` 仓库内，则直接复用当前目录，父目录为 `..`；否则在用户指定目录或当前工作目录下创建）：

```bash
# 若当前不在 Claudio 目录内：
git clone https://github.com/Guzi212/Claudio.git
cd Claudio
```

2. 安装 Claudio 依赖（纯 JS 依赖 + Electron，只用 `npm`，不要用 pnpm/yarn）：

```bash
npm install
```

3. 克隆并安装上游 `KuGouMusicApi`（若 `../KuGouMusicApi` 已存在，跳过 clone，确保依赖已安装）：

```bash
# 从 Claudio 目录执行
if [ ! -d "../KuGouMusicApi" ]; then
  git clone https://github.com/MakcRe/KuGouMusicApi.git ../KuGouMusicApi
fi
(cd ../KuGouMusicApi && npm install)
```

Windows PowerShell 等价写法：

```powershell
if (-not (Test-Path ..\KuGouMusicApi)) {
  git clone https://github.com/MakcRe/KuGouMusicApi.git ..\KuGouMusicApi
}
Push-Location ..\KuGouMusicApi; npm install; Pop-Location
```

---

## 3. 生成并配置 `.env`

1. 若 `.env` 不存在，从模板复制：
   - macOS / Linux：`cp .env.example .env`
   - Windows PowerShell：`Copy-Item .env.example .env`
2. **向用户确认以下 2 项信息**（一次性问清楚，不要多轮碎问）：
   - **酷狗音乐登录方式（必填，二选一）**：
     1. 手机号 + 密码：`KUGOU_USERNAME` 和 `KUGOU_PASSWORD`（推荐，支持自动登录与后台续期）
     2. 浏览器 Cookie：`KUGOU_COOKIE`（登录 kugou.com 后从开发者工具复制）
   - **选歌模式（可选，默认 external）**：
     1. **外部 AI 主持**（默认 `CLAUDIO_BRAIN=external`）：留给 Claude Code / OpenClaw / Grok Bot 等外部 Agent 通过 HTTP API 点歌，无需填 LLM Key。
     2. **内置 AI 点歌 / 常驻 DJ**：将 `CLAUDIO_BRAIN=internal`（和/或 `CLAUDIO_DJ=1`），建议填入 `DEEPSEEK_API_KEY`（比本机 `claude -p` 快 3–5 倍；不填且本机已安装 Claude Code CLI 时自动回退到 `claude -p`）。
     3. **纯本地播放器**：保持默认，不填任何 AI Key，直接在网页/桌面端搜歌、放酷狗歌单。
3. **可选网络代理检查**：
   - 如果用户在 Windows 上开了 Clash / Mihomo 且使用 `fake-ip` 模式，询问其本地 HTTP/mixed 端口（常见 `7890` 或 `7897`），写入 `KUGOU_PROXY=http://127.0.0.1:<端口>`。
   - 若用户不需要代理，保持 `KUGOU_PROXY=` 留空。
4. 引导用户可选编辑 `user/taste.md`（写几行喜欢的歌手或场景偏好，供 AI 选歌参考；不填也能正常启动）。

---

## 4. 启动与端到端验收

1. **运行单元测试**确认基础代码与环境健康：

```bash
npm test
```

预期：全部测试通过（全绿）。

2. **启动服务**（`npm run dev` 会自动按 `.env` 中的 `KUGOU_API_BASE` 先拉起 `KuGouMusicApi`，就绪后再启动 Claudio）：

```bash
npm run dev
```

预期日志依次出现：
```text
[dev] starting KuGouMusicApi: ...
[dev] starting Claudio: ...
[kugou-login] OK · ...
[claudio] 8080 ready · http://127.0.0.1:8080
```

3. **健康检查**：

```bash
curl -s http://127.0.0.1:8080/api/status
```

预期返回 JSON，且包含 `"brain"`、`"volume"`、`"queue"` 等字段。

4. **打开播放器**：
   - **推荐（桌面原生窗口，免自动播放限制）**：另开终端执行 `npm run desktop`（Windows 也可直接运行 `scripts/open-player.ps1`）。
   - **浏览器 PWA**：打开 `http://127.0.0.1:8080`。

---

## 5. 常见故障自愈速查

| 现象 | 原因 | 处理方式 |
| --- | --- | --- |
| `Cannot find module 'node:sqlite'` | Node 版本低于 22.12.0 | 升级 Node.js 至 `>= 22.12.0` |
| `KuGouMusicApi 启动超时` 或端口报错 `EACCES` | Windows Hyper-V/WSL 占用了默认端口，或 `../KuGouMusicApi` 路径不对 | 确认 `.env` 中 `KUGOU_API_BASE=http://localhost:33400`（不要用 3000），并确认 `KUGOU_API_DIR` 指向正确目录 |
| 搜歌/登录超时或连接被重置 | Clash `fake-ip` 拦截了 Node 直连酷狗网关 | 在 `.env` 设置 `KUGOU_PROXY=http://127.0.0.1:<Clash端口>`，并重启 `npm run dev` |
| 浏览器打开后不出声，显示「点击开声」 | 浏览器默认禁止无手势有声自动播放 | 点击页面遮罩开声，或改用 `npm run desktop` / `scripts/open-player.ps1` |
| 搜歌返回 404 | 上游 `KuGouMusicApi` 分支接口路径不同 | 确认克隆的是 `https://github.com/MakcRe/KuGouMusicApi.git`，或检查 `server/services/kugou.js` 顶部的 `ENDPOINTS` |

---

## 6. 交付汇报模板

安装与验收完成后，向用户简要汇报：
- 安装路径（`Claudio` 与 `KuGouMusicApi` 目录）
- 已启用的模式（外部 Agent / 内置 AI / 常驻 DJ / 纯播放器）
- 验收结果（`npm test`、`GET /api/status`、酷狗登录状态）
- 访问地址（`http://127.0.0.1:8080` 或 `npm run desktop`）
- 如需接入外部 Agent 点歌，提示参考 [`docs/api.md`](./api.md)。
