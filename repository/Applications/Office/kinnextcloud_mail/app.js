const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function isLoopbackHost(host) {
    return LOOPBACK_HOSTS.has((host || '').toLowerCase());
}

function getInstanceId() {
    try {
        const url = new URL(window.location.href);
        return url.searchParams.get('kin_app_instance') || '';
    } catch (_error) {
        return '';
    }
}

function resolveNextcloudHost(params) {
    const override = params.get('nextcloud_host') || params.get('nextcloudHost');
    if (override) {
        return override;
    }
    if (!isLoopbackHost(window.location.hostname)) {
        return window.location.hostname;
    }
    return window.location.hostname;
}

function setLoading(text) {
    const el = document.getElementById('loading');
    if (!el) return;
    if (text) {
        el.textContent = String(text);
        el.classList.remove('hidden');
    } else {
        el.classList.add('hidden');
    }
}

export function bootstrapNextcloudMail() {
    const iframeEl = document.getElementById('iframe');
    if (!iframeEl) {
        throw new Error('Missing #iframe element');
    }

    const ORIGIN = window.location.origin;
    const instanceId = getInstanceId();
    const params = new URLSearchParams(window.location.search);
    const nextcloudHost = resolveNextcloudHost(params);
    const NEXTCLOUD_ORIGIN = 'https://' + nextcloudHost + ':5002';
    const targetPath = '/index.php/apps/mail/';

    let loginInProgress = false;
    let launchedTarget = false;

    function postToParent(message) {
        try {
            window.parent.postMessage(message, ORIGIN);
        } catch (_error) {
            // ignore
        }
    }

    function registerMenus() {
        if (!instanceId) return;
        postToParent({
            kinAppRegisterMenus: true,
            instanceId,
            menus: {
                File: [
                    { name: 'Log out', command: 'nextcloud.mail.logout' }
                ]
            }
        });
    }

    function sendToBridge(type, payload) {
        try {
            if (!iframeEl.contentWindow) {
                throw new Error('Bridge iframe is not ready');
            }
            iframeEl.contentWindow.postMessage(Object.assign({ type }, payload || {}), '*');
            return true;
        } catch (_error) {
            return false;
        }
    }

    function ensureMailLoaded(status) {
        if (launchedTarget) return;
        const url = status && status.url ? String(status.url) : '';
        if (url.indexOf('/index.php/apps/mail') !== -1) {
            launchedTarget = true;
            return;
        }
        launchedTarget = true;
        setLoading('Opening Mail…');
        sendToBridge('kinBridgeNavigate', { path: targetPath });
    }

    function handleBridgeStatus(data) {
        if (!data) return;

        if (data.isLoggedIn) {
            loginInProgress = false;
            ensureMailLoaded(data);
            setLoading(null);
            return;
        }

        if (data.isLoginPage && !loginInProgress) {
            loginInProgress = true;
            setLoading('Signing in…');
            sendToBridge('kinBridgeLogin');
            return;
        }

        if (loginInProgress) {
            setLoading('Signing in…');
        } else {
            setLoading('Connecting to Nextcloud…');
        }
    }

    async function handleMenuCommand(command) {
        if (command === 'nextcloud.mail.logout') {
            setLoading('Logging out…');
            sendToBridge('kinBridgeLogout');
        }
    }

    window.addEventListener('message', (event) => {
        const data = event.data;
        if (!data) return;

        if (event.origin === ORIGIN && data.kinMenuCommand === true) {
            handleMenuCommand(data.command);
            return;
        }

        if (data.type && String(data.type).indexOf('kinBridge') === 0) {
            if (
                data.type === 'kinBridgeReady' ||
                data.type === 'kinBridgeHandshakeResponse' ||
                data.type === 'kinBridgeStatus' ||
                data.type === 'kinBridgeStatusChange'
            ) {
                handleBridgeStatus(data);
            }
        }
    });

    iframeEl.onload = function() {
        sendToBridge('kinBridgeHandshake');
        sendToBridge('kinBridgeGetStatus');
    };

    registerMenus();
    setLoading('Connecting to Nextcloud…');
    iframeEl.src = NEXTCLOUD_ORIGIN + targetPath;
}

bootstrapNextcloudMail();

