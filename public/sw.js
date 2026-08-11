const CACHE = "arena-arte-luta-v4";
const APP_SHELL = ["/", "/manifest.webmanifest", "/brand/capoeira-app-icon-v2.png"];

self.addEventListener("install", (event) => event.waitUntil(
  caches.open(CACHE)
    .then((cache) => cache.addAll(APP_SHELL))
    .then(() => self.skipWaiting()),
));

self.addEventListener("activate", (event) => event.waitUntil(
  caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()),
));

self.addEventListener("fetch", (event) => { if (event.request.method === "GET") event.respondWith(fetch(event.request).catch(() => caches.match(event.request))); });
