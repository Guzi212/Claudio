import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const indexHtml = fs.readFileSync(path.resolve('pwa/index.html'), 'utf8');
const playerJs = fs.readFileSync(path.resolve('pwa/views/player.js'), 'utf8');
const settingsJs = fs.readFileSync(path.resolve('pwa/views/settings.js'), 'utf8');
const kugouJs = fs.readFileSync(path.resolve('server/services/kugou.js'), 'utf8');

describe('播放页音质切换', () => {
  it('收藏按钮右侧有音质按钮和菜单', () => {
    const feedback = indexHtml.slice(
      indexHtml.indexOf('class="feedback"'),
      indexHtml.indexOf('player-options'),
    );
    const favIdx = feedback.indexOf('data-console-control="favorite"');
    const qBtn = feedback.indexOf('id="np-quality-btn"');
    expect(favIdx).toBeGreaterThan(-1);
    expect(qBtn).toBeGreaterThan(favIdx); // 在收藏右边
    expect(feedback).toContain('id="np-quality-menu"');
    expect(feedback).toContain('class="quality-picker"');
  });

  it('六档选项齐全且没有假档/魔法音质', () => {
    for (const q of ['viper_clear', 'viper_atmos', 'high', 'flac', '320', '128']) {
      expect(playerJs).toContain(`q: '${q}'`);
    }
    for (const bad of ['super', 'viper_tape', 'piano', 'acappella', 'subwoofer', 'surnay']) {
      expect(playerJs).not.toContain(`q: '${bad}'`);
    }
    expect(kugouJs).not.toContain("'super'");
    expect(kugouJs).not.toContain("'viper_tape'");
  });

  it('切档写回设置、用 quality 参数取直链、seek 回断点', () => {
    expect(playerJs).toContain('export async function switchPlaybackQuality');
    expect(playerJs).toContain("body: JSON.stringify({ playback_quality: q })");
    expect(playerJs).toContain('&quality=${encodeURIComponent(quality)}');
    expect(playerJs).toContain('audio.currentTime = resumeAt');
    expect(playerJs).toContain('resolveTrackUrl(t.kugouId, q)');
  });

  it('切档失败保持原播放、回落时提示实际档', () => {
    expect(playerJs).toContain('已回落到');
    expect(playerJs).toContain('保持原档');
    expect(playerJs).toContain('suppressPauseSync = true'); // 换 src 不触发暂停上报
  });

  it('设置页音质下拉扩到六档', () => {
    for (const v of ['flac', '320', '128', 'high', 'viper_atmos', 'viper_clear']) {
      expect(indexHtml).toContain(`value="${v}"`);
    }
    expect(settingsJs).toContain("payload.playback_quality");
    expect(settingsJs).toContain("s?.playback_quality");
  });

  it('实际档位角标走 QUALITY_LABEL，显示真实值', () => {
    expect(playerJs).toContain('QUALITY_LABEL[q]');
    expect(playerJs).toContain('paintAudioQuality');
  });
});
