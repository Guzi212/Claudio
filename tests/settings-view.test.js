import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const settingsViewJs = fs.readFileSync(path.resolve('pwa/views/settings.js'), 'utf8');
const indexHtml = fs.readFileSync(path.resolve('pwa/index.html'), 'utf8');

describe('settings view API contract', () => {
  it('使用 /api/settings 的全量扁平字段契约读写配置', () => {
    const expectedKeys = [
      'brain_mode',
      'dj_enabled',
      'dj_poll_seconds',
      'dj_min_remaining_minutes',
      'dj_batch_size',
      'deepseek_api_key',
      'deepseek_model',
      'adaptive_volume_enabled',
      'volume_safe_max',
      'like_target_listid',
      'like_target_name',
      'fish_api_key',
      'fish_voice_id',
      'weather_enabled',
      'openweather_api_key',
      'openweather_city',
      'calendar_provider',
      'ui_theme',
      'global_hotkey',
      'hotkey_media_key',
      'close_to_tray',
      'always_on_top_mini',
    ];
    for (const key of expectedKeys) {
      expect(settingsViewJs).toContain(key);
    }

    expect(settingsViewJs).not.toContain('s?.weather?.apiKey');
    expect(settingsViewJs).not.toContain('payload.weather.apiKey');
    expect(settingsViewJs).not.toContain('s?.tts?.apiKey');
    expect(settingsViewJs).not.toContain('payload.tts.apiKey');
  });

  it('AI 与日历连通测试和清空红心歌单入口就位，无多余 helper 文案', () => {
    expect(indexHtml).toContain('data-test="ai"');
    expect(indexHtml).toContain('data-test="calendar"');
    expect(indexHtml).toContain('id="btn-clear-like-target"');
    expect(settingsViewJs).toContain('/api/test/ai');
    expect(settingsViewJs).toContain('/api/test/calendar');
  });

  it('手动改红心歌单名会清掉旧的隐藏 listid', () => {
    expect(settingsViewJs).not.toContain('!nodes.likeTargetName.value.trim()');
  });
});
