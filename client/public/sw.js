// Lab 8: the minimal service worker that makes Dogfight installable (PWA) and lets the page and
// the solo mode open without a network. Deliberately small:
//   - the game itself is online (WebSocket): /ws and the API are NEVER cached or intercepted;
//   - every other GET goes NETWORK FIRST, the cache is only a fallback — a new deploy is seen on
//     the next load, never hidden behind a stale cache;
//   - a new version of this file replaces the old cache (CACHE carries a version).
const CACHE = "dogfight-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];
const LIVE = /^\/(ws|api\/|health|ready|metrics)/;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin || LIVE.test(url.pathname))
    return; // the browser handles it as if there were no service worker
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(event.request, copy)));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request, { ignoreSearch: url.pathname === "/" });
        return cached ?? (event.request.mode === "navigate" ? caches.match("/") : Response.error());
      }),
  );
});
