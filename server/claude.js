import { spawn } from 'node:child_process';
import 'dotenv/config';
import { dbApi } from './db.js';
import { resolveTrack } from './services/kugou.js';

const TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS) || 15_000;
const IS_WIN = process.platform === 'win32';

// 调用 claude CLI 子进程，返回它写在 stdout 的文本。
// claude -p --output-format json 会把整个回答打包成 { type, subtype, result, session_id, ... }
// Windows 上 claude 可能是 .cmd（npm 全局装）或 .exe（native install），shell:true 让 cmd.exe 走 PATH 解析。
function runClaudeCli(prompt) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json'];
    const child = spawn('claude', args, {
      shell: IS_WIN,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`claude CLI timeout after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });

    child.on('error', err => {
      clearTimeout(timer);
      reject(new Error(`claude CLI spawn failed: ${err.message}`));
    });

    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude CLI exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve(stdout);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// 第一层 JSON：claude CLI 自己的元数据包
function extractResultField(stdout) {
  const trimmed = stdout.trim();
  try {
    const wrapper = JSON.parse(trimmed);
    if (typeof wrapper.result === 'string') return wrapper.result;
    if (typeof wrapper.response === 'string') return wrapper.response;
    return trimmed;
  } catch {
    return trimmed;
  }
}

// 第二层 JSON：我们定义的 DJ schema
export function parseDjJson(text) {
  const trimmed = String(text || '').trim();

  // 1) 直接尝试
  try {
    const parsed = JSON.parse(trimmed);
    return normalizeDjJson(parsed);
  } catch { /* fall through */ }

  // 2) 抠出第一个 {...} 块再试（模型常把 JSON 包在解释里）
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      return normalizeDjJson(parsed);
    } catch { /* fall through */ }
  }

  // 3) 最终兜底：把原文当作 say，play 空
  return {
    say: trimmed.slice(0, 500),
    play: [],
    reason: '(claude 输出未通过 JSON 解析，已回退为纯文本)',
    segue: '',
    _parseFailed: true,
  };
}

function normalizeDjJson(obj) {
  return {
    say: String(obj?.say ?? '').trim(),
    play: Array.isArray(obj?.play) ? obj.play.map(p => ({
      title: String(p?.title ?? '').trim(),
      artist: String(p?.artist ?? '').trim(),
      hint: String(p?.hint ?? '').trim(),
    })).filter(p => p.title) : [],
    reason: String(obj?.reason ?? '').trim(),
    segue: String(obj?.segue ?? '').trim(),
  };
}

// 超时 / 失败兜底：从历史 plays 取最近 3 首
function fallbackFromHistory(reason) {
  const recent = dbApi.recentPlays(10);
  const picks = recent.slice(0, 3);
  return {
    say: 'DJ 今天思路有点卡，先给你接着放最近听的几首。',
    play: picks.map(p => ({ title: p.title, artist: p.artist, hint: '' })),
    reason: reason || '(fallback: 取自播放历史)',
    segue: '',
    _fallback: true,
  };
}

/**
 * 完整链路：systemPrompt + 用户输入 → Claude → 解析 → 翻译成可播放队列
 * @returns {Promise<{say, queue, reason, raw}>}
 */
export async function ask(systemPrompt, userMessage) {
  const fullPrompt = `${systemPrompt}\n\n用户：${userMessage}\n\nClaudio 的 JSON 回复：`;

  let djJson;
  try {
    const stdout = await runClaudeCli(fullPrompt);
    const resultField = extractResultField(stdout);
    djJson = parseDjJson(resultField);
  } catch (err) {
    console.error('[claude] CLI failure, falling back:', err.message);
    djJson = fallbackFromHistory(err.message);
  }

  // 翻译 play[] → queue（每条调酷狗匹配）
  const queue = [];
  for (const want of djJson.play) {
    const track = await resolveTrack(want);
    if (track) {
      queue.push({
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration: track.duration,
        kugouId: track.kugouId,
        audioUrl: `/api/proxy?u=${encodeURIComponent(track.upstreamUrl)}`,
      });
    }
  }

  return {
    say: djJson.say,
    queue,
    reason: djJson.reason,
    raw: djJson,
  };
}

export default { ask, parseDjJson };
