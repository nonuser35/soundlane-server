const CACHE = 'janela-shell-v5';
const SHELL = ['/window/', '/window/styles.css', '/window/catalog.js', '/window/soundlane-player.js', '/window/soundlane-worklet.js', '/window/script.js', '/window/manifest.webmanifest', '/window/icon.svg'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== location.origin) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
