# 安全策略

## 报告漏洞

请不要在公开 Issue 里贴出可利用细节、token、cookie 或账号密码。

优先使用 GitHub 的私密报告入口：

- 仓库页面 → **Security** → **Advisories** → **Report a vulnerability**

如果无法使用该入口，可以通过 GitHub 私信维护者 [@Guzi212](https://github.com/Guzi212)。

## 重点关注

- 鉴权绕过：`CLAUDIO_API_TOKEN`、会话 cookie、WebSocket 升级校验
- Host / Origin 白名单绕过（DNS 重绑定）
- `/api/proxy` 的 SSRF（目标域名白名单、重定向、IP 字面量）
- 路径遍历、命令注入、XSS
- 日志或错误信息泄露 token、cookie、账号

## 已知边界

- Claudio 通过社区维护的 KuGouMusicApi 访问酷狗，不包含也不保证上游服务的安全性。
- 默认只监听 `127.0.0.1`。把服务暴露到局域网或公网前，请先阅读 `docs/manual.md` 里的「监听地址与鉴权」。
- 不要把 `.env`、`user/*.local.md`、`claudio/*.local.md` 提交到仓库。
