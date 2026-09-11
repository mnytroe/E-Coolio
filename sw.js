// Service Worker for Havet Arena
// Versjonen kommer fra ?v= på registreringen i app.js, som igjen leser
// APP_VERSION i utils.js. Da finnes versjonen kun ett sted i kodebasen.
const SW_VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE_NAME = `havet-arena-${SW_VERSION}`;
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/utils.js',
  '/manifest.json',
];

// Hvor lenge et cachet API-svar kan brukes som offline-fallback
const API_CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 24; // 1 døgn
const CACHED_AT_HEADER = 'x-havet-cached-at';

// Install - cache essential files
self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS_TO_CACHE))
      .then(() => self.skipWaiting())
  );
});

// Activate - clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(cacheNames =>
        Promise.all(cacheNames.filter(name => name !== CACHE_NAME).map(name => caches.delete(name)))
      )
      .then(() => self.clients.claim())
  );
});

function isApiRequest(url) {
  return (
    url.includes('workers.dev') ||
    url.includes('api.') ||
    url.includes('open-meteo') ||
    url.includes('havvarsel')
  );
}

function isTrackingRequest(url) {
  return url.includes('sentry') || url.includes('ingest.') || url.includes('analytics');
}

/**
 * Lagrer et API-svar med tidsstempel, slik at det kan brukes som
 * offline-fallback uten å vise vilkårlig gamle måleverdier.
 */
async function cacheApiResponse(request, response) {
  const body = await response.clone().blob();
  const headers = new Headers(response.headers);
  headers.set(CACHED_AT_HEADER, String(Date.now()));

  const cache = await caches.open(CACHE_NAME);
  await cache.put(
    request,
    new Response(body, { status: response.status, statusText: response.statusText, headers })
  );
}

/** Henter et cachet API-svar, men kun hvis det er ferskt nok. */
async function getFreshEnoughApiResponse(request) {
  const cached = await caches.match(request);
  if (!cached) return null;

  const cachedAt = Number(cached.headers.get(CACHED_AT_HEADER) || 0);
  if (!cachedAt || Date.now() - cachedAt > API_CACHE_MAX_AGE_MS) return null;

  return cached;
}

// Nett først for alt, cache som offline-fallback
self.addEventListener('fetch', event => {
  const { request } = event;

  // Only handle GET requests - POST, etc. cannot be cached
  if (request.method !== 'GET') return;

  // Sentry og analytics skal aldri gjennom cachen
  if (isTrackingRequest(request.url)) return;

  // API: nett først, cachet svar som fallback hvis det er ferskt nok
  if (isApiRequest(request.url)) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            event.waitUntil(cacheApiResponse(request, response));
          }
          return response;
        })
        .catch(async () => {
          const cached = await getFreshEnoughApiResponse(request);
          if (cached) return cached;

          return new Response(JSON.stringify({ error: 'Offline og ingen ferske data i cache' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        })
    );
    return;
  }

  // Navigasjon: nett først, fall tilbake til cachet index.html offline
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const cached = await caches.match('/index.html');
        return (
          cached ||
          new Response('<h1>Offline</h1><p>Siden er ikke tilgjengelig uten nett.</p>', {
            status: 503,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          })
        );
      })
    );
    return;
  }

  // Statiske filer: nett først, cache som offline-fallback.
  //
  // Cache-first ville vært raskere, men skaper to problemer for denne siden:
  // brukeren får gammel kode én lasting etter hver deploy, og APP_VERSION bor
  // i utils.js - en fil som da ville blitt servert fra cachen, slik at en ny
  // versjon aldri kunne oppdages. Filene er små og ligger bak HTTP-caching
  // uansett, så nett-først koster lite her.
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok) {
          const clone = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(request, clone)));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        throw new Error(`Ingen cachet versjon av ${request.url}`);
      })
  );
});

// Lar siden be om at en ventende worker tar over med én gang
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
