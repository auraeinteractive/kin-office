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
            var port = params.get('nextcloud_port') || params.get('nextcloudPort') || '443';
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
        // Canonical login entry avoids user_oidc redirect bugs on subpath installs
        // (e.g. broken "index.php_oidc/login/N"; see nextcloud/user_oidc#766).
        var iframeSrc = trimTrailingSlash(nextcloudUrl) + '/index.php/login';

        iframeEl = document.createElement('iframe');
        iframeEl.id = 'iframe';
        iframeEl.title = 'Nextcloud';
        iframeEl.src = iframeSrc;
        document.body.appendChild(iframeEl);

        window.addEventListener('message', function(ev) {
            var d = ev.data;
            if (!d || typeof d !== 'object') {
                return;
            }
            if (d.type === 'kinBridgeError' && d.action === 'user_oidc_discovery') {
                log('OIDC setup:', d.error || d);
            }
        });

        log('Opening Nextcloud at:', iframeSrc, '(header visible by default)');
    }

    init();
})(typeof window !== 'undefined' ? window : global);
