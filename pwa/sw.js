// 极简 service worker：只缓存壳层（HTML/CSS/JS），不缓存音频和 /api/*
const CACHE = 'claudio-shell-v23';
const SHELL = [
  '/', '/index.html', '/app.js', '/session-url.js', '/theme-store.js', '/volume-memory.js', '/client-id.js', '/media-session.js', '/styles.css', '/manifest.json', '/icon.svg',
  '/external-playback.js', '/boot-playback.js', '/runtime-sync.js', '/player-mode.js',
  '/views/ui.js', '/views/player.js', '/views/playlists.js', '/views/profile.js', '/views/settings.js',
  '/components/lyrics.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return;
  if (url.searchParams.has('token')) {
    e.respondWith(fetch(e.request));
    return;
  }
  if (e.request.method !== 'GET') return;

  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok && SHELL.includes(url.pathname)) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
