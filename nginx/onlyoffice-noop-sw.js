/* Kin-office: replace ONLYOFFICE document_editor_service_worker (breaks behind reverse proxy). */
self.addEventListener('install', function(e) {
    self.skipWaiting();
});
self.addEventListener('activate', function(e) {
    e.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', function(e) {
    e.respondWith(fetch(e.request));
});
