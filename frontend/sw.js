// FormCoach AI service worker — network-first with cache fallback.
// Always serves fresh files when online (safe during development);
// falls back to the last good copy offline, making the app shell installable.
const CACHE = "formcoach-v2";

self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  event.respondWith(
    fetch(request, { cache: "no-cache" }) // always revalidate — no more stale builds
      .then((res) => {
        // cache same-origin successes for offline fallback
        if (res.ok && new URL(request.url).origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request))
  );
});
