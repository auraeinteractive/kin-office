/**
 * kinnextcloud - Nextcloud integration app for Kin OS
 * Registers a Dormant drive with Workspace via postMessage.
 * Passes WebDAV URL and credentials so Workspace can fetch directly.
 */

(function(global) {
    'use strict';

    var WEBDAV_BASE = 'https://katana-arphicia:5002/remote.php/webdav/';
    var WEBDAV_USER = 'admin';
    var WEBDAV_PASS = 'admin123';

    // --- Register dormant drive with WebDAV info ---

    function reportDriveToWorkspace() {
        window.parent.postMessage({
            kinDormantRequest: true,
            operation: 'register',
            path: 'Nextcloud:',
            data: {
                name: 'Nextcloud:',
                appId: 'kinnextcloud',
                writable: true,
                persistent: false,
                automount: true,
                // WebDAV endpoint info - Workspace will call this directly
                webdav: {
                    baseUrl: WEBDAV_BASE,
                    authHeader: 'Basic ' + btoa(WEBDAV_USER + ':' + WEBDAV_PASS)
                }
            },
            requestId: 'register-' + Date.now()
        }, '*');
    }

    // --- Kin workspace integration ---

    function getInstanceId() {
        try {
            var u = new URL(window.location.href);
            return u.searchParams.get('kin_app_instance') || '';
        } catch (e) {
            return '';
        }
    }

    var INSTANCE_ID = getInstanceId();
    var ORIGIN = window.location.origin;

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
            console.log('[kinnextcloud] Logout requested');
        }
    }

    window.addEventListener('message', function(event) {
        var data = event.data;
        if (!data) return;
        if (data.kinMenuCommand === true) {
            handleMenuCommand(data.command);
        }
    });

    // --- Init ---

    reportDriveToWorkspace();
    registerMenus();
    console.log('[kinnextcloud] App loaded - registered Nextcloud: with WebDAV endpoint');

})(typeof window !== 'undefined' ? window : global);
