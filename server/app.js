import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import axios from 'axios';
import 'dotenv/config';

import { dbApi } from './db.js';
import { route } from './router.js';
import { buildSystemPrompt } from './context.js';
import { ask as claudeAsk } from './claude.js';
import { ensureLogin } from './services/kugou-login.js';
import { start as startScheduler } from './scheduler.js';
import { synthesize as ttsSynthesize, mountTtsRoutes } from './tts.js';
import { mountSettingsRoutes } from './api/settings.js';
import { mountLyricRoute } from './api/lyric.js';
import { mountWeatherRoute } from './api/weather.js';
import { mountTasteRoutes } from './api/taste.js';
import { mountHealthRoute } from './api/health.js';
import { mountKugouReloginRoutes } from './api/kugou-relogin.js';
import { mountStudioRoutes } from './api/studio.js';
import { mountTestRoutes } from './api/test.js';
import { detectSignal, appendJournalEntry } from './services/journal.js';
import { mountPlaylistRoutes } from './api/playlists.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 8080;

const app = express();
app.use(express.json({ limit: '1mb' }));

// 简单运行时状态（in-memory）：当前 queue + 索引
const runtime = {
  queue: [],      // [{title, artist, kugouId, audioUrl, ...}]
  index: 0,       // 当前播放索引
  paused: false,
  lastSay: '',
  active: false,  // PWA 是否连着 WS（scheduler 的 hourly-mood 凭这门禁）
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

// ────────────────────────────────────────────────────────
// API
// ────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.get('/api/now', (req, res) => {
  res.json({
    nowPlaying: runtime.queue[runtime.index] || null,
    queue: runtime.queue,
    index: runtime.index,
    paused: runtime.paused,
    lastSay: runtime.lastSay,
  });
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

// 快速启动：跳过 TTS 合成，直接返回完整队列
// TTS 每次生成新 say 几乎都是 cache miss（2-5s），跳过后 boot 整体省 30-50%
app.post('/api/boot', async (req, res) => {
  const BOOT_MSG = '刚打开电台，请根据现在的时间和天气推荐开播曲目';
  try {
    const systemPrompt = await buildSystemPrompt();
    const { say, queue: songQueue, reason, raw } = await claudeAsk(systemPrompt, BOOT_MSG);

    if (songQueue.length > 0) {
      runtime.queue = songQueue;
      runtime.index = 0;
      runtime.paused = false;
      for (const q of songQueue) {
        dbApi.addPlay({ kugouId: q.kugouId, title: q.title, artist: q.artist, reason, source: 'boot' });
      }
    }
    runtime.lastSay = say;
    dbApi.addMessage('user', BOOT_MSG);
    dbApi.addMessage('assistant', say);
    broadcast({ type: 'state', runtime });

    const _resolveError = Array.isArray(raw?.play) && raw.play.length > 0 && songQueue.length === 0;
    res.json({ say, queue: songQueue, reason, intent: 'boot', _resolveError });
  } catch (err) {
    console.error('[boot] error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chat', async (req, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message) {
    res.status(400).json({ error: 'message required' });
    return;
  }

  dbApi.addMessage('user', message);

  const intent = route(message);

  if (intent.intent === 'control') {
    const result = handleControl(intent);
    dbApi.addMessage('assistant', `(control: ${intent.command}) ${result.say}`);
    broadcast({ type: 'state', runtime });
    res.json(result);
    return;
  }

  if (intent.intent === 'unknown-command') {
    const say = `不认识的命令：/${intent.command}。试试 /skip /pause /play /vol N`;
    dbApi.addMessage('assistant', say);
    res.json({ say, queue: [], reason: '', intent: intent.intent });
    return;
  }

  // chat: 走 Claude 子进程
  try {
    const systemPrompt = await buildSystemPrompt();
    const { say, queue: songQueue, reason, raw } = await claudeAsk(systemPrompt, message);

    // fire-and-forget：信号检测 + 日志追加，不阻塞响应
    try {
      const recentPlays = dbApi.recentPlays(8);
      const signal = detectSignal(message, recentPlays, new Date());
      if (signal) appendJournalEntry(signal);
    } catch { /* 日志写入失败不影响主流程 */ }

    // 把 say 合成语音放队首（Fish Audio 未配置时 synthesize 返 null，自动降级）
    const voice = say ? await ttsSynthesize(say) : null;
    const ttsTrack = voice ? {
      title: '🔊 ' + say.slice(0, 40),
      artist: 'Claudio',
      audioUrl: voice.url,
      isTts: true,
      duration: 0,
    } : null;

    const finalQueue = ttsTrack ? [ttsTrack, ...songQueue] : songQueue;

    if (finalQueue.length > 0) {
      runtime.queue = finalQueue;
      runtime.index = 0;
      runtime.paused = false;
      // 只把真正的歌写入历史（跳过 TTS 串场条）
      for (const q of finalQueue) {
        if (q.isTts) continue;
        dbApi.addPlay({
          kugouId: q.kugouId, title: q.title, artist: q.artist,
          reason, source: 'claude',
        });
      }
    }
    runtime.lastSay = say;

    dbApi.addMessage('assistant', say);
    broadcast({ type: 'state', runtime });

    const _resolveError = Array.isArray(raw?.play) && raw.play.length > 0 && songQueue.length === 0;
    res.json({ say, queue: finalQueue, reason, intent: 'chat', _raw: raw, _resolveError });
  } catch (err) {
    console.error('[chat] error:', err);
    res.status(500).json({ error: err.message });
  }
});

function handleControl({ command, arg }) {
  switch (command) {
    case 'skip':
    case 'next':
      if (runtime.index < runtime.queue.length - 1) runtime.index += 1;
      return { say: `▶ 下一首：${runtime.queue[runtime.index]?.title || '(队列结束)'}`, queue: runtime.queue };
    case 'prev':
    case 'back':
      if (runtime.index > 0) runtime.index -= 1;
      return { say: `◀ 上一首：${runtime.queue[runtime.index]?.title || '(队列开始)'}`, queue: runtime.queue };
    case 'pause':
      runtime.paused = true;
      return { say: '⏸ 暂停', queue: runtime.queue };
    case 'play':
    case 'resume':
      runtime.paused = false;
      return { say: '▶ 继续', queue: runtime.queue };
    case 'now':
      return {
        say: runtime.queue[runtime.index]
          ? `🎵 ${runtime.queue[runtime.index].title} — ${runtime.queue[runtime.index].artist}`
          : '(没有正在播放)',
        queue: runtime.queue,
      };
    case 'queue':
      return {
        say: runtime.queue.length
          ? '当前队列：\n' + runtime.queue.map((q, i) => `${i === runtime.index ? '▶' : '  '} ${q.title} — ${q.artist}`).join('\n')
          : '(队列空)',
        queue: runtime.queue,
      };
    case 'help':
      return {
        say: '命令：/skip /prev /pause /play /now /queue · 或者直接跟我聊天',
        queue: runtime.queue,
      };
    default:
      return { say: `(未实现的命令：${command})`, queue: runtime.queue };
  }
}

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
    const upstream = await axios.get(decodeURIComponent(url), {
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
    runtime.index = Math.max(0, Math.min(explicit, runtime.queue.length - 1));
  } else if (runtime.index < runtime.queue.length - 1) {
    runtime.index += 1;
  }
  broadcast({ type: 'state', runtime });
  res.json({ ok: true, index: runtime.index });
});

// 全量 sync：前端把 paused 等状态也推回来（按钮触发时使用）
app.post('/api/runtime/state', (req, res) => {
  const { index, paused } = req.body || {};
  if (typeof index === 'number' && Number.isFinite(index)) {
    runtime.index = Math.max(0, Math.min(index, runtime.queue.length - 1));
  }
  if (typeof paused === 'boolean') {
    runtime.paused = paused;
  }
  broadcast({ type: 'state', runtime });
  res.json({ ok: true, index: runtime.index, paused: runtime.paused });
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

// ────────────────────────────────────────────────────────
// HTTP server + WS upgrade
// ────────────────────────────────────────────────────────
const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/stream') {
    wss.handleUpgrade(req, socket, head, ws => {
      wsClients.add(ws);
      runtime.active = true;
      ws.send(JSON.stringify({ type: 'hello', runtime }));
      ws.on('close', () => {
        wsClients.delete(ws);
        runtime.active = wsClients.size > 0;
      });
    });
  } else {
    socket.destroy();
  }
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

  // 节律调度（07:00 早间 / 09:00 通勤 / 每小时情绪检查）
  const scheduler = startScheduler({
    runtime,
    broadcast,
    log: (...args) => console.log('[scheduler]', ...args),
    ask: claudeAsk,
    buildSystemPrompt,
  });
  console.log('[claudio] scheduler 已挂 cron');

  process.on('SIGINT', () => { scheduler.stop(); process.exit(0); });
  process.on('SIGTERM', () => { scheduler.stop(); process.exit(0); });

  server.listen(PORT, () => {
    console.log(`[claudio] 8080 ready · http://localhost:${PORT}`);
    console.log(`[claudio] PWA:    http://localhost:${PORT}/`);
    console.log(`[claudio] health: http://localhost:${PORT}/api/health`);
  });
}

start().catch(err => {
  console.error('[claudio] 启动失败:', err);
  process.exit(1);
});
