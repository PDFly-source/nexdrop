/**
 * NexDrop Offline PWA Service Worker
 * Serves the application shell from cache so the PWA opens offline.
 *
 * NOTE: offline shell caching only makes the APP openable offline. Active
 * WebRTC transfers still require a network connection to the peer.
 */

const CACHE_NAME = 'nexdrop-shell-v3';
const BASE = '/nexdrop';
const SHELL_ASSETS = [
  `${BASE}/`,
  `${BASE}/manifest.webmanifest`,
  `${BASE}/icons/icon.svg`,
  `${BASE}/icons/icon-192.png`,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((key) => key !== CACHE_NAME && caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Never intercept anything outside the app scope or non-GET requests.
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(BASE + '/') && url.pathname !== BASE) return;

  // Cache-first for hashed static assets, network-first for pages.
  const isStaticAsset =
    url.pathname.includes('/_next/static/') ||
    url.pathname.startsWith(`${BASE}/icons/`);

  if (isStaticAsset) {
    event.respondWith(
      caches.match(event.request).then(
        (cached) =>
          cached ||
          fetch(event.request).then((response) => {
            if (response.status === 200) {
              const copy = response.clone();
              caches
                .open(CACHE_NAME)
                .then((cache) => cache.put(event.request, copy))
                .catch(() => {});
            }
            return response;
          })
      )
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.status === 200) {
          const copy = response.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(event.request, copy))
            .catch(() => {});
        }
        return response;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => {
          if (cached) return cached;
          if (event.request.mode === 'navigate') {
            return caches.match(`${BASE}/`);
          }
          return Response.error();
        })
      )
  );
});
