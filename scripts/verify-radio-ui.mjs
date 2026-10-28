// Isolated visual verification for the radio shell. No production services, credentials or music APIs.
// Usage: node scripts/verify-radio-ui.mjs [output-directory]
import http from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] || path.join(tmpdir(), 'claudio-radio-ui-preview'));
const chromeProfile = path.join(tmpdir(), `claudio-ui-chrome-${process.pid}`);
const port = await freePort();
const debugPort = await freePort();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const base = `http://127.0.0.1:${port}`;
let server;
let chrome;
let ws;
let sequence = 0;
const pending = new Map();
const errors = [];

async function freePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => socket.listen(0, '127.0.0.1', resolve).once('error', reject));
  const value = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return value;
}

function send(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}

async function waitFor(expression, timeout = 10000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await evaluate(expression); if (last) return last; } catch (error) { last = error.message; }
    await delay(80);
  }
  throw new Error(`Timed out: ${expression}; last=${JSON.stringify(last)}`);
}

function cover(title, subtitle, colors) {
  const [a, b, c] = colors;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600"><defs><linearGradient id="g" x2=".8" y2="1"><stop stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient><radialGradient id="h"><stop stop-color="#f0e5d2" stop-opacity=".65"/><stop offset="1" stop-color="#f0e5d2" stop-opacity="0"/></radialGradient></defs><g><path fill="url(#g)" d="M0 0h600v600H0z"/><circle cx="390" cy="190" r="210" fill="url(#h)"/><circle cx="390" cy="190" r="83" fill="#e1dfd4" opacity=".88"/><path d="m0 310 110-84 100 62 104-80 99 83 106-68 81 72v305H0z" fill="${c}" opacity=".72"/><path d="m0 395 114-47 96 36 102-68 133 71 155-55v268H0z" fill="${c}"/><path d="M0 490q190-52 600 0v110H0z" fill="#101a27" opacity=".65"/><g fill="#f1f0e9"><text x="38" y="64" font-size="20" font-family="sans-serif" letter-spacing="5">${title}</text><text x="38" y="552" font-size="14" font-family="sans-serif" letter-spacing="3" opacity=".75">${subtitle}</text></g></g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function wav(seconds = 240) {
  const rate = 8000;
  const length = rate * seconds;
  const buffer = Buffer.alloc(44 + length * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + length * 2, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(length * 2, 40);
  for (let i = 0; i < length; i++) {
    const envelope = i % rate < rate / 2 ? 0.35 : 0;
    buffer.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 110 * i / rate) * 2400 * envelope), 44 + i * 2);
  }
  return buffer;
}

const tracks = [
  { title: '晴天', artist: '周杰伦', kugouId: 'preview-sunny', reason: '熟悉的吉他前奏，把傍晚交给青春。', audioUrl: '/preview-tone.wav', duration: 240, cover: cover('晴天', '周杰伦', ['#8099aa', '#253e58', '#21374c']) },
  { title: '后来', artist: '刘若英', kugouId: 'preview-later', reason: '让回忆跟着钢琴慢慢来。', audioUrl: '/preview-tone.wav', duration: 240, cover: cover('后来', '刘若英', ['#8b8278', '#473c39', '#433933']) },
  { title: '富士山下', artist: '陈奕迅', kugouId: 'preview-fuji', reason: '用一段弦乐，接住心事。', audioUrl: '/preview-tone.wav', duration: 240, cover: cover('富士山下', '陈奕迅', ['#a1b1b5', '#3c5662', '#33434c']) },
  { title: '慢慢喜欢你', artist: '莫文蔚', kugouId: 'preview-slow', reason: '把日常唱得温柔一点。', audioUrl: '/preview-tone.wav', duration: 240, cover: cover('慢慢喜欢你', '莫文蔚', ['#a59b82', '#5b4b3b', '#504333']) },
];
const tone = wav();
const state = { queue: tracks, index: 0, paused: false, trackEnded: false, currentTime: 83, duration: 240, volume: 30, brain: 'external', lastSay: '晚上好，loic。今晚让 Grokbot 陪你，把节奏放慢一点。', lastReason: '', queuedAt: '2026-10-27T09:05:00.000Z' };
const clients = new Set();
function broadcastState(origin) {
  const event = JSON.stringify({ type: 'state', runtime: state, ...(origin ? { origin } : {}) });
  for (const client of clients) if (client.readyState === 1) client.send(event);
}

function createPreview() {
  const app = express();
  app.use(express.json());
  app.get('/api/now', (_req, res) => res.json({ ok: true, ...state, nowPlaying: state.queue[state.index] }));
  app.get('/api/status', (_req, res) => res.json({ ok: true, ...state, nowPlaying: state.queue[state.index] }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/health/integrations', (_req, res) => res.json({ kugou: { ok: true, message: '试听就绪' }, weather: { ok: false, message: '未配置' }, tts: { ok: false, message: '未配置' }, ai: { ok: false, message: '未配置' }, lark: { ok: false, message: '未配置' } }));
  app.get('/api/settings', (_req, res) => res.json({ openweather_city: 'Shanghai' }));
  app.get('/api/studio/state', (_req, res) => res.json({ studio: { activeMode: 'dark', onAir: !state.paused } }));
  app.get('/api/taste', (_req, res) => res.json({ taste: '# 喜欢的声音\n\n- 周杰伦\n- 陈奕迅\n- 安静的夜晚\n\n<!-- kugou-distilled:start -->\n<!-- kugou-distilled:end -->', routines: '# 日常\n\n- 09:00 工作\n- 22:00 放松' }));
  app.get('/api/kugou/playlists', (_req, res) => res.json({ ok: true, playlists: [{ listid: '1', name: '深夜循环', songCount: 28 }, { listid: '2', name: '通勤路上', songCount: 45 }, { listid: '3', name: '那些年的华语歌', songCount: 62 }] }));
  app.get('/api/kugou/playlists/pool', (_req, res) => res.json({ ok: true, pool: null }));
  app.get('/api/lyric', (_req, res) => res.json({ lyric: Array.from({ length: 40 }, (_, index) => {
    const seconds = index * 5;
    const time = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    return `[${time}]${['故事的小黄花', '从出生那年就飘着', '童年的荡秋千', '随记忆一直晃到现在'][index % 4]}`;
  }).join('\n') }));
  app.get('/api/unmatched', (_req, res) => res.json({ items: [] }));
  app.get('/preview-tone.wav', (_req, res) => res.type('audio/wav').send(tone));
  app.post('/api/control', (req, res) => {
    const command = req.body?.command;
    if (command === 'pause') state.paused = true;
    if (command === 'play' || command === 'toggle') state.paused = command === 'toggle' ? !state.paused : false;
    if (command === 'next') state.index = Math.min(state.index + 1, state.queue.length - 1);
    if (command === 'prev') state.index = Math.max(state.index - 1, 0);
    if (command === 'jump') state.index = Math.max(0, Math.min(Number(req.body.value) || 0, state.queue.length - 1));
    if (command === 'volume') state.volume = Number(req.body.value);
    broadcastState();
    res.json({ ok: true, ...state });
  });
  app.post('/api/runtime/state', (req, res) => {
    if (Number.isInteger(req.body?.index)) state.index = req.body.index;
    if (typeof req.body?.paused === 'boolean') state.paused = req.body.paused;
    broadcastState(req.body?.clientId);
    res.json({ ok: true });
  });
  app.post('/api/feedback', (_req, res) => res.json({ ok: true, id: 1 }));
  app.get('/api/track-url', (_req, res) => res.json({ ok: true, url: '/preview-tone.wav' }));
  app.get('/api/kugou/track-url', (_req, res) => res.json({ ok: true, url: '/preview-tone.wav' }));
  app.use(express.static(path.join(root, 'pwa')));
  server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, base).pathname !== '/stream') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, client => {
      clients.add(client);
      client.on('close', () => clients.delete(client));
      client.on('message', raw => {
        const message = JSON.parse(raw.toString());
        if (message.type !== 'progress') return;
        for (const key of ['currentTime', 'duration', 'volume', 'paused', 'index']) {
          if (message[key] != null) state[key] = message[key];
        }
      });
    });
  });
}

async function click(selector) {
  const point = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center', behavior: 'instant' }); const rect = el.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width, height: rect.height }; })()`);
  assert.ok(point && point.width > 0 && point.height > 0, `Click target not visible: ${selector}`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}

async function screenshot(name) {
  await evaluate('window.scrollTo({ top: 0, behavior: "instant" })');
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(path.join(output, `${name}.png`), Buffer.from(shot.data, 'base64'));
}

async function viewport(width, height, reduced = true) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setLocaleOverride', { locale: 'zh-CN' });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] });
}

async function navigate(query = '') {
  await send('Page.navigate', { url: `${base}/${query}` });
  await waitFor(`document.readyState === 'complete' && !!document.querySelector('#np-title')`);
  await evaluate('window.scrollTo({ top: 0, behavior: "instant" })');
  await evaluate('document.fonts.ready');
  await waitFor(`document.querySelector('#status').textContent.includes('在线')`);
  await delay(150);
  // Headless Chrome 默认不允许自动播放；按真实产品路径点击解锁，不绕过遮罩。
  const visible = await evaluate(`!document.querySelector('#boot-overlay').classList.contains('hidden')`);
  if (visible) await click('#boot-btn');
  await waitFor(`document.querySelector('#boot-overlay').classList.contains('hidden')`).catch(async error => {
    await screenshot('unlock-failure');
    console.error('Unlock state:', await evaluate(`({ audio: { src: document.querySelector('#audio').src, paused: document.querySelector('#audio').paused, error: document.querySelector('#audio').error?.message, readyState: document.querySelector('#audio').readyState }, overlay: document.querySelector('#boot-overlay').outerHTML, errors: ${JSON.stringify(errors)} })`));
    throw error;
  });
}

async function layout(name, width, height, { fit = false } = {}) {
  const metrics = await evaluate(`(() => ({
    width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    title: document.querySelector('#np-title')?.textContent,
    visibleControls: [...document.querySelectorAll('[data-console-control]')].filter(el => el.getBoundingClientRect().width > 0).map(el => ({ action: el.dataset.consoleControl, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })),
    duplicateIds: [...document.querySelectorAll('[id]')].map(el => el.id).filter((id, i, all) => all.indexOf(id) !== i),
    topbar: getComputedStyle(document.querySelector('#topbar')).display,
    host: document.querySelector('.host')?.getBoundingClientRect().toJSON(),
    cover: document.querySelector('.cover')?.getBoundingClientRect().toJSON(),
    playback: document.querySelector('.playback-panel')?.getBoundingClientRect().toJSON()
  }))()`);
  assert.equal(metrics.scrollWidth, width, `${name}: horizontal overflow`);
  assert.equal(metrics.duplicateIds.length, 0, `${name}: duplicate IDs`);
  assert.notEqual(metrics.topbar, 'none', `${name}: navigation hidden`);
  if (fit) assert.ok(metrics.scrollHeight <= height + 1, `${name}: content height ${metrics.scrollHeight} exceeds ${height}`);
  await screenshot(name);
  return metrics;
}

try {
  await mkdir(output, { recursive: true });
  createPreview();
  await new Promise((resolve, reject) => server.listen(port, '127.0.0.1', resolve).once('error', reject));
  chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
    '--headless=new', '--hide-scrollbars', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--mute-audio',
    '--force-device-scale-factor=1', `--user-data-dir=${chromeProfile}`, `--remote-debugging-port=${debugPort}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let chromeLog = '';
  chrome.stderr.on('data', chunk => { chromeLog = (chromeLog + chunk.toString()).slice(-2000); });
  let target;
  for (let i = 0; i < 100; i++) {
    try { const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json(); target = pages.find(p => p.type === 'page'); if (target) break; } catch {}
    await delay(100);
  }
  if (!target) throw new Error(`Chrome unavailable: ${chromeLog}`);
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (!message.id) return;
    const job = pending.get(message.id); if (!job) return;
    pending.delete(message.id);
    if (message.error) job.reject(new Error(message.error.message)); else job.resolve(message.result);
  });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `navigator.serviceWorker?.getRegistrations().then(rs => Promise.all(rs.map(r => r.unregister())));` });
  await evaluate(`navigator.serviceWorker?.getRegistrations().then(rs => Promise.all(rs.map(r => r.unregister())))`).catch(() => {});

  const results = {};
  for (const [name, width, height] of [['desktop', 1280, 900], ['wide', 1440, 900], ['mobile', 390, 844], ['small', 320, 760]]) {
    await viewport(width, height);
    await navigate();
    await waitFor(`document.querySelector('#queue-list').children.length === 3`);
    results[name] = await layout(name, width, height);
  }

  await viewport(390, 844); await navigate();
  await waitFor(`!document.body.classList.contains('is-empty')`);
  await evaluate(`document.querySelector('[data-console-control="play-pause"]').click()`);
  await waitFor(`document.body.classList.contains('paused')`);
  await click('[data-console-control="play-pause"]');
  await waitFor(`!document.body.classList.contains('paused')`);
  await waitFor(`document.body.classList.contains('is-playing')`);
  const playback = await evaluate(`({ playing: document.body.classList.contains('is-playing'), paused: document.body.classList.contains('paused'), label: document.querySelector('[data-console-control="play-pause"]').getAttribute('aria-label'), audioPaused: document.querySelector('#audio').paused })`);
  assert.equal(playback.playing, true); assert.equal(playback.paused, false); assert.equal(playback.label, '暂停'); assert.equal(playback.audioPaused, false);
  await viewport(390, 844, false); await delay(250);
  const motionPlaying = await evaluate(`getComputedStyle(document.querySelector('#host-speaking i')).animationName`);
  console.log('Motion state:', await evaluate(`({ body: document.body.className, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, animation: getComputedStyle(document.querySelector('#host-speaking i')).animationName, audioPaused: document.querySelector('#audio').paused })`));

  await evaluate(`document.querySelector('[data-console-control="play-pause"]').click()`);
  await waitFor(`document.body.classList.contains('paused')`);
  const motionPaused = await evaluate(`getComputedStyle(document.querySelector('#host-speaking i')).animationName`);
  assert.notEqual(motionPlaying, 'none'); assert.equal(motionPaused, 'none');
  await screenshot('mobile-paused');

  await evaluate(`document.querySelector('#queue-list [data-idx="1"]').click()`);
  await waitFor(`document.querySelector('#np-title').textContent === '后来'`);
  const selected = await evaluate(`document.querySelector('#np-title').textContent`);
  assert.equal(selected, '后来');
  await evaluate('window.scrollTo({ top: 0, behavior: "instant" })');
  await waitFor(`document.body.classList.contains('is-playing') && document.querySelector('#audio').readyState >= 2`);
  await click('[data-console-control="next"]');
  await waitFor(`document.querySelector('#np-title').textContent === '富士山下'`);
  await waitFor(`document.body.classList.contains('is-playing') && document.querySelector('#audio').readyState >= 2`);
  await evaluate('window.scrollTo({ top: 0, behavior: "instant" })');
  await click('[data-console-control="prev"]');
  await waitFor(`document.querySelector('#np-title').textContent === '后来'`).catch(async error => {
    await screenshot('previous-failure');
    console.error('Previous state:', await evaluate(`({ title: document.querySelector('#np-title').textContent, y: scrollY, hit: document.elementFromPoint(...(() => { const r = document.querySelector('[data-console-control="prev"]').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })())?.outerHTML, alert: document.querySelector('#alert-bar').textContent })`));
    throw error;
  });
  await evaluate(`document.querySelector('[data-feedback="like"]').click()`);
  const liked = await evaluate(`document.querySelector('[data-feedback="like"]').getAttribute('aria-pressed')`);
  await evaluate(`document.querySelector('[data-feedback="dislike"]').click()`);
  const exclusive = await evaluate(`document.querySelector('[data-feedback="like"]').getAttribute('aria-pressed') === 'false' && document.querySelector('[data-feedback="dislike"]').getAttribute('aria-pressed') === 'true'`);
  await evaluate(`document.querySelector('[data-feedback="dislike"]').click()`);
  const cancelled = await evaluate(`document.querySelector('[data-feedback="dislike"]').getAttribute('aria-pressed') === 'false'`);
  assert.equal(liked, 'true'); assert.equal(exclusive, true); assert.equal(cancelled, true);

  await waitFor(`Number.isFinite(document.querySelector('#audio').duration) && document.querySelector('#audio').duration > 0`);
  await evaluate(`(() => { const el = document.querySelector('#np-seek'); el.value = '40'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(`document.querySelector('#np-time-cur').textContent === '1:36'`).catch(async error => {
    console.error('Seek state:', await evaluate(`({ duration: document.querySelector('#audio').duration, currentTime: document.querySelector('#audio').currentTime, label: document.querySelector('#np-time-cur').textContent, value: document.querySelector('#np-seek').value })`));
    throw error;
  });
  const seek = await evaluate(`document.querySelector('#np-time-cur').textContent`);
  assert.equal(seek, '1:36');
  await evaluate(`(() => { const el = document.querySelector('#np-vol'); el.value = '47'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(`document.querySelector('#np-vol-out').textContent === '47'`);
  await send('Page.reload'); await waitFor(`document.querySelector('#np-vol')?.value === '47'`).catch(async error => {
    console.error('Volume state:', await evaluate(`({ value: document.querySelector('#np-vol')?.value, output: document.querySelector('#np-vol-out')?.textContent, stored: localStorage.getItem('claudio:volume') })`));
    await screenshot('volume-failure');
    throw error;
  });
  const rememberedVolume = await evaluate(`document.querySelector('#np-vol').value`);
  assert.equal(rememberedVolume, '47');
  await evaluate(`(() => { const el = document.querySelector('#np-vol'); el.value = '30'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);

  const nav = {};
  for (const view of ['playlists', 'profile', 'settings', 'player']) {
    await evaluate(`document.querySelector('.tab[data-view="${view}"]').click()`);
    await waitFor(`!document.querySelector('#view-${view}').classList.contains('hidden')`);
    await delay(100);
    nav[view] = await evaluate(`({ active: document.querySelector('.tab[data-view="${view}"]').classList.contains('active'), width: document.documentElement.scrollWidth, url: location.search })`);
    assert.equal(nav[view].active, true); assert.equal(nav[view].width, 390);
    if (view !== 'player') await screenshot(`mobile-${view}`);
  }
  await viewport(1280, 900);
  for (const view of ['playlists', 'profile', 'settings']) {
    await evaluate(`document.querySelector('.tab[data-view="${view}"]').click()`);
    await waitFor(`!document.querySelector('#view-${view}').classList.contains('hidden')`);
    await delay(100);
    assert.equal(await evaluate(`document.documentElement.scrollWidth`), 1280);
    await screenshot(`desktop-${view}`);
  }
  await evaluate(`document.querySelector('.tab[data-view="player"]').click()`);
  let focus;
  for (let i = 0; i < 12; i++) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    focus = await evaluate(`({ outline: getComputedStyle(document.activeElement).outlineStyle, element: document.activeElement.dataset.consoleControl || document.activeElement.dataset.view, visible: document.activeElement.matches(':focus-visible') })`);
    if (focus.element === 'play-pause') break;
  }
  assert.notEqual(focus.outline, 'none'); assert.equal(focus.element, 'play-pause');

  await viewport(390, 844); await navigate();
  await evaluate(`document.querySelector('#np-title').textContent = '慢慢喜欢你，在漫长的季节里'; document.querySelector('#np-artist').textContent = '一位名字很长的歌手'; document.querySelector('.track-info').classList.add('long-title'); document.querySelector('#host-line').textContent = '晚上好。今晚从一首熟悉的歌开始，不赶时间，也不必急着去哪里。让音乐陪你慢慢把今天放下。';`);
  await screenshot('mobile-long-copy');
  assert.equal(await evaluate('document.documentElement.scrollWidth'), 390);
  await evaluate(`document.body.classList.add('is-empty')`);
  await screenshot('mobile-empty');
  await viewport(1280, 900); await screenshot('desktop-empty');
  await evaluate(`document.body.classList.remove('is-empty')`);
  await viewport(390, 844);
  const consoleHidden = await evaluate(`getComputedStyle(document.querySelector('#console-chat')).display`);
  assert.equal(consoleHidden, 'none');
  const externalOptionsHidden = await evaluate(`[...document.querySelectorAll('[data-internal-only]')].every(el => getComputedStyle(el).display === 'none')`);
  assert.equal(externalOptionsHidden, true);

  const savedQueue = state.queue;
  state.index = 0;
  state.queue = Array.from({ length: 8 }, (_, index) => ({ ...savedQueue[index % savedQueue.length], title: `${savedQueue[index % savedQueue.length].title} · 深夜特别版本 ${index + 1}`, cover: '' }));
  await viewport(320, 760); await navigate();
  await waitFor(`document.querySelector('#queue-list').children.length === 7`).catch(async error => {
    console.error('Long queue state:', await evaluate(`({ index: ${state.index}, count: document.querySelector('#queue-list').children.length, empty: document.body.className, queueText: document.querySelector('#queue-list').textContent })`));
    throw error;
  });
  const longQueue = await evaluate(`({ width: document.documentElement.scrollWidth, count: document.querySelector('#queue-list').children.length, titleWidth: document.querySelector('.queue-title').getBoundingClientRect().width, scrollHeight: document.documentElement.scrollHeight })`);
  assert.equal(longQueue.width, 320); assert.equal(longQueue.count, 7);
  await screenshot('small-long-queue');
  state.queue = savedQueue.map(track => ({ ...track, cover: '/missing-cover.png' }));
  await navigate();
  await waitFor(`document.querySelector('#np-cover-img').hidden && !document.querySelector('#np-cover-fallback').hidden`);
  await evaluate(`document.querySelector('#np-cover-img').src = '/missing-cover.png'`);
  await waitFor(`document.querySelector('#np-cover-img').hidden && !document.querySelector('#np-cover-fallback').hidden`);
  await waitFor(`document.querySelectorAll('.mini-cover img').length === 0`);
  const queueCoverFallback = await evaluate(`document.querySelectorAll('.mini-cover img').length`);
  assert.equal(queueCoverFallback, 0);
  await screenshot('mobile-cover-fallback');
  state.queue = savedQueue;

  state.brain = 'internal';
  await viewport(1280, 900); await navigate();
  await waitFor(`document.querySelector('#lyrics-panel .lyric-line')`);
  const internal = await evaluate(`({ chat: getComputedStyle(document.querySelector('#console-chat')).display, lyrics: getComputedStyle(document.querySelector('#lyrics-panel')).display, toggle: document.querySelector('#lyrics-toggle').hidden, aiSettings: null, scrollWidth: document.documentElement.scrollWidth })`);
  assert.notEqual(internal.chat, 'none'); assert.equal(internal.lyrics, 'none'); assert.equal(internal.toggle, false); assert.equal(internal.scrollWidth, 1280);
  await screenshot('desktop-internal');
  await click('#lyrics-toggle');
  await waitFor(`getComputedStyle(document.querySelector('#lyrics-panel')).display !== 'none'`);
  internal.lyrics = await evaluate(`getComputedStyle(document.querySelector('#lyrics-panel')).display`);
  await screenshot('desktop-internal-lyrics');
  await click('#lyrics-toggle');
  await waitFor(`getComputedStyle(document.querySelector('#lyrics-panel')).display === 'none'`);
  const internalOptions = {};
  await click('[data-console-control="loop"]');
  await waitFor(`document.querySelector('[data-console-control="loop"]').textContent === '列表循环'`);
  internalOptions.loop = await evaluate(`document.querySelector('[data-console-control="loop"]').textContent`);
  await click('[data-console-control="loop"]');
  await waitFor(`document.querySelector('[data-console-control="loop"]').textContent === '单曲循环'`);
  await click('[data-console-control="queue"]');
  await waitFor(`getComputedStyle(document.querySelector('#queue-list')).display === 'none'`);
  internalOptions.collapsed = await evaluate(`document.querySelector('[data-console-control="queue"]').getAttribute('aria-expanded')`);
  await click('[data-console-control="queue"]');
  await waitFor(`getComputedStyle(document.querySelector('#queue-list')).display !== 'none'`);
  internalOptions.expanded = await evaluate(`document.querySelector('[data-console-control="queue"]').getAttribute('aria-expanded')`);
  assert.equal(internalOptions.loop, '列表循环'); assert.equal(internalOptions.collapsed, 'false'); assert.equal(internalOptions.expanded, 'true');
  await evaluate(`document.querySelector('.tab[data-view="settings"]').click()`);
  await waitFor(`getComputedStyle(document.querySelector('#settings-ai')).display !== 'none'`);
  internal.aiSettings = await evaluate(`getComputedStyle(document.querySelector('#settings-ai')).display`);
  await screenshot('desktop-internal-settings');

  await viewport(390, 844);
  await evaluate(`document.querySelector('.tab[data-view="player"]').click()`);
  await evaluate(`(() => { const audio = document.querySelector('#audio'); audio.pause(); audio.currentTime = 60; })()`);
  await waitFor(`document.querySelector('.lyric-line.active')?.dataset.idx === '12'`);
  await click('#lyrics-toggle');
  const lyricPosition = await evaluate(`(() => {
    const panel = document.querySelector('#lyrics-panel');
    const line = panel.querySelector('.lyric-line.active');
    const p = panel.getBoundingClientRect(), r = line.getBoundingClientRect();
    return { pageY: scrollY, scrollTop: panel.scrollTop, centered: Math.abs(r.top + r.height / 2 - p.top - panel.clientTop - panel.clientHeight / 2) < 2 };
  })()`);
  assert.equal(lyricPosition.centered, true, 'Paused lyrics should center immediately on expansion');
  await evaluate(`window.scrollTo({ top: 0, behavior: 'instant' }); document.querySelector('#audio').currentTime = 65`);
  await waitFor(`document.querySelector('.lyric-line.active')?.dataset.idx === '13'`);
  const lyricFollow = await evaluate(`(() => {
    const panel = document.querySelector('#lyrics-panel');
    const line = panel.querySelector('.lyric-line.active');
    const p = panel.getBoundingClientRect(), r = line.getBoundingClientRect();
    return { pageY: scrollY, scrollTop: panel.scrollTop, centered: Math.abs(r.top + r.height / 2 - p.top - panel.clientTop - panel.clientHeight / 2) < 2 };
  })()`);
  assert.equal(lyricFollow.pageY, 0, 'Lyrics must not pull the page away from the controls');
  assert.equal(lyricFollow.centered, true, 'Following lyrics should only center within the panel');
  await screenshot('mobile-lyrics-follow');

  state.brain = 'external'; state.queue = []; state.index = 0; state.paused = true;
  await viewport(390, 844); await navigate();
  await waitFor(`document.body.classList.contains('is-empty')`);
  const empty = await evaluate(`({ stage: getComputedStyle(document.querySelector('.stage')).display, empty: getComputedStyle(document.querySelector('.empty-stage')).display, overlay: getComputedStyle(document.querySelector('#boot-overlay')).display, scrollWidth: document.documentElement.scrollWidth })`);
  assert.equal(empty.stage, 'none'); assert.notEqual(empty.empty, 'none'); assert.equal(empty.overlay, 'none'); assert.equal(empty.scrollWidth, 390);
  await screenshot('mobile-empty');

  assert.equal(errors.length, 0, `Browser errors: ${errors.join('\n')}`);
  await writeFile(path.join(output, 'verification.json'), JSON.stringify({ results, playback, motionPlaying, motionPaused, selected, liked, exclusive, cancelled, seek, rememberedVolume, nav, focus, consoleHidden, externalOptionsHidden, longQueue, internal, internalOptions, lyricPosition, lyricFollow, empty, errors }, null, 2));
  console.log(JSON.stringify({ ok: true, output, screenshots: 14, playback, motionPlaying, motionPaused, selected, seek, rememberedVolume, nav, errors }, null, 2));
} finally {
  if (ws?.readyState === WebSocket.OPEN) { try { await send('Browser.close'); } catch {} ws.close(); }
  if (chrome && chrome.exitCode === null) chrome.kill();
  if (server) await new Promise(resolve => server.close(resolve));
}
