# Worktree TASK · feat/settings-api

> 这是 git worktree 的一个分支视图。同时还有两个 worktree 在改 `pwa/*`（feat/three-views 和 feat/lyrics-env-strip）。
> **你只能改 server/ 和 tests/。不要碰 pwa/ 任何文件。**

## 任务

在后端添加四类能力，给 PWA 三视图（W2）和歌词组件（W3）依赖。三个 worktree 大致同时干活，所以**契约必须严格按下面写**，别自己发挥重命名字段。

## 1. 集成配置层 · `server/services/settings.js`（新文件）

`weather.js` / `tts.js` 现在都直接读 `process.env.OPENWEATHER_API_KEY` / `FISH_API_KEY`。改成走一个统一的 settings 层，**优先从 `state.db.prefs` 读，回退到 .env**。这样 PWA 能改 settings 不用动 .env。

```js
// server/services/settings.js
export const KEYS = [
  'openweather_api_key',
  'openweather_city',
  'fish_api_key',
  'fish_voice_id',
];

export function getAll() {
  // 返回 { openweather_api_key: '...', ... } · 优先 prefs · 否则 .env 同名 KEY（大写）
}

export function set(key, value) {
  // 校验 key 在 KEYS 里 · 写 state.db.prefs · value 为空字符串则 delPref
}

export function get(key) {
  // 单个读
}
```

然后修改：
- `server/services/weather.js` 顶部不再 `process.env.OPENWEATHER_API_KEY`，改成 `settings.get('openweather_api_key')`
- `server/services/tts.js` 类似

注意：weather.js 现在缓存 60 秒，settings 变更后缓存会变陈旧。给 `weather.js` 加一个 `invalidateCache()` export，PUT settings 时 app.js 会调它。

## 2. `/api/settings` GET / PUT

挂在 `server/app.js`（**这是唯一允许你改 app.js 的地方**：在合适位置加新路由，不要重写已有结构）。

```
GET /api/settings
  → { openweather_api_key: '****已配置' | '', openweather_city: 'Shanghai', fish_api_key: '****已配置' | '', fish_voice_id: '...' }
  · key 永远不回原文，配置过返回 mask，未配置返回空字符串。城市和 voice_id 这种非密钥字段返回真值。

PUT /api/settings
  body: { openweather_api_key?, openweather_city?, fish_api_key?, fish_voice_id? }
  · 只更新 body 里出现的字段
  · 字段为空字符串 → 清除
  · 字段为 '****已配置' → 视作"不变更"（前端把 GET 来的占位回传时跳过）
  · 调 weather.invalidateCache() / tts 不需要（无缓存）
  → 200 { ok: true, applied: [...field names that changed] }
```

mask 规则：API key 之类的敏感字段，已配置时返 `****已配置`，避免暴露原值；非敏感（city / voice_id）回真值。

## 3. `/api/taste` PUT 写回 taste.md

```
PUT /api/taste
  body: { taste?: string, routines?: string }
  · 同步写 user/taste.md 和 user/routines.md
  · taste.md 里如果有 <!-- kugou-distilled:start --> 区块，PWA 提交时只动那之外的部分，蒸馏区由 scripts/import-kugou-data.js 维护，**不要被前端覆盖**
  → 200 { ok: true }
```

具体策略：
- 读现有 taste.md，找 `<!-- kugou-distilled:start -->` 到 `<!-- kugou-distilled:end -->` 的整块
- 如果 body 里 taste 是 _不包含_ 蒸馏区的，则把蒸馏区原样拼回去再写
- 如果 body 里 taste _包含_ 蒸馏区，按 body 写（用户在 UI 里没改蒸馏区时直接整文 GET-PUT 也行）

## 4. `/api/lyric?hash=...`

挂在 app.js。透传 `services/kugou.js` 的 `lyric(hash)`。

```
GET /api/lyric?hash=<kugou file hash>
  → 200 { lyric: 'LRC 文本' } · 拿不到时 { lyric: null }
  → 400 missing hash
```

## 5. `/api/health/integrations`

让 Settings 视图能可视化"哪个集成现在能用"。

```
GET /api/health/integrations
  → {
      kugou:    { ok: bool, detail: 'cookie alive' | 'cookie missing' | '...' },
      weather:  { ok: bool, detail: 'configured' | 'no key' | 'api error' },
      tts:      { ok: bool, detail: 'configured' | 'no key' },
      lark:     { ok: bool, detail: 'lark-cli ok' | 'not installed' | 'not logged in' }
    }
```

不要真打外部 API（避免 GET 一次健康检查就消耗一次 OpenWeather quota）。只检测"配了 key 没"、"lark-cli 进程能跑起来不"这种本地状态。

## 触碰的文件

允许：
- 新建 `server/services/settings.js`
- 修改 `server/services/weather.js`、`server/services/tts.js`（仅改读 key 的来源）
- 修改 `server/app.js`（**仅在文件末尾的路由块加新 endpoint**，不要重排已有逻辑）
- 新建 `tests/settings.test.js`、`tests/lyric.test.js`、`tests/health.test.js`、`tests/taste-put.test.js`
- 修改 `tests/weather.test.js`、`tests/tts.test.js` 适配新的 settings 来源

禁止：
- pwa/ 任何文件
- server/scheduler.js
- server/context.js
- server/claude.js
- server/router.js
- server/db.js（用 dbApi.getPref/setPref 接口即可）
- prompts/, user/

## 验收

- [ ] `npm test` 全绿，新加至少 12 个用例
- [ ] curl GET/PUT /api/settings 行为符合契约（mask 规则、空字符串清除）
- [ ] curl GET /api/lyric?hash=... 在 KuGouMusicApi 上游有歌词时能透传
- [ ] curl GET /api/health/integrations 返四个 key 都非空且类型对

## 起手

```powershell
Set-Location "D:\Claude code\works\Claudio-settings-api"
npm install
npm test    # 应该绿，先看基线
# 然后开始干活
```

完工后：`git add -A && git commit -m "feat: settings-api · 集成配置 + lyric + taste 持久化"`，等三路 merge。
