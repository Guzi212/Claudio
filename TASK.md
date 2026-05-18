# Worktree TASK · feat/scheduler

> 这是 git worktree 的一个分支视图。`D:\Claude code\works\Claudio` 是 main 分支同时在另一个 Claude 窗口被改（P0 体验补）。**别动 main 在改的文件**：`server/app.js`、`pwa/app.js`、`pwa/manifest.json`、`pwa/styles.css`、`pwa/index.html`。

## 你的任务

实现 `server/scheduler.js` —— 节律调度器，对应施工图第 2 层的"SCHEDULER.JS · 节律调度"。

**功能：**
- 07:00 早间规划：触发一次 chat("早安，规划今天的播放氛围")
- 09:00 早间播报：触发一次 chat("到上班路上了，给我点提气的")
- 每小时 :00 情绪检查：触发一次 chat("当前氛围合适吗？需要换吗？") —— 只在 PWA 处于 active 状态时
- 预留 `addCalendarHook(eventCb)` 接口，给 P1-B 飞书日历调用

**技术约束：**
- 用 `node-cron` 库（已知 maintained，跨平台）
- 不要自己起子进程调 claude；而是 import `claude.ask` + `context.buildSystemPrompt` 走同一条链
- 触发后把结果写回 `runtime`（参考 `server/app.js` 里的 runtime 对象），通过 WS 推给 PWA
- **不要修改 server/app.js** —— 在 scheduler.js 里 export 一个 `start({ runtime, broadcast, log })`，main 那边以后会调它

**接口契约（你要 export 的）：**
```js
// server/scheduler.js
export function start({ runtime, broadcast, log }) {
  // runtime: 共享的状态对象（见 app.js）
  // broadcast: (event) => void，向所有 WS 客户端推
  // log: 简单 logger
  // 返回 stop() 用于关停所有 cron
}
```

## 触碰的文件（只准改这些）

- 新建：`server/scheduler.js`
- 新建：`tests/scheduler.test.js` —— 测 cron 表达式正确性、能触发回调
- 修改：`package.json` —— 加 `node-cron` 到 dependencies

## 验收

- [ ] `npm install` 没新增编译依赖
- [ ] `npm test` 全绿（含你新加的 scheduler.test.js）
- [ ] `server/scheduler.js` export 了正确的 `start` / `stop` 签名
- [ ] cron 表达式覆盖 07:00 / 09:00 / 每小时
- [ ] 默认不启动任何 cron，要调 `start()` 才启动（便于测试）

## 不要做

- ❌ 接 Fish Audio / TTS（那是 feat/tts 那个 worktree 的事）
- ❌ 接飞书日历 / 天气（那是 feat/env-injection 的事）
- ❌ 改 `server/app.js`（会跟 main 的 P0 改动冲突）
- ❌ 改 PWA 任何文件
- ❌ 改 README / HANDOVER

## 起手命令

```powershell
Set-Location "D:\Claude code\works\Claudio-scheduler"
npm install        # node_modules 不在 git，每个 worktree 独立装
```

完工后：`git add -A && git commit -m "feat: scheduler · 节律调度"`，留着不 merge。最后由主窗口的 Claude 三路 merge。
