// Service worker: keep the app current, and never serve stale code to a client
// that is online.
//
// A reference worker for a new app. An app that already has one wants
// sw-update.js on its own instead -- see the README.
//
// __BUILD_VERSION__ is replaced at deploy time with a hash of the web
// directory. A version derived from the content cannot be forgotten, which a
// hand-bumped constant can and eventually will be -- and a worker whose bytes
// have not changed is a worker the browser will not update.
const CACHE_NAME = 'magpie-__BUILD_VERSION__';

importScripts('/sw-update.js');

self.addEventListener('install', () => {
  // Take over at once rather than waiting for every tab to close. An installed
  // PWA is often never closed at all, so a worker that waits politely can sit
  // there for weeks.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    await self.clients.claim();
    await announceUpdate();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // The API is never cached, and /bust must always reach the server, or the
  // escape hatch is behind the thing it exists to escape.
  if (event.request.method !== 'GET') return;
  if (url.pathname === '/bust' || url.pathname.startsWith('/api/')) return;

  // Network-first, always. This buys no speed -- an online client waits for the
  // network every time. It is chosen for one property: a deployed change is
  // live on the next request, and there is no path by which an online client
  // can be served an old asset.
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request, { cache: 'no-cache' });
      if (response.ok) {
        const copy = response.clone();
        // Not awaited: the response should not wait on the write.
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
      }
      return response;
    } catch {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      // A navigation with nothing cached still has to render something, and
      // the shell is the only sensible answer.
      if (event.request.mode === 'navigate') {
        const shell = await caches.match('/') || await caches.match('/index.html');
        if (shell) return shell;
      }
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    }
  })());
});
