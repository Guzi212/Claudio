# 安全策略

## 报告漏洞

请不要在公开 Issue 或讨论区里贴出可利用细节、`.env` 内容、cookie、token 或账号密码。

请通过 GitHub 的私密漏洞报告入口提交：

- 仓库页面 → **Security** → **Report a vulnerability**

## 重点关注

- 鉴权绕过：`CLAUDIO_API_TOKEN`、会话 cookie、WebSocket 升级校验
- Host / Origin 白名单绕过（DNS 重绑定）
- `/api/proxy` 的 SSRF（目标域名白名单、重定向、IP 字面量）
- 路径遍历、命令注入、XSS
- 日志或错误信息泄露 `.env`、token、cookie 或账号信息

## 已知边界

- Claudio 通过社区维护的上游音乐接口服务（如 KuGouMusicApi 及可选的网易云 / QQ 音乐上游）获取曲目信息，不包含也不保证上游服务本身的安全性。
- 默认只监听 `127.0.0.1`。把服务暴露到局域网或公网前，请先阅读 [README.md](README.md) 里的「监听地址与鉴权」。
- 不要把 `.env`、`.mcp.json`、`user/*.local.md`、`user/music/*.local.*` 等敏感或个人文件提交到仓库。
