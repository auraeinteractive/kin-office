(function(global) {
    'use strict';

    var iframeEl = null;

    function log() {
        var args = ['[kinnextcloud]'].concat(Array.prototype.slice.call(arguments));
        console.log.apply(console, args);
    }

    function trimTrailingSlash(value) {
        return String(value || '').replace(/\/+$/, '');
    }

    function resolveNextcloudOrigin(params) {
        var originOverride = params.get('nextcloud_origin') || params.get('nextcloudOrigin');
        if (originOverride) return trimTrailingSlash(originOverride);

        var hostOverride = params.get('nextcloud_host') || params.get('nextcloudHost');
        if (hostOverride) {
            var port = params.get('nextcloud_port') || params.get('nextcloudPort') || '5002';
            return 'https://' + hostOverride + ':' + port;
        }

        return trimTrailingSlash(window.location.origin) + '/kin-office';
    }

    function init() {
        document.documentElement.style.height = '100%';
        document.body.style.margin = '0';
        document.body.style.padding = '0';
        document.body.style.height = '100%';
        document.body.replaceChildren();

        var params = new URLSearchParams(window.location.search);
        var nextcloudUrl = resolveNextcloudOrigin(params);

        iframeEl = document.createElement('iframe');
        iframeEl.id = 'iframe';
        iframeEl.title = 'Nextcloud';
        iframeEl.src = nextcloudUrl;
        document.body.appendChild(iframeEl);

        log('Opening Nextcloud at:', nextcloudUrl, '(header visible by default)');
    }

    init();
})(typeof window !== 'undefined' ? window : global);
