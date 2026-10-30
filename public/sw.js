const CACHE_PREFIX = 'inventory-app-shell-';
const CACHE_VERSION = `${CACHE_PREFIX}v2`;
const APP_SHELL = ['./', './index.html', './manifest.webmanifest'];
const STATIC_ASSET = /\/assets\/[A-Za-z0-9._-]+$/;

const isCacheableRequest = (request) => {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (request.headers.has('authorization')) return false;
  if (request.mode === 'navigate') return url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');
  return STATIC_ASSET.test(url.pathname) || url.pathname.endsWith('/manifest.webmanifest');
};

const canStoreResponse = (response) => {
  if (!response.ok || response.type !== 'basic') return false;
  const cacheControl = response.headers.get('cache-control') || '';
  if (/no-store|private/i.test(cacheControl)) return false;
  if (response.headers.has('set-cookie')) return false;
  return true;
};

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => Promise.all(APP_SHELL.map(async (path) => {
    const request = new Request(path, { method: 'GET', credentials: 'same-origin', cache: 'reload' });
    const response = await fetch(request);
    if (!canStoreResponse(response)) return false;
    await cache.put(request, response.clone());
    return true;
  }))));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!isCacheableRequest(request)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (canStoreResponse(response)) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.put('./index.html', copy)));
          }
          return response;
        })
        .catch(async () => (await caches.match('./index.html')) || (await caches.match('/index.html')) || Response.error()),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (canStoreResponse(response)) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy)));
      }
      return response;
    })),
  );
});
