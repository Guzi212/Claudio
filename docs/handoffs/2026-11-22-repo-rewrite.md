
## 2026-11-22 仓库脱敏重写（开源前清理）

**背景**：仓库将开源，清理历史中的个人数据与本机路径。loic 批准 force push。

**已清除（全历史，filter-repo）**：
- 删除路径：`user/taste.md`、`user/routines.md`、`user/music/kugou_raw.md`、`user/music/kugou_taste_summary.md`、`HANDOVER.md`、`.serena/`
- 文本替换：`C:\Users\13479`→`C:\Users\<user>`、`D:\works`→`D:\<workspace>`、`/home/box`→`/home/<user>`、`mymind-ro`→`<vault>`

**当前机制**：`user/*.local.md`、`user/music/*.local.*` 已入 `.gitignore`；代码内建 `.local` 优先读取（`server/services/user-files.js`）。本机真实数据在 `user/taste.local.md`、`user/routines.local.md`，未进 git。

**遗留风险**：已合并 PR #4/#5/#21/#29/#41 的 diff 视图仍含个人数据（GitHub 缓存，force push 影响不到）。需 GitHub Support 手动清：https://support.github.com/contact/private-information

**备份**：`D:\works\Claudio-mirror-backup-2026-11-22.git`（clone --mirror，含全分支历史），登记进 `agents-home/备份清单.md`，可删除日期 2026-12-22。

**影响**：全部远程分支已 force push 重写后历史。open PR #39（feat/play-window-mode）mergeable=CONFLICTING，merge 时需重开或 rebase。各 worktree 的本地分支 ref 已重写，checkout 的 worktree 需 `git fetch` + reset 到新 ref 才能继续工作。
