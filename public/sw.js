const CACHE = "arena-arte-luta-v3";
self.addEventListener("install", (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(["/", "/manifest.webmanifest"]))));
self.addEventListener("fetch", (event) => { if (event.request.method === "GET") event.respondWith(fetch(event.request).catch(() => caches.match(event.request))); });
