import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import 'dotenv/config';
import { get as getSetting } from './services/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CACHE_DIR = path.resolve(__dirname, '..', 'cache', 'tts');
const FISH_API_URL = 'https://api.fish.audio/v1/tts';
const REQUEST_TIMEOUT_MS = 30_000;

function getCacheDir() {
  return process.env.TTS_CACHE_DIR || DEFAULT_CACHE_DIR;
}

function ensureCacheDir() {
  const dir = getCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function hashKey(text, voiceId) {
  return createHash('sha1').update(`${text}::${voiceId}`).digest('hex');
}

/**
 * 把一段中文 say 文本送去 Fish Audio 合成 → 返回本地 mp3 路径 + 公开 URL。
 * SHA1(text + voiceId) 做缓存 key，命中不发请求。
 * 任何失败（空文本、缺 key、网络错）都返回 null，调用方应忽略语音化。
 *
 * @param {string} text
 * @returns {Promise<{hash: string, filePath: string, url: string} | null>}
 */
export async function synthesize(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;

  const apiKey = getSetting('fish_api_key');
  const voiceId = getSetting('fish_voice_id') || '';
  if (!apiKey) {
    console.warn('[tts] FISH_API_KEY 未配置，跳过语音合成');
    return null;
  }

  const hash = hashKey(trimmed, voiceId);
  const dir = ensureCacheDir();
  const filePath = path.join(dir, `${hash}.mp3`);
  const url = `/tts/${hash}.mp3`;

  if (fs.existsSync(filePath)) {
    return { hash, filePath, url };
  }

  try {
    const res = await axios.post(
      FISH_API_URL,
      { text: trimmed, reference_id: voiceId, format: 'mp3' },
      {
        responseType: 'arraybuffer',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
    );

    fs.writeFileSync(filePath, Buffer.from(res.data));
    return { hash, filePath, url };
  } catch (err) {
    const detail = err?.response?.status ? `HTTP ${err.response.status}` : err.message;
    console.error('[tts] Fish Audio failed:', detail);
    return null;
  }
}

/**
 * 把 GET /tts/:hash.mp3 挂到 express app 上。读 cache 目录里的 mp3。
 * hash 必须是 40 位十六进制（SHA1），否则 400，防路径穿越。
 */
export function mountTtsRoutes(app) {
  app.get('/tts/:hash.mp3', (req, res) => {
    const { hash } = req.params;
    if (!/^[a-f0-9]{40}$/.test(hash)) {
      res.status(400).send('bad hash');
      return;
    }

    const filePath = path.join(getCacheDir(), `${hash}.mp3`);
    if (!fs.existsSync(filePath)) {
      res.status(404).send('not found');
      return;
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    fs.createReadStream(filePath).pipe(res);
  });
}

export default { synthesize, mountTtsRoutes };
