# Claudio · 个人 Claude AI 电台

个人 AI 电台项目。默认 `CLAUDIO_BRAIN=external`：选歌交给外部 Grok Bot（Claudio主持人），Claudio 只负责酷狗检索、直链和浏览器 PWA 播放。设成 `internal` 才由 Claude 根据品味语料 + 当前时间 + 历史播放选歌。

架构（internal 选歌路径）：`router → context → claude → state.db → services/kugou`

## Agent skills

### Issue tracker

Issues 存放在 GitHub（`Guzi212/Claudio`），通过 `gh` CLI 操作。见 `docs/agents/issue-tracker.md`。

### Triage labels

使用默认五标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。见 `docs/agents/triage-labels.md`。

### Domain docs

单一上下文：`CONTEXT.md` + `docs/adr/` 在项目根目录。见 `docs/agents/domain.md`。

## 模型选择清单

接手任务前，先判断任务复杂度，并选择合适能力档位。不要为了省成本牺牲正确性。

### FAST / 低成本模型

用于：
- 单文件小改动
- 文案、样式、配置的小修小补
- 明确 bug，定位已知，改动范围很小
- 简单脚本、格式调整、测试补充
- 阅读和总结代码，不做高风险修改

避免用于：
- 安全、权限、支付、数据迁移
- 跨模块逻辑修改
- 难以复现的 bug
- 需要长期推理或复杂取舍的架构问题

### BALANCED / 中等模型

用于：
- 2-5 个文件内的功能开发
- 常规 API / UI / 数据流修改
- 需要读懂现有模式后实现
- 普通测试失败排查
- 小型重构，但公共接口变化有限

### STRONG / 强模型

用于：
- 跨文件、跨模块、跨服务重构
- 架构设计、复杂状态管理、并发、缓存、权限、安全
- 难复现 bug、CI 长链路失败、性能问题
- 数据库 schema / migration / 兼容性改动
- 公共 API、核心业务逻辑、生产风险较高的改动
- 任务描述不清，但影响面可能较大

### 升级规则

如果出现以下任一情况，必须升级到更强模型或先请求用户确认：
- 连续两次修复失败
- 需要修改超过 5 个相关文件
- 需要理解多个模块之间的隐式约定
- 测试失败原因不明确
- 涉及认证、授权、密钥、支付、数据删除、迁移、部署
- 低成本模型无法清楚解释修改风险

### 工作协议

每次开始任务时先给出：
- 任务复杂度：FAST / BALANCED / STRONG
- 选择理由
- 预计改动范围
- 是否存在需要升级的风险点

如果当前会话模型能力不足，不要硬做；应说明原因并建议切换到更强模型。

## 多会话开发工作流

并行会话会踩脚。每个任务必须在独立的 git worktree 里进行，禁止直接在 main 分支上改代码。

### 开始任务前（必须执行）

```bash
# 1. 确认当前在主工作目录（仓库根，不是 worktree）

# 2. 拉取最新 main
git fetch origin main
git checkout main
git pull origin main

# 3. 建分支 + worktree（feat/xxx 或 fix/xxx）
git worktree add ../claudio-<branch-name> -b feat/<branch-name>

# 4. 进入 worktree 工作目录
cd ../claudio-<branch-name>

# 5. 安装依赖（和 CI 一致用 npm ci）
npm ci
```

### 任务完成后（必须执行）

```bash
# 1. 跑测试，必须全部通过
npm test

# 2. push 分支
git push -u origin feat/<branch-name>

# 3. 开 PR
gh pr create --title "<标题>" --body "<描述>" --base main

# 4. 等 CI 通过后再 merge（检查状态）
gh pr checks          # 等所有 checks 变绿
gh pr merge --squash  # CI 全绿后执行

# 5. 清理 worktree（merge 完成后，回到主工作目录执行）
git worktree remove ../claudio-<branch-name>
```

### 规则

- 分支命名：`feat/<功能描述>` 或 `fix/<问题描述>`，用连字符，全小写
- 禁止直接 push main，禁止 `git checkout main` 后直接改文件
- PR 有冲突时不要尝试自动解决，停下来通知用户
- 每个 worktree 对应一个独立任务，不在同一 worktree 里做多个无关改动

### 文档类改动和清理

本项目覆盖全局「未经授权不 commit / push / 开 PR」的默认规则：

- 只改文档、规则文件、注释或 `.claude/` 配置的改动，检查没问题就直接 commit、push、开 PR，不用先问。不要自己 merge，用户在 PR 上审批。
- 过时、用不上的东西主动清理：已合并 PR 的分支和 worktree、已完成的计划文档、被替代的旧稿、一次性调试脚本和日志。清理了什么写进 PR 描述或汇报。
- 含有未合并的独有提交、对应 PR 还开着、或别的会话正在用的，先问再删。

### 其它约定

- 依赖和测试以 CI（`.github/workflows/ci.yml`：`npm ci` + `npm test`）为准；只用 npm，仓库里没有 pnpm 锁文件
- 每次 commit 后 `.githooks/post-commit` 会往 `docs/devlog.md` 追加一行，提交前留意它
- 改了 PWA 壳资源（HTML/CSS/JS/图片）要升 `pwa/sw.js` 的 `CACHE` 版本，并同步测试里的版本断言
- UI 视觉验收：`node scripts/verify-radio-ui.mjs <输出目录>`（需要本机 Chrome）
