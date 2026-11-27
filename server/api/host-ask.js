// 手机 / 播放页主持人对话框中转：
// 前端只调同源 POST /api/host/ask（走现有 authMiddleware 鉴权，零前端密钥），
// 后端仅向本机 mirasim-webhook 的单一目标助手 `claudio`（Claudio主持人）投递，
// 并携带 targetClientId，让主持人选歌与播控精准作用到当前手机，不打断电脑端。
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_WEBHOOK_BASE = 'http://127.0.0.1:18790';
const DEFAULT_WEBHOOK_ENV = 'D:\\works\\mirasim-webhook\\.env';
const TARGET_ASSISTANT = 'claudio';
const MAX_MESSAGE_CHARS = 300;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 6;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{4,80}$/;

function clipChars(raw, max) {
  const text = String(raw ?? '').trim();
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

function readSecretFromEnvFile(envPath) {
  try {
    if (!envPath || !fs.existsSync(envPath)) return '';
    const content = fs.readFileSync(envPath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^WEBHOOK_SECRET\s*=\s*(.*)$/);
      if (!m) continue;
      let val = m[1].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (val) return val;
    }
  } catch { /* ignore */ }
  return '';
}

export function resolveWebhookSecret(env = process.env) {
  const direct = String(env.MIRASIM_WEBHOOK_SECRET || '').trim();
  if (direct) return direct;
  const envFile = String(env.MIRASIM_WEBHOOK_ENV_PATH || DEFAULT_WEBHOOK_ENV).trim();
  return readSecretFromEnvFile(envFile);
}

export function buildHostPrompt({ message, clientId = '', standalone = false, nowPlaying = null }) {
  const lines = [
    '来自 Claudio 手机播放页对话框的指令：',
    `用户原话：${message}`,
  ];
  if (nowPlaying && (nowPlaying.title || nowPlaying.artist)) {
    const label = [nowPlaying.title, nowPlaying.artist].filter(Boolean).join(' - ');
    lines.push(`手机当前曲目：${label}`);
  }
  if (standalone && clientId) {
    lines.push(
      '',
      `【重要：定向控制当前手机（targetClientId="${clientId}"），不要打断电脑播放】`,
      '- 选歌/换歌请调用 POST http://127.0.0.1:8080/api/queue/external，JSON 必带 "targetClientId": "' + clientId + '"、tracks 和简短 say（会在手机对话框显示）。',
      '- 播放/暂停/切歌/调音量请调用 POST http://127.0.0.1:8080/api/control，JSON 必带 "targetClientId": "' + clientId + '"、command（play/pause/toggle/next/prev/volume）和可选 say。',
      '- 若只需文字回复不改播放，可调用 POST http://127.0.0.1:8080/api/host/reply，JSON 带 "targetClientId": "' + clientId + '" 和 "text"。',
    );
  } else {
    lines.push(
      '',
      '请按 Claudio 主持人规范通过本机 http://127.0.0.1:8080/api/queue/external 或 /api/control 响应，并在 say 里给一句简短口播反馈。',
    );
  }
  return lines.join('\n');
}

export function createRateLimiter({ max = RATE_MAX_REQUESTS, windowMs = RATE_WINDOW_MS, now = () => Date.now() } = {}) {
  const buckets = new Map();
  return function check(key) {
    const t = now();
    const list = (buckets.get(key) || []).filter(ts => t - ts < windowMs);
    if (list.length >= max) {
      const oldest = list[0];
      const retryAfterSec = Math.max(1, Math.ceil((windowMs - (t - oldest)) / 1000));
      buckets.set(key, list);
      return { ok: false, retryAfterSec };
    }
    list.push(t);
    buckets.set(key, list);
    // 防止 key 无限增长
    if (buckets.size > 500) {
      for (const [k, v] of buckets) {
        if (!v.some(ts => t - ts < windowMs)) buckets.delete(k);
      }
    }
    return { ok: true, retryAfterSec: 0 };
  };
}

export function mountHostAskRoutes(app, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const sendToClient = typeof deps.sendToClient === 'function' ? deps.sendToClient : () => 0;
  const broadcast = typeof deps.broadcast === 'function' ? deps.broadcast : () => {};
  const getSecret = typeof deps.getSecret === 'function' ? deps.getSecret : () => resolveWebhookSecret();
  const webhookBase = String(deps.webhookBase || process.env.MIRASIM_WEBHOOK_URL || DEFAULT_WEBHOOK_BASE).replace(/\/+$/, '');
  const checkLimit = createRateLimiter({
    max: deps.rateMax ?? RATE_MAX_REQUESTS,
    windowMs: deps.rateWindowMs ?? RATE_WINDOW_MS,
    now: deps.now,
  });

  app.post('/api/host/ask', async (req, res) => {
    const body = req.body || {};
    const rawMsg = typeof body.message === 'string' ? body.message.trim() : '';
    if (!rawMsg) {
      res.status(400).json({ ok: false, error: '请输入想对主持人说的内容' });
      return;
    }
    const message = clipChars(rawMsg, MAX_MESSAGE_CHARS);
    const rawClientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
    const clientId = CLIENT_ID_RE.test(rawClientId) ? rawClientId : '';
    const standalone = Boolean(body.standalone);
    const nowPlaying = body.nowPlaying && typeof body.nowPlaying === 'object'
      ? {
          title: clipChars(body.nowPlaying.title, 80),
          artist: clipChars(body.nowPlaying.artist, 60),
        }
      : null;

    const rateKey = clientId || req.socket?.remoteAddress || 'anon';
    const limit = checkLimit(rateKey);
    if (!limit.ok) {
      res.setHeader('Retry-After', String(limit.retryAfterSec));
      res.status(429).json({
        ok: false,
        error: `发送太频繁，请 ${limit.retryAfterSec} 秒后再试`,
        retryAfterSec: limit.retryAfterSec,
      });
      return;
    }

    const secret = getSecret();
    if (!secret) {
      res.status(503).json({ ok: false, error: '本机主持人 Webhook 未配置' });
      return;
    }

    const requestId = `host-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const text = buildHostPrompt({ message, clientId, standalone, nowPlaying });
    const url = `${webhookBase}/webhook/assistant/${TARGET_ASSISTANT}`;

    try {
      const upstream = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${secret}`,
          'X-Webhook-Id': requestId,
        },
        body: JSON.stringify({
          source: 'Claudio手机端',
          text,
        }),
      });
      if (!upstream.ok) {
        res.status(502).json({ ok: false, error: `主持人通道返回 HTTP ${upstream.status}` });
        return;
      }
      res.status(202).json({
        ok: true,
        accepted: true,
        requestId,
        targetClientId: standalone && clientId ? clientId : null,
      });
    } catch (err) {
      console.error('[host-ask] relay failed:', err.message);
      res.status(502).json({ ok: false, error: '无法连接本机主持人通道' });
    }
  });

  app.post('/api/host/reply', (req, res) => {
    const body = req.body || {};
    const text = clipChars(body.text || body.say, 500);
    if (!text) {
      res.status(400).json({ ok: false, error: 'text 必填' });
      return;
    }
    const rawTarget = typeof body.targetClientId === 'string' ? body.targetClientId.trim() : '';
    const targetClientId = CLIENT_ID_RE.test(rawTarget) ? rawTarget : '';
    const event = {
      type: 'host-reply',
      text,
      ts: Date.now(),
      ...(targetClientId ? { targetClientId } : {}),
    };
    const delivered = targetClientId ? sendToClient(targetClientId, event) : null;
    if (!targetClientId) broadcast(event);
    res.json({ ok: true, targetClientId: targetClientId || null, delivered });
  });
}

export default { mountHostAskRoutes, buildHostPrompt, createRateLimiter, resolveWebhookSecret };
