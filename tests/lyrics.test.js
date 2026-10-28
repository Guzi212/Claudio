import { describe, it, expect, vi } from 'vitest';
import { parseLRC, init } from '../pwa/components/lyrics.js';

function lyricDom() {
  const audio = {
    listeners: {},
    addEventListener(type, handler) { this.listeners[type] = handler; },
    currentTime: 0,
  };
  const container = {
    children: [],
    scrollTop: 0,
    clientTop: 1,
    clientHeight: 172,
    classList: { toggle() {} },
    getBoundingClientRect() { return { top: 600, height: 174 }; },
    scrollTo: vi.fn(function({ top }) { this.scrollTop = top; }),
    appendChild(fragment) {
      fragment.children.forEach((child, index) => {
        child.getBoundingClientRect = () => ({ top: 666 + index * 28 - this.scrollTop, height: 28 });
        this.children.push(child);
      });
    },
    querySelectorAll() { return this.children; },
    set textContent(value) { if (!value) this.children = []; },
  };
  const toggle = {
    hidden: true,
    expanded: 'false',
    textContent: '',
    setAttribute(name, value) { if (name === 'aria-expanded') this.expanded = value; },
    addEventListener(type, handler) { if (type === 'click') this.click = handler; },
  };
  const oldDocument = globalThis.document;
  globalThis.document = {
    getElementById(id) { return id === 'lyrics-toggle' ? toggle : null; },
    createDocumentFragment() { return { children: [], appendChild(child) { this.children.push(child); } }; },
    createElement() {
      return { className: '', dataset: {}, textContent: '', scrollIntoView: vi.fn(), classList: { add() {}, remove() {} } };
    },
  };
  return { audio, container, toggle, restore() { globalThis.document = oldDocument; } };
}

describe('parseLRC · LRC 解析器', () => {
  it('解析标准 [mm:ss.xx] 单行', () => {
    expect(parseLRC('[00:12.50]hello world')).toEqual([
      { time: 12.5, text: 'hello world' },
    ]);
  });

  it('一行多时间戳要展开成多条', () => {
    expect(parseLRC('[00:01.00][00:05.50]chorus')).toEqual([
      { time: 1, text: 'chorus' },
      { time: 5.5, text: 'chorus' },
    ]);
  });

  it('跳过元数据行 [ti:] [ar:] [al:] [by:] [offset:]', () => {
    const input = [
      '[ti:Song Title]',
      '[ar:Artist]',
      '[al:Album]',
      '[by:LRC Maker]',
      '[offset:+200]',
      '[00:10.00]lyric',
    ].join('\n');
    expect(parseLRC(input)).toEqual([{ time: 10, text: 'lyric' }]);
  });

  it('空字符串返回空数组', () => {
    expect(parseLRC('')).toEqual([]);
  });

  it('非字符串输入安全返回空数组', () => {
    expect(parseLRC(null)).toEqual([]);
    expect(parseLRC(undefined)).toEqual([]);
    expect(parseLRC(123)).toEqual([]);
  });

  it('非法格式行被跳过，合法行保留', () => {
    const r = parseLRC('not a lrc line\n[00:05.00]ok\nrandom\n[00:08.00]two');
    expect(r).toEqual([
      { time: 5, text: 'ok' },
      { time: 8, text: 'two' },
    ]);
  });

  it('结果按时间升序排序，即使输入乱序', () => {
    const r = parseLRC('[00:30.00]later\n[00:10.00]earlier\n[00:20.00]middle');
    expect(r.map(x => x.time)).toEqual([10, 20, 30]);
  });

  it('支持 [mm:ss] 无小数格式', () => {
    expect(parseLRC('[01:23]plain')).toEqual([{ time: 83, text: 'plain' }]);
  });

  it('歌词文本前后空格被 trim', () => {
    expect(parseLRC('[00:01.00]   spaced   ')).toEqual([
      { time: 1, text: 'spaced' },
    ]);
  });

  it('暂停后展开歌词，即使当前行没有变化也立即定位', async () => {
    const dom = lyricDom();
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ lyric: '[00:00]开头\n[00:05]前奏\n[00:10]主歌\n[00:15]副歌' }) }));
    try {
      const lyrics = init({ audio: dom.audio, container: dom.container });
      await lyrics.loadLyric({ kugouId: 'song-1' });
      dom.audio.currentTime = 15;
      dom.audio.listeners.timeupdate();
      expect(dom.container.scrollTop).toBe(0);
      dom.toggle.click();
      expect(dom.container.scrollTop).toBe(77);
      dom.toggle.click();
      dom.container.scrollTop = 0;
      dom.toggle.click();
      expect(dom.container.scrollTop).toBe(77);
    } finally {
      vi.unstubAllGlobals();
      dom.restore();
    }
  });

  it('逐行跟随只滚动歌词容器，不调用整页 scrollIntoView', async () => {
    const dom = lyricDom();
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ lyric: '[00:00]开头\n[00:05]前奏\n[00:10]主歌\n[00:15]副歌' }) }));
    try {
      const lyrics = init({ audio: dom.audio, container: dom.container });
      await lyrics.loadLyric({ kugouId: 'song-1' });
      dom.toggle.click();
      dom.audio.currentTime = 15;
      dom.audio.listeners.timeupdate();
      expect(dom.container.scrollTop).toBe(77);
      expect(dom.container.children.every(line => line.scrollIntoView.mock.calls.length === 0)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      dom.restore();
    }
  });

  it('暂停连续定位时 seeked 不被 timeupdate 的节流跳过', async () => {
    const dom = lyricDom();
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ lyric: '[00:00]开头\n[00:05]前奏\n[00:10]主歌\n[00:15]副歌' }) }));
    try {
      const lyrics = init({ audio: dom.audio, container: dom.container });
      await lyrics.loadLyric({ kugouId: 'song-1' });
      dom.toggle.click();
      dom.audio.currentTime = 10;
      dom.audio.listeners.timeupdate();
      expect(dom.container.scrollTop).toBe(49);
      dom.audio.currentTime = 15;
      dom.audio.listeners.seeked?.();
      expect(dom.container.scrollTop).toBe(77);
    } finally {
      vi.unstubAllGlobals();
      dom.restore();
    }
  });

  it('歌词加载后由用户展开，歌词文本不进入 HTML 解析', async () => {
    const dom = lyricDom();
    const oldFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ lyric: '[00:00]<img src=x onerror=alert(1)>' }) }));
    try {
      const lyrics = init({ audio: dom.audio, container: dom.container, getCurrentTrack: () => ({ kugouId: 'song-1' }) });
      await lyrics.loadLyric({ kugouId: 'song-1' });
      expect(dom.container.children).toHaveLength(1);
      expect(dom.container.children[0].textContent).toBe('<img src=x onerror=alert(1)>');
      expect(dom.toggle.hidden).toBe(false);
      expect(dom.toggle.expanded).toBe('false');
      expect(dom.toggle.textContent).toBe('歌词');
      dom.toggle.click();
      expect(dom.toggle.expanded).toBe('true');
      expect(dom.toggle.textContent).toBe('收起歌词');
      dom.toggle.click();
      expect(dom.toggle.expanded).toBe('false');
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/lyric?hash=song-1');
    } finally {
      globalThis.fetch = oldFetch;
      dom.restore();
    }
  });
});
