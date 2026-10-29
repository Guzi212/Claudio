# PROGRESS

基线：origin/main 3270098，`npm test` 57 文件 / 493 用例 / 跳过 0（已核对）。

目标：`/api/proxy` 只转发酷狗音频与图片域名，挡住 SSRF；分享链接域名严格匹配；未匹配列表报错按纯文本显示；补文档。

顺序：任务 0 基线 → 1 代理白名单（proxy-guard.js + 每跳复查）→ 2 分享链接 → 3 报错纯文本 + sw v15 → 4 文档 → 提交开 PR。

最大风险：酷狗实际 CDN 域名超出 `kugou.com` / `kgimg.com` 时个别歌放不出来；兜底是 `CLAUDIO_PROXY_ALLOWED_HOSTS` 追加，且不按解析后 IP 拦（Clash fake-IP 会误伤）。

## 进度
- [x] 任务 0：基线核对 57/493/跳过 0
- [x] 任务 1：`server/proxy-guard.js` + `/api/proxy` 403 + `beforeRedirect` 逐跳复查。反向验证：判定函数临时永远 true → 24 failed / 12 passed；还原 → 36 passed。
- [x] 任务 2：`kugou-share-url.js` 改严格匹配 + 重定向后复查（新增 6 个用例，原 7 个照样过）。
- [x] 任务 3：`profile.js` 报错改 `createElement` + `textContent`；`sw.js` v14 → v15，三处版本断言同步。
- [x] 任务 4：README「监听地址与鉴权」加「音频代理只转发酷狗域名」小节；`.env.example` 加 `CLAUDIO_PROXY_ALLOWED_HOSTS`。
- [x] 全量 `npm test`：60 文件 / 537 用例 / 跳过 0。
- [x] 真实运行验收：`PORT=8123 node server/app.js`，6 个恶意目标全 403，`https://www.kugou.com/` 正常转发 200。

## 取舍记录
- 不做 DNS 解析后按 IP 拦：Clash fake-IP 会把酷狗域名解析到 198.18.x.x，按 IP 拦会误杀正常播放。只排除「主机名本身就是 IP」。
- 未给 `/api/proxy` 设 `maxRedirects`：沿用 axios 默认 21，每一跳都由 `beforeRedirect` 判定，链长不是风险点。
- 分享链接只加「最终地址复查」，没给短链请求加 `beforeRedirect`：任务书只要求复查，加逐跳判定会多一次改动面，收益边际。
