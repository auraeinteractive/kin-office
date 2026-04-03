const TARGET_PATH = '/index.php/apps/onlyoffice/new?name=New%20document.docx&dir=%2F';
const ONLYOFFICE_PATH = '/index.php/apps/onlyoffice/';
const MENU_LOGOUT_COMMAND = 'onlyoffice.documents.logout';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const DEFAULT_NEXTCLOUD_HOST = window.location.hostname;

function isLoopbackHost(host) {
    return LOOPBACK_HOSTS.has((host || '').toLowerCase());
}

function resolveNextcloudHost() {
    const params = new URLSearchParams(window.location.search);
    const override = params.get('nextcloud_host') || params.get('nextcloudHost');
    if (override) {
        return override;
    }

    try {
        localStorage.removeItem('kin.nextcloud.host');
    } catch (error) {
        // ignore storage failures
    }

    if (!isLoopbackHost(window.location.hostname)) {
        return window.location.hostname;
    }

    return DEFAULT_NEXTCLOUD_HOST;
}

const NEXTCLOUD_ORIGIN = `https://${resolveNextcloudHost()}:5002`;

const iframeEl = document.getElementById('iframe');
const ORIGIN = window.location.origin;

let loginInProgress = false;
let launchedTarget = false;

function getInstanceId() {
    try {
        const url = new URL(window.location.href);
        return url.searchParams.get('kin_app_instance') || '';
    } catch (error) {
        return '';
    }
}

const INSTANCE_ID = getInstanceId();

function postToParent(message) {
    try {
        window.parent.postMessage(message, ORIGIN);
    } catch (error) {
        // ignore
    }
}

function registerMenus() {
    if (!INSTANCE_ID) return;
    postToParent({
        kinAppRegisterMenus: true,
        instanceId: INSTANCE_ID,
        menus: {
            File: [
                { name: 'Log out', command: MENU_LOGOUT_COMMAND }
            ]
        }
    });
}

function sendToBridge(type, payload = {}) {
    try {
        iframeEl.contentWindow.postMessage({ type, ...payload }, '*');
    } catch (error) {
        console.error('[kinonlyoffice_documents] Bridge send failed:', error);
    }
}

function handleMenuCommand(command) {
    if (command === MENU_LOGOUT_COMMAND) {
        sendToBridge('kinBridgeLogout');
    }
}

function openTargetWhenReady(status) {
    if (!status || !status.isLoggedIn || launchedTarget) {
        return;
    }

    const currentUrl = status.url || '';
    if (currentUrl.includes(ONLYOFFICE_PATH)) {
        launchedTarget = true;
        return;
    }

    launchedTarget = true;
    sendToBridge('kinBridgeNavigate', { path: TARGET_PATH });
}

function handleBridgeMessage(data) {
    switch (data.type) {
        case 'kinBridgeReady':
            if (data.isLoggedIn) {
                loginInProgress = false;
                openTargetWhenReady(data);
            } else if (!loginInProgress) {
                loginInProgress = true;
                sendToBridge('kinBridgeLogin', {
                    username: 'admin',
                    password: 'admin123'
                });
            }
            break;

        case 'kinBridgeHandshakeResponse':
            if (data.isLoggedIn) {
                loginInProgress = false;
                openTargetWhenReady(data);
            } else if (!loginInProgress) {
                loginInProgress = true;
                sendToBridge('kinBridgeLogin', {
                    username: 'admin',
                    password: 'admin123'
                });
            }
            break;

        case 'kinBridgeStatus':
        case 'kinBridgeStatusChange':
            if (data.isLoggedIn) {
                loginInProgress = false;
                openTargetWhenReady(data);
            }
            break;

        case 'kinBridgeError':
            loginInProgress = false;
            console.error('[kinonlyoffice_documents] Bridge error:', data.error, 'action:', data.action);
            break;
    }
}

window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data) return;

    if (data.kinMenuCommand === true) {
        handleMenuCommand(data.command);
        return;
    }

    if (data.type && data.type.startsWith('kinBridge')) {
        handleBridgeMessage(data);
    }
});

iframeEl.onload = () => {
    sendToBridge('kinBridgeHandshake');
    sendToBridge('kinBridgeGetStatus');
};

registerMenus();
iframeEl.src = NEXTCLOUD_ORIGIN + TARGET_PATH;
