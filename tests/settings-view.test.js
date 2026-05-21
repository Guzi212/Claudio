import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const settingsViewJs = fs.readFileSync(path.resolve('pwa/views/settings.js'), 'utf8');

describe('settings view API contract', () => {
  it('使用 /api/settings 的扁平字段契约读写配置', () => {
    expect(settingsViewJs).toContain('openweather_api_key');
    expect(settingsViewJs).toContain('openweather_city');
    expect(settingsViewJs).toContain('fish_api_key');
    expect(settingsViewJs).toContain('fish_voice_id');

    expect(settingsViewJs).not.toContain('s?.weather?.apiKey');
    expect(settingsViewJs).not.toContain('payload.weather.apiKey');
    expect(settingsViewJs).not.toContain('s?.tts?.apiKey');
    expect(settingsViewJs).not.toContain('payload.tts.apiKey');
  });
});
