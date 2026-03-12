/* ============================================================
   sw.js — Market Radar v5.0 — Service Worker
   Handles PWA notifications for smart alerts
   ============================================================ */

const CACHE_NAME = 'market-radar-v5';

// Install — cache shell
self.addEventListener('install', (event) => {
  self.skipWaiting();
  console.log('[sw] Installed');
});

// Activate — clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
  console.log('[sw] Activated');
});

// Notification click — open POSITIONS tab
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // Focus existing window if open
      for (const client of clientList) {
        if (client.url.includes('MarketVivi') && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open new window
      return clients.openWindow('./');
    })
  );
});
