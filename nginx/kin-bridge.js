/**
 * Kin Nextcloud Bridge
 * Injected into Nextcloud pages via nginx sub_filter
 * Enables postMessage communication and auto-login
 */
(function() {
    'use strict';

    var BRIDGE_VERSION = '2.0';
    var MAX_LOGIN_ATTEMPTS = 2;
    var LOGIN_STORAGE_KEY = 'kinBridgeLoginAttempts';
    var LOGIN_SUCCESS_KEY = 'kinBridgeLoginSuccess';

    // --- Helpers ---

    function log() {
        var args = ['[kin-bridge]'].concat(Array.prototype.slice.call(arguments));
        console.log.apply(console, args);
    }

    function postToParent(msg) {
        if (window.parent && window.parent !== window) {
            window.parent.postMessage(msg, '*');
        }
    }

    // --- Login state detection ---

    function getRequestToken() {
        // Try hidden input first
        var input = document.querySelector('input[name="requesttoken"]');
        if (input && input.value) return input.value;
        // Try data attribute on head element (Nextcloud stores it here)
        var el = document.querySelector('[data-requesttoken]');
        if (el) return el.getAttribute('data-requesttoken');
        return null;
    }

    function getLoggedInUser() {
        // Method 1: data-user attribute (most reliable in Nextcloud)
        var dataUser = document.querySelector('[data-user]');
        if (dataUser && dataUser.getAttribute('data-user')) {
            return dataUser.getAttribute('data-user');
        }
        // Method 2: expandDisplayName element
        var displayName = document.getElementById('expandDisplayName');
        if (displayName && displayName.textContent.trim()) {
            return displayName.textContent.trim();
        }
        // Method 3: OC.currentUser (Nextcloud JS global)
        if (window.OC && window.OC.currentUser) {
            return window.OC.currentUser;
        }
        // Method 4: nc-firstrunwizard or other logged-in indicators
        var body = document.body;
        if (body && body.getAttribute('data-user')) {
            return body.getAttribute('data-user');
        }
        return null;
    }

    function isLoginPage() {
        return !!(
            document.querySelector('form[name="login"]') ||
            document.querySelector('form[action*="login"]') ||
            document.getElementById('login') ||
            document.querySelector('.login-form') ||
            (window.location.pathname.indexOf('/login') !== -1 && document.querySelector('input[name="password"]'))
        );
    }

    function getStatus() {
        var user = getLoggedInUser();
        return {
            isLoggedIn: !!user,
            currentUser: user,
            isLoginPage: isLoginPage(),
            url: window.location.href
        };
    }

    function getOnlyOfficeContext() {
        var context = {
            available: false,
            fileId: null,
            filePath: null,
            inframe: false,
            url: window.location.href
        };
        if (!window.OCA || !window.OCA.Onlyoffice) {
            return context;
        }
        var oo = window.OCA.Onlyoffice;
        context.available = true;
        context.fileId = oo.fileId || null;
        context.filePath = oo.filePath || null;
        context.inframe = !!oo.inframe;
        return context;
    }

    // --- Login attempt tracking (survives page reloads) ---

    function getLoginAttempts() {
        try {
            return parseInt(sessionStorage.getItem(LOGIN_STORAGE_KEY) || '0', 10);
        } catch (e) {
            return 0;
        }
    }

    function setLoginAttempts(n) {
        try {
            sessionStorage.setItem(LOGIN_STORAGE_KEY, String(n));
        } catch (e) {}
    }

    function clearLoginAttempts() {
        try {
            sessionStorage.removeItem(LOGIN_STORAGE_KEY);
        } catch (e) {}
    }

    function markLoginSuccess() {
        try {
            sessionStorage.setItem(LOGIN_SUCCESS_KEY, 'true');
        } catch (e) {}
    }

    // --- Login via fetch (POST) ---

    function doLogin(username, password) {
        var attempts = getLoginAttempts();
        if (attempts >= MAX_LOGIN_ATTEMPTS) {
            log('Max login attempts reached (' + attempts + '), stopping.');
            postToParent({
                type: 'kinBridgeError',
                error: 'Max login attempts exceeded',
                action: 'login'
            });
            return;
        }

        setLoginAttempts(attempts + 1);
        log('Login attempt', attempts + 1, 'for user:', username);

        var token = getRequestToken();
        log('Request token:', token ? '(found)' : '(none)');

        // Build form data - Nextcloud uses the same form fields as OwnCloud
        var formData = new FormData();
        formData.append('user', username || 'admin');
        formData.append('password', password || 'admin123');
        if (token) {
            formData.append('requesttoken', token);
        }
        formData.append('timezone-offset', String(new Date().getTimezoneOffset() / -60));
        formData.append('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');

        fetch('/index.php/login', {
            method: 'POST',
            body: formData,
            credentials: 'same-origin',
            redirect: 'manual',
            headers: {
                'Accept': 'text/html,application/xhtml+xml',
                'requesttoken': token || ''
            }
        }).then(function(resp) {
            log('Login response status:', resp.status, 'type:', resp.type);
            // Nextcloud returns 303 on successful login
            // With redirect: 'manual', we get an opaque-redirect (type=opaqueredirect) or 303
            if (resp.type === 'opaqueredirect' || resp.status === 303 || resp.status === 302 || resp.status === 0) {
                log('Login succeeded (redirect detected)');
                clearLoginAttempts();
                markLoginSuccess();
                window.location.href = '/index.php/apps/dashboard/';
                return;
            }
            if (resp.ok) {
                // 200 OK could mean login page re-rendered (wrong credentials)
                return resp.text().then(function(body) {
                    if (body.indexOf('apps/dashboard') !== -1 || body.indexOf('apps/files') !== -1 || body.indexOf('data-user') !== -1) {
                        // Actually logged in
                        clearLoginAttempts();
                        markLoginSuccess();
                        window.location.href = '/index.php/apps/dashboard/';
                    } else {
                        var errorMatch = body.match(/class="warning"[^>]*>([^<]+)/);
                        var errorMsg = errorMatch ? errorMatch[1].trim() : 'Login failed - check credentials';
                        log('Login error:', errorMsg);
                        postToParent({
                            type: 'kinBridgeError',
                            error: errorMsg,
                            action: 'login'
                        });
                    }
                });
            }
            log('Login failed with status:', resp.status);
            postToParent({
                type: 'kinBridgeError',
                error: 'Login failed (HTTP ' + resp.status + ')',
                action: 'login'
            });
        }).catch(function(err) {
            log('Login fetch error:', err.message);
            postToParent({
                type: 'kinBridgeError',
                error: err.message,
                action: 'login'
            });
        });
    }

    // --- Logout ---

    function doLogout() {
        var token = getRequestToken();
        var logoutUrl = '/index.php/logout';
        if (token) {
            logoutUrl += '?requesttoken=' + encodeURIComponent(token);
        }
        clearLoginAttempts();
        window.location.href = logoutUrl;
    }

    // --- WebDAV ---

    function handleWebDAV(method, path, body, extraHeaders, source, requestId) {
        var user = getLoggedInUser() || 'admin';
        var url = path || '/remote.php/dav/files/' + user;
        var headers = {
            'Content-Type': 'application/xml',
            'Depth': '1'
        };
        if (extraHeaders && typeof extraHeaders === 'object') {
            Object.keys(extraHeaders).forEach(function(key) {
                headers[key] = extraHeaders[key];
            });
        }

        fetch(url, {
            method: method || 'PROPFIND',
            credentials: 'same-origin',
            headers: headers,
            body: body || null
        }).then(function(resp) {
            return resp.text().then(function(text) {
                source.postMessage({
                    type: 'kinBridgeWebDAVResponse',
                    requestId: requestId,
                    status: resp.status,
                    body: text,
                    ok: resp.ok
                }, '*');
            });
        }).catch(function(err) {
            source.postMessage({
                type: 'kinBridgeError',
                requestId: requestId,
                error: err.message,
                action: 'webdav'
            }, '*');
        });
    }

    // --- OCS API (Nextcloud uses v2) ---

    function handleOCS(method, endpoint, data, source, requestId) {
        var url = '/ocs/v2.php/' + endpoint;
        var options = {
            method: method || 'GET',
            credentials: 'same-origin',
            headers: {
                'OCS-APIREQUEST': 'true',
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        };
        if (data) {
            options.body = new URLSearchParams(data).toString();
        }

        fetch(url, options).then(function(resp) {
            return resp.text().then(function(text) {
                source.postMessage({
                    type: 'kinBridgeOCSResponse',
                    requestId: requestId,
                    status: resp.status,
                    body: text,
                    ok: resp.ok
                }, '*');
            });
        }).catch(function(err) {
            source.postMessage({
                type: 'kinBridgeError',
                requestId: requestId,
                error: err.message,
                action: 'ocs'
            }, '*');
        });
    }

    // --- Message handler ---

    window.addEventListener('message', function(event) {
        var data = event.data;
        if (!data) return;

        if (data.method && typeof data.method === 'string' && data.method.indexOf('editorRequest') === 0) {
            if (data.method === 'editorRequestSaveAs') {
                postToParent({
                    type: 'kinBridgeOnlyOfficeRequestSaveAs',
                    saveData: data.param || {},
                    context: getOnlyOfficeContext()
                });
            }
            postToParent({
                type: 'kinBridgeOnlyOfficeEvent',
                method: data.method,
                payload: data.param || null,
                context: getOnlyOfficeContext()
            });
            return;
        }

        if (!data.type) return;

        var status = getStatus();

        switch (data.type) {
            case 'kinBridgeHandshake':
                event.source.postMessage({
                    type: 'kinBridgeHandshakeResponse',
                    version: BRIDGE_VERSION,
                    isNextcloud: true,
                    isLoggedIn: status.isLoggedIn,
                    currentUser: status.currentUser,
                    url: status.url
                }, '*');
                break;

            case 'kinBridgeLogin':
                if (status.isLoginPage) {
                    doLogin(data.username, data.password);
                } else if (!status.isLoggedIn) {
                    // Not on login page and not logged in, navigate to login
                    window.location.href = '/index.php/login';
                }
                break;

            case 'kinBridgeLogout':
                doLogout();
                break;

            case 'kinBridgeGetStatus':
                event.source.postMessage({
                    type: 'kinBridgeStatus',
                    isNextcloud: true,
                    isLoggedIn: status.isLoggedIn,
                    currentUser: status.currentUser,
                    url: status.url,
                    requestToken: getRequestToken()
                }, '*');
                break;

            case 'kinBridgeNavigate':
                if (data.path) window.location.href = data.path;
                break;

            case 'kinBridgeGetUser':
                event.source.postMessage({
                    type: 'kinBridgeUser',
                    user: status.currentUser,
                    isLoggedIn: status.isLoggedIn
                }, '*');
                break;

            case 'kinBridgeWebDAV':
                handleWebDAV(data.method, data.path, data.body, data.headers, event.source, data.requestId);
                break;

            case 'kinBridgeOCS':
                handleOCS(data.method, data.endpoint, data.data, event.source, data.requestId);
                break;

            case 'kinBridgeGetOnlyOfficeContext':
                var context = getOnlyOfficeContext();
                event.source.postMessage({
                    type: 'kinBridgeOnlyOfficeContext',
                    requestId: data.requestId,
                    context: context,
                    fileId: context.fileId,
                    filePath: context.filePath,
                    inframe: context.inframe
                }, '*');
                break;

            case 'kinBridgeOnlyOfficeSaveAs':
                if (window.OCA && window.OCA.Onlyoffice && typeof window.OCA.Onlyoffice.editorSaveAs === 'function') {
                    try {
                        window.OCA.Onlyoffice.editorSaveAs(data.saveData || {});
                        event.source.postMessage({
                            type: 'kinBridgeOnlyOfficeSaveAsResult',
                            requestId: data.requestId,
                            ok: true
                        }, '*');
                    } catch (saveErr) {
                        event.source.postMessage({
                            type: 'kinBridgeOnlyOfficeSaveAsResult',
                            requestId: data.requestId,
                            ok: false,
                            error: saveErr && saveErr.message ? saveErr.message : 'OnlyOffice Save As failed'
                        }, '*');
                    }
                } else {
                    event.source.postMessage({
                        type: 'kinBridgeOnlyOfficeSaveAsResult',
                        requestId: data.requestId,
                        ok: false,
                        error: 'OnlyOffice context unavailable'
                    }, '*');
                }
                break;
        }
    });

    // --- Init ---

    function init() {
        var status = getStatus();
        log('Init on', window.location.href);
        log('isLoggedIn:', status.isLoggedIn, 'isLoginPage:', status.isLoginPage, 'user:', status.currentUser);

        // If logged in, clear any stored attempts and notify parent
        if (status.isLoggedIn) {
            clearLoginAttempts();
            postToParent({
                type: 'kinBridgeReady',
                isNextcloud: true,
                isLoggedIn: true,
                currentUser: status.currentUser,
                url: status.url
            });
            return;
        }

        // Notify parent we're ready (not logged in)
        postToParent({
            type: 'kinBridgeReady',
            isNextcloud: true,
            isLoggedIn: false,
            currentUser: null,
            url: status.url
        });

        // Auto-login if on the login page
        if (status.isLoginPage) {
            var attempts = getLoginAttempts();
            if (attempts < MAX_LOGIN_ATTEMPTS) {
                log('Auto-login attempt', attempts + 1);
                // Small delay to ensure the page is fully rendered and token is available
                setTimeout(function() {
                    doLogin('admin', 'admin123');
                }, 500);
            } else {
                log('Skipping auto-login, max attempts reached');
                postToParent({
                    type: 'kinBridgeError',
                    error: 'Auto-login failed after ' + MAX_LOGIN_ATTEMPTS + ' attempts',
                    action: 'login'
                });
            }
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
