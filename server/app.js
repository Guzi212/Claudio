import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import axios from 'axios';
import 'dotenv/config';

import { buildSystemPrompt } from './context.js';
import { ask as claudeAsk } from './claude.js';
import { dbApi } from './db.js';
import { ensureLogin, startAutoRefresh, stopAutoRefresh } from './services/kugou-login.js';
import { start as startScheduler } from './scheduler.js';
import { brainMode, startBrainServices } from './brain.js';
import { playbackStatus, applyProgress } from './playback-control.js';
import { readSavedVolume, createVolumeSaver } from './volume-store.js';
import { mountTtsRoutes } from './tts.js';
import { mountSettingsRoutes } from './api/settings.js';
import { mountLyricRoute } from './api/lyric.js';
import { mountWeatherRoute } from './api/weather.js';
import { mountTasteRoutes } from './api/taste.js';
import { mountHealthRoute } from './api/health.js';
import { mountKugouReloginRoutes } from './api/kugou-relogin.js';
import { mountStudioRoutes } from './api/studio.js';
import { mountTestRoutes } from './api/test.js';
import { mountPlaylistRoutes } from './api/playlists.js';
import { mountExternalQueueRoutes } from './api/external-queue.js';
import { mountBootRoute } from './api/boot.js';
import { mountChatRoute } from './api/chat.js';
import { mountControlRoute } from './api/control.js';
import { mountPlaysRoutes } from './api/plays.js';
import { mountSearchRoute } from './api/search.js';
import { applyRuntimePlayback } from './queue-source.js';
import { stateBroadcast } from './runtime-events.js';
import { authMiddleware, authorizeUpgrade } from './auth.js';
import { hostGuard } from './host-guard.js';
import { mountSessionRoute } from './session.js';
import { resolveListenHost } from './listen.js';
import { axiosProxyOptions } from './outbound-proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 8080;
const HOST = resolveListenHost();

const app = express();
// Host 白名单放在静态文件和 JSON 解析之前，对不上直接 403。
app.use(hostGuard);
app.use(express.json({ limit: '1mb' }));

// 简单运行时状态（in-memory）：当前 queue + 索引
const runtime = {
  queue: [],      // [{title, artist, kugouId, audioUrl, ...}]
  index: 0,       // 当前播放索引
  paused: false,
  lastSay: '',
  active: false,  // PWA 是否连着 WS（scheduler 的 hourly-mood 凭这门禁）
  queueSource: null, // bot | boot | claude | playlist | scheduler
  trackEnded: false, // 当前这首已自然结束；外部队列要到最后一首结束才算放完
  volume: readSavedVolume(dbApi), // 0-100，prefs 里的上次音量；没有则默认 30
  currentTime: 0,
  duration: 0,
  lastReason: '',
};

const wss = new WebSocketServer({ noServer: true });
const wsClients = new Set();

function broadcast(event) {
  const payload = JSON.stringify(event);
  for (const ws of wsClients) {
    if (ws.readyState === 1) {
      try { ws.send(payload); } catch { /* ignore */ }
    }
  }
}

// ────────────────────────────────────────────────────────
// 静态：PWA
// ────────────────────────────────────────────────────────
app.use(express.static(path.join(ROOT, 'pwa'), { extensions: ['html'] }));

// 静态壳层保持公开。/api/* 与 /tts/* 走鉴权。
// 默认回环放行；CLAUDIO_REQUIRE_TOKEN 打开后回环也要令牌或会话 cookie。
app.use(authMiddleware);
mountSessionRoute(app);

// ────────────────────────────────────────────────────────
// API
// ────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

function statusBody() {
  return playbackStatus(runtime, { listeners: wsClients.size, brain: brainMode() });
}

app.get('/api/now', (req, res) => {
  res.json(statusBody());
});

app.get('/api/status', (req, res) => {
  res.json(statusBody());
});

app.get('/api/taste', (req, res) => {
  try {
    const taste = fs.readFileSync(path.join(ROOT, 'user', 'taste.md'), 'utf8');
    const routines = fs.readFileSync(path.join(ROOT, 'user', 'routines.md'), 'utf8');
    res.json({ taste, routines });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 快速启动：跳过 TTS 合成，直接返回完整队列。
// 外部点歌还没放完时，boot 在 Claude 返回之后放弃覆盖，见 server/api/boot.js。
const volumeSaver = createVolumeSaver({ db: dbApi, initial: runtime.volume });
const rememberVolume = (value, opts) => volumeSaver.remember(value, opts);
const brainDeps = { getRuntime: () => runtime, broadcast, brain: () => brainMode() };
mountBootRoute(app, brainDeps);
mountChatRoute(app, { ...brainDeps, rememberVolume });
mountControlRoute(app, { getRuntime: () => runtime, broadcast, db: dbApi, rememberVolume });
mountPlaysRoutes(app);
mountSearchRoute(app);

// 音频代理：破酷狗防盗链 + 支持 Range
// timeout 只覆盖 connect 阶段（10s），body 流式读取不限时（长歌可能 5+ min）。
app.get('/api/proxy', async (req, res) => {
  const url = req.query.u;
  if (!url) {
    res.status(400).send('missing u');
    return;
  }

  const range = req.headers.range;
  const ac = new AbortController();
  // 客户端中途断开时（用户切歌 / 关页面）立刻终止上游拉流，不浪费带宽
  req.on('close', () => ac.abort());

  try {
    const target = decodeURIComponent(url);
    const upstream = await axios.get(target, {
      responseType: 'stream',
      headers: {
        Referer: 'https://www.kugou.com',
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
        ...(range ? { Range: range } : {}),
      },
      timeout: 10_000,        // connect / 首字节超时
      timeoutErrorMessage: 'upstream first-byte timeout',
      signal: ac.signal,
      validateStatus: s => s >= 200 && s < 400,
      // CDN 走 KUGOU_PROXY；目标若是 127.0.0.1 / localhost 则强制直连。
      ...axiosProxyOptions(target),
    });

    for (const h of ['content-type', 'content-length', 'accept-ranges', 'content-range']) {
      const v = upstream.headers[h];
      if (v) res.setHeader(h, v);
    }
    res.status(upstream.status);

    // 拿到 response 后清掉 axios 的 timeout，body 读取不限时
    if (upstream.request?.socket) {
      upstream.request.socket.setTimeout(0);
    }

    upstream.data.pipe(res);
    upstream.data.on('error', err => {
      if (err.name === 'CanceledError' || err.code === 'ERR_CANCELED') return; // 客户端正常断开
      console.error('[proxy] upstream stream error:', err.message);
      try { res.end(); } catch { /* */ }
    });
  } catch (err) {
    if (err.name === 'CanceledError' || err.code === 'ERR_CANCELED') return;
    console.error('[proxy] failed:', err.message);
    if (!res.headersSent) res.status(502).send('upstream failed: ' + err.message);
    else try { res.end(); } catch { /* */ }
  }
});

// PWA 通知队列指针变化。前端是 audio 元素的真实播放方，服务端只是镜像状态。
// 两种调用方式：
//   POST /api/runtime/advance              → 自然往后一首
//   POST /api/runtime/advance {index: N}   → 强制对齐到 N（推荐：前端按钮触发时使用）
app.post('/api/runtime/advance', (req, res) => {
  const explicit = req.body?.index;
  if (typeof explicit === 'number' && Number.isFinite(explicit)) {
    applyRuntimePlayback(runtime, { index: explicit, ended: false });
  } else if (runtime.index < runtime.queue.length - 1) {
    applyRuntimePlayback(runtime, { index: runtime.index + 1, ended: false });
  }
  broadcast(stateBroadcast(runtime, req.body?.clientId));
  res.json({ ok: true, index: runtime.index });
});

// 全量 sync：前端把 paused / 当前这首是否结束也推回来（按钮触发时使用）。
// clientId 原样放进广播的 origin。页面认出是自己刚报的，就不再跟着重播或暂停。
app.post('/api/runtime/state', (req, res) => {
  const { index, paused, ended, clientId } = req.body || {};
  const playback = applyRuntimePlayback(runtime, { index, paused, ended });
  broadcast(stateBroadcast(runtime, clientId));
  res.json({ ok: true, index: playback.index, paused: playback.paused });
});

// TTS 路由（/tts/<sha1>.mp3 读 cache/tts/<sha1>.mp3）
mountTtsRoutes(app);

// W2/W3 视图依赖的扩展 API
mountSettingsRoutes(app);
mountLyricRoute(app);
mountWeatherRoute(app);
mountTasteRoutes(app, { rootDir: ROOT });
mountHealthRoute(app);
mountKugouReloginRoutes(app);
mountStudioRoutes(app, { getRuntime: () => runtime });
mountTestRoutes(app);
mountPlaylistRoutes(app, { runtime, broadcast });
mountExternalQueueRoutes(app, { runtime, broadcast });

// ────────────────────────────────────────────────────────
// HTTP server + WS upgrade
// ────────────────────────────────────────────────────────
const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  const decision = authorizeUpgrade(req);
  if (!decision.ok) {
    const statusText = { 401: 'Unauthorized', 403: 'Forbidden' };
    if (decision.status && statusText[decision.status]) {
      socket.write(`HTTP/1.1 ${decision.status} ${statusText[decision.status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => {
    wsClients.add(ws);
    runtime.active = true;
    ws.send(JSON.stringify({ type: 'hello', runtime }));
    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg?.type === 'progress') {
        const before = runtime.volume;
        applyProgress(runtime, msg);
        if (runtime.volume !== before) volumeSaver.remember(runtime.volume);
      }
    });
    ws.on('close', () => {
      wsClients.delete(ws);
      runtime.active = wsClients.size > 0;
    });
  });
});

// ────────────────────────────────────────────────────────
// 启动
// ────────────────────────────────────────────────────────
async function start() {
  console.log('[claudio] 启动中...');

  const login = await ensureLogin();
  if (!login.ok) {
    console.warn('[claudio] 警告：KuGou 登录未通过，搜索 / 播放可能受限。可继续启动以便先测试 Chat。');
  }

  // 后台低频续期：只有在距上次成功续期超过 KUGOU_REFRESH_INTERVAL_HOURS（默认 24h）
  // 时才真正调 /login/token，避免「每次启动都登录」被上游风控。
  startAutoRefresh();

  // 定时推歌只在 CLAUDIO_BRAIN=internal 时挂上。external 不调用 Claude。
  const scheduler = startBrainServices({
    brain: brainMode(),
    startScheduler,
    schedulerOptions: {
      runtime,
      broadcast,
      log: (...args) => console.log('[scheduler]', ...args),
      ask: claudeAsk,
      buildSystemPrompt,
    },
  });
  console.log(scheduler.started
    ? '[claudio] scheduler 已挂 cron'
    : '[claudio] CLAUDIO_BRAIN=external，跳过定时推歌');

  process.on('SIGINT', () => { stopAutoRefresh(); scheduler.stop(); process.exit(0); });
  process.on('SIGTERM', () => { stopAutoRefresh(); scheduler.stop(); process.exit(0); });

  server.listen(PORT, HOST, () => {
    const shownHost = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;
    console.log(`[claudio] listening on ${HOST}:${PORT}`);
    console.log(`[claudio] PWA:    http://${shownHost}:${PORT}/`);
    console.log(`[claudio] health: http://${shownHost}:${PORT}/api/health`);
  });
}

start().catch(err => {
  console.error('[claudio] 启动失败:', err);
  process.exit(1);
});
