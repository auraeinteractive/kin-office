(function(global) {
    'use strict';

    var LOOPBACK_HOSTS = { 'localhost': true, '127.0.0.1': true, '::1': true };
    var NEXTCLOUD_PORT = 5002;

    var iframeEl = null;

    function log() {
        var args = ['[kinnextcloud]'].concat(Array.prototype.slice.call(arguments));
        console.log.apply(console, args);
    }

    function resolveNextcloudHost(params) {
        var override = params.get('nextcloud_host') || params.get('nextcloudHost');
        if (override) return override;
        return window.location.hostname;
    }

    function init() {
        document.documentElement.style.height = '100%';
        document.body.style.margin = '0';
        document.body.style.padding = '0';
        document.body.style.height = '100%';
        document.body.replaceChildren();

        var params = new URLSearchParams(window.location.search);
        var host = resolveNextcloudHost(params);
        var nextcloudUrl = 'https://' + host + ':' + String(NEXTCLOUD_PORT);

        iframeEl = document.createElement('iframe');
        iframeEl.id = 'iframe';
        iframeEl.title = 'Nextcloud';
        iframeEl.src = nextcloudUrl;
        document.body.appendChild(iframeEl);

        log('Opening Nextcloud at:', nextcloudUrl, '(OIDC login is automatic)');
    }

    init();
})(typeof window !== 'undefined' ? window : global);
