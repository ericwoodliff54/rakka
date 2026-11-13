const CACHE_NAME = 'rakka-v150';
const ASSETS = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-192.png?v=17',
  './icon-512.png',
  './apple-touch-icon.png',
  './apple-touch-icon.png?v=17',
  './favicon.png',
  './favicon.png?v=17',
  './logo-1024.png',
  './logo-1024.png?v=17',
  './staples_catalog.json'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS).catch(err => {
        console.warn('Rakka pre-cache notice:', err);
      });
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // 1. Navigation requests (HTML pages): NETWORK-FIRST with offline cache fallback!
  if (event.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/' || url.pathname.endsWith('/rakka/') || url.pathname.endsWith('/rakka')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then(cached => cached || caches.match('./index.html')))
    );
    return;
  }

  // 2. Local static assets: Cache-first with network fallback
  if (url.origin === location.origin) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        return cached || fetch(event.request).then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // 3. Cache-first for trusted static CDN dependencies (Tailwind, scanner engines, fonts)
  const cdnHosts = ['cdn.tailwindcss.com', 'cdnjs.cloudflare.com', 'fastly.jsdelivr.net', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];
  if (cdnHosts.includes(url.hostname)) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        return cached || fetch(event.request).then(response => {
          if (response && (response.status === 200 || response.type === 'opaque')) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // 4. Network-first for external APIs (openFDA, etc.)
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// 4. Notification interaction handler: opens Watchlist tab when tapped
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './index.html?tab=watchlist';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (let client of windowClients) {
        if (client.url.includes('index.html') && 'focus' in client) {
          if ('postMessage' in client) {
            client.postMessage({ type: 'NAVIGATE_TAB', tab: 'watchlist' });
          }
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
