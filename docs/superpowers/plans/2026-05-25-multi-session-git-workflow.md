# Multi-Session Git Workflow 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为并行多会话开发建立安全的 git 工作流：强制分支隔离（worktree）+ GitHub Actions CI + main 分支保护 + 无冲突时自动合并。

**Architecture:** CLAUDE.md 规则约束 Claude 会话行为（建分支、用 worktree、开 PR）；GitHub Actions 在每个 PR 上跑 vitest；GitHub 分支保护规则要求 CI 通过才能合入 main，开启 auto-merge，有冲突时通知用户。

**Tech Stack:** git worktree, GitHub Actions, vitest, gh CLI

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `CLAUDE.md` | 新增"多会话开发工作流"章节，规定 worktree + 分支 + PR 规则 |
| 新建 | `.github/workflows/ci.yml` | PR 触发 vitest，结果上报 GitHub checks |
| 配置 | GitHub 仓库设置（gh CLI） | main 分支保护 + auto-merge + 冲突通知 |

---

## Task 1：更新 CLAUDE.md — 多会话开发工作流规则

**Files:**
- Modify: `CLAUDE.md`（在文件末尾新增章节）

- [ ] **Step 1：在 CLAUDE.md 末尾追加工作流章节**

在 `CLAUDE.md` 文件末尾（第 78 行后）添加以下内容：

```markdown

## 多会话开发工作流

并行会话会踩脚。每个任务必须在独立的 git worktree 里进行，禁止直接在 main 分支上改代码。

### 开始任务前（必须执行）

```bash
# 1. 确认当前在主工作目录（不是 worktree）
cd /Users/loic/workspace/Claudio

# 2. 拉取最新 main
git fetch origin main
git checkout main
git pull origin main

# 3. 建分支 + worktree（feat/xxx 或 fix/xxx）
git worktree add ../claudio-<branch-name> -b feat/<branch-name>

# 4. 进入 worktree 工作目录
cd ../claudio-<branch-name>

# 5. 安装依赖（如果 package.json 有变化）
pnpm install
```

### 任务完成后（必须执行）

```bash
# 1. 跑测试，必须全部通过
pnpm test

# 2. push 分支
git push -u origin feat/<branch-name>

# 3. 开 PR（开启 auto-merge）
gh pr create --title "<标题>" --body "<描述>" --base main
gh pr merge --auto --squash

# 4. 清理 worktree（merge 完成后）
cd /Users/loic/workspace/Claudio
git worktree remove ../claudio-<branch-name>
```

### 规则

- 分支命名：`feat/<功能描述>` 或 `fix/<问题描述>`，用连字符，全小写
- 禁止直接 push main，禁止 `git checkout main` 后直接改文件
- PR 有冲突时不要尝试自动解决，停下来通知用户
- 每个 worktree 对应一个独立任务，不在同一 worktree 里做多个无关改动
```

- [ ] **Step 2：验证 CLAUDE.md 格式正确**

```bash
cat CLAUDE.md | tail -60
```

期望：末尾出现"多会话开发工作流"章节，markdown 格式正确。

- [ ] **Step 3：commit**

```bash
git add CLAUDE.md
git commit -m "docs: 新增多会话开发工作流规则（worktree + 分支 + PR）"
```

---

## Task 2：创建 GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1：创建目录并写入 CI 配置**

```bash
mkdir -p .github/workflows
```

创建 `.github/workflows/ci.yml`：

```yaml
name: CI

on:
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: latest

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run tests
        run: pnpm test
```

- [ ] **Step 2：验证 YAML 语法**

```bash
cat .github/workflows/ci.yml
```

期望：文件内容完整，缩进正确，无语法错误。

- [ ] **Step 3：commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: 新增 GitHub Actions CI（PR 触发 vitest）"
```

---

## Task 3：配置 GitHub 分支保护 + auto-merge

**Files:**
- 无本地文件修改，全部通过 `gh` CLI 操作 GitHub 仓库设置

- [ ] **Step 1：push 当前 main 到远端（确保 CI 配置已推送）**

```bash
git push origin main
```

- [ ] **Step 2：开启仓库 auto-merge 功能**

```bash
gh repo edit Guzi212/Claudio --enable-auto-merge
```

期望输出：`✓ Edited repository Guzi212/Claudio`

- [ ] **Step 3：配置 main 分支保护规则**

```bash
gh api repos/Guzi212/Claudio/branches/main/protection \
  --method PUT \
  --header "Accept: application/vnd.github+json" \
  --field required_status_checks='{"strict":true,"contexts":["test"]}' \
  --field enforce_admins=false \
  --field required_pull_request_reviews=null \
  --field restrictions=null
```

> 注意：`"contexts":["test"]` 对应 CI yml 中的 job 名 `test`。如果 CI 从未跑过，GitHub 还不认识这个 check name，需要先有一个 PR 触发 CI 后再重新设置。

- [ ] **Step 4：验证分支保护已生效**

```bash
gh api repos/Guzi212/Claudio/branches/main/protection \
  --jq '{required_status_checks: .required_status_checks.contexts, enforce_admins: .enforce_admins.enabled}'
```

期望输出：

```json
{
  "required_status_checks": ["test"],
  "enforce_admins": false
}
```

- [ ] **Step 5：验证 auto-merge 已开启**

```bash
gh repo view Guzi212/Claudio --json autoMergeAllowed --jq '.autoMergeAllowed'
```

期望输出：`true`

---

## 注意事项

- **CI 首次运行**：分支保护的 `required_status_checks` 只有在 CI job 至少跑过一次后才能被 GitHub 识别。Task 3 Step 3 建议在第一个真实 PR 触发 CI 之后再执行，或先跳过 Step 3，等 CI 跑通后补配置。
- **个人仓库限制**：GitHub Free 版对私有仓库不支持分支保护的 `required_status_checks`（需要 Pro 或 public repo）。若仓库为私有，Task 3 Step 3 会报错，可跳过，仅依赖 CLAUDE.md 规则约束 Claude 行为。
- **worktree 路径**：worktree 目录建议放在主项目同级（`../claudio-feat-xxx`），避免放在主项目目录内被 git 误追踪。
