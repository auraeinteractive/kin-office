/* Kin-office: kept for reference. nginx no longer serves a service worker
 * for ONLYOFFICE Document Server; document_editor_service_worker.js returns
 * 404 and the editor HTML is rewritten so navigator.serviceWorker.register
 * cannot install it. A no-op worker is not enough because Document Server
 * re-registers it on every page load, racing with our unregister. */
self.addEventListener('install', function(e) {
    self.skipWaiting();
});
self.addEventListener('activate', function(e) {
    e.waitUntil(self.registration.unregister());
});
