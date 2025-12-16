// Service Worker for Havet Arena
const CACHE_NAME = 'havet-arena-v1';
const ASSETS_TO_CACHE = [
    '/',
    '/index.html',
    '/styles.css',
    '/app.js',
    '/manifest.json'
];

// Install - cache essential files
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(ASSETS_TO_CACHE))
            .then(() => self.skipWaiting())
    );
});

// Activate - clean up old caches
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames
                    .filter(name => name !== CACHE_NAME)
                    .map(name => caches.delete(name))
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch - network first, fall back to cache
self.addEventListener('fetch', event => {
    const { request } = event;
    
    // For API requests (workers, open-meteo, etc.) - always try network first
    if (request.url.includes('workers.dev') || 
        request.url.includes('api.') ||
        request.url.includes('open-meteo') ||
        request.url.includes('havvarsel')) {
        event.respondWith(
            fetch(request)
                .catch(() => caches.match(request))
        );
        return;
    }
    
    // For static assets - cache first, then network
    event.respondWith(
        caches.match(request)
            .then(cached => {
                const networked = fetch(request)
                    .then(response => {
                        // Update cache with new version
                        if (response.ok) {
                            const clone = response.clone();
                            caches.open(CACHE_NAME)
                                .then(cache => cache.put(request, clone));
                        }
                        return response;
                    })
                    .catch(() => cached);
                
                return cached || networked;
            })
    );
});

