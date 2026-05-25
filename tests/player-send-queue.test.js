import fs from 'node:fs';
import { describe, it, expect } from 'vitest';

const playerJs = fs.readFileSync('./pwa/views/player.js', 'utf8');

// 从 send() 函数体中截取，避免误匹配文件其他地方的代码
const sendFnStart = playerJs.indexOf('async function send(');
const sendFnBody = playerJs.slice(sendFnStart, playerJs.indexOf('\nasync function ', sendFnStart + 1));

describe('send() 响应队列处理', () => {
  it('聊天气泡歌单过滤掉 isTts 条目', () => {
    // 必须用 filter(!q.isTts) 构建显示列表，TTS 播报不该出现在用户看到的歌单里
    expect(sendFnBody).toMatch(/\.filter\(\s*q\s*=>\s*!q\.isTts\s*\)/);
  });

  it('无真实歌曲但 _resolveError 为 true 时调用 showAlert', () => {
    // 酷狗搜索全部失败时需要给用户反馈，而不是静默无响应
    expect(sendFnBody).toContain('_resolveError');
    expect(sendFnBody).toMatch(/showAlert\(/);
  });

  it('聊天气泡为每首有 comment 的歌渲染 track-comment', () => {
    // send() 生成的 metaHtml 必须包含 track-list 和 q.comment 的引用
    expect(sendFnBody).toContain('track-list');
    expect(sendFnBody).toMatch(/q\.comment/);
  });
});
