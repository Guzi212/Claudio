import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import { describe, expect, it } from 'vitest';
import {
  BLOCKED_CODE,
  DEFAULT_ALLOWED_HOSTS,
  allowedHosts,
  checkProxyUrl,
  createRedirectGuard,
  findProxyBlock,
  inferProxyContentType,
  isAllowedProxyUrl,
  isIpLiteralHost,
  redirectTargetOf,
  refererForProxyUrl,
} from '../server/proxy-guard.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('proxy-guard · 放行', () => {
  it.each([
    'https://www.kugou.com/song/abc.mp3',
    'http://fs.kugou.com/20261030/a.mp3',
    'https://kugou.com/',
    'https://imge.kgimg.com/cover.jpg',
    'http://kgimg.com/x.png',
    'https://WWW.KuGou.com./song/abc.mp3',
    'http://m701.music.126.net/a.mp3',
    'http://m801.music.126.net/a.mp3',
    'http://p3.music.126.net/cover.jpg',
    'https://music.163.com/song?id=1',
    'https://isure.stream.qqmusic.qq.com/M500002.mp3',
    'https://aqqmusic.tc.qq.com/M500002.mp3',
    'https://y.gtimg.cn/music/photo_new/T002R300x300M000000.jpg',
  ])('白名单域名放行：%s', url => {
    expect(isAllowedProxyUrl(url)).toBe(true);
  });

  it('环境变量追加的域名和它的子域都放行', () => {
    const env = { CLAUDIO_PROXY_ALLOWED_HOSTS: 'cdn.example.net, .kglive.cn ,' };
    expect(isAllowedProxyUrl('https://cdn.example.net/a.mp3', env)).toBe(true);
    expect(isAllowedProxyUrl('https://a.b.cdn.example.net/a.mp3', env)).toBe(true);
    expect(isAllowedProxyUrl('https://x.kglive.cn/a.mp3', env)).toBe(true);
    expect(allowedHosts(env)).toEqual(
      expect.arrayContaining(['kugou.com', 'kgimg.com', 'music.126.net', 'qqmusic.qq.com', 'cdn.example.net', 'kglive.cn']),
    );
  });

  it('没有环境变量时只用默认白名单', () => {
    expect(allowedHosts({})).toEqual(DEFAULT_ALLOWED_HOSTS);
    expect(isAllowedProxyUrl('https://cdn.example.net/a.mp3', {})).toBe(false);
  });

  it('refererForProxyUrl 按平台分配正确的防盗链 Referer', () => {
    expect(refererForProxyUrl('https://fs.kugou.com/a.mp3')).toBe('https://www.kugou.com');
    expect(refererForProxyUrl('http://m801.music.126.net/a.mp3')).toBe('https://music.163.com/');
    expect(refererForProxyUrl('https://isure.stream.qqmusic.qq.com/M500.mp3')).toBe('https://y.qq.com/');
    expect(refererForProxyUrl('https://aqqmusic.tc.qq.com/M500.mp3')).toBe('https://y.qq.com/');
    expect(refererForProxyUrl('https://y.gtimg.cn/cover.jpg')).toBe('https://y.qq.com/');
    expect(refererForProxyUrl('invalid-url')).toBe('https://www.kugou.com');
  });
});

describe('proxy-guard · 拒绝', () => {
  it.each([
    ['https://evil-kugou.com/a.mp3', 'not-allowed'],
    ['https://kugou.com.evil.net/a.mp3', 'not-allowed'],
    ['https://example.com/a.mp3', 'not-allowed'],
    ['https://kugou.com.cn/a.mp3', 'not-allowed'],
  ])('近似域名被拒：%s', (url, reason) => {
    const check = checkProxyUrl(url);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe(reason);
  });

  it.each([
    ['ftp://www.kugou.com/a.mp3', 'protocol'],
    ['file:///etc/passwd', 'protocol'],
    ['javascript:alert(1)', 'protocol'],
    ['data:text/html,<h1>x</h1>', 'protocol'],
  ])('非 http/https 协议被拒：%s', (url, reason) => {
    expect(checkProxyUrl(url).reason).toBe(reason);
  });

  it('带用户名密码的地址被拒（避免拿凭据去请求白名单域名）', () => {
    expect(checkProxyUrl('http://user:secret@www.kugou.com/a.mp3').reason).toBe('credentials');
  });

  it.each([
    ['http://127.0.0.1:8080/api/status', 'ip-literal'],
    ['http://10.0.0.1/a.mp3', 'ip-literal'],
    ['http://192.168.1.20/a.mp3', 'ip-literal'],
    ['http://2130706433/a.mp3', 'ip-literal'],
    ['http://0x7f000001/a.mp3', 'ip-literal'],
    ['http://[::1]:8080/a.mp3', 'ip-literal'],
    ['http://[::ffff:127.0.0.1]/a.mp3', 'ip-literal'],
  ])('IP 字面量被拒：%s', (url, reason) => {
    expect(checkProxyUrl(url).reason).toBe(reason);
  });

  it('IP 字面量识别覆盖十六进制分段与整数写法', () => {
    expect(isIpLiteralHost('0x7f.0.0.1')).toBe(true);
    expect(isIpLiteralHost('0x7f000001')).toBe(true);
    expect(isIpLiteralHost('3232235777')).toBe(true);
    expect(isIpLiteralHost('[::ffff:127.0.0.1]')).toBe(true);
    expect(isIpLiteralHost('www.kugou.com')).toBe(false);
    expect(isIpLiteralHost('1.kugou.com')).toBe(false);
  });

  it.each(['', 'not a url', 'kugou.com/song'])('无效地址被拒：%s', url => {
    expect(checkProxyUrl(url).ok).toBe(false);
  });
});

describe('proxy-guard · 重定向逐跳判定', () => {
  const guard = createRedirectGuard({});

  it('酷狗地址重定向到 127.0.0.1 被拒', () => {
    const options = {
      protocol: 'http:',
      hostname: '127.0.0.1',
      host: '127.0.0.1:8080',
      path: '/api/status',
      href: 'http://127.0.0.1:8080/api/status',
    };
    let thrown;
    try {
      guard(options);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown.code).toBe(BLOCKED_CODE);
    expect(thrown.hostname).toBe('127.0.0.1');
    expect(thrown.reason).toBe('ip-literal');
  });

  it('重定向到白名单域名放行', () => {
    expect(() => guard({ href: 'https://fs.kugou.com/a.mp3' })).not.toThrow();
    expect(() => guard({ protocol: 'https:', hostname: 'imge.kgimg.com', path: '/c.jpg' })).not.toThrow();
  });

  it('重定向到近似域名被拒', () => {
    expect(() => guard({ href: 'https://evil-kugou.com/a.mp3' })).toThrow(/blocked/);
  });

  it('取不到重定向目标时失败关闭', () => {
    expect(() => guard({})).toThrow(/blocked/);
    expect(() => guard(null)).toThrow(/blocked/);
  });

  it('redirectTargetOf 从 axios 的 options 还原地址', () => {
    expect(redirectTargetOf({ href: 'https://fs.kugou.com/a.mp3' })).toBe('https://fs.kugou.com/a.mp3');
    expect(redirectTargetOf({ protocol: 'https:', host: 'fs.kugou.com', path: '/a.mp3' }))
      .toBe('https://fs.kugou.com/a.mp3');
    expect(redirectTargetOf({ protocol: 'https', hostname: 'fs.kugou.com', pathname: '/a.mp3' }))
      .toBe('https://fs.kugou.com/a.mp3');
    expect(redirectTargetOf(null)).toBe('');
  });

  it('findProxyBlock 沿 cause 链找到被拒原因（follow-redirects 会包一层）', () => {
    const blocked = new Error('proxy target blocked: ip-literal');
    blocked.code = BLOCKED_CODE;
    blocked.reason = 'ip-literal';
    blocked.hostname = '127.0.0.1';
    const wrapped = Object.assign(new Error('Redirected request failed'), { cause: blocked });
    expect(findProxyBlock(wrapped)).toBe(blocked);
    expect(findProxyBlock(new Error('unrelated'))).toBeNull();
    expect(findProxyBlock(null)).toBeNull();
  });

  it('真实 axios 请求：重定向到 127.0.0.1 时中止，且目标地址从未被请求', async () => {
    const hits = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url);
      if (req.url === '/start') {
        res.writeHead(302, { location: '/secret' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('secret');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    let caught;
    try {
      await axios.get(`http://127.0.0.1:${port}/start`, {
        responseType: 'stream',
        beforeRedirect: createRedirectGuard({}),
        validateStatus: s => s >= 200 && s < 400,
      });
    } catch (err) {
      caught = err;
    } finally {
      await new Promise(resolve => server.close(resolve));
    }

    expect(caught).toBeDefined();
    const blocked = findProxyBlock(caught);
    expect(blocked).not.toBeNull();
    expect(blocked.hostname).toBe('127.0.0.1');
    // 第二跳没发出去：/secret 从未被请求
    expect(hits).toEqual(['/start']);
  });
});

describe('proxy-guard · 接线', () => {
  it('/api/proxy 先判定目标，并把 beforeRedirect 交给 axios', () => {
    const appSource = fs.readFileSync(path.join(ROOT, 'server', 'app.js'), 'utf8');
    const route = appSource.slice(appSource.indexOf("app.get('/api/proxy'"));
    const body = route.slice(0, route.indexOf('// PWA 通知队列指针变化'));

    expect(body).toContain('checkProxyUrl(target)');
    expect(body).toContain('beforeRedirect: createRedirectGuard()');
    expect(body).toContain("res.status(403).send('forbidden target')");
    // 判定必须在真正发请求之前
    expect(body.indexOf('checkProxyUrl(target)')).toBeLessThan(body.indexOf('axios.get(target'));
  });

  it('/api/proxy 把上游 4xx（如 Range 越界 416）透传给客户端，不吞成 502', () => {
    const appSource = fs.readFileSync(path.join(ROOT, 'server', 'app.js'), 'utf8');
    const route = appSource.slice(appSource.indexOf("app.get('/api/proxy'"));
    const body = route.slice(0, route.indexOf('// PWA 通知队列指针变化'));

    // catch 分支应读 err.response.status 并原样返回，而不是一律 502
    expect(body).toContain('err.response?.status');
    expect(body).toContain('res.status(upstreamStatus)');
    // 416 的 content-range 也应透传，客户端才能知道总长度
    expect(body).toContain("['content-range']");
  });

  it('inferProxyContentType 修正 application/octet-stream 与 audio/x-flac 为标准音频 MIME', () => {
    expect(inferProxyContentType('http://fsandroid.tx.kugou.com/a/b.flac', 'application/octet-stream')).toBe('audio/flac');
    expect(inferProxyContentType('http://fsandroid.tx.kugou.com/a/b.flac', 'audio/x-flac')).toBe('audio/flac');
    expect(inferProxyContentType('http://fsandroid.tx.kugou.com/a/b.mp3', '')).toBe('audio/mpeg');
    expect(inferProxyContentType('http://fsandroid.tx.kugou.com/a/b.mp3', 'audio/mpeg')).toBe('audio/mpeg');
  });

  it('/api/proxy 兼容 iOS Safari CoreMedia（res.on close、HEAD、ETag、Cache-Control、MIME 修正）', () => {
    const appSource = fs.readFileSync(path.join(ROOT, 'server', 'app.js'), 'utf8');
    const route = appSource.slice(appSource.indexOf("app.get('/api/proxy'"));
    const body = route.slice(0, route.indexOf('// TTS 路由'));

    expect(body).toContain("res.on('close'");
    expect(body).toContain('!res.writableEnded');
    expect(body).toContain("req.method === 'HEAD'");
    expect(body).toContain('inferProxyContentType');
    expect(body).toContain("res.setHeader('etag'");
    expect(body).toContain("res.setHeader('cache-control'");
  });
});
