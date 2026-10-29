# BLOCKED

无阻塞项。任务 0–4 全部完成，没有卡住的地方。

## 顺手活（按任务书要求只记录、不动手）

- **其它 `err.message` 外泄**：`server/api/boot.js:95`、`server/api/chat.js:134`、`server/api/kugou-import-api.js:67`、`server/api/kugou-relogin.js:154/169/180`、`server/api/playlists.js:66/87/124/156` 等仍把 `err.message` 直接放进响应体。这些接口都要过鉴权，单机自用收益小，本轮没改。
- **其它 `innerHTML`**：`pwa/views/player.js:785`（队列列表）和 `player.js:192`（`addBubble` 的 meta）走 `innerHTML`，但字段都先过了 `escapeHtml`，看起来是有意为之，本轮没动。`pwa/views/profile.js:91/98` 剩下两处写死的字面量（「加载中…」「暂无未匹配歌曲」）不含变量，没改。
- **依赖升级**：`npm ci` 报 18 个漏洞（4 moderate / 9 high / 5 critical）。本轮按要求不新增、不升级依赖。
- **`/api/proxy` 未设 `maxRedirects`**：沿用 axios 默认值（21 跳），每一跳都由 `beforeRedirect` 重新判定，链长本身不是风险点，所以没动。
- **PR #6**：按要求不关闭、不 merge，留给领导处理。
- **`docs/devlog.md` 未提交**：仓库的 post-commit hook 会在每次提交后自动追加一行 devlog。它不在本次允许修改的文件白名单里，所以工作区里这一行改动故意留在未提交状态，没有进 PR。后续谁提交都会再生成一次。
