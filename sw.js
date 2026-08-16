// @@PAPER_NAME@@ — service worker מינימלי (ללא cache) כדי לאפשר התקנה כאפליקציה
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => { /* רשת בלבד — תמיד תוכן עדכני */ });
