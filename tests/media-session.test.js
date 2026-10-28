import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  MEDIA_ACTIONS,
  bindMediaSession,
  currentTrack,
  installMediaSession,
  metadataFields,
  playbackStateFor,
  postControl,
  shouldApplyPlaybackState,
  shouldToggleOnSpace,
} from '../pwa/media-session.js';

function fakeSession() {
  return {
    metadata: undefined,
    playbackState: 'none',
    handlers: {},
    setActionHandler(name, fn) { this.handlers[name] = fn; },
  };
}

class FakeMetadata {
  constructor(init) { Object.assign(this, init); }
}

function fakeDoc(extra = {}) {
  const listeners = [];
  return {
    visibilityState: 'visible',
    hasFocus: () => true,
    activeElement: null,
    listeners,
    addEventListener(type, fn, capture) { listeners.push({ type, fn, capture }); },
    fire(type, event) {
      for (const item of listeners) {
        if (item.type === type) item.fn(event);
      }
    },
    ...extra,
  };
}

function bind(post = vi.fn()) {
  const session = fakeSession();
  const doc = fakeDoc();
  const win = fakeDoc();
  const api = bindMediaSession({
    navigator: { mediaSession: session },
    document: doc,
    window: win,
    artworkFallback: 'http://127.0.0.1:8080/icon.svg',
    base: 'http://127.0.0.1:8080',
    MediaMetadata: FakeMetadata,
    postControl: post,
  });
  return { session, doc, win, api, post };
}

describe('媒体元数据', () => {
  const track = { title: '晴天', artist: '周杰伦', album: '叶惠美', cover: 'https://img.example/a.jpg' };

  it('从队列里取出当前这首', () => {
    expect(currentTrack({ queue: [track], index: 0 })).toMatchObject({ title: '晴天' });
    expect(currentTrack({ queue: [] })).toBeNull();
    expect(currentTrack({ queue: [track, { title: '下一首', artist: 'B' }], index: 5 }).title).toBe('下一首');
  });

  it('歌名、歌手、封面都写进 metadata，没有封面时用站点图标', () => {
    const fields = metadataFields(track, { iconUrl: 'http://127.0.0.1:8080/icon.svg', base: 'http://127.0.0.1:8080' });
    expect(fields).toMatchObject({ title: '晴天', artist: '周杰伦', album: '叶惠美' });
    expect(fields.artwork[0]).toMatchObject({ src: 'https://img.example/a.jpg', type: 'image/jpeg' });

    const fallback = metadataFields(
      { title: '夜曲', artist: '周杰伦' },
      { iconUrl: 'http://127.0.0.1:8080/icon.svg', base: 'http://127.0.0.1:8080' },
    );
    expect(fallback.artwork[0].src).toBe('http://127.0.0.1:8080/icon.svg');
    expect(fallback.artwork[0].type).toBe('image/svg+xml');
  });

  it('相对封面按页面源补成绝对地址', () => {
    const fields = metadataFields(
      { title: 'A', artist: 'B', pic: '/covers/a.png' },
      { base: 'http://127.0.0.1:8080', iconUrl: 'http://127.0.0.1:8080/icon.svg' },
    );
    expect(fields.artwork[0].src).toBe('http://127.0.0.1:8080/covers/a.png');
    expect(fields.artwork[0].type).toBe('image/png');
  });

  it('空队列没有元数据，播放状态是 none', () => {
    expect(metadataFields(null, {})).toBeNull();
    expect(playbackStateFor({ queue: [], paused: false })).toBe('none');
    expect(playbackStateFor({ queue: [track], paused: true })).toBe('paused');
    expect(playbackStateFor({ queue: [track], paused: false })).toBe('playing');
    expect(playbackStateFor({
      queue: [{ title: '第一首', artist: 'A' }, track],
      index: 1,
      paused: false,
      trackEnded: true,
    })).toBe('paused');
  });
});

describe('空格只在前台、且不在输入框里切换', () => {
  const doc = { visibilityState: 'visible', hasFocus: () => true, activeElement: null };

  it('空格要切换，输入框、组合键和后台不切换', () => {
    expect(shouldToggleOnSpace({ key: ' ', target: { nodeType: 1, tagName: 'BODY' } }, doc)).toBe(true);
    expect(shouldToggleOnSpace({ key: ' ', repeat: true, target: { nodeType: 1, tagName: 'BODY' } }, doc)).toBe(false);
    expect(shouldToggleOnSpace({ key: ' ', ctrlKey: true, target: { nodeType: 1, tagName: 'BODY' } }, doc)).toBe(false);
    expect(shouldToggleOnSpace({ key: 'k', target: { nodeType: 1, tagName: 'BODY' } }, doc)).toBe(false);
    expect(shouldToggleOnSpace(
      { key: ' ', target: { nodeType: 1, tagName: 'INPUT' } },
      doc,
    )).toBe(false);
    expect(shouldToggleOnSpace(
      { key: ' ', target: { nodeType: 1, tagName: 'TEXTAREA' } },
      doc,
    )).toBe(false);
    expect(shouldToggleOnSpace(
      { key: ' ', target: { nodeType: 1, tagName: 'DIV', isContentEditable: true } },
      doc,
    )).toBe(false);
    expect(shouldToggleOnSpace(
      { key: ' ', target: { nodeType: 1, tagName: 'DIV', getAttribute: () => 'textbox' } },
      doc,
    )).toBe(false);
    expect(shouldToggleOnSpace(
      { key: ' ', target: { nodeType: 1, tagName: 'BODY' } },
      { ...doc, activeElement: { nodeType: 1, tagName: 'INPUT' } },
    )).toBe(false);
    expect(shouldToggleOnSpace(
      { key: ' ', target: { nodeType: 1, tagName: 'BODY' } },
      { visibilityState: 'hidden', hasFocus: () => true },
    )).toBe(false);
    expect(shouldToggleOnSpace(
      { key: ' ', target: { nodeType: 1, tagName: 'BODY' } },
      { visibilityState: 'visible', hasFocus: () => false },
    )).toBe(false);
  });

  it('shadow DOM 里的输入框用 composedPath 识别', () => {
    const input = { nodeType: 1, tagName: 'INPUT' };
    expect(shouldToggleOnSpace({
      key: ' ',
      target: { nodeType: 1, tagName: 'DIV' },
      composedPath: () => [input],
    }, doc)).toBe(false);
  });
});

describe('Media Session 回调走 /api/control', () => {
  it('play / pause / prev / next 不带 clientId', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true };
    });
    await postControl('play', { fetchImpl });
    expect(calls[0].url).toBe('/api/control');
    expect(calls[0].opts.credentials).toBe('same-origin');
    expect(JSON.parse(calls[0].opts.body)).toEqual({ command: 'play' });
    expect(calls[0].opts.body).not.toContain('clientId');
  });

  it('动作回调和空格都发控制命令', () => {
    const { session, doc, post } = bind();
    session.handlers.play();
    session.handlers.pause();
    session.handlers.previoustrack();
    session.handlers.nexttrack();
    const preventDefault = vi.fn();
    doc.fire('keydown', { key: ' ', target: { nodeType: 1, tagName: 'BODY' }, preventDefault });
    expect(post.mock.calls.map(call => call[0])).toEqual(['play', 'pause', 'prev', 'next', 'toggle']);
    expect(preventDefault).toHaveBeenCalled();
    expect(MEDIA_ACTIONS.nexttrack).toBe('next');
  });

  it('焦点在输入框时空格不发命令', () => {
    const { doc, post } = bind();
    const preventDefault = vi.fn();
    doc.fire('keydown', { key: ' ', target: { nodeType: 1, tagName: 'INPUT' }, preventDefault });
    expect(post).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('外部状态写入歌名和播放状态，自己的回声不改播放状态', () => {
    const { session, api } = bind();
    const runtime = {
      queue: [{ title: '晴天', artist: '周杰伦', album: '叶惠美' }],
      index: 0,
      paused: false,
    };
    api.noteRuntime(runtime, { origin: undefined, clientId: 'page-a' });
    expect(session.metadata).toMatchObject({ title: '晴天', artist: '周杰伦' });
    expect(session.metadata.artwork[0].src).toBe('http://127.0.0.1:8080/icon.svg');
    expect(session.playbackState).toBe('playing');

    api.noteRuntime({ ...runtime, paused: true }, { origin: 'page-a', clientId: 'page-a' });
    expect(session.playbackState).toBe('playing');
    expect(shouldApplyPlaybackState('page-a', 'page-a')).toBe(false);
    expect(shouldApplyPlaybackState(undefined, 'page-a')).toBe(true);

    api.noteRuntime({ ...runtime, paused: true }, { origin: 'page-b', clientId: 'page-a' });
    expect(session.playbackState).toBe('paused');
  });

  it('切歌事件更新封面，audio 的 play/pause 更新播放状态', () => {
    const { session, doc, win } = bind();
    win.fire('claudio:trackchange', {
      detail: { title: '夜曲', artist: '周杰伦', cover: '/c.jpg' },
    });
    expect(session.metadata.title).toBe('夜曲');
    expect(session.metadata.artwork[0].src).toBe('http://127.0.0.1:8080/c.jpg');

    doc.fire('play', { type: 'play', target: { tagName: 'AUDIO' } });
    expect(session.playbackState).toBe('playing');
    doc.fire('pause', { type: 'pause', target: { tagName: 'DIV' } });
    expect(session.playbackState).toBe('playing');
    doc.fire('pause', { type: 'pause', target: { tagName: 'AUDIO' } });
    expect(session.playbackState).toBe('paused');

    win.fire('claudio:trackchange', { detail: null });
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe('none');
  });
});

describe('安装位置不在视图里', () => {
  const app = fs.readFileSync(new URL('../pwa/app.js', import.meta.url), 'utf8');
  const player = fs.readFileSync(new URL('../pwa/views/player.js', import.meta.url), 'utf8');
  const sw = fs.readFileSync(new URL('../pwa/sw.js', import.meta.url), 'utf8');

  it('app.js 接线，播放视图里没有 Media Session', () => {
    expect(app).toContain('installMediaSession');
    expect(app).toContain('mediaSession.noteRuntime');
    expect(player).not.toContain('mediaSession');
    expect(player).not.toContain('installMediaSession');
    expect(sw).toContain("const CACHE = 'claudio-shell-v12'");
    expect(sw).toContain('/media-session.js');
  });

  it('安装时先读 /api/now，再把歌名写进 metadata', async () => {
    const session = fakeSession();
    const fetchImpl = vi.fn(async (url) => {
      if (url === '/api/now') {
        return {
          ok: true,
          json: async () => ({
            queue: [{ title: '晴天', artist: '周杰伦' }],
            index: 0,
            paused: true,
          }),
        };
      }
      return { ok: true };
    });
    const api = installMediaSession({
      document: fakeDoc(),
      window: fakeDoc(),
      navigator: { mediaSession: session },
      location: { origin: 'http://127.0.0.1:8080', protocol: 'http:' },
      fetch: fetchImpl,
      MediaMetadata: FakeMetadata,
    });
    await vi.waitFor(() => {
      expect(session.metadata?.title).toBe('晴天');
    });
    expect(session.playbackState).toBe('paused');
    expect(fetchImpl).toHaveBeenCalledWith('/api/now', { credentials: 'same-origin' });
    expect(api.noteRuntime).toBeTypeOf('function');
  });
});
