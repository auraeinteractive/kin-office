/**
 * kinnextcloud - Nextcloud web UI launcher for Kin.
 * Admin-only app - injects admin bridge and logs in as admin.
 */

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
        if (!LOOPBACK_HOSTS[window.location.hostname.toLowerCase()]) {
            return window.location.hostname;
        }
        return window.location.hostname;
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

    function sendToBridge(type, payload) {
        try {
            if (!iframeEl || !iframeEl.contentWindow) return false;
            iframeEl.contentWindow.postMessage(Object.assign({ type: type }, payload || {}), '*');
            return true;
        } catch (_e) {
            return false;
        }
    }

    function injectAdminBridge(iframe) {
        var script = iframe.contentDocument.createElement('script');
        script.textContent = '(' + adminBridgeCode.toString() + ')();';
        iframe.contentDocument.head.appendChild(script);
    }

    function adminBridgeCode() {
        var ADMIN_LOGIN = { username: 'admin', password: 'admin' };
        var loginInProgress = false;
        var csrfToken = null;

        function log() {
            var args = ['[kin-bridge-admin]'].concat(Array.prototype.slice.call(arguments));
            console.log.apply(console, args);
        }

        function getCsrfToken() {
            var input = document.querySelector('input[name="requesttoken"]');
            if (input && input.value) return input.value;
            var el = document.querySelector('[data-requesttoken]');
            if (el) return el.getAttribute('data-requesttoken');
            if (window.oc_requesttoken) return window.oc_requesttoken;
            if (window.OC && window.OC.requestToken) return window.OC.requestToken;
            return null;
        }

        function isLoginFormReady() {
            return !!(
                document.querySelector('form[name="login"]') ||
                document.querySelector('form[action*="login"]') ||
                document.getElementById('login')
            );
        }

        function isLoggedIn() {
            return !!getCsrfToken() && !isLoginFormReady();
        }

        function doLogin() {
            if (loginInProgress) return;
            if (!isLoginFormReady()) {
                log('Login form not ready, waiting...');
                setTimeout(doLogin, 200);
                return;
            }

            loginInProgress = true;
            csrfToken = getCsrfToken();
            log('Starting admin login...');

            var formData = new FormData();
            formData.append('user', ADMIN_LOGIN.username);
            formData.append('password', ADMIN_LOGIN.password);
            if (csrfToken) formData.append('requesttoken', csrfToken);
            formData.append('timezone-offset', String(new Date().getTimezoneOffset() / -60));

            fetch('/index.php/login', {
                method: 'POST',
                body: formData,
                credentials: 'same-origin',
                redirect: 'manual',
                headers: csrfToken ? { 'requesttoken': csrfToken } : {}
            }).then(function(resp) {
                log('Login response:', resp.status, resp.type);
                if (resp.type === 'opaqueredirect' || resp.status === 303 || resp.status === 302 || resp.status === 0) {
                    log('Admin login succeeded');
                    window.location.href = '/index.php/apps/dashboard/';
                } else {
                    log('Admin login failed:', resp.status);
                }
            }).catch(function(err) {
                log('Admin login error:', err.message);
            });
        }

        function getStatus() {
            return {
                isLoggedIn: isLoggedIn(),
                isLoginPage: isLoginFormReady()
            };
        }

        function postToParent(msg) {
            if (window.parent && window.parent !== window) {
                window.parent.postMessage(msg, '*');
            }
        }

        window.addEventListener('message', function(event) {
            var data = event.data;
            if (!data || !data.type) return;

            switch (data.type) {
                case 'kinBridgeHandshake':
                case 'kinBridgeGetStatus':
                    var status = getStatus();
                    postToParent({
                        type: data.type === 'kinBridgeHandshake' ? 'kinBridgeHandshakeResponse' : 'kinBridgeStatus',
                        isLoggedIn: status.isLoggedIn,
                        isLoginPage: status.isLoginPage
                    });
                    if (status.isLoginPage && !isLoggedIn()) {
                        setTimeout(doLogin, 500);
                    }
                    break;
            }
        });

        // Wait for DOM to be ready before checking login form
        function waitAndLogin() {
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', function() {
                    setTimeout(doLogin, 300);
                });
            } else {
                setTimeout(doLogin, 300);
            }
        }
        waitAndLogin();
        log('Admin bridge initialized');
    }

    function handleBridgeStatus(data) {
        if (!data) return;
        if (data.isLoggedIn) {
            setLoading(null);
        }
    }

    function init() {
        iframeEl = document.getElementById('iframe');
        if (!iframeEl) return;

        var params = new URLSearchParams(window.location.search);
        var host = resolveNextcloudHost(params);
        var nextcloudOrigin = 'https://' + host + ':' + String(NEXTCLOUD_PORT);
        var adminOrigin = nextcloudOrigin + '/nc-admin';
        var step = 0;

        function nextStep() {
            step++;
            log('Step:', step);

            if (step === 1) {
                // Step 1: Clear session via logout
                iframeEl.onload = nextStep;
                iframeEl.src = nextcloudOrigin + '/index.php/logout';
            } else if (step === 2) {
                // Step 2: Go to admin login page
                iframeEl.onload = nextStep;
                iframeEl.src = adminOrigin + '/index.php/login';
            } else if (step === 3) {
                // Step 3: Inject bridge and trigger login
                injectAdminBridge(iframeEl);
                setTimeout(function() {
                    sendToBridge('kinBridgeHandshake');
                    sendToBridge('kinBridgeGetStatus');
                }, 500);
            }
        }

        setLoading('Loading Nextcloud admin…');
        nextStep();
    }

    window.addEventListener('message', function(event) {
        var d = event.data || {};
        if (d.type && String(d.type).indexOf('kinBridge') === 0) {
            handleBridgeStatus(d);
        }
    });

    init();
})(typeof window !== 'undefined' ? window : global);
