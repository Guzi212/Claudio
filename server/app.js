import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import axios from 'axios';
import 'dotenv/config';

import { dbApi } from './db.js';
import { ensureLogin, startAutoRefresh, stopAutoRefresh } from './services/kugou-login.js';
import {
  ensureLogin as ensureNeteaseLogin,
  startAutoRefresh as startNeteaseAutoRefresh,
  stopAutoRefresh as stopNeteaseAutoRefresh,
} from './services/netease-login.js';
import {
  ensureLogin as ensureQQLogin,
  startAutoRefresh as startQQAutoRefresh,
  stopAutoRefresh as stopQQAutoRefresh,
} from './services/qq-login.js';
import { applyProgress, readSavedScene } from './playback-control.js';
import { createStreamRegistry, leaderBroadcast, progressBroadcast } from './runtime-events.js';
import { readContinuePool } from './continue-pool.js';
import { mountContinuePoolRoutes } from './api/continue-pool.js';
import { mountRuntimeRoutes } from './api/runtime.js';
import { readSavedVolume, hasSavedVolume, createVolumeSaver } from './volume-store.js';
import { mountTtsRoutes } from './tts.js';
import { mountSettingsRoutes } from './api/settings.js';
import { mountLyricRoute } from './api/lyric.js';
import { mountWeatherRoute } from './api/weather.js';
import { mountTasteRoutes } from './api/taste.js';
import { mountHealthRoute } from './api/health.js';
import { mountKugouReloginRoutes } from './api/kugou-relogin.js';
import { mountNeteaseReloginRoutes } from './api/netease-relogin.js';
import { mountQQReloginRoutes } from './api/qq-relogin.js';
import { mountStudioRoutes } from './api/studio.js';
import { mountTestRoutes } from './api/test.js';
import { mountPlaylistRoutes } from './api/playlists.js';
import { mountExternalQueueRoutes } from './api/external-queue.js';
import { mountBootRoute } from './api/boot.js';
import { mountChatRoute } from './api/chat.js';
import { mountControlRoute } from './api/control.js';
import { mountPlaysRoutes } from './api/plays.js';
import { mountSearchRoute } from './api/search.js';
import { mountFavoriteRoutes } from './api/favorites.js';
import { mountLikeRoutes } from './api/likes.js';
import { mountKugouImportApiRoute } from './api/kugou-import-api.js';
import { mountUnmatchedRoute } from './api/unmatched.js';
import { mountMemoryRoutes } from './api/memory.js';
import { resolveReadUserFile } from './services/user-files.js';
import { authMiddleware, authorizeUpgrade } from './auth.js';
import { hostGuard } from './host-guard.js';
import { mountSessionRoute } from './session.js';
import { resolveListenHost } from './listen.js';
import { axiosProxyOptions } from './outbound-proxy.js';
import { checkProxyUrl, createRedirectGuard, findProxyBlock, refererForProxyUrl } from './proxy-guard.js';
import { musicService, getMusicProvider, getEnabledProviders } from './services/music.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export function warnRemovedInternalBrain({ env = process.env, db = dbApi, warn = console.warn } = {}) {
  const candidates = [
    env?.CLAUDIO_BRAIN,
    env?.BRAIN_MODE,
    db?.getPref?.('brain_mode'),
  ];
  const hadInternal = candidates.some(v => String(v || '').trim().toLowerCase() === 'internal');
  if (hadInternal) {
    warn('[claudio] internal 模式已移除，按 external 运行');
  }
  return hadInternal;
}

export function warnRemovedResidentDj({ env = process.env, db = dbApi, warn = console.warn } = {}) {
  const candidates = [
    env?.CLAUDIO_DJ,
    env?.DJ_ENABLED,
    db?.getPref?.('dj_enabled'),
  ];
  const truthy = new Set(['1', 'true', 'on', 'yes']);
  const hadDj = candidates.some(v => truthy.has(String(v || '').trim().toLowerCase()));
  if (hadDj) {
    warn('[claudio] 常驻 DJ 已移除，自动续歌请用续播池或让 Agent 追加');
  }
  return hadDj;
}

export function createApp(options = {}) {
  const db = options.db || dbApi;
  const rootDir = options.rootDir || ROOT;
  const searchDeps = {
    ...(options.search ? { search: options.search } : {}),
    ...(options.multiSearch ? { multiSearch: options.multiSearch } : {}),
  };
  const externalQueueDeps = {
    ...(options.resolveTrack ? { resolveTrack: options.resolveTrack } : {}),
    ...(options.synthesize ? { synthesize: options.synthesize } : {}),
    ...(options.writeTracks ? { writeTracks: options.writeTracks } : {}),
  };
  const continuePoolDeps = {
    ...(options.resolveTrack ? { resolveTrack: options.resolveTrack } : {}),
    ...(options.fetchUserPlaylistTracks ? { fetchUserPlaylistTracks: options.fetchUserPlaylistTracks } : {}),
  };

  const app = express();
  // Host 白名单放在静态文件和 JSON 解析之前，对不上直接 403。
  app.use(hostGuard);
  app.use(express.json({ limit: '1mb' }));

  // 简单运行时状态（in-memory）：当前 queue + 索引
  const runtime = {
    queue: [],      // [{title, artist, kugouId, audioUrl, ...}]
    index: 0,       // 当前播放索引
    queueOffset: 0, // 当前队列累计裁掉的头部曲目数
    paused: false,
    lastSay: '',
    active: false,  // PWA 是否连着 WS
    queueSource: null, // bot | playlist
    trackEnded: false, // 当前这首已自然结束；外部队列要到最后一首结束才算放完
    volume: readSavedVolume(db), // 0-100，prefs 里的上次音量；没有则默认 30
    volumeExplicit: hasSavedVolume(db), // false 表示 30 只是默认值，用户没显式设过
    currentTime: 0,
    duration: 0,
    lastReason: '',
    queuedAt: null,
    queuedSource: '',
    scene: readSavedScene(db),
    continuePool: readContinuePool(db),
  };

  const wss = new WebSocketServer({ noServer: true });
  const wsClients = createStreamRegistry();

  function broadcast(event) {
    const payload = JSON.stringify(event);
    for (const ws of wsClients.clients()) {
      if (ws.readyState === 1) {
        try { ws.send(payload); } catch { /* ignore */ }
      }
    }
  }

  // ────────────────────────────────────────────────────────
  // 静态：PWA
  // ────────────────────────────────────────────────────────
  app.use(express.static(path.join(rootDir, 'pwa'), { extensions: ['html'] }));

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

  // stateBroadcast 的回声规则和续播结束处理集中在 runtime 路由。
  mountRuntimeRoutes(app, {
    runtime, broadcast, db,
    canReportState: clientId => wsClients.canReportState(clientId),
    statusOptions: () => ({
      listeners: wsClients.size(),
      playback: wsClients.snapshot(),
      brain: 'external',
      provider: getMusicProvider(),
      providers: getEnabledProviders(),
    }),
  });

  app.get('/api/taste', (req, res) => {
    try {
      const taste = resolveReadUserFile(rootDir, 'user/taste.md').content;
      const routines = resolveReadUserFile(rootDir, 'user/routines.md').content;
      res.json({ taste, routines });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  const volumeSaver = createVolumeSaver({ db, initial: runtime.volume });
  const rememberVolume = (value, opts) => volumeSaver.remember(value, opts);
  mountBootRoute(app, { getRuntime: () => runtime });
  mountChatRoute(app, {
    getRuntime: () => runtime,
    broadcast,
    db,
    rememberVolume,
  });
  mountControlRoute(app, { getRuntime: () => runtime, broadcast, db, rememberVolume });
  mountPlaysRoutes(app);
  mountSearchRoute(app, searchDeps);
  mountFavoriteRoutes(app, { db });
  mountLikeRoutes(app, { db });

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
      // 只替白名单域名（默认 kugou.com / kgimg.com 及其子域）转发，见 server/proxy-guard.js
      const check = checkProxyUrl(target);
      if (!check.ok) {
        console.warn(`[proxy] blocked target host=${check.hostname || '(none)'} reason=${check.reason}`);
        res.status(403).send('forbidden target');
        return;
      }
      const upstream = await axios.get(target, {
        responseType: 'stream',
        headers: {
          Referer: refererForProxyUrl(target),
          'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
          ...(range ? { Range: range } : {}),
        },
        timeout: 10_000,        // connect / 首字节超时
        timeoutErrorMessage: 'upstream first-byte timeout',
        signal: ac.signal,
        validateStatus: s => s >= 200 && s < 400,
        // 重定向的每一跳都重新判定，跳到白名单外直接中止
        beforeRedirect: createRedirectGuard(),
        // CDN 走 KUGOU_PROXY；目标若是 127.0.0.1 / localhost 则强制直连。
        ...axiosProxyOptions(target),
      });

      // 兜底：万一某一跳没走 beforeRedirect，最终地址也复查一次
      const finalUrl = upstream.request?.res?.responseUrl;
      if (finalUrl) {
        const finalCheck = checkProxyUrl(finalUrl);
        if (!finalCheck.ok) {
          upstream.data?.destroy?.();
          console.warn(`[proxy] blocked redirect host=${finalCheck.hostname || '(none)'} reason=${finalCheck.reason}`);
          res.status(403).send('forbidden target');
          return;
        }
      }

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
      const blocked = findProxyBlock(err);
      if (blocked) {
        console.warn(`[proxy] blocked redirect host=${blocked.hostname || '(none)'} reason=${blocked.reason}`);
        if (!res.headersSent) res.status(403).send('forbidden target');
        else try { res.end(); } catch { /* */ }
        return;
      }
      console.error('[proxy] failed:', err.message);
      // 上游明确拒绝的状态（如 416 范围越界）透传给客户端，不吞成 502
      const upstreamStatus = err.response?.status;
      if (!res.headersSent) {
        if (upstreamStatus && upstreamStatus >= 400) {
          const cr = err.response?.headers?.['content-range'];
          if (cr) res.setHeader('content-range', cr);
          res.status(upstreamStatus).send('upstream rejected: ' + upstreamStatus);
        } else {
          res.status(502).send('upstream failed: ' + err.message);
        }
      } else try { res.end(); } catch { /* */ }
    }
  });

  // TTS 路由（/tts/<sha1>.mp3 读 cache/tts/<sha1>.mp3）
  mountTtsRoutes(app);

  // W2/W3 视图依赖的扩展 API
  function applyLiveSettings(applied = []) {
    broadcast({ type: 'settings-updated', applied });
  }

  mountSettingsRoutes(app, { onSettingsSaved: applyLiveSettings });
  mountLyricRoute(app);
  mountWeatherRoute(app);
  mountTasteRoutes(app, { rootDir });
  mountHealthRoute(app);
  mountKugouReloginRoutes(app);
  mountNeteaseReloginRoutes(app);
  mountQQReloginRoutes(app);
  mountStudioRoutes(app, { getRuntime: () => runtime });
  mountTestRoutes(app);
  mountPlaylistRoutes(app, { runtime, broadcast });
  mountExternalQueueRoutes(app, { runtime, broadcast, db, ...externalQueueDeps });
  mountContinuePoolRoutes(app, { runtime, broadcast, db, ...continuePoolDeps });
  mountKugouImportApiRoute(app, { rootDir });
  mountUnmatchedRoute(app, { db });
  mountMemoryRoutes(app, { runtime, broadcast, db, rootDir });

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
      const { leader } = wsClients.connect(ws);
      runtime.active = true;
      ws.send(JSON.stringify({ type: 'hello', runtime }));
      broadcast(leaderBroadcast(leader));
      ws.on('message', raw => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg?.type === 'identify') {
          const nextLeader = wsClients.identify(ws, msg);
          broadcast(leaderBroadcast(nextLeader));
          return;
        }
        if (msg?.type === 'progress') {
          if (!wsClients.isLeader(ws)) return;
          const before = runtime.volume;
          if (!applyProgress(runtime, msg)) return;
          if (runtime.volume !== before) volumeSaver.remember(runtime.volume);
          const entry = wsClients.getClient(ws);
          const origin = (typeof msg.clientId === 'string' && msg.clientId.trim()) || entry?.clientId || '';
          broadcast(progressBroadcast(runtime, origin));
        }
      });
      ws.on('close', () => {
        const nextLeader = wsClients.disconnect(ws);
        runtime.active = wsClients.size() > 0;
        broadcast(leaderBroadcast(nextLeader));
      });
    });
  });

  function stopBackground() {}

  return {
    app,
    server,
    wss,
    runtime,
    broadcast,
    db,
    stopBackground,
  };
}

// ────────────────────────────────────────────────────────
// 启动
// ────────────────────────────────────────────────────────
export async function start() {
  const PORT = Number(process.env.PORT) || 8080;
  const HOST = resolveListenHost();
  const instance = createApp();
  const { server, stopBackground } = instance;

  console.log('[claudio] 启动中...');
  warnRemovedInternalBrain({ db: dbApi });
  warnRemovedResidentDj({ db: dbApi });

  const login = await ensureLogin();
  if (!login.ok) {
    console.warn('[claudio] 警告：KuGou 登录未通过，搜索 / 播放可能受限。可继续启动以便先测试 Chat。');
  }

  if (musicService.providers.netease?.isEnabled?.()) {
    ensureNeteaseLogin()
      .then(async res => {
        if (res.ok) return;
        const cookie = await musicService.providers.netease.ensureCookie();
        console.log(cookie
          ? '[netease] 匿名会话已就绪'
          : '[netease] 已启用（使用上游内置匿名会话）');
      })
      .catch(err => console.warn('[netease] 预热跳过:', err.message));
    startNeteaseAutoRefresh();
  }

  if (musicService.providers.qq?.isEnabled?.()) {
    ensureQQLogin().catch(err => console.warn('[qq] 登录态自检跳过:', err.message));
    startQQAutoRefresh();
  }

  // 后台低频续期：只有在距上次成功续期超过 KUGOU_REFRESH_INTERVAL_HOURS（默认 24h）
  // 时才真正调 /login/token，避免「每次启动都登录」被上游风控。
  startAutoRefresh();

  const stopAllBackground = () => {
    stopAutoRefresh();
    stopNeteaseAutoRefresh();
    stopQQAutoRefresh();
    stopBackground();
  };
  process.on('SIGINT', () => { stopAllBackground(); process.exit(0); });
  process.on('SIGTERM', () => { stopAllBackground(); process.exit(0); });

  server.listen(PORT, HOST, () => {
    const shownHost = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;
    console.log(`[claudio] listening on ${HOST}:${PORT}`);
    console.log(`[claudio] PWA:    http://${shownHost}:${PORT}/`);
    console.log(`[claudio] health: http://${shownHost}:${PORT}/api/health`);
  });

  return instance;
}

function isDirectRun(metaUrl = import.meta.url, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    const entry = fs.realpathSync(path.resolve(argv1));
    const current = fs.realpathSync(fileURLToPath(metaUrl));
    return process.platform === 'win32'
      ? entry.toLowerCase() === current.toLowerCase()
      : entry === current;
  } catch {
    return path.resolve(argv1) === fileURLToPath(metaUrl);
  }
}

if (isDirectRun()) {
  start().catch(err => {
    console.error('[claudio] 启动失败:', err);
    process.exit(1);
  });
}
