import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync(path.resolve('pwa/index.html'), 'utf8');
const css = fs.readFileSync(path.resolve('pwa/styles.css'), 'utf8');
const sw = fs.readFileSync(path.resolve('pwa/sw.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.resolve('pwa/manifest.json'), 'utf8'));

describe('minimalist dual-theme radio contract', () => {
  it('保留跨视图统一导航与无框桌面标题栏', () => {
    expect(css).not.toMatch(/body\.view-player\s+#topbar\s*\{\s*display:\s*none/);
    expect(html).toContain('id="topbar"');
    expect(html).toContain('aria-label="电台导航"');
    expect(html).toContain('id="desktop-titlebar"');
  });

  it('歌词是播放舞台的一部分，internal 聊天保留独立入口', () => {
    const stage = html.slice(html.indexOf('class="stage"'), html.indexOf('class="queue"'));
    expect(stage).toContain('id="lyrics-panel"');
    expect(html).toContain('id="console-chat"');
    expect(html).toContain('id="chat"');
    expect(html).toContain('id="composer"');
    expect(css).toContain('body:not(.brain-internal) #console-chat');
  });

  it('浅色暖纸 + 深色冷静双主题随系统切换并同步 manifest', () => {
    expect(html).toContain('<html lang="zh-cn" data-theme="auto">');
    expect(css).toContain('--bg: #F7F6F2');
    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).toContain('--bg: #121316');
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(manifest.background_color).toBe('#F7F6F2');
    expect(manifest.theme_color).toBe('#F7F6F2');
    expect(html).toContain('<meta name="theme-color" content="#F7F6F2">');
  });

  it('Grok 风格合成器级微动效，无 backdrop-filter 与冗余 helper 文案', () => {
    expect(css).toContain('--ease-out: cubic-bezier(0.23, 1, 0.32, 1)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain(':focus-visible');
    expect(css).not.toContain('backdrop-filter');
    expect(css).not.toMatch(/@keyframes[^{]+\{[^}]*filter:/);
    expect(html).not.toContain('class="field-hint"');
    expect(html).not.toContain('ink-scene');
  });

  it('Agent 解耦身份、即时意图与记忆洞察入口就位', () => {
    expect(html).toContain('id="host-agent-name"');
    expect(html).toContain('id="intent-form"');
    expect(html).toContain('id="memory-insights"');
    expect(html).toContain('id="trait-form"');
    expect(html).toContain('id="trait-list"');
    expect(html).not.toMatch(/Grokbot/i);
    expect(manifest.description).not.toMatch(/Grok/i);
  });

  it('桌面双栏、手机单列及 380x136 迷你陪伴态均有明确断点', () => {
    expect(css).toMatch(/\.stage\s*\{[^}]*grid-template-columns:\s*minmax\(220px,\s*320px\)/);
    expect(css).toMatch(/@media\s*\(max-height:\s*220px\)/);
    expect(css).toMatch(/@media\s*\(max-width:\s*720px\)[\s\S]*?\.stage\s*\{[^}]*grid-template-columns:\s*1fr/);
    expect(css).toMatch(/\.queue-title-line\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.queue-title\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  it('离线壳缓存覆盖新增资源并移除已淘汰视觉模块', () => {
    expect(sw).toMatch(/const CACHE = 'claudio-shell-v21'/);
    expect(sw).toContain('\'/theme-store.js\'');
    expect(sw).toContain('\'/external-playback.js\'');
    expect(sw).toContain('\'/boot-playback.js\'');
    expect(sw).toContain('\'/runtime-sync.js\'');
    expect(sw).toContain('\'/player-mode.js\'');
    expect(sw).toContain('\'/views/playlists.js\'');
    expect(sw).not.toContain('studio-visual.js');
    expect(sw).not.toContain('env-strip.js');
  });

  it('歌单页支持搜索、设置默认红心单并精确播放单曲', () => {
    expect(html).toContain('id="search-form"');
    expect(html).toContain('id="search-input"');
    expect(html).toContain('id="search-results"');
    const playlistsJs = fs.readFileSync(path.resolve('pwa/views/playlists.js'), 'utf8');
    expect(playlistsJs).toContain('/api/kugou/search?q=');
    expect(playlistsJs).toContain('/api/kugou/play');
    expect(playlistsJs).toContain('like_target_listid');
    expect(playlistsJs).toContain('claudio:queue-replace');
  });
});
