import { describe, it, expect } from 'vitest';
import { route } from '../server/router.js';

describe('router.route', () => {
  it('空串 → noop', () => {
    expect(route('').intent).toBe('noop');
    expect(route('   ').intent).toBe('noop');
  });

  it('/skip 等已知命令 → control', () => {
    expect(route('/skip')).toMatchObject({ intent: 'control', command: 'skip' });
    expect(route('/pause')).toMatchObject({ intent: 'control', command: 'pause' });
    expect(route('/play')).toMatchObject({ intent: 'control', command: 'play' });
    expect(route('/now')).toMatchObject({ intent: 'control', command: 'now' });
    expect(route('/queue')).toMatchObject({ intent: 'control', command: 'queue' });
    expect(route('/help')).toMatchObject({ intent: 'control', command: 'help' });
  });

  it('/vol 50 → control with arg', () => {
    const r = route('/vol 50');
    expect(r.intent).toBe('control');
    expect(r.command).toBe('vol');
    expect(r.arg).toBe('50');
  });

  it('/未知命令 → unknown-command', () => {
    expect(route('/foobar').intent).toBe('unknown-command');
  });

  it('普通中文 / 英文 → chat', () => {
    expect(route('来点雨天聆听的').intent).toBe('chat');
    expect(route('hello').intent).toBe('chat');
    expect(route('放周杰伦的晴天').intent).toBe('chat'); // MVP 阶段不做"搜索直连"
  });

  it('大小写不敏感', () => {
    expect(route('/SKIP').intent).toBe('control');
    expect(route('/Pause').intent).toBe('control');
  });
});
