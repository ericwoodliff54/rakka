const CACHE_NAME = 'rakka-v229';
const SAFETY_ASSETS = [
  './js/rakka-safety.js',
  './js/core/text.js',
  './js/core/gtin.js',
  './js/core/allergens.js',
  './js/core/recalls.js',
  './js/core/verdict.js',
  './js/ui/scanResultCard.js',
  './js/rakka-household.js',
  './js/core/householdCrypto.js'
];

const ASSETS = [
  './index.html',
  './app.css?v=5',
  './vendor/html5-qrcode.min.js',
  './vendor/qrcode.min.js',
  './manifest.json',
  './icon-192.png',
  './icon-192.png?v=18',
  './apple-touch-icon.png',
  './apple-touch-icon.png?v=18',
  './favicon.png',
  './favicon.png?v=18',
  './splash-mascot-sm.png?v=19',
  './staples_catalog.json'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS).catch(err => {
        console.warn('Rakka pre-cache notice:', err);
      }).then(() => Promise.all(SAFETY_ASSETS.map(a => cache.add(a).catch(err => console.warn('Rakka safety asset not cached:', a, err)))));
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

  // 1. Navigation requests (HTML pages): open instantly from the saved copy, then refresh the copy in the background.
  //    (Waiting on the network first left the screen black on slow connections. The next launch gets any new version.)
  if (event.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/' || url.pathname.endsWith('/rakka/') || url.pathname.endsWith('/rakka')) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = (await cache.match(event.request, { ignoreSearch: true })) || (await cache.match('./index.html'));
      const refresh = fetch(new Request(url.origin + url.pathname, { cache: 'no-cache' }))
        .then(response => {
          if (response && response.status === 200) {
            cache.put(event.request.mode === 'navigate' ? './index.html' : event.request, response.clone());
          }
          return response;
        });
      if (cached) {
        event.waitUntil(refresh.catch(() => {}));
        return cached;
      }
      return refresh.catch(() => new Response('Offline', { status: 503 }));
    })());
    return;
  }

  // Catalog files must always be fresh (and are big), so they bypass the cache entirely.
  if (/catalog_manifest\.json$|community_catalog\.json(\.gz)?$|\/catalog\/part-\d+\.json$/.test(url.pathname)) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }));
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
