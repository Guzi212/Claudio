---
name: claudio-pr
description: Claudio 项目完整开发流程 — worktree 创建、测试、PR、CI 等待、merge、清理。开始新任务前或任务完成后使用。
---

# Claudio 开发工作流

## 开始新任务（必须执行）

```bash
# 1. 确认在主工作目录
cd /Users/loic/workspace/Claudio

# 2. 拉取最新 main
git fetch origin main && git checkout main && git pull origin main

# 3. 建 worktree（功能/修复分支）
git worktree add ../claudio-<name> -b feat/<name>
# 或 bug 修复：
git worktree add ../claudio-<name> -b fix/<name>

# 4. 进入 worktree
cd ../claudio-<name>

# 5. 安装依赖（package.json 有变化时）
pnpm install
```

分支命名规则：`feat/<功能>` 或 `fix/<问题>`，全小写，连字符。

## 任务完成后（必须执行）

```bash
# 1. 全量测试，必须全部通过
pnpm test

# 2. Push 分支
git push -u origin HEAD

# 3. 创建 PR
gh pr create --title "<标题>" --body "<描述>" --base main

# 4. 等 CI 通过（不要 merge 前跳过）
gh pr checks --watch

# 5. Squash merge
gh pr merge --squash --delete-branch

# 6. 清理 worktree
cd /Users/loic/workspace/Claudio
git worktree remove ../claudio-<name>
git pull origin main
```

## 检查清单

- [ ] `pnpm test` 全部通过
- [ ] commit message 描述行为变化，不描述实现细节
- [ ] 没有 `.env`、私钥、token、cookie 被提交
- [ ] PR 描述说明改动原因
- [ ] CI 全绿后才 merge

## 注意事项

- 禁止直接 push main，禁止在 main 分支上直接改文件
- PR 有冲突时停下来通知用户，不要自动解决
- 每个 worktree 只做一个独立任务
- 注意区分当前 cwd 是主目录还是 worktree 目录
