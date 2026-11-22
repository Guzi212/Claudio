# Claudio v2 五方向核验报告

- 日期：2026-11-15
- 仓库 / 工作区：`D:/<workspace>\claudio-v2`（既有 worktree，未新开并行写入者）
- 分支：`feat/claudio-v2`
- 核验基线：`7938a79`（含五个本地提交）
  - `5351083` feat(memory): 情境记忆学习引擎、画像遥测表与本地个人档案优先读写
  - `33096a7` feat(agent): 解耦固定 Agent 身份绑定
  - `3111566` feat(desktop): Windows 原生 Electron 无框双态桌面窗口
  - `7d7234c` feat(ui): 极简浅深双主题界面
  - `7938a79` feat(settings): 22 项真实配置链路、连通自检与保存即热生效
- 结论：五个方向均已完成静态核查 + 可后台运行验证；发现并修复 1 个桌面控制桥缺陷，另修正 2 处已过期的 UI 验证脚本断言。未 commit / push / merge / PR / 发布。

## 一、实际执行结果

### 1. 完整测试

```text
npm test
Test Files  74 passed (74)
Tests       707 passed (707)
Exit        0
```

首次基线为 706 个测试；修复桌面控制桥后新增 1 个回归断言，共 707 个。

### 2. 隔离运行烟测（真实服务进程）

- 隔离方式：临时目录 + `CLAUDIO_DB_PATH=<临时目录>/state.db`，工作目录设为临时目录以避免加载项目 `.env`；`CLAUDIO_BRAIN=external`、`CLAUDIO_DJ=0`、`CLAUDIO_REQUIRE_TOKEN=0`；未读取任何生产凭据，未触碰项目 `state.db`（项目根原本不存在该文件）。
- 说明：服务端 `ROOT` 固定指向项目目录，`/api/memory/brief` 会以只读方式统计 `user/taste.md`、`user/taste.learned.md` 的长度；未输出或修改其内容，也未调用会写入用户文件的接口。
- 结果：13 项检查全部通过。
  - `/api/health` 启动可用
  - `/api/settings` 返回 22 项；敏感 key 掩码回传被忽略
  - `PUT /api/settings` 后 WS 收到 `settings-updated`，服务端读回新值
  - 记忆遥测：音量、会话开始/结束
  - `/api/memory/brief`、traits 增删改查、intent 设置/读取/清除
  - `/api/control` 的 `command` 契约、`activeAgent` 跟踪、非法命令 400
  - `/api/health/integrations` 七项集成状态
  - PWA 静态壳、双主题 CSS、Service Worker `claudio-shell-v21`
- 产物：`C:\Users\<user>\AppData\Local\Temp\claudio-v2-smoke-1794674072\`
  - `server.log`、`smoke.log`、`smoke-result.json`

### 3. 双主题 UI（无头 Chrome，隔离预览服务）

```text
node scripts/verify-radio-ui.mjs <临时输出目录>
ok: true
errors: []
```

- 实际读取到的主题值：
  - light：`--bg #F7F6F2`、`--ink #18181B`、`meta #F7F6F2`、`localStorage=light`
  - dark：`--bg #121316`、`--ink #F4F4F6`、`meta #121316`、`localStorage=dark`
- 同时覆盖桌面/宽屏/手机/320px 布局、播放/暂停、上一首/下一首、喜欢/不喜欢、收藏、进度、音量记忆、导航、歌词、空态、internal 模式差异；浏览器异常为 0。
- 产物：`C:\Users\<user>\AppData\Local\Temp\claudio-v2-ui-verify-3\`
  - `verification.json`、`theme-light.png`、`theme-dark.png` 及各视口截图

### 4. 桌面窗口（Electron 自带 verify-dump，隔离用户数据）

```text
electron desktop/main.cjs --url=http://127.0.0.1:<隔离端口> \
  --user-data-dir=<临时目录> --verify-dump=<临时目录> --no-kugou
Exit 0
```

- `report.json`：`ok: true`，`trayReady: true`，标准窗 1042×703，迷你窗 381×137，`isMini: true`。
- 截图确认：标准窗无框标题栏、导航、主持区、空态、页脚正常；迷你窗标题栏、封面占位、等待点歌、上一首/播放/下一首正常。
- 为避免影响本机现有热键，验证前把隔离配置的 `global_hotkey` 设为无效值，`registeredShortcuts` 为空；未注册真实全局热键。
- 产物：`C:\Users\<user>\AppData\Local\Temp\claudio-v2-smoke-1794674072\desktop-verify\`
  - `standard.png`、`mini.png`、`report.json`

## 二、发现并修复的问题

### 1. 桌面控制桥字段不匹配（已修复）

- 位置：`desktop/main.cjs` 的 `sendControl()`。
- 现象：桌面托盘菜单与全局热键发送 `{ action: 'toggle' }`，而 `/api/control` 只读取 `body.command`，实际会返回 400「未知命令」。即桌面壳的播放/暂停、上一首/下一首按钮与热键不生效。
- 修复：改为发送 `{ command, agentId: 'desktop-shell', agentName: 'Desktop Shell' }`；JSON `Content-Type` 原本已正确。
- 回归：`tests/desktop-shell.test.js` 新增静态契约断言，防止再次写回 `action`。

### 2. UI 验证脚本过期（已修复，仅验证工具）

- `scripts/verify-radio-ui.mjs` 仍在校验已被 UI 重构删除的 `.ink-tint` / `data-daypart`，导致脚本在主题段直接抛错。
- 改为校验当前真实的 `claudio:theme` 事件链路：dataset、CSS 变量、body 背景、`meta[theme-color]`、`localStorage`。
- 点踩行为已变为「点踩后自动跳下一首」，原脚本仍按旧行为断言互斥/取消；已改为在队尾曲目上验证互斥与取消，并补充「喜欢二次点击取消」。
- 验证用示例主持人口播从旧的 `Grokbot` 改为中性「外部主持人」，与去 Agent 绑定方向一致。

## 三、五个方向核查结论

| 方向 | 结论 | 证据 |
| --- | --- | --- |
| 记忆系统 | 通过 | 单测 + 隔离烟测：遥测、会话、brief、traits CRUD、intent CRUD、学习画像；DB 迁移幂等 |
| 去 Agent 绑定 | 通过 | `activeAgent` 由控制/外部队列/常驻 DJ 统一维护；PWA 显示动态名称；用户可见 UI 无固定 `Grokbot` |
| 桌面窗口 | 通过（自动化窗口级） | Electron verify-dump 标准/迷你双态截图与 report.json |
| 双主题 UI | 通过 | 无头 Chrome 实测 light/dark 变量、meta、localStorage 与截图 |
| 设置热生效 | 通过（服务端主链路） | 22 项读写、WS `settings-updated`、按需读取、天气缓存失效、scheduler/DJ 重启代码路径 |

## 四、未验项（明确未做）

1. 桌面壳的真实交互验收：托盘菜单点击、全局热键实际触发、关闭到托盘、迷你窗置顶、多显示器/重启后的窗口位置恢复。本次只跑了自动 verify-dump，未做前台点击或全局热键占用。
2. `brain_mode=internal` 与 `dj_enabled=true` 的热重启实际运行：会启动定时任务/常驻 DJ 并调用 Claude 或酷狗，未在隔离烟测中触发。
3. 天气、TTS、AI、飞书/Google 日历的真实连通性：未配置凭据，未发起外部请求。
4. 酷狗登录、搜索、播放、外部队列真实解析：无凭据/上游服务，未验证；相关逻辑由单测覆盖。
5. 真机移动端视觉与触控：仅无头 Chrome 视口模拟。
6. 生产 `state.db` 与生产凭据：全程未触碰、未读取。

## 五、工作区与交付状态

- 未提交改动（3 个文件）：
  - `desktop/main.cjs`
  - `tests/desktop-shell.test.js`
  - `scripts/verify-radio-ui.mjs`
- 未执行：commit、push、merge、rebase、PR、发布、全局设置修改。
- 隔离服务进程与 Electron 进程已停止；临时目录保留供复核，可随时删除。
- 建议下一步：评审并提交上述 3 个文件；需要真机验收时，再单独安排桌面托盘/热键与移动端实机检查。
