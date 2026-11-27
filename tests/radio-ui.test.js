import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync(path.resolve('pwa/index.html'), 'utf8');
const css = fs.readFileSync(path.resolve('pwa/styles.css'), 'utf8');
const sw = fs.readFileSync(path.resolve('pwa/sw.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.resolve('pwa/manifest.json'), 'utf8'));

describe('radio visual contract (ink-on-xuan-paper)', () => {
  it('保留跨视图统一导航与无框桌面标题栏', () => {
    expect(css).not.toMatch(/body\.view-player\s+#topbar\s*\{\s*display:\s*none/);
    expect(html).toContain('id="topbar"');
    expect(html).toContain('aria-label="电台导航"');
    expect(html).toContain('id="desktop-titlebar"');
  });

  it('歌词位于紧凑封面正下方实时展示，内置点歌聊天区已移除', () => {
    const stage = html.slice(html.indexOf('class="stage"'), html.indexOf('class="queue"'));
    const coverColumn = stage.slice(stage.indexOf('class="cover-column"'), stage.indexOf('class="playback-panel"'));
    expect(coverColumn).toContain('id="np-cover"');
    expect(coverColumn).toContain('id="lyrics-panel"');
    expect(coverColumn.indexOf('id="np-cover"')).toBeLessThan(coverColumn.indexOf('id="lyrics-panel"'));
    expect(html).not.toContain('id="console-chat"');
    expect(html).not.toContain('id="chat"');
    expect(html).not.toContain('id="composer"');
    expect(css).not.toContain('brain-internal');
  });

  it('宣纸底、墨色字、朱砂印章色并同步 manifest', () => {
    expect(css).toContain('--canvas: #f2ede1');
    expect(css).toContain('--ink: #1f1c18');
    expect(css).toContain('--muted: #6f675b');
    expect(css).toContain('--seal: #b4432d');
    expect(css).toContain('color-scheme: light');
    expect(css).toContain('url("assets/ink/paper.webp")');
    expect(manifest.background_color).toBe('#f2ede1');
    expect(manifest.theme_color).toBe('#f2ede1');
    expect(html).toContain('<meta name="theme-color" content="#f2ede1">');
  });

  it('配色随时辰切换，五个时段都有色板且与场次划分一致', () => {
    expect(html).toContain('<html lang="zh-cn" data-daypart="night" data-theme="auto">');
    for (const part of ['dawn', 'noon', 'afternoon', 'dusk', 'night']) {
      expect(css).toContain(`:root[data-daypart="${part}"]`);
    }
    expect(css).toMatch(/\.ink-tint\s*\{[^}]*background:\s*var\(--tint\)/);
    const playerJs = fs.readFileSync(path.resolve('pwa/views/player.js'), 'utf8');
    expect(playerJs).toContain('function daypartFor(');
    expect(playerJs).toContain('root.dataset.daypart = daypart');
    expect(playerJs).toContain("daypart === 'night' ? '#moon' : '#sun'");
    expect(html).toContain('<symbol id="moon"');
    expect(html).toContain('id="edition-symbol"');
  });

  it('水墨山水是固定静态背景，动画只走 transform/opacity，不用实时滤镜', () => {
    expect(html).toContain('class="ink-scene" aria-hidden="true"');
    expect(css).toContain('url("assets/ink/landscape-wide.webp")');
    expect(css).toContain('url("assets/ink/landscape-tall.webp")');
    for (const asset of ['landscape-wide.webp', 'landscape-tall.webp', 'paper.webp', 'cover.webp', 'grokbot.webp', 'icon-512.png']) {
      expect(fs.existsSync(path.resolve('pwa/assets/ink', asset))).toBe(true);
      expect(sw).toContain(`'/assets/ink/${asset}'`);
    }
    expect(css).not.toContain('background-attachment: fixed');
    expect(css).toMatch(/\.ink-scene\s*\{[^}]*position:\s*fixed[^}]*pointer-events:\s*none/);
    expect(css).toMatch(/\.ink-mist\s*\{[^}]*will-change:\s*transform/);
    expect(css).not.toContain('backdrop-filter');
    expect(css).not.toMatch(/@keyframes[^{]+\{[^}]*filter:/);
    expect(html).not.toContain('feTurbulence');
    expect(html).not.toContain('feGaussianBlur');
    expect(html).not.toContain('class="field-hint"');
  });

  it('墨团头像、水墨默认封面与主持人动效就位，同时支持 Agent 解耦与记忆洞察', () => {
    expect(html).toMatch(/class="[^"]*\bbot-mark\b[^"]*"/);
    expect(html).toContain('href="#grokbot"');
    expect(html).toContain('id="np-cover-fallback"');
    expect(html).toContain('href="assets/ink/cover.webp"');
    const icon = fs.readFileSync(path.resolve('pwa/icon.svg'), 'utf8');
    expect(icon).toContain('#f2ede1');
    expect(manifest.icons.map(i => i.src)).toContain('/assets/ink/icon-512.png');
    expect(manifest.description).not.toMatch(/Grok/i);
    expect(css).toMatch(/\.is-playing\s+#host-speaking\s+i\s*\{[^}]*animation:/);
    expect(css).toMatch(/#host-speaking\s+i\s*\{[^}]*animation:\s*none/);
    expect(html).toContain('id="host-agent-name"');
    expect(html).toContain('id="scene-pills"');
    expect(html).toContain('id="intent-form"');
    expect(html).toContain('id="memory-insights"');
    expect(html).toContain('id="trait-form"');
    expect(html).toContain('id="trait-list"');
  });

  it('桌面双栏紧凑封面、手机紧凑舞台与 380x136 迷你陪伴态均有明确断点', () => {
    expect(css).toMatch(/\.stage\s*\{[^}]*grid-template-columns:\s*minmax\(248px,\s*324px\)/);
    expect(css).toMatch(/\.cover\s*\{[^}]*width:\s*clamp\(144px,\s*14\.5vw,\s*176px\)/);
    expect(css).toMatch(/@media\s*\(max-height:\s*220px\)/);
    expect(css).toMatch(/@media\s*\(max-width:\s*700px\)[\s\S]*?\.stage\s*\{[^}]*grid-template-areas:\s*"art info"/);
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toMatch(/\.queue-title-line\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.queue-title\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  it('离线壳缓存覆盖新增资源与全部水墨/品牌/像素素材', () => {
    expect(sw).toMatch(/const CACHE = 'claudio-shell-v37'/);
    expect(sw).toContain('\'/leader-claim.js\'');
    expect(sw).toContain('\'/theme-store.js\'');
    expect(sw).toContain('\'/host-mood.js\'');
    expect(sw).toContain('\'/assets/brand/mark-ink.svg\'');
    expect(sw).toContain('\'/assets/brand/mark-pixel.png\'');
    expect(sw).toContain('\'/assets/pixel/host-listen.webp\'');
    expect(sw).toContain('\'/assets/pixel/host-thumbsup.webp\'');
    expect(sw).toContain('\'/assets/pixel/host-head.webp\'');
    expect(sw).toContain('\'/external-playback.js\'');
    expect(sw).not.toContain('\'/boot-playback.js\'');
    expect(sw).toContain('\'/runtime-sync.js\'');
    expect(sw).toContain('\'/player-mode.js\'');
    expect(sw).toContain('\'/views/playlists.js\'');
    expect(sw).not.toContain('studio-visual.js');
    expect(sw).not.toContain('env-strip.js');
  });

  it('设置页提供像素数码第 4 主题选项与数码小人开关，深夜蓝金样式严格隔离在 [data-theme="pixel"] 下', () => {
    const selectMatch = html.match(/<select id="set-ui-theme">([\s\S]*?)<\/select>/);
    expect(selectMatch).not.toBeNull();
    expect(selectMatch[1]).toContain('<option value="auto">跟随系统</option>');
    expect(selectMatch[1]).toContain('<option value="light">浅色</option>');
    expect(selectMatch[1]).toContain('<option value="dark">深色</option>');
    expect(selectMatch[1]).toContain('<option value="pixel">像素数码</option>');
    expect(html).toContain('id="set-pixel-host"');
    expect(html).toContain('id="pixel-host-sprite"');
    expect(html).toContain('id="pixel-host-head"');
    expect(html).toContain('id="pixel-host-waiting"');
    expect(html).toContain('assets/brand/mark-ink.svg');
    expect(html).toContain('assets/brand/mark-pixel.png');
    expect(manifest.description).toBe('有记忆、越用越懂你的私人 AI 电台');
    expect(css).toContain(':root[data-theme="pixel"]');
    expect(css).toContain('--canvas: #0B1526');
    expect(css).toContain('--pixel-sky: #469BE7');
    expect(css).toContain('--pixel-gold: #F4B66A');
    for (const forbidden of ['#b8f135', '#a3e635', '#e84393', '#f472b6', '#150824', '#2a0d3f', '#461257']) {
      expect(css.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('pixel 主题在 380x136 迷你陪伴态重置控制钮尺寸，且扫码弹窗错误态不用青柠主色', () => {
    const pixelSection = css.slice(css.indexOf('/* Festival Pixel Salon theme'));
    const miniBlock = pixelSection.match(/@media\s*\(max-height:\s*220px\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    expect(miniBlock).toMatch(/:root\[data-theme="pixel"\]\s+\.icon-button\s*\{[^}]*width:\s*32px/);
    expect(miniBlock).toMatch(/:root\[data-theme="pixel"\]\s+\.main-play\s*\{[^}]*width:\s*36px/);
    expect(miniBlock).toMatch(/:root\[data-theme="pixel"\]\s+\.track-info\s+h1\s*\{[^}]*text-shadow:\s*none/);
    expect(pixelSection).toMatch(/:root\[data-theme="pixel"\]\s+\.modal-status\.off\s*\{[^}]*color:\s*var\(--pixel-red\)/);
  });

  it('歌单页支持多源搜索、设置默认红心单并精确播放单曲', () => {
    expect(html).toContain('id="search-form"');
    expect(html).toContain('id="search-input"');
    expect(html).toContain('id="search-results"');
    expect(html).toContain('id="set-music-provider"');
    const playlistsJs = fs.readFileSync(path.resolve('pwa/views/playlists.js'), 'utf8');
    expect(playlistsJs).toContain('/api/music/search?q=');
    expect(playlistsJs).toContain('/api/kugou/play');
    expect(playlistsJs).toContain('like_target_listid');
    expect(playlistsJs).toContain('claudio:queue-replace');
    // 订阅/系统歌单不可写，不能设为红心目标。
    expect(playlistsJs).toContain('p.writable !== false');
  });
});
