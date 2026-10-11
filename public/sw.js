// Playlite service worker: opens the app when the network is flaky, and shows app notifications (Web Push).
// Browsers only run it on a secure address (HTTPS or localhost).
const CACHE = 'playlite-v1';
const SHELL = ['/', '/app.js', '/style.css', '/manifest.webmanifest', '/favicon.svg', '/icon-192.png', '/login.html'];

// Save the app's files right away so it opens offline. A file that redirects (signed out → login page) is skipped, never
// saved under the wrong name.
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(SHELL.map(async (p) => {
      const res = await fetch(p, { cache: 'no-store' }).catch(() => null);
      if (res?.ok && !res.redirected) await c.put(p, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// The app's own files: network first (so updates show up right away), the saved copy when Playlite can't be reached.
// Everything else — live data (/api), webhooks, camera pictures — always goes to the network.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || !SHELL.includes(url.pathname)) return;
  const key = e.request.mode === 'navigate' ? url.pathname : e.request; // pages by path (ignore ?app)
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok && !res.redirected) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {});
      }
      return res;
    } catch {
      const hit = await caches.match(key, { ignoreSearch: true });
      return hit ?? new Response('<!doctype html><meta name="viewport" content="width=device-width"><body style="font:16px system-ui;background:#0f1218;color:#e7eaf0;padding:24px"><h2>Playlite is out of reach</h2><p>Are you on your home Wi-Fi (or VPN)?</p>', { headers: { 'Content-Type': 'text/html' } });
    }
  })());
});

self.addEventListener('push', (e) => {
  let msg = {};
  try {
    msg = e.data?.json() ?? {};
  } catch {
    msg = { message: e.data?.text() };
  }
  // an open Playlite window also gets it (shown as a toast), then the system notification
  const tell = self.clients.matchAll({ type: 'window' }).then((wins) => wins.forEach((w) => w.postMessage({ type: 'push', msg })));
  e.waitUntil(tell.then(() => self.registration.showNotification(msg.title || 'Playlite', {
    body: msg.message || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: msg.tag || undefined,
    requireInteraction: msg.priority >= 5, // urgent: stays until dismissed
    data: { url: msg.click || '/' },
  })));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = e.notification.data?.url || '/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const same = wins.find((w) => new URL(w.url).origin === location.origin);
    if (same && new URL(target, location.origin).origin === location.origin) {
      await same.focus();
      return same.navigate?.(new URL(target, location.origin).href);
    }
    return self.clients.openWindow(target);
  })());
});
