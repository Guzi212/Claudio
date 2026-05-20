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
