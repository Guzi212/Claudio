// KuGouMusicApi 的默认地址，Claudio 服务端和 scripts/dev.js 共用。
//
// 不用上游自带的 3000：Windows 开着 Hyper-V / WSL / Docker 时，WinNAT 会从
// TCP 动态端口范围里成段保留端口（`netsh int ipv4 show excludedportrange protocol=tcp`
// 能看到），3000 经常被划进去，非管理员账户 listen 直接 EACCES。
// 33400 在 Windows 默认动态范围 49152-65535 之下，也在常见的改小范围 1024-15000
// 之上，这类保留不会落到它头上。要换端口，在 .env 里设 KUGOU_API_BASE。
export const DEFAULT_KUGOU_API_PORT = 33400;
export const DEFAULT_KUGOU_API_BASE = `http://localhost:${DEFAULT_KUGOU_API_PORT}`;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

// 本机地址返回端口号（字符串），给拉起上游时的 PORT 用；非本机或解析失败返回 null。
export function localKugouApiPort(base) {
  let url;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!LOCAL_HOSTS.has(host) && !host.startsWith('127.')) return null;
  if (url.port) return url.port;
  return url.protocol === 'https:' ? '443' : '80';
}
