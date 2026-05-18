# Claudio · 交接文档

## 当前状态（MVP + P0 + P1 都跑通了）

- ✅ PWA chat → Claude → 酷狗 → 浏览器播放（端到端验证通过）
- ✅ P0 体验补：proxy 长流不再 timeout · queue 切歌同步 · autoplay 兜底 · PWA icon
- ✅ P1 三件套已合并 + 接入：
  - **scheduler**（节律调度）— 已挂 cron：07:00 早间规划 · 09:00 通勤 · 每小时情绪检查（PWA 在线时才触发）
  - **tts**（Fish Audio 合成）— 配 key 后 `say` 会被合成 mp3 放队首
  - **env-injection**（天气 + 飞书日历）— context.js 第 3 片已自动注入
- ✅ 测试 57/57 全绿
- ✅ git 历史干净：9 个 commit，main 一路推平

## 启动命令（每天就这套）

```powershell
# 后端音乐源
Set-Location "D:\Claude code\works\KuGouMusicApi"
npm start                     # :3000

# 另开窗口
Set-Location "D:\Claude code\works\Claudio"
npm run dev                   # :8080

# 浏览器
Start-Process "http://localhost:8080/"
```

## 还要做什么（你这边）

### 必填 · 让现有功能真起作用
- [ ] **`user/taste.md`** 自己填几行（喜欢的歌手、风格、场景），现在是空模板 → Claude 推荐才有"你"味
- [ ] **`user/routines.md`** 可选填，填了 scheduler 推荐更准

### 选填 · 打开 P1 模块开关
- [ ] **天气**：去 https://openweathermap.org 申请免费 key，`.env` 填 `OPENWEATHER_API_KEY` + `OPENWEATHER_CITY=Shanghai`（或你的城市英文名）
- [ ] **TTS 真开口**：去 https://fish.audio 注册（付费），`.env` 填 `FISH_API_KEY` + `FISH_VOICE_ID`（在 Fish 控制台 Voice 详情页拿）
- [ ] **飞书日历**：本机跑过 `lark-cli auth login` 即可，无需 .env 配置

### 维护 · 长期使用要注意的事
- [ ] **酷狗 cookie 过期**：如果发现搜歌全 0 匹配，cookie 死了。重扫码：
  ```powershell
  curl.exe --noproxy "*" -o "$env:TEMP\qrkey.json" "http://localhost:3000/login/qr/key?type=web"
  # 然后按今天的流程：拿 key → 生成 PNG → 扫码 → poll check → 更新 cookie
  ```
  （可以做成 PWA Settings 里一个按钮触发，见 P3）

## 还剩的路线图

### P2 · 客厅扩展
- [ ] **UPnP 推 Naim**：用 node-upnp 在 PWA `<audio>` 旁边并存输出 adapter；切换播放目标到客厅音响
- [ ] **多设备同步**：state.db 加 device_id，WS 区分 client

### P3 · 体验打磨
- [ ] **PWA 三视图**（Player / Profile / Settings）：当前只有 Player。Settings 里能编辑 taste.md、看 unmatched、点按钮重扫码
- [ ] **歌词显示**：`/lyric?hash=...` 后端已就绪，前端没接

## 项目地图

```
D:\Claude code\works\
├── Claudio\                    主项目
│   ├── server\
│   │   ├── app.js              Express + WS + proxy + 接所有模块
│   │   ├── router.js           intent 分流
│   │   ├── context.js          ★ async 拼 system prompt（含天气 + 日历）
│   │   ├── claude.js           spawn claude -p
│   │   ├── scheduler.js        ★ node-cron 节律
│   │   ├── tts.js              ★ Fish Audio 合成 + /tts/:hash.mp3
│   │   ├── db.js               node:sqlite 包装
│   │   └── services\
│   │       ├── kugou.js
│   │       ├── kugou-login.js
│   │       ├── weather.js      ★ OpenWeather
│   │       └── lark-calendar.js ★ 通过 lark-cli 读日程
│   ├── pwa\                    chat + audio player 单页
│   ├── tests\                  8 文件 57 用例
│   ├── prompts\dj-persona.md   Claude 的人格 + JSON schema 硬约束
│   └── user\{taste,routines}.md ★ 你的语料（填一填）
├── KuGouMusicApi\              社区版酷狗 API · 独立 :3000
└── (.claude-* 之类的不管它)

C:\Users\13479\.claude\
├── plans\claudio-...goose.md   原始 plan
└── projects\D--Claude-code-works-Claudio\memory\
    ├── user_profile.md         你的偏好
    └── project_claudio.md      项目本身
```

## 提示给明天的 Claude

读这份 + plan + memory 就有全部 context。**架构忠实施工图分层是用户的硬约束**（学习目的）。音乐源是**酷狗**，cookie 在 `state.db.prefs.kugou_cookie`。
