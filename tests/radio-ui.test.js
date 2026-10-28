import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync(path.resolve('pwa/index.html'), 'utf8');
const css = fs.readFileSync(path.resolve('pwa/styles.css'), 'utf8');
const sw = fs.readFileSync(path.resolve('pwa/sw.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.resolve('pwa/manifest.json'), 'utf8'));

describe('radio visual contract', () => {
  it('保留跨视图统一导航，播放页不能只靠隐藏的旧顶栏', () => {
    expect(css).not.toMatch(/body\.view-player\s+#topbar\s*\{\s*display:\s*none/);
    expect(html).toContain('id="topbar"');
    expect(html).toContain('aria-label="电台导航"');
  });

  it('歌词是播放舞台的一部分，internal 聊天保留独立入口', () => {
    const stage = html.slice(html.indexOf('class="stage"'), html.indexOf('class="queue"'));
    expect(stage).toContain('id="lyrics-panel"');
    expect(html).toContain('id="console-chat"');
    expect(html).toContain('id="chat"');
    expect(html).toContain('id="composer"');
    expect(css).toContain('body:not(.brain-internal) #console-chat');
  });

  it('使用夜间广播台 token 与克制的信号蓝', () => {
    expect(css).toContain('--canvas: #0b0d12');
    expect(css).toContain('--surface: #151922');
    expect(css).toContain('--ink: #edf0f5');
    expect(css).toContain('--muted: #949dad');
    expect(css).toContain('--signal: #78bfff');
    expect(manifest.background_color).toBe('#0b0d12');
  });

  it('Grokbot 标记、声波和页面图标保持一致身份', () => {
    expect(html).toMatch(/class="[^"]*\bbot-mark\b[^"]*"/);
    expect(html).toContain('href="#grokbot"');
    const icon = fs.readFileSync(path.resolve('pwa/icon.svg'), 'utf8');
    expect(icon).toContain('#0b0d12');
    expect(icon).toContain('#78bfff');
    expect(css).toMatch(/\.is-playing\s+#host-speaking\s+i\s*\{[^}]*animation:/);
    expect(css).toMatch(/#host-speaking\s+i\s*\{[^}]*animation:\s*none/);
  });

  it('桌面双栏与手机紧凑舞台由明确断点切换', () => {
    expect(css).toMatch(/\.stage\s*\{[^}]*grid-template-columns:\s*minmax\(280px,\s*420px\)/);
    expect(css).toMatch(/@media\s*\(max-width:\s*700px\)[\s\S]*?\.stage\s*\{[^}]*grid-template-areas:\s*"art info"/);
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toMatch(/\.queue-title-line\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.queue-title\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  it('离线壳缓存覆盖新增资源', () => {
    expect(sw).toContain('const CACHE = \'claudio-shell-v12\'');
    expect(sw).toContain('\'/components/studio-visual.js\'');
    expect(sw).toContain('\'/external-playback.js\'');
    expect(sw).toContain('\'/boot-playback.js\'');
    expect(sw).toContain('\'/runtime-sync.js\'');
    expect(sw).toContain('\'/player-mode.js\'');
    expect(sw).toContain('\'/views/playlists.js\'');
  });
});
