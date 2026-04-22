/**
 * Kin Nextcloud Bridge
 * Injected into Nextcloud pages via nginx sub_filter
 * Enables postMessage communication and auto-login
 */
(function() {
    'use strict';

    var BRIDGE_VERSION = '2.0';

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
        // Common Nextcloud globals
        if (window.oc_requesttoken) return window.oc_requesttoken;
        if (window.OC && window.OC.requestToken) return window.OC.requestToken;
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
        var loginPage = isLoginPage();
        var token = getRequestToken();
        var sessionHint = !!token && !loginPage;
        return {
            isLoggedIn: !!user || sessionHint,
            currentUser: user,
            isLoginPage: loginPage,
            hasSessionHint: sessionHint,
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
        var pathMatch = String(window.location.pathname || '').match(/\/index\.php\/apps\/onlyoffice\/(\d+)/i);
        if (pathMatch && pathMatch[1]) {
            context.fileId = pathMatch[1];
            try {
                var parsed = new URL(window.location.href);
                var qpPath = parsed.searchParams.get('filePath');
                if (qpPath) context.filePath = qpPath;
                var inframeValue = parsed.searchParams.get('inframe');
                if (inframeValue === 'true' || inframeValue === '1') {
                    context.inframe = true;
                }
            } catch (_error) {
                // ignore URL parsing errors
            }
        }
        if (!window.OCA || !window.OCA.Onlyoffice) {
            return context;
        }
        var oo = window.OCA.Onlyoffice;
        context.available = true;
        context.fileId = oo.fileId || context.fileId || null;
        context.filePath = oo.filePath || context.filePath || null;
        context.inframe = !!oo.inframe;
        return context;
    }

    function parseJsonSafe(text) {
        try {
            return JSON.parse(text);
        } catch (_error) {
            return null;
        }
    }

    function pickOnlyOfficeConfigData(parsed) {
        if (!parsed) return null;
        if (parsed.ocs && parsed.ocs.data) return parsed.ocs.data;
        if (parsed.data) return parsed.data;
        return parsed;
    }

    function parseOnlyOfficeCommandResult(text) {
        var parsed = parseJsonSafe(text || '');
        if (!parsed || typeof parsed.error !== 'number') {
            return { accepted: false, parsed: parsed };
        }
        return { accepted: parsed.error === 0, parsed: parsed };
    }

    function postOnlyOfficeForceSaveCommand(key, token, source, requestId) {
        var payload = { c: 'forcesave', key: key };
        if (token) payload.token = token;
        var body = JSON.stringify(payload);

        function sendTo(endpoint) {
            var headers = {
                'Content-Type': 'application/json'
            };
            var requestToken = getRequestToken();
            if (requestToken) {
                headers.requesttoken = requestToken;
            }
            return fetch(endpoint, {
                method: 'POST',
                credentials: 'same-origin',
                headers: headers,
                body: body
            }).then(function(resp) {
                return resp.text().then(function(text) {
                    var commandResult = parseOnlyOfficeCommandResult(text || '');
                    return {
                        ok: resp.ok && commandResult.accepted,
                        status: resp.status,
                        body: text || '',
                        accepted: commandResult.accepted
                    };
                });
            });
        }

        var endpoints = [
            '/coauthoring/CommandService.ashx',
            '/ds/coauthoring/CommandService.ashx',
            '/command',
            '/ds/command'
        ];

        function attempt(index, lastResult) {
            if (index >= endpoints.length) {
                source.postMessage({
                    type: 'kinBridgeOnlyOfficeForceSaveResult',
                    requestId: requestId,
                    ok: false,
                    status: lastResult ? lastResult.status : 0,
                    body: lastResult ? lastResult.body : '',
                    error: 'forcesave command was not accepted'
                }, '*');
                return;
            }

            sendTo(endpoints[index]).then(function(result) {
                if (result.ok) {
                    source.postMessage({
                        type: 'kinBridgeOnlyOfficeForceSaveResult',
                        requestId: requestId,
                        ok: true,
                        status: result.status,
                        body: result.body
                    }, '*');
                    return;
                }
                attempt(index + 1, result);
            }).catch(function(err) {
                if (index >= endpoints.length - 1) {
                    source.postMessage({
                        type: 'kinBridgeOnlyOfficeForceSaveResult',
                        requestId: requestId,
                        ok: false,
                        error: err && err.message ? err.message : 'forcesave failed'
                    }, '*');
                    return;
                }
                attempt(index + 1, lastResult);
            });
        }

        attempt(0, null);
    }

    function handleOnlyOfficeForceSave(source, requestId) {
        var ctx = getOnlyOfficeContext();
        if (!ctx || !ctx.fileId) {
            source.postMessage({
                type: 'kinBridgeOnlyOfficeForceSaveResult',
                requestId: requestId,
                ok: false,
                error: 'No active OnlyOffice file context'
            }, '*');
            return;
        }

        var configUrl = '/ocs/v2.php/apps/onlyoffice/api/v1/config/' + encodeURIComponent(String(ctx.fileId));
        if (ctx.filePath) {
            configUrl += '?filePath=' + encodeURIComponent(String(ctx.filePath));
        }

        fetch(configUrl, {
            method: 'GET',
            credentials: 'same-origin',
            headers: {
                'OCS-APIREQUEST': 'true',
                Accept: 'application/json'
            }
        }).then(function(resp) {
            return resp.text().then(function(text) {
                return { ok: resp.ok, status: resp.status, text: text || '' };
            });
        }).then(function(result) {
            if (!result.ok) {
                source.postMessage({
                    type: 'kinBridgeOnlyOfficeForceSaveResult',
                    requestId: requestId,
                    ok: false,
                    status: result.status,
                    error: 'Config fetch failed (HTTP ' + result.status + ')'
                }, '*');
                return;
            }
            var parsed = parseJsonSafe(result.text);
            var data = pickOnlyOfficeConfigData(parsed);
            var key = data && data.document && data.document.key ? String(data.document.key) : '';
            var token = data && data.token ? String(data.token) : '';
            if (!key) {
                source.postMessage({
                    type: 'kinBridgeOnlyOfficeForceSaveResult',
                    requestId: requestId,
                    ok: false,
                    error: 'No OnlyOffice document key available for forcesave'
                }, '*');
                return;
            }
            postOnlyOfficeForceSaveCommand(key, token, source, requestId);
        }).catch(function(err) {
            source.postMessage({
                type: 'kinBridgeOnlyOfficeForceSaveResult',
                requestId: requestId,
                ok: false,
                error: err && err.message ? err.message : 'forcesave setup failed'
            }, '*');
        });
    }

// --- Toolbar hiding (Always apply, for OnlyOffice context) ---

    function hideNextcloudToolbar() {
        var style = document.createElement('style');
        style.id = 'kin-bridge-toolbar-hide';
        style.textContent = 
            '#header { display: none !important; }' +
            '#content { margin-top: 0 !important; height: 100% !important; }' +
            '#content > #app > iframe { height: 100% !important; }' +
            '.header { display: none !important; }' +
            '.app-content { margin-top: 0 !important; }' +
            '#app-content { margin-top: 0 !important; height: 100% !important; }';
        
        if (!document.getElementById('kin-bridge-toolbar-hide')) {
            document.head.appendChild(style);
        }
    }

    function ensureToolbarHidden() {
        hideNextcloudToolbar();
        // Re-apply on DOM changes (for dynamically loaded content)
        if (typeof MutationObserver !== 'undefined') {
            window.__kinBridgeToolbarObserver = new MutationObserver(function() {
                hideNextcloudToolbar();
            });
            window.__kinBridgeToolbarObserver.observe(document.body || document.documentElement, {
                childList: true,
                subtree: true
            });
        }
    }

    // --- OnlyOffice check (for other features) ---

    function isOnlyOfficeContext() {
        var ctx = getOnlyOfficeContext();
        return ctx && ctx.inframe;
    }

    // --- New window interception ---

    function interceptNewWindowAttempts() {
        // Override window.open
        var originalWindowOpen = window.open;
        window.open = function(url, name, features) {
            postToParent({
                type: 'kinBridgeOpenWindow',
                url: url || '',
                target: name || '_blank'
            });
            return null;
        };

        // Intercept anchor clicks that target _blank
        document.addEventListener('click', function(e) {
            var anchor = e.target.closest('a[target="_blank"]');
            if (anchor) {
                e.preventDefault();
                e.stopPropagation();
                postToParent({
                    type: 'kinBridgeOpenWindow',
                    url: anchor.href || '',
                    target: '_blank'
                });
            }
        }, true);
    }

    // --- Login via OIDC (silent) ---

    function startOidcLogin() {
        try {
            var u = new URL(window.location.href);
            // Allow admins to force the local login form.
            if (u.searchParams.get('direct') === '1') {
                log('Login direct=1 requested; not starting OIDC');
                return;
            }
        } catch (_e) {}

        // If user_oidc is configured with allow_multiple_user_backends=0, /login auto-redirects to the IdP.
        // This keeps the user out of the Nextcloud login form entirely.
        window.location.href = '/index.php/login';
    }

    // --- Logout ---

    function doLogout(data) {
        var token = getRequestToken();
        var logoutUrl = '/index.php/logout';
        if (token) {
            logoutUrl += '?requesttoken=' + encodeURIComponent(token);
        }
        // If switching to admin, go to login page with direct=1 after logout
        if (data && data.switchToAdmin) {
            logoutUrl += '&redirect=/login%3Fdirect%3D1';
        }
        window.location.href = logoutUrl;
    }

    // --- WebDAV ---

    function arrayBufferToBase64(buffer) {
        var bytes = new Uint8Array(buffer || new ArrayBuffer(0));
        var chunk = 0x8000;
        var binary = '';
        for (var i = 0; i < bytes.length; i += chunk) {
            var slice = bytes.subarray(i, i + chunk);
            binary += String.fromCharCode.apply(null, slice);
        }
        return btoa(binary);
    }

    function handleWebDAV(method, path, body, extraHeaders, responseType, source, requestId) {
        var user = getLoggedInUser() || 'unknown';
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

        var token = getRequestToken();
        if (token && !headers.requesttoken && !headers.RequestToken) {
            headers.requesttoken = token;
        }
        if (!headers['X-Requested-With']) {
            headers['X-Requested-With'] = 'XMLHttpRequest';
        }

        fetch(url, {
            method: method || 'PROPFIND',
            credentials: 'include',
            cache: 'no-store',
            headers: headers,
            body: body || null
        }).then(function(resp) {
            var contentType = resp.headers && resp.headers.get ? (resp.headers.get('content-type') || '') : '';
            if (responseType === 'base64') {
                return resp.arrayBuffer().then(function(buffer) {
                    source.postMessage({
                        type: 'kinBridgeWebDAVResponse',
                        requestId: requestId,
                        status: resp.status,
                        bodyBase64: arrayBufferToBase64(buffer),
                        contentType: contentType,
                        isBase64: true,
                        ok: resp.ok
                    }, '*');
                });
            }
            return resp.text().then(function(text) {
                source.postMessage({
                    type: 'kinBridgeWebDAVResponse',
                    requestId: requestId,
                    status: resp.status,
                    body: text,
                    contentType: contentType,
                    isBase64: false,
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

        if (data.type === 'kinEditorKeydown') {
            postToParent({ type: 'kinBridgeEditorKeydown' });
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
                if (!status.isLoggedIn) {
                    startOidcLogin();
                }
                break;

            case 'kinBridgeLogout':
                doLogout(data);
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
                handleWebDAV(data.method, data.path, data.body, data.headers, data.responseType, event.source, data.requestId);
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

            case 'kinBridgeOnlyOfficeForceSave':
                handleOnlyOfficeForceSave(event.source, data.requestId);
                break;
        }
    });

    // --- URL change detection for SPA navigation ---

    function handleUrlChange() {
        var status = getStatus();
        log('URL changed to:', status.url);
        log('isLoggedIn:', status.isLoggedIn, 'isLoginPage:', status.isLoginPage);

        ensureToolbarHidden();

        if (status.isLoggedIn) {
            postToParent({
                type: 'kinBridgeStatusChange',
                isNextcloud: true,
                isLoggedIn: true,
                currentUser: status.currentUser,
                url: status.url
            });
            return;
        }

        if (status.isLoginPage) {
            setTimeout(function() {
                startOidcLogin();
            }, 250);
        }
    }

    // --- Init ---

    // BUG: Wrapping DocsAPI.DocEditor constructor to hook onDocumentStateChange
    // does not work — the Nextcloud OnlyOffice app appears to create the editor
    // before kin-bridge.js can intercept it, or uses a code path that bypasses
    // the wrapped constructor. Instead, keydown events are injected directly into
    // the OO editor iframe via nginx sub_filter, then forwarded here as
    // kinEditorKeydown → kinBridgeEditorKeydown for debounced autosave.

    function init() {
        var status = getStatus();
        log('Init on', window.location.href);
        log('isLoggedIn:', status.isLoggedIn, 'isLoginPage:', status.isLoginPage, 'user:', status.currentUser);

        ensureToolbarHidden();

        // Intercept new window requests
        interceptNewWindowAttempts();

        // If logged in, notify parent
        if (status.isLoggedIn) {
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

        // If Nextcloud shows a login form, start OIDC immediately.
        if (status.isLoginPage) {
            setTimeout(function() {
                startOidcLogin();
            }, 250);
        }

        // Watch for URL changes (SPA navigation within Nextcloud)
        var lastUrl = status.url;
        if (typeof MutationObserver !== 'undefined') {
            window.__kinBridgeUrlObserver = new MutationObserver(function() {
                if (window.location.href !== lastUrl) {
                    lastUrl = window.location.href;
                    handleUrlChange();
                }
            });
            window.__kinBridgeUrlObserver.observe(document.documentElement, {
                childList: true,
                subtree: true
            });
        }

        // Also handle popstate for back/forward navigation
        window.addEventListener('popstate', function() {
            if (window.location.href !== lastUrl) {
                lastUrl = window.location.href;
                handleUrlChange();
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
