# 参与开发

感谢你愿意改进 Claudio。这个项目优先保证“本地能跑、改动可验证、敏感数据不进仓库”。

## 环境与依赖

- Node.js >= 22.12
- 至少一个可用的音乐上游服务：默认 [KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi)（放在仓库同级的 `../KuGouMusicApi`）；可选网易云（NeteaseCloudMusicApiEnhanced）或 QQ 音乐（QQMusicApi），详见 [README.md](README.md)
- 本机 Chrome（仅运行 UI 视觉验收时需要）

依赖管理只使用 **npm**（与 CI `.github/workflows/ci.yml` 一致，仓库不使用 pnpm 或 yarn）：

```bash
npm ci
npm test
```

## 提 Issue

提交 Bug 反馈、功能建议或使用问题时，请使用仓库提供的 Issue 模板（`.github/ISSUE_TEMPLATE/`），按模板补齐复现步骤、环境信息和日志摘要。

不要在公开 Issue 中粘贴 `.env`、cookie、token 或账号密码。

## 分支与 worktree

- 不要直接在 `main` 上改代码。
- 一个任务一个分支：`feat/<描述>` 或 `fix/<描述>`，全小写、连字符（例如 `feat/lyrics-panel`、`fix/proxy-redirect`）。
- 并行开发建议使用独立 git worktree：

```bash
git fetch origin main
git worktree add ../claudio-<name> -b feat/<name> origin/main
cd ../claudio-<name>
npm ci
```

## 提交前检查

```bash
npm test
```

- 改动 PWA 壳资源（HTML / CSS / JS / 图片）时，必须升级 `pwa/sw.js` 的 `CACHE` 版本，并同步更新测试里的版本断言。
- 用户可感知的功能新增、行为变化或 Bug 修复，请在 `CHANGELOG.md` 中补充一条记录。
- UI 改动建议跑一次视觉验收（需要本机 Chrome）：

```bash
node scripts/verify-radio-ui.mjs <输出目录>
```

## 提交与 PR

- commit message 描述行为变化，不要只描述实现细节。
- 一个 PR 只做一件相关的事。
- PR 描述里写清楚：改了什么、为什么改、怎么验证。
- 等待 `.github/workflows/ci.yml`（`npm ci` + `npm test`）全部通过后再合并。

## 不要提交的内容

- `.env`、token、cookie、私钥、账号密码、`.mcp.json`。
- `user/*.local.md`、`user/music/*.local.*`、`user/taste.learned.md`、`user/session-note.md` 等个人语料与运行时文件。
- `state.db*`、`cache/`、`logs/`。

这些路径已经在 `.gitignore` 里。提交前建议再次确认：

```bash
git status --short
git diff --cached --name-only
```

## 代码风格

- 跟现有文件保持一致：原生 ESM、无前端框架、注释克制。
- 新增依赖前先确认项目里已有可复用的实现。
- 安全相关改动（鉴权、Host 白名单、音频代理、路径处理）请补充对应测试。
