# Claudio · 个人 Claude AI 电台

个人 AI 电台项目。Claude 做大脑，根据品味语料 + 当前时间 + 历史播放推荐歌曲；酷狗音乐负责检索 + 直链；浏览器 PWA 播放。

架构：`router → context → claude → state.db → services/kugou`

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
