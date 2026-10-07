const CACHE = 'kuulo-v1';
const SHELL = [
  './',
  './index.html',
  './app.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/audio.js',
  './js/calibration.js',
  './js/colormap.js',
  './js/meter-worklet.js',
  './js/peak.js',
  './js/settings.js',
  './js/ui-calibrate.js',
  './js/ui-common.js',
  './js/ui-meter.js',
  './js/ui-spectrum.js',
  './js/weighting.js',
  './vendor/audioMotion-analyzer.js',
  './fonts/ibm-plex-mono-latin-400-normal.woff2',
  './fonts/ibm-plex-mono-latin-500-normal.woff2',
  './fonts/ibm-plex-sans-condensed-latin-400-normal.woff2',
  './fonts/ibm-plex-sans-condensed-latin-500-normal.woff2',
  './fonts/ibm-plex-sans-condensed-latin-600-normal.woff2',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' so a new version never precaches stale copies from the HTTP cache.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Network-first: try the network, refresh the cache, fall back to the cache when offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req)),
  );
});
