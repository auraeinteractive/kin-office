/**
 * kinnextcloud - Nextcloud integration app for Kin OS
 * Uses iframe with kin-bridge.js for session-based login
 */

const NEXTCLOUD_URL = 'https://localhost:5002';
const ORIGIN = window.location.origin;

const iframeEl = document.getElementById('iframe');

let bridgeReady = false;
let currentUser = null;
let loginInProgress = false;

// --- Kin workspace integration ---

function getInstanceId() {
    try {
        const u = new URL(window.location.href);
        return u.searchParams.get('kin_app_instance') || '';
    } catch (e) {
        return '';
    }
}

const INSTANCE_ID = getInstanceId();

function postToParent(msg) {
    try {
        window.parent.postMessage(msg, ORIGIN);
    } catch (e) { /* ignore */ }
}

function registerMenus() {
    if (!INSTANCE_ID) return;
    postToParent({
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
        sendToBridge('kinBridgeLogout');
    }
}

// --- Bridge communication ---

function sendToBridge(type, payload = {}) {
    try {
        iframeEl.contentWindow.postMessage({ type, ...payload }, '*');
    } catch (err) {
        console.error('[kinnextcloud] Failed to send to bridge:', err);
    }
}

function handleBridgeMessage(data) {
    switch (data.type) {
        case 'kinBridgeReady':
            bridgeReady = true;
            currentUser = data.currentUser;
            if (data.isLoggedIn) {
                console.log('[kinnextcloud] Logged in as', currentUser);
            } else {
                loginInProgress = true;
                console.log('[kinnextcloud] Logging in...');
            }
            break;

        case 'kinBridgeHandshakeResponse':
            currentUser = data.currentUser;
            if (data.isLoggedIn) {
                loginInProgress = false;
                console.log('[kinnextcloud] Logged in as', currentUser);
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
            currentUser = data.currentUser;
            loginInProgress = false;
            break;

        case 'kinBridgeError':
            loginInProgress = false;
            console.error('[kinnextcloud] Bridge error:', data.error, 'action:', data.action);
            break;
    }
}

// --- Event listeners ---

window.addEventListener('message', (e) => {
    const data = e.data;
    if (!data) return;

    // Kin workspace menu commands
    if (data.kinMenuCommand === true) {
        handleMenuCommand(data.command);
        return;
    }

    // Bridge messages from iframe
    if (data.type && data.type.startsWith('kinBridge')) {
        handleBridgeMessage(data);
    }
});

iframeEl.onload = () => {
    console.log('[kinnextcloud] iframe loaded');
};

// --- Init ---

registerMenus();
console.log('[kinnextcloud] App loaded');
