'use strict';

const CACHE = 'tennis-2026-05-04-1100';
const ASSETS = [
  '/tennis/',
  '/tennis/index.html',
  '/tennis/style.css',
  '/tennis/app.js',
  '/tennis/manifest.json',
  '/tennis/icon.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(cached => cached ?? fetch(e.request))
  );
});
