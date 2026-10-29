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

  it('使用夜墨山水 token，朱砂（Claude 赭）作印章色', () => {
    expect(css).toContain('--canvas: #0b0c0e');
    expect(css).toContain('--surface: #15171a');
    expect(css).toContain('--ink: #ece6d8');
    expect(css).toContain('--muted: #9b968b');
    expect(css).toContain('--seal: #d97757');
    expect(css).toContain('--paper: #e9e2d0');
    expect(manifest.background_color).toBe('#0b0c0e');
    expect(html).toContain('<meta name="theme-color" content="#0b0c0e">');
  });

  it('配色随时辰切换，五个时段都有色板且与场次划分一致', () => {
    expect(html).toContain('<html lang="zh-cn" data-daypart="night">');
    for (const part of ['dawn', 'noon', 'afternoon', 'dusk']) {
      expect(css).toContain(`:root[data-daypart="${part}"]`);
    }
    const playerJs = fs.readFileSync(path.resolve('pwa/views/player.js'), 'utf8');
    expect(playerJs).toContain('function daypartFor(');
    expect(playerJs).toContain('root.dataset.daypart = daypart');
    expect(playerJs).toContain("daypart === 'night' ? '#moon' : '#sun'");
    expect(html).toContain('<symbol id="moon"');
    expect(html).toContain('id="edition-symbol"');
  });

  it('水墨远山是固定背景，动画只走 transform/opacity，不用实时滤镜', () => {
    expect(html).toContain('class="ink-scene" aria-hidden="true"');
    expect(css).toMatch(/\.ink-scene\s*\{[^}]*position:\s*fixed[^}]*pointer-events:\s*none/);
    expect(css).toMatch(/\.ink-mist\s*\{[^}]*will-change:\s*transform/);
    expect(css).not.toContain('backdrop-filter');
    expect(css).not.toMatch(/@keyframes[^{]+\{[^}]*filter:/);
    expect(html).not.toContain('feTurbulence');
    expect(html).not.toContain('feGaussianBlur');
  });

  it('侠客 Grokbot 标记、声波和页面图标保持一致身份', () => {
    expect(html).toMatch(/class="[^"]*\bbot-mark\b[^"]*"/);
    expect(html).toContain('href="#grokbot"');
    const grokbot = html.slice(html.indexOf('<symbol id="grokbot"'), html.indexOf('</symbol>', html.indexOf('<symbol id="grokbot"')));
    expect(grokbot).toContain('#d97757');
    const icon = fs.readFileSync(path.resolve('pwa/icon.svg'), 'utf8');
    expect(icon).toContain('#0b0c0e');
    expect(icon).toContain('#d97757');
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
    expect(sw).toContain('const CACHE = \'claudio-shell-v13\'');
    expect(sw).toContain('\'/components/studio-visual.js\'');
    expect(sw).toContain('\'/external-playback.js\'');
    expect(sw).toContain('\'/boot-playback.js\'');
    expect(sw).toContain('\'/runtime-sync.js\'');
    expect(sw).toContain('\'/player-mode.js\'');
    expect(sw).toContain('\'/views/playlists.js\'');
  });
});
