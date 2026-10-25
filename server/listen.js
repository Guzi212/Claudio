// 默认只听 127.0.0.1。要让局域网或其他机器上的 bot 连进来，设 CLAUDIO_HOST=0.0.0.0。
export function resolveListenHost(env = process.env) {
  const raw = String(env.CLAUDIO_HOST ?? '').trim();
  return raw || '127.0.0.1';
}
