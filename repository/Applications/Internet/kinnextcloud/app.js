/**
 * kinnextcloud - Nextcloud web UI launcher for Kin.
 * Opens Nextcloud in an iframe and auto-logins via kin-bridge.js.
 */

(function(global) {
    'use strict';

    var LOOPBACK_HOSTS = { 'localhost': true, '127.0.0.1': true, '::1': true };
    var NEXTCLOUD_PORT = 5002;
    var NEXTCLOUD_DASHBOARD_PATH = '/index.php/apps/dashboard/';

    var LOGIN_USER = 'admin';
    var LOGIN_PASS = 'admin123';

    var INSTANCE_ID = '';
    var iframeEl = null;
    var loginInProgress = false;

    function getInstanceId() {
        try {
            var u = new URL(window.location.href);
            return u.searchParams.get('kin_app_instance') || '';
        } catch (e) {
            return '';
        }
    }

    function setLoading(text) {
        var el = document.getElementById('loading');
        if (!el) return;
        if (text) {
            el.textContent = String(text);
            el.classList.remove('hidden');
        } else {
            el.classList.add('hidden');
        }
    }

    function postToWorkspace(msg) {
        try {
            window.parent.postMessage(msg, window.location.origin);
        } catch (e) {
            /* ignore */
        }
    }

    function isLoopbackHost(host) {
        var value = String(host || '').toLowerCase();
        return !!LOOPBACK_HOSTS[value];
    }

    function resolveNextcloudHost(params) {
        var override = params.get('nextcloud_host') || params.get('nextcloudHost');
        if (override) return override;
        if (!isLoopbackHost(window.location.hostname)) return window.location.hostname;
        return window.location.hostname;
    }

    function sendToBridge(type, payload) {
        try {
            if (!iframeEl || !iframeEl.contentWindow) {
                throw new Error('Bridge iframe is not ready');
            }
            iframeEl.contentWindow.postMessage(Object.assign({ type: type }, payload || {}), '*');
            return true;
        } catch (_e) {
            return false;
        }
    }

    function registerMenus() {
        if (!INSTANCE_ID) return;
        postToWorkspace({
            kinAppRegisterMenus: true,
            instanceId: INSTANCE_ID,
            menus: {
                File: [
                    { name: 'Log out', command: 'nextcloud.logout' }
                ]
            }
        });
    }

    function handleMenuCommand(cmd) {
        if (cmd === 'nextcloud.logout') {
            setLoading('Logging out…');
            sendToBridge('kinBridgeLogout');
        }
    }

    function handleBridgeStatus(data) {
        if (!data) return;

        if (data.isLoggedIn) {
            loginInProgress = false;
            setLoading(null);
            return;
        }

        if (data.isLoginPage && !loginInProgress) {
            loginInProgress = true;
            setLoading('Signing in…');
            sendToBridge('kinBridgeLogin', { username: LOGIN_USER, password: LOGIN_PASS });
            return;
        }

        if (loginInProgress) {
            setLoading('Signing in…');
        } else {
            setLoading('Connecting to Nextcloud…');
        }
    }

    function init() {
        INSTANCE_ID = getInstanceId();
        iframeEl = document.getElementById('iframe');

        var params = new URLSearchParams(window.location.search);
        var host = resolveNextcloudHost(params);
        var nextcloudOrigin = 'https://' + host + ':' + String(NEXTCLOUD_PORT);
        var initialPath = NEXTCLOUD_DASHBOARD_PATH;

        if (iframeEl) {
            iframeEl.onload = function() {
                sendToBridge('kinBridgeHandshake');
                sendToBridge('kinBridgeGetStatus');
            };
            iframeEl.src = nextcloudOrigin + initialPath;
        }

        registerMenus();
        setLoading('Connecting to Nextcloud…');
    }

    window.addEventListener('message', function(event) {
        var d = event.data || {};

        if (d.kinMenuCommand === true) {
            handleMenuCommand(d.command);
            return;
        }

        if (d.type && String(d.type).indexOf('kinBridge') === 0) {
            if (
                d.type === 'kinBridgeReady' ||
                d.type === 'kinBridgeHandshakeResponse' ||
                d.type === 'kinBridgeStatus' ||
                d.type === 'kinBridgeStatusChange'
            ) {
                handleBridgeStatus(d);
            }
        }
    });

    init();
})(typeof window !== 'undefined' ? window : global);
