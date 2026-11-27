import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const settingsViewJs = fs.readFileSync(path.resolve('pwa/views/settings.js'), 'utf8');
const indexHtml = fs.readFileSync(path.resolve('pwa/index.html'), 'utf8');

describe('settings view API contract', () => {
  it('使用 /api/settings 的全量扁平字段契约读写配置', () => {
    const expectedKeys = [
      'adaptive_volume_enabled',
      'volume_safe_max',
      'like_target_listid',
      'like_target_name',
      'fish_api_key',
      'fish_voice_id',
      'weather_enabled',
      'openweather_api_key',
      'openweather_city',
      'ui_theme',
      'global_hotkey',
      'hotkey_media_key',
      'close_to_tray',
      'always_on_top_mini',
      'music_provider',
    ];
    for (const key of expectedKeys) {
      expect(settingsViewJs).toContain(key);
    }

    expect(settingsViewJs).not.toContain('brain_mode');
    expect(settingsViewJs).not.toContain('calendar_provider');
    expect(settingsViewJs).not.toContain('dj_enabled');
    expect(settingsViewJs).not.toContain('deepseek_api_key');
    expect(settingsViewJs).not.toContain('deepseek_model');
    expect(settingsViewJs).not.toContain("key: 'lark'");
    expect(settingsViewJs).not.toContain("key: 'calendar'");
    expect(settingsViewJs).not.toContain("key: 'ai'");
    expect(settingsViewJs).not.toContain("key: 'dj'");
    expect(settingsViewJs).not.toContain('s?.weather?.apiKey');
    expect(settingsViewJs).not.toContain('payload.weather.apiKey');
    expect(settingsViewJs).not.toContain('s?.tts?.apiKey');
    expect(settingsViewJs).not.toContain('payload.tts.apiKey');
  });

  it('清空红心歌单入口就位，模式选择、日历、常驻 DJ 与 AI 设置已移除', () => {
    expect(indexHtml).toContain('id="btn-clear-like-target"');
    expect(indexHtml).not.toContain('id="set-brain-mode"');
    expect(indexHtml).not.toContain('id="set-calendar-provider"');
    expect(indexHtml).not.toContain('data-test="calendar"');
    expect(indexHtml).not.toContain('id="settings-ai"');
    expect(indexHtml).not.toContain('id="set-dj-enabled"');
    expect(indexHtml).not.toContain('data-test="ai"');
    expect(settingsViewJs).not.toContain('/api/test/ai');
    expect(settingsViewJs).not.toContain('/api/test/calendar');
  });

  it('手动改红心歌单名会清掉旧的隐藏 listid', () => {
    expect(settingsViewJs).not.toContain('!nodes.likeTargetName.value.trim()');
  });

  it('酷狗、网易云、QQ 三家扫码登录按钮与状态栏全部就位，无多余辅助文案', () => {
    for (const id of [
      'kugou-status',
      'netease-status',
      'qq-status',
      'btn-kugou-relogin',
      'btn-netease-relogin',
      'btn-qq-relogin',
    ]) {
      expect(indexHtml).toContain(`id="${id}"`);
      expect(settingsViewJs).toContain(id);
    }
    expect(settingsViewJs).toContain('/api/kugou/relogin/start');
    expect(settingsViewJs).toContain('/api/netease/relogin/start');
    expect(settingsViewJs).toContain('/api/qq/relogin/start');
  });

  it('设置页提供反馈入口，点击新标签打开 GitHub Issue 选择页，无多余辅助文案', async () => {
    const previousDoc = globalThis.document;
    globalThis.document = { getElementById: () => null };
    let FEEDBACK_URL;
    try {
      ({ FEEDBACK_URL } = await import('../pwa/views/settings.js'));
    } finally {
      globalThis.document = previousDoc;
    }
    expect(FEEDBACK_URL).toBe('https://github.com/Guzi212/Claudio/issues/new/choose');
    const feedbackCard = indexHtml.match(/<section class="card settings-feedback">([\s\S]*?)<\/section>/);
    expect(feedbackCard).not.toBeNull();
    const linkMatch = feedbackCard[1].match(/<a\b[^>]*id="settings-feedback"[^>]*>([\s\S]*?)<\/a>/);
    expect(linkMatch).not.toBeNull();
    expect(linkMatch[0]).toContain(`href="${FEEDBACK_URL}"`);
    expect(linkMatch[0]).toContain('target="_blank"');
    expect(linkMatch[0]).toContain('rel="noopener noreferrer"');
    expect(linkMatch[1].trim()).toBe('反馈');
    expect(feedbackCard[1]).not.toMatch(/<(p|small)\b/i);
    expect(settingsViewJs).toContain("getElementById('settings-feedback')");
  });
});
