(function(global) {
    'use strict';

    var iframeEl = null;
    var nextcloudBaseUrl = '';
    var overlayEl = null;

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

    function buildLoginUrl(baseUrl, params) {
        var path = trimTrailingSlash(baseUrl) + '/index.php/login';
        var useDirect = params.get('nextcloud_direct') === '1' ||
            params.get('nextcloudDirect') === '1';
        if (useDirect) {
            path += (path.indexOf('?') === -1 ? '?' : '&') + 'direct=1';
        }
        return path;
    }

    function hideOidcErrorOverlay() {
        if (overlayEl && overlayEl.parentNode) {
            overlayEl.parentNode.removeChild(overlayEl);
        }
        overlayEl = null;
        if (iframeEl) {
            iframeEl.style.visibility = '';
        }
    }

    function showOidcErrorOverlay(message) {
        if (overlayEl) {
            return;
        }
        if (iframeEl) {
            iframeEl.style.visibility = 'hidden';
        }
        overlayEl = document.createElement('div');
        overlayEl.id = 'kinnextcloud-oidc-error';
        overlayEl.setAttribute('role', 'alert');

        var title = document.createElement('h1');
        title.textContent = 'Nextcloud sign-in (OpenID) is not available';
        title.className = 'kinnextcloud-oidc-error__title';

        var p = document.createElement('p');
        p.className = 'kinnextcloud-oidc-error__body';
        p.textContent = String(message || 'OpenID Connect discovery failed. Fix Kin TLS /.well-known on this host, then reinstall or restart kin-office.');

        var actions = document.createElement('div');
        actions.className = 'kinnextcloud-oidc-error__actions';

        var btnLocal = document.createElement('button');
        btnLocal.type = 'button';
        btnLocal.className = 'kinnextcloud-oidc-error__btn kinnextcloud-oidc-error__btn--primary';
        btnLocal.textContent = 'Use local Nextcloud login (admin)';
        btnLocal.addEventListener('click', function() {
            hideOidcErrorOverlay();
            if (iframeEl) {
                iframeEl.src = trimTrailingSlash(nextcloudBaseUrl) + '/index.php/login?direct=1';
                log('Reloading iframe with local login (direct=1)');
            }
        });

        var btnRetry = document.createElement('button');
        btnRetry.type = 'button';
        btnRetry.className = 'kinnextcloud-oidc-error__btn';
        btnRetry.textContent = 'Retry OpenID login';
        btnRetry.addEventListener('click', function() {
            hideOidcErrorOverlay();
            if (iframeEl) {
                iframeEl.src = buildLoginUrl(nextcloudBaseUrl, new URLSearchParams(window.location.search));
                log('Retrying iframe:', iframeEl.src);
            }
        });

        actions.appendChild(btnLocal);
        actions.appendChild(btnRetry);
        overlayEl.appendChild(title);
        overlayEl.appendChild(p);
        overlayEl.appendChild(actions);
        document.body.appendChild(overlayEl);
    }

    function init() {
        document.documentElement.style.height = '100%';
        document.body.style.margin = '0';
        document.body.style.padding = '0';
        document.body.style.height = '100%';
        document.body.replaceChildren();

        var params = new URLSearchParams(window.location.search);
        nextcloudBaseUrl = resolveNextcloudOrigin(params);
        var iframeSrc = buildLoginUrl(nextcloudBaseUrl, params);

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
                showOidcErrorOverlay(d.error);
            }
        });

        log('Opening Nextcloud at:', iframeSrc, '(append ?nextcloud_direct=1 to URL for local admin login without OIDC)');
    }

    init();
})(typeof window !== 'undefined' ? window : global);
