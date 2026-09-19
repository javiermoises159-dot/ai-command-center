/**
 * Minimal service worker.
 *
 * Its only job is making the app shell installable and openable offline on
 * iOS. It deliberately does NOT cache /api responses: mission state changes
 * every second while agents run, and a stale cached pipeline would be worse
 * than an honest network error.
 */

const CACHE = 'acc-shell-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => undefined),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never serve API traffic from cache.
  if (request.method !== 'GET' || url.pathname.startsWith('/api/')) return;

  // Navigations: network first, cached shell as the offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/index.html').then((r) => r ?? Response.error())));
    return;
  }

  // Static assets: cache first, refresh in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached ?? Response.error());
      return cached ?? network;
    }),
  );
});
