import fs from 'node:fs';
import { describe, it, expect } from 'vitest';

const app = fs.readFileSync('./pwa/app.js', 'utf8');
const player = fs.readFileSync('./pwa/views/player.js', 'utf8');
const html = fs.readFileSync('./pwa/index.html', 'utf8');

describe('WS 断线重连', () => {
  it('close 之后会排下一次重连，不是就此离线', () => {
    expect(app).toContain("ws.addEventListener('close'");
    expect(app).toContain('scheduleRetry');
    expect(app).toContain('retryTimer');
    // 退避有上限，不能无限翻倍
    expect(app).toContain('Math.min(30_000');
  });

  it('重连成功后拉一次全量状态，断线期间漏的广播补不回来', () => {
    expect(app).toContain('syncFromServer({ silent: true, keepOverlay: true })');
    expect(player).toContain('export async function syncFromServer');
  });

  it('服务端连上就推的 hello 不会被丢掉', () => {
    expect(app).toContain("evt.type === 'hello'");
    expect(app).toContain('applyRuntime(evt.runtime');
  });

  it('页面回到前台/网络恢复/bfcache 恢复时立刻补一次连接', () => {
    expect(app).toContain("addEventListener('visibilitychange'");
    expect(app).toContain("addEventListener('online'");
    expect(app).toContain("ev.persisted");
  });

  it('页面关掉前不把服务端状态改成暂停（重连只读不写）', () => {
    const body = app.slice(app.indexOf('function connectWs()'));
    expect(body).not.toContain('/api/runtime/state');
  });
});

describe('Chrome 播放', () => {
  it('audio 用 preload=metadata，Chrome 才能在被 autoplay 拦住时先拿到时长', () => {
    expect(html).toContain('preload="metadata"');
    expect(html).not.toContain('preload="none"');
  });

  it('打开播放页的脚本用 Chrome 并放开 autoplay policy', () => {
    const ps1 = fs.readFileSync('./scripts/open-player.ps1', 'utf8');
    expect(ps1).toContain('chrome.exe');
    expect(ps1).toContain('--autoplay-policy=no-user-gesture-required');
    expect(ps1).toContain('--user-data-dir=');
    expect(ps1).not.toContain('msedge');
  });
});
