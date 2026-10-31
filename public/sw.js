'use strict';
// Offline support: the app shell and hashed assets are cached; /api is never cached (solves queue in localStorage instead)
const CACHE = 'cubetimer-v1';

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch('/', { cache: 'no-store' });
      const html = await res.clone().text();
      await cache.put('/', res);
      const assets = [...html.matchAll(/(?:href|src)="([^"]+\?v=[^"]+)"/g)].map((m) => m[1]);
      await cache.addAll(assets.map((a) => new URL(a, self.location.origin).href));
    } catch { /* offline during install; runtime caching fills in later */ }
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Keep one copy per hashed asset path so old deploys don't pile up
async function put(req, res) {
  const cache = await caches.open(CACHE);
  const url = new URL(req.url || req, self.location.origin);
  if (url.searchParams.has('v')) {
    for (const k of await cache.keys()) {
      const ku = new URL(k.url);
      if (ku.origin === url.origin && ku.pathname === url.pathname && ku.search !== url.search) await cache.delete(k);
    }
  }
  await cache.put(req, res);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;
  if (same && (url.pathname.startsWith('/api/') || url.pathname === '/health' || url.pathname === '/sw.js')) return;

  if (req.mode === 'navigate') {
    if (!same || url.pathname !== '/') return;
    e.respondWith(fetch(req).then((res) => { if (res.ok) put('/', res.clone()); return res; })
      .catch(async () => (await caches.match('/')) || Response.error()));
    return;
  }
  // Hashed assets and font files never change: cache first. Everything else: network first.
  const immutable = (same && url.searchParams.has('v')) || url.hostname === 'fonts.gstatic.com';
  if (!same && !url.hostname.startsWith('fonts.')) return;
  e.respondWith((async () => {
    if (immutable) {
      const hit = await caches.match(req);
      if (hit) return hit;
    }
    try {
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') put(req, res.clone());
      return res;
    } catch {
      return (await caches.match(req)) || Response.error();
    }
  })());
});
