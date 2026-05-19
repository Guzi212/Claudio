// 极简 service worker：只缓存壳层（HTML/CSS/JS），不缓存音频和 /api/*
const CACHE = 'claudio-shell-v3';
const SHELL = [
  '/', '/index.html', '/app.js', '/styles.css', '/manifest.json', '/icon.svg',
  '/components/lyrics.js', '/components/env-strip.js',
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
  // /api/* 和音频代理永远不走缓存
  if (url.pathname.startsWith('/api/')) return;
  // 仅对 GET 走 cache-first
  if (e.request.method !== 'GET') return;

  e.respondWith(
    caches.match(e.request).then(hit => {
      if (hit) return hit;
      return fetch(e.request).then(res => {
        if (res.ok && SHELL.includes(url.pathname)) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => hit);
    })
  );
});
