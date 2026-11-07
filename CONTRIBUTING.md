# 参与开发

感谢你愿意改进 Claudio。这个项目优先保证“本地能跑、改动可验证、敏感数据不进仓库”。

## 环境

- Node.js >= 22.12
- 一个可用的 [KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi) 上游（默认放在仓库同级的 `../KuGouMusicApi`）
- 本机 Chrome（仅运行 UI 视觉验收时需要）

```bash
npm ci
npm test
```

## 分支与 worktree

- 不要直接在 `main` 上改代码。
- 一个任务一个分支：`feat/<描述>` 或 `fix/<描述>`，全小写、连字符。
- 并行任务建议各用独立 worktree：

```bash
git fetch origin main
git worktree add ../claudio-<name> -b feat/<name> origin/main
cd ../claudio-<name>
npm ci
```

## 提交前

```bash
npm test
```

- 改动 PWA 壳资源（HTML / CSS / JS / 图片）时，升 `pwa/sw.js` 的 `CACHE` 版本，并同步测试里的版本断言。
- UI 改动建议跑一次视觉验收（需要本机 Chrome）：

```bash
node scripts/verify-radio-ui.mjs <输出目录>
```

## 提交与 PR

- commit message 描述行为变化，不要只描述实现细节。
- 一个 PR 只做一件相关的事。
- PR 描述里写清楚：改了什么、为什么改、怎么验证。
- CI（`npm ci` + `npm test`）全绿后再合并。

## 不要提交的内容

- `.env`、token、cookie、私钥、账号密码。
- `user/*.local.md`、`claudio/*.local.md`、`user/music/*.local.*` 等个人覆盖文件。
- `state.db*`、`cache/`、`docs/devlog.md`。

这些路径已经在 `.gitignore` 里。提交前可以再确认一次：

```bash
git status --short
git diff --cached --name-only
```

## 代码风格

- 跟现有文件保持一致：原生 ESM、无前端框架、注释克制。
- 新增依赖前先确认项目里已有可复用的实现。
- 安全相关改动（鉴权、Host 白名单、音频代理、路径处理）请补充测试。
