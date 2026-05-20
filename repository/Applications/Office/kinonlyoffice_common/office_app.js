function normalizeVolumeLabel(volume) {
    const value = String(volume || 'Nextcloud').trim();
    if (!value) return 'Nextcloud:';
    return value.endsWith(':') ? value : value + ':';
}

function parseKinPath(path) {
    const value = String(path || '').trim();
    const match = value.match(/^([^:]+):(.*)$/);
    if (!match) return null;
    return {
        volume: match[1],
        relative: String(match[2] || '').replace(/^\/+/, '')
    };
}

function kinPathBaseName(path) {
    const parsed = parseKinPath(path);
    if (!parsed) return '';
    const rel = String(parsed.relative || '');
    if (!rel) return '';
    const parts = rel.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
}

function kinPathInfoPath(path) {
    const value = String(path || '').trim();
    return value ? value + '.info' : '';
}

function fileTypeFromName(name, fallback) {
    const value = String(name || '').toLowerCase();
    const match = value.match(/\.([a-z0-9]+)$/);
    if (match && (match[1] === 'docx' || match[1] === 'xlsx' || match[1] === 'pptx')) {
        return match[1];
    }
    return fallback || 'docx';
}

function kinPathToFileRoute(path) {
    const parsed = parseKinPath(path);
    if (!parsed) return null;
    const segs = String(parsed.relative || '').split('/').filter(Boolean).map(encodeURIComponent);
    if (!segs.length) return null;
    return '/file/' + encodeURIComponent(parsed.volume) + '/' + segs.join('/');
}

function toNextcloudPath(kinPath, nextcloudVolumeLabel) {
    const parsed = parseKinPath(kinPath);
    if (!parsed) return null;
    const expected = normalizeVolumeLabel(nextcloudVolumeLabel).slice(0, -1).toLowerCase();
    if (parsed.volume.toLowerCase() !== expected) return null;
    return '/' + parsed.relative;
}

function splitNextcloudPath(nextcloudPath) {
    const path = String(nextcloudPath || '/');
    const normalized = path.startsWith('/') ? path : '/' + path;
    const index = normalized.lastIndexOf('/');
    if (index <= 0) {
        return {
            dir: '/',
            name: normalized.replace(/^\//, '')
        };
    }
    return {
        dir: normalized.slice(0, index) || '/',
        name: normalized.slice(index + 1)
    };
}

function encodePathSegments(path) {
    const value = String(path || '/');
    if (value === '/') return '/';
    return '/' + value.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

function requestId(prefix) {
    return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
}

function shellQuote(value) {
    const text = String(value || '');
    return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function ensureOnlyOfficeIframeShell() {
    const html = document.documentElement;
    const body = document.body;
    html.style.height = '100%';
    body.style.margin = '0';
    body.style.padding = '0';
    body.style.height = '100%';
    body.style.overflow = 'hidden';
    let iframeEl = document.getElementById('iframe');
    if (!iframeEl) {
        body.replaceChildren();
        iframeEl = document.createElement('iframe');
        iframeEl.id = 'iframe';
        iframeEl.setAttribute('title', 'OnlyOffice');
        iframeEl.style.width = '100%';
        iframeEl.style.height = '100%';
        iframeEl.style.border = 'none';
        body.appendChild(iframeEl);
    }
    return iframeEl;
}

export function bootstrapOnlyOfficeApp(config) {
    const appConfig = Object.assign({
        appTag: 'kinonlyoffice',
        targetPath: '/index.php/apps/onlyoffice/new?name=New%20document.docx&dir=%2F',
        menuPrefix: 'onlyoffice.app',
        defaultFilename: 'Document.docx',
        fileType: 'docx'
    }, config || {});

    const iframeEl = ensureOnlyOfficeIframeShell();

    const ORIGIN = window.location.origin;
    const params = new URLSearchParams(window.location.search);
    const NEXTCLOUD_ORIGIN = resolveNextcloudOrigin(params);
    const nextcloudVolumeLabel = normalizeVolumeLabel(params.get('kin_nextcloud_volume') || params.get('nextcloud_volume') || 'Nextcloud');
    const nextcloudAssignTarget = String(params.get('kin_nextcloud_assign_target') || 'Home:.Mounts/nextcloud');
    const dialogInitialPath = 'Mountlist:';
    const kinOpenPath = params.get('kin_open_path') || params.get('path') || '';
    const modeParam = String(params.get('onlyoffice_mode') || params.get('kin_onlyoffice_mode') || '').toLowerCase();
    const directMode = modeParam === 'direct' || params.get('onlyoffice_direct') === '1' || params.get('kin_onlyoffice_direct') === '1';
    const directOrigin = String(params.get('onlyoffice_direct_origin') || params.get('kin_onlyoffice_direct_origin') || NEXTCLOUD_ORIGIN).replace(/\/+$/, '');
    const directApiBase = directOrigin + '/direct/api';

    const MENU_OPEN_COMMAND = appConfig.menuPrefix + '.open';
    const MENU_SAVE_COMMAND = appConfig.menuPrefix + '.save';
    const MENU_SAVE_AS_COMMAND = appConfig.menuPrefix + '.saveAs';
    const MENU_LOGOUT_COMMAND = appConfig.menuPrefix + '.logout';
    const MENU_STORAGE_CONNECT_COMMAND = appConfig.menuPrefix + '.storage.connect';
    const MENU_STORAGE_STATUS_COMMAND = appConfig.menuPrefix + '.storage.status';
    const MENU_STORAGE_DISCONNECT_COMMAND = appConfig.menuPrefix + '.storage.disconnect';

    const pendingBridgeRequests = new Map();

    let loginInProgress = false;
    let launchedTarget = false;
    let launchInProgress = false;
    let kinOpenPathAttempted = false;
    let bridgeUser = null;
    let currentOnlyOfficePath = null;
    let currentKinPath = null;
    let autosavePollingInterval = null;
    let directSession = null;
    let directStatePollingInterval = null;
    let directSyncing = false;
    let directSaveAsPromptOpen = false;
    let directLastPromptedVersion = 0;

    let bridgeHeartbeatInterval = null;
    let bridgeDead = false;
    let bridgeHeartbeatFailures = 0;
    let bridgeRehandshakeTimer = null;

    const instanceId = getInstanceId();

    function log() {
        const args = ['[' + appConfig.appTag + ']'].concat(Array.prototype.slice.call(arguments));
        console.log.apply(console, args);
    }

    function postToParent(message) {
        try {
            window.parent.postMessage(message, ORIGIN);
        } catch (_error) {
            // ignore
        }
    }

    function ensureBusyOverlay() {
        var overlay = document.getElementById('kinOnlyOfficeBusyOverlay');
        if (overlay) return overlay;
        overlay = document.createElement('div');
        overlay.id = 'kinOnlyOfficeBusyOverlay';
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.zIndex = '99999';
        overlay.style.display = 'none';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.background = 'rgba(0,0,0,0.32)';

        var card = document.createElement('div');
        card.style.padding = '14px 18px';
        card.style.borderRadius = '10px';
        card.style.background = 'rgba(20,20,20,0.9)';
        card.style.color = '#fff';
        card.style.fontFamily = 'monospace';
        card.style.fontSize = '13px';
        card.style.boxShadow = '0 10px 26px rgba(0,0,0,0.35)';
        card.textContent = 'Working...';
        overlay.appendChild(card);

        document.body.appendChild(overlay);
        return overlay;
    }

    function showBusy(message) {
        var overlay = ensureBusyOverlay();
        if (overlay.firstChild) {
            overlay.firstChild.textContent = String(message || 'Working...');
        }
        overlay.style.display = 'flex';
    }

    function hideBusy() {
        var overlay = document.getElementById('kinOnlyOfficeBusyOverlay');
        if (!overlay) return;
        overlay.style.display = 'none';
    }

    async function withBusy(message, operation) {
        showBusy(message);
        try {
            return await operation();
        } finally {
            hideBusy();
        }
    }

    function requestWorkspaceRefresh() {
        postToParent({
            kinWorkspace: true,
            action: 'refreshAllDirectoryViews'
        });
    }

    function bytesToBase64(bytes) {
        var binary = '';
        var chunk = 0x8000;
        for (var i = 0; i < bytes.length; i += chunk) {
            var slice = bytes.subarray(i, i + chunk);
            binary += String.fromCharCode.apply(null, slice);
        }
        return btoa(binary);
    }

    function base64ToBytes(base64) {
        var binary = atob(String(base64 || ''));
        var out = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i += 1) {
            out[i] = binary.charCodeAt(i);
        }
        return out;
    }

    function registerMenus() {
        if (!instanceId) return;
        const menus = {
            File: [
                { name: 'Open...', command: MENU_OPEN_COMMAND },
                { name: 'Save', command: MENU_SAVE_COMMAND },
                { name: 'Save As...', command: MENU_SAVE_AS_COMMAND },
                { name: 'Log out', command: MENU_LOGOUT_COMMAND }
            ]
        };
        if (!directMode) {
            menus.Storage = [
                { name: 'Connect Nextcloud volume', command: MENU_STORAGE_CONNECT_COMMAND },
                { name: 'Nextcloud volume status', command: MENU_STORAGE_STATUS_COMMAND },
                { name: 'Disconnect Nextcloud volume', command: MENU_STORAGE_DISCONNECT_COMMAND }
            ];
        }
        postToParent({
            kinAppRegisterMenus: true,
            instanceId,
            menus
        });
    }

    function sendToBridge(type, payload) {
        try {
            if (!iframeEl.contentWindow) {
                throw new Error('Bridge iframe is not ready');
            }
            iframeEl.contentWindow.postMessage(Object.assign({ type }, payload || {}), '*');
            return true;
        } catch (error) {
            log('Bridge send failed:', error);
            return false;
        }
    }

    function bridgeRequest(type, payload, timeoutMs) {
        const reqId = requestId('bridge');
        const timeout = typeof timeoutMs === 'number' ? timeoutMs : 15000;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pendingBridgeRequests.delete(reqId);
                reject(new Error('Bridge request timed out: ' + type));
            }, timeout);
            pendingBridgeRequests.set(reqId, { resolve, reject, timer, type });
            const sent = sendToBridge(type, Object.assign({}, payload || {}, { requestId: reqId }));
            if (!sent) {
                pendingBridgeRequests.delete(reqId);
                clearTimeout(timer);
                reject(new Error('Bridge iframe is not ready for ' + type));
            }
        });
    }

    function settlePendingBridgeRequest(reqId, callback) {
        if (!reqId || !pendingBridgeRequests.has(reqId)) return false;
        const pending = pendingBridgeRequests.get(reqId);
        pendingBridgeRequests.delete(reqId);
        clearTimeout(pending.timer);
        callback(pending);
        return true;
    }

    function requestFileDialog(options) {
        const dialogOptions = options || {};
        return new Promise((resolve, reject) => {
            const reqId = requestId('fd');
            function onMsg(event) {
                const data = event.data;
                if (event.origin !== ORIGIN || !data || data.kinFileDialogResult !== true || data.requestId !== reqId) {
                    return;
                }
                window.removeEventListener('message', onMsg);
                if (data.cancelled) {
                    reject(new Error('cancel'));
                    return;
                }
                resolve(String(data.path || ''));
            }
            window.addEventListener('message', onMsg);
            postToParent({
                kinOpenFileDialog: true,
                requestId: reqId,
                mode: dialogOptions.mode === 'save' ? 'save' : 'load',
                initialPath: dialogOptions.initialPath || dialogInitialPath,
                defaultFilename: dialogOptions.defaultFilename || ''
            });
        });
    }

    function openAlert(message, title) {
        return new Promise((resolve) => {
            const reqId = requestId('alert');
            function onMsg(event) {
                const data = event.data;
                if (event.origin !== ORIGIN || !data || data.kinAlertResult !== true || data.requestId !== reqId) {
                    return;
                }
                window.removeEventListener('message', onMsg);
                resolve();
            }
            window.addEventListener('message', onMsg);
            postToParent({
                kinOpenAlert: true,
                requestId: reqId,
                message: String(message || ''),
                title: title || 'OnlyOffice'
            });
        });
    }

    async function apiPostJson(path, payload) {
        const response = await fetch(path, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify(payload || {})
        });
        const text = await response.text();
        let json = null;
        if (text) {
            try {
                json = JSON.parse(text);
            } catch (_error) {
                json = null;
            }
        }
        if (!response.ok) {
            log('apiPostJson error:', response.status, 'path=', path, 'response=', text);
            throw new Error((json && json.message) ? String(json.message) : ('HTTP ' + response.status + ' ' + text.substring(0, 200)));
        }
        return json || {};
    }

    async function readKinTextFile(kinPath, options) {
        const readOptions = options || {};
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timeoutMs = typeof readOptions.timeoutMs === 'number' ? readOptions.timeoutMs : 0;
        let timer = null;
        if (controller && timeoutMs > 0) {
            timer = setTimeout(function() {
                controller.abort();
            }, timeoutMs);
        }
        const response = await fetch('/api/file/read', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify({ path: String(kinPath || '') }),
            signal: controller ? controller.signal : undefined
        });
        if (timer) clearTimeout(timer);
        const text = await response.text();
        let json = null;
        if (text) {
            try {
                json = JSON.parse(text);
            } catch (_error) {
                json = null;
            }
        }
        if (!response.ok || !json || json.response !== 'success') {
            return '';
        }
        return String(json.data || '');
    }

    async function writeKinTextFile(kinPath, body) {
        const response = await apiPostJson('/api/file/write', {
            path: String(kinPath || ''),
            body: String(body || '')
        });
        if (!response || response.response !== 'success') {
            throw new Error((response && response.message) ? String(response.message) : 'Could not write ' + kinPath);
        }
    }

    async function readKinOnlyOfficeInfo(kinPath) {
        const infoPath = kinPathInfoPath(kinPath);
        if (!infoPath) return {};
        try {
            const text = await readKinTextFile(infoPath, { timeoutMs: 1500 });
            if (!text) return {};
            const parsed = JSON.parse(text);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (_error) {
            return {};
        }
    }

    async function writeKinOnlyOfficeInfo(kinPath, directInfo) {
        const infoPath = kinPathInfoPath(kinPath);
        if (!infoPath || !directInfo) return;
        const existing = await readKinOnlyOfficeInfo(kinPath);
        existing.kinOnlyOffice = Object.assign({}, existing.kinOnlyOffice || {}, directInfo);
        await writeKinTextFile(infoPath, JSON.stringify(existing, null, 2));
    }

    async function directFetchJson(path, options) {
        const requestOptions = options || {};
        const response = await fetch(directApiBase + path, {
            method: requestOptions.method || 'GET',
            cache: 'no-store',
            headers: Object.assign({
                Accept: 'application/json'
            }, requestOptions.headers || {}),
            body: requestOptions.body || null
        });
        const text = await response.text();
        let json = null;
        if (text) {
            try {
                json = JSON.parse(text);
            } catch (_error) {
                json = null;
            }
        }
        if (!response.ok || !json || (json.response && json.response !== 'success')) {
            throw new Error((json && json.message) ? String(json.message) : ('Direct connector failed (HTTP ' + response.status + ')'));
        }
        return json;
    }

    function directPostJson(path, payload) {
        return directFetchJson(path, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload || {})
        });
    }

    async function runKinDosLine(line, cwd) {
        const response = await apiPostJson('/api/kindos/shell-line', {
            line: String(line || ''),
            cwd: cwd || 'Home:'
        });
        if (!response || response.response !== 'ok') {
            throw new Error((response && response.message) ? String(response.message) : 'KinDOS command failed');
        }
        if (typeof response.exit_code === 'number' && response.exit_code !== 0) {
            const stderr = String(response.stderr || '').trim();
            const stdout = String(response.stdout || '').trim();
            throw new Error(stderr || stdout || ('KinDOS command failed with exit code ' + response.exit_code));
        }
        return response;
    }

    async function ensureKinDir(path) {
        const params = new URLSearchParams({ path: String(path || '') });
        const response = await fetch('/api/commands/makedir', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                Accept: 'application/json'
            },
            body: params.toString()
        });
        const json = await response.json().catch(() => ({}));
        if (!response.ok || !json || json.response !== 'success') {
            throw new Error((json && json.message) ? String(json.message) : 'makedir failed for ' + path);
        }
    }

    function buildAssignCommand(targetPath) {
        return 'assign ' + nextcloudVolumeLabel + ' ' + shellQuote(String(targetPath || nextcloudAssignTarget));
    }

    async function runAssignCommand(op, targetPath) {
        if (op === 'add') {
            const response = await runKinDosLine(buildAssignCommand(targetPath || nextcloudAssignTarget), 'Home:');
            const out = String(response.stdout || '').trim();
            if (out.toUpperCase().indexOf('OK') !== 0) {
                throw new Error(out || 'Could not create assign for ' + nextcloudVolumeLabel);
            }
            return response;
        }
        if (op === 'remove') {
            const response = await runKinDosLine('assign ' + nextcloudVolumeLabel + ' REMOVE', 'Home:');
            const out = String(response.stdout || '').trim();
            if (out.toUpperCase().indexOf('OK') !== 0) {
                throw new Error(out || 'Could not remove assign for ' + nextcloudVolumeLabel);
            }
            return response;
        }
        return runKinDosLine('assign', 'Home:');
    }

    async function ensureNextcloudAssign() {
        await ensureKinDir('Home:.Mounts');
        await ensureKinDir(nextcloudAssignTarget);
        await runAssignCommand('add', nextcloudAssignTarget);
    }

    async function getNextcloudVolumeStatus() {
        let assignStdout = '';
        let assignPresent = false;
        let assignTarget = null;
        try {
            const assignResponse = await runAssignCommand('list');
            assignStdout = String(assignResponse.stdout || '');
            const escapedVolume = nextcloudVolumeLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const matcher = new RegExp('^\\s*' + escapedVolume + '\\s*->\\s*(.+)$', 'im');
            const match = assignStdout.match(matcher);
            if (match) {
                assignPresent = true;
                assignTarget = String(match[1] || '').trim();
            }
        } catch (_error) {
            // ignore and report unknown below
        }

        let mountlistVisible = false;
        try {
            const mountlist = await apiPostJson('/api/dir', { path: 'Mountlist:' });
            if (mountlist && mountlist.response === 'success' && Array.isArray(mountlist.data)) {
                mountlistVisible = mountlist.data.some((entry) => {
                    const name = String(entry && entry.filename ? entry.filename : '').replace(/:+$/, '').toLowerCase();
                    const expected = nextcloudVolumeLabel.replace(/:+$/, '').toLowerCase();
                    return name === expected;
                });
            }
        } catch (_error) {
            // ignore and report unknown below
        }

        let accessOk = false;
        let entries = null;
        let accessMessage = 'Not accessible';
        try {
            const dirResponse = await apiPostJson('/api/dir', { path: nextcloudVolumeLabel });
            if (dirResponse && dirResponse.response === 'success' && Array.isArray(dirResponse.data)) {
                accessOk = true;
                entries = dirResponse.data.length;
                accessMessage = 'Accessible';
            } else {
                accessMessage = (dirResponse && dirResponse.message) ? String(dirResponse.message) : 'Could not open volume';
            }
        } catch (error) {
            accessMessage = error && error.message ? error.message : 'Could not open volume';
        }

        return {
            assignPresent,
            assignTarget,
            assignStdout,
            mountlistVisible,
            accessOk,
            entries,
            accessMessage
        };
    }

    async function showNextcloudVolumeStatus() {
        const status = await getNextcloudVolumeStatus();
        const lines = [
            'Volume: ' + nextcloudVolumeLabel,
            'Assign: ' + (status.assignPresent ? 'present' : 'missing'),
            'Assign target: ' + (status.assignTarget || '(not set)'),
            'Mountlist entry: ' + (status.mountlistVisible ? 'visible' : 'missing'),
            'Directory access: ' + status.accessMessage
        ];
        if (status.entries != null) {
            lines.push('Entries visible: ' + status.entries);
            if (status.entries === 0) {
                lines.push('Hint: if this should contain cloud files, verify host-side WebDAV mount into ' + nextcloudAssignTarget + '.');
            }
        }
        lines.push('');
        lines.push('Note: Host-side WebDAV mounting is external to this app.');
        await openAlert(lines.join('\n'), 'Nextcloud Volume Status');
    }

    async function connectNextcloudVolume() {
        await withBusy('Connecting storage...', async function() {
            await ensureNextcloudAssign();
            requestWorkspaceRefresh();
            await showNextcloudVolumeStatus();
        });
    }

    async function disconnectNextcloudVolume() {
        await withBusy('Disconnecting storage...', async function() {
            await runAssignCommand('remove');
            requestWorkspaceRefresh();
        });
        await openAlert('Removed assign for ' + nextcloudVolumeLabel + '.', 'Nextcloud Volume');
    }

    function buildWebDavPath(nextcloudPath) {
        if (!bridgeUser) {
            throw new Error('No logged in Nextcloud user');
        }
        const normalized = String(nextcloudPath || '/');
        return '/remote.php/dav/files/' + encodeURIComponent(bridgeUser) + encodePathSegments(normalized);
    }

    async function webDavRequest(method, nextcloudPath, options) {
        const requestOptions = options || {};
        const path = requestOptions.path || buildWebDavPath(nextcloudPath);
        let lastError = null;
        const attempts = requestOptions.retryCount || 2;
        for (let index = 0; index < attempts; index += 1) {
            try {
                const response = await bridgeRequest('kinBridgeWebDAV', {
                    method,
                    path,
                    body: requestOptions.body || null,
                    headers: requestOptions.headers || {},
                    responseType: requestOptions.responseType || 'text'
                }, requestOptions.timeoutMs || 60000);
                return response;
            } catch (error) {
                lastError = error;
                const isTimeout = error && String(error.message || '').indexOf('timed out') !== -1;
                if (!isTimeout || index >= attempts - 1) {
                    throw error;
                }
                await new Promise((resolve) => setTimeout(resolve, 300));
            }
        }
        throw lastError || new Error('WebDAV request failed');
    }

    async function readNextcloudFileBytes(nextcloudPath) {
        const response = await webDavRequest('GET', nextcloudPath, {
            responseType: 'base64',
            headers: {
                'Cache-Control': 'no-cache',
                Pragma: 'no-cache'
            }
        });
        if (!response || response.status < 200 || response.status >= 300) {
            throw new Error('Could not read Nextcloud file (HTTP ' + (response ? response.status : 'unknown') + ')');
        }
        return base64ToBytes(response.bodyBase64 || '');
    }

    function waitMs(duration) {
        return new Promise((resolve) => setTimeout(resolve, duration));
    }

    function parseXmlFirstTag(xmlText, tagNames) {
        const text = String(xmlText || '');
        for (let index = 0; index < tagNames.length; index += 1) {
            const tag = String(tagNames[index] || '');
            if (!tag) continue;
            const expr = new RegExp('<(?:[a-zA-Z0-9_\\-]+:)?' + tag + '>([^<]*)</(?:[a-zA-Z0-9_\\-]+:)?' + tag + '>', 'i');
            const match = text.match(expr);
            if (match && typeof match[1] === 'string') {
                return match[1].trim();
            }
        }
        return '';
    }

    function normalizeNextcloudPath(path) {
        let value = String(path || '').trim();
        if (!value) return '';
        if (value[0] !== '/') value = '/' + value;
        try {
            value = decodeURIComponent(value);
        } catch (_error) {
            // keep original when decoding fails
        }
        return value;
    }

    function sameNextcloudPath(a, b) {
        return normalizeNextcloudPath(a) === normalizeNextcloudPath(b);
    }

    async function getNextcloudFileFingerprint(nextcloudPath) {
        const body = [
            '<?xml version="1.0"?>',
            '<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">',
            '  <d:prop><d:getetag/><d:getcontentlength/><d:getlastmodified/><oc:size/></d:prop>',
            '</d:propfind>'
        ].join('');
        const response = await webDavRequest('PROPFIND', nextcloudPath, {
            body,
            headers: {
                Depth: '0',
                'Content-Type': 'application/xml'
            },
            timeoutMs: 30000,
            retryCount: 2
        });
        if (!response || response.status < 200 || response.status >= 400) {
            throw new Error('Could not read file metadata (HTTP ' + (response ? response.status : 'unknown') + ')');
        }

        const xml = String(response.body || '');
        const etag = parseXmlFirstTag(xml, ['getetag']);
        const sizeRaw = parseXmlFirstTag(xml, ['getcontentlength', 'size']);
        const mtime = parseXmlFirstTag(xml, ['getlastmodified']);
        const size = sizeRaw ? String(sizeRaw).trim() : '';

        return {
            etag,
            size,
            mtime,
            signature: [etag || '', size || '', mtime || ''].join('|')
        };
    }

    function isFingerprintDifferent(before, after) {
        if (!before || !after) return false;
        return String(before.signature || '') !== String(after.signature || '');
    }

    function isForceSaveCommandAccepted(result) {
        if (!result) return false;
        if (result.ok === false) return false;
        if (!result.body) return !!result.ok;
        try {
            const parsed = JSON.parse(String(result.body || '{}'));
            if (typeof parsed.error === 'number') {
                return parsed.error === 0;
            }
            return !!result.ok;
        } catch (_error) {
            return !!result.ok;
        }
    }

    async function flushOnlyOfficeEdits(sourcePath) {
        const context = await getOnlyOfficeContext();
        const contextPath = context && context.filePath ? String(context.filePath) : '';
        if (!contextPath || !sourcePath || !sameNextcloudPath(contextPath, sourcePath)) {
            return;
        }

        let before = null;
        try {
            before = await getNextcloudFileFingerprint(sourcePath);
        } catch (_error) {
            before = null;
        }

        let forceSaveAccepted = false;
        try {
            const result = await bridgeRequest('kinBridgeOnlyOfficeForceSave', {}, 30000);
            forceSaveAccepted = isForceSaveCommandAccepted(result);
            if (!forceSaveAccepted) {
                log('OnlyOffice force-save was not accepted; continuing with best-effort export');
            }
        } catch (error) {
            log('OnlyOffice force-save request failed; continuing with best-effort export:', error && error.message ? error.message : error);
        }

        const maxPolls = before ? 2 : 1;
        for (let index = 0; index < maxPolls; index += 1) {
            await waitMs(900);
            if (!before) {
                if (index >= 0) {
                    return;
                }
                continue;
            }
            try {
                const after = await getNextcloudFileFingerprint(sourcePath);
                if (isFingerprintDifferent(before, after)) {
                    return;
                }
            } catch (_error) {
                // continue polling
            }
        }

        if (forceSaveAccepted) {
            log('Timed out waiting for Nextcloud metadata change after force-save; proceeding anyway');
        }
    }

    async function writeKinBinaryFile(kinPath, bytes) {
        log('writeKinBinaryFile: path=', kinPath, 'bytes=', bytes ? bytes.length : 0);
        const response = await apiPostJson('/api/file/write', {
            path: String(kinPath || ''),
            data: Array.from(bytes)
        });
        log('writeKinBinaryFile response:', response);
        if (!response || response.response !== 'success') {
            throw new Error((response && response.message) ? String(response.message) : 'Could not write file to Kin path');
        }
    }

    async function saveNextcloudFileToKinPath(sourceNextcloudPath, targetKinPath) {
        log('saveNextcloudFileToKinPath: source=', sourceNextcloudPath, 'target=', targetKinPath);
        try {
            await flushOnlyOfficeEdits(sourceNextcloudPath);
        } catch (e) {
            log('flushOnlyOfficeEdits failed:', e && e.message ? e.message : e);
        }
        const bytes = await readNextcloudFileBytes(sourceNextcloudPath);
        log('readNextcloudFileBytes got', bytes ? bytes.length : 0, 'bytes');
        await writeKinBinaryFile(targetKinPath, bytes);
        log('writeKinBinaryFile completed');
        try {
            const verifyBytes = await readKinFileBytes(targetKinPath);
            if (verifyBytes && verifyBytes.length !== bytes.length) {
                log('Save verification length mismatch', bytes.length, verifyBytes.length, targetKinPath);
            } else {
                log('Save verification OK,', verifyBytes ? verifyBytes.length : 0, 'bytes');
            }
        } catch (error) {
            log('Save verification readback failed:', error && error.message ? error.message : error);
        }
    }

    const AUTOSAVE_DEBOUNCE_MS = 3000;
    const AUTOSAVE_FALLBACK_POLL_MS = 30000;
    let autosaveSyncing = false;
    let autosaveLastSignature = '';
    let autosaveDebounceTimer = null;

    async function autosaveSyncNow(reason) {
        if (autosaveSyncing) return;
        if (!currentKinPath) return;
        autosaveSyncing = true;
        try {
            const ctx = await getOnlyOfficeContext();
            const sourcePath = (ctx && ctx.filePath) ? String(ctx.filePath) : currentOnlyOfficePath;
            if (!sourcePath) return;

            const fingerprint = await getNextcloudFileFingerprint(sourcePath);
            const sig = fingerprint ? fingerprint.signature : '';
            if (sig && sig !== autosaveLastSignature) {
                log('Autosave (' + reason + '): syncing to', currentKinPath);
                await flushOnlyOfficeEdits(sourcePath);
                await saveNextcloudFileToKinPath(sourcePath, currentKinPath);
                autosaveLastSignature = sig;
                log('Autosave sync complete');
            }
        } catch (error) {
            log('Autosave sync error:', error && error.message ? error.message : error);
        } finally {
            autosaveSyncing = false;
        }
    }

    function scheduleAutosaveDebounce() {
        if (!currentKinPath) return;
        if (autosaveDebounceTimer) clearTimeout(autosaveDebounceTimer);
        autosaveDebounceTimer = setTimeout(function() {
            autosaveDebounceTimer = null;
            autosaveSyncNow('keydown-debounce');
        }, AUTOSAVE_DEBOUNCE_MS);
    }

    function startAutosavePolling() {
        if (autosavePollingInterval) return;
        if (!currentKinPath) return;

        log('Starting autosave (debounced keydown + fallback poll) for', currentKinPath);
        autosavePollingInterval = setInterval(function() {
            autosaveSyncNow('fallback-poll');
        }, AUTOSAVE_FALLBACK_POLL_MS);
    }

    function stopAutosavePolling() {
        if (autosavePollingInterval) {
            clearInterval(autosavePollingInterval);
            autosavePollingInterval = null;
        }
        if (autosaveDebounceTimer) {
            clearTimeout(autosaveDebounceTimer);
            autosaveDebounceTimer = null;
        }
        log('Stopped autosave');
    }

    function startBridgeHeartbeat() {
        if (bridgeHeartbeatInterval) return;
        bridgeHeartbeatInterval = setInterval(async function() {
            try {
                await bridgeRequest('kinBridgeGetStatus', {}, 5000);
                if (bridgeDead) {
                    bridgeDead = false;
                    bridgeHeartbeatFailures = 0;
                    log('Bridge heartbeat: reconnected');
                }
                bridgeHeartbeatFailures = 0;
            } catch (error) {
                bridgeHeartbeatFailures += 1;
                if (bridgeHeartbeatFailures >= 3 && !bridgeDead) {
                    bridgeDead = true;
                    log('Bridge heartbeat: bridge unreachable after', bridgeHeartbeatFailures, 'failures, scheduling re-handshake');
                    scheduleBridgeRehandshake();
                }
            }
        }, 60000);
        log('Started bridge heartbeat');
    }

    function stopBridgeHeartbeat() {
        if (bridgeHeartbeatInterval) {
            clearInterval(bridgeHeartbeatInterval);
            bridgeHeartbeatInterval = null;
        }
        if (bridgeRehandshakeTimer) {
            clearTimeout(bridgeRehandshakeTimer);
            bridgeRehandshakeTimer = null;
        }
        bridgeDead = false;
        bridgeHeartbeatFailures = 0;
        log('Stopped bridge heartbeat');
    }

    function scheduleBridgeRehandshake() {
        if (bridgeRehandshakeTimer) return;
        bridgeRehandshakeTimer = setTimeout(async function() {
            bridgeRehandshakeTimer = null;
            log('Bridge re-handshake attempt...');
            if (sendToBridge('kinBridgeHandshake')) {
                await waitMs(3000);
                if (bridgeDead) {
                    scheduleBridgeRehandshake();
                }
            } else {
                scheduleBridgeRehandshake();
            }
        }, 15000);
    }

    async function readKinFileBytes(kinPath) {
        const route = kinPathToFileRoute(kinPath);
        if (!route) {
            throw new Error('Open from this volume is not supported yet: ' + kinPath);
        }
        const separator = route.indexOf('?') === -1 ? '?' : '&';
        const noCacheRoute = route + separator + '_kin_ts=' + Date.now();
        const response = await fetch(noCacheRoute, {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: {
                'Cache-Control': 'no-cache',
                Pragma: 'no-cache'
            }
        });
        if (!response.ok) {
            throw new Error('Could not read Kin file (HTTP ' + response.status + ')');
        }
        const buffer = await response.arrayBuffer();
        return new Uint8Array(buffer);
    }

    function directSessionId() {
        return directSession && directSession.sessionId ? String(directSession.sessionId) : '';
    }

    function directEditorUrl(session) {
        const editorUrl = String(session && session.editorUrl ? session.editorUrl : '');
        if (!editorUrl) return '';
        const url = new URL(editorUrl, directOrigin);
        url.searchParams.set('api', directOrigin + '/direct/api');
        return url.toString();
    }

    async function createDirectSession(payload) {
        const response = await directPostJson('/session', payload);
        directSession = response;
        return response;
    }

    async function refreshDirectState() {
        const id = directSessionId();
        if (!id) return null;
        const response = await directFetchJson('/session/' + encodeURIComponent(id) + '/state');
        if (response && response.state) {
            directSession.state = response.state;
            directSession.version = response.state.version;
            directSession.info = response.info || directSession.info;
        }
        return response;
    }

    async function fetchDirectContent() {
        const id = directSessionId();
        if (!id) {
            throw new Error('No direct ONLYOFFICE session is active');
        }
        const response = await directFetchJson('/session/' + encodeURIComponent(id) + '/content');
        if (response && response.state) {
            directSession.state = response.state;
            directSession.version = response.state.version;
            directSession.info = response.info || directSession.info;
        }
        return base64ToBytes(response.data_base64 || '');
    }

    async function forceSaveDirectSession() {
        const id = directSessionId();
        if (!id) return;
        const beforeVersion = Number(directSession && directSession.version ? directSession.version : 0);
        try {
            await directPostJson('/session/' + encodeURIComponent(id) + '/forcesave', {});
        } catch (error) {
            log('Direct force-save failed; continuing with latest connector content:', error && error.message ? error.message : error);
        }
        for (let index = 0; index < 10; index += 1) {
            await waitMs(700);
            const stateResponse = await refreshDirectState();
            const state = stateResponse && stateResponse.state ? stateResponse.state : null;
            if (!state) continue;
            if (Number(state.version || 0) > beforeVersion || state.savePending === false) {
                return;
            }
        }
    }

    async function saveDirectSessionToKinPath(targetKinPath, options) {
        const saveOptions = options || {};
        if (!directSessionId()) {
            throw new Error('No direct ONLYOFFICE document is open');
        }
        if (!saveOptions.skipForceSave) {
            await forceSaveDirectSession();
        }
        const bytes = await fetchDirectContent();
        await writeKinBinaryFile(targetKinPath, bytes);
        currentKinPath = targetKinPath;
        if (directSession && directSession.info) {
            await writeKinOnlyOfficeInfo(targetKinPath, directSession.info);
        }
        requestWorkspaceRefresh();
    }

    async function syncDirectAutosaveToKin() {
        if (!directMode || directSyncing || !directSessionId()) return;
        directSyncing = true;
        try {
            const beforeVersion = Number(directSession && directSession.version ? directSession.version : 0);
            const stateResponse = await refreshDirectState();
            const state = stateResponse && stateResponse.state ? stateResponse.state : null;
            const nextVersion = Number(state && state.version ? state.version : 0);
            if (!currentKinPath) {
                if (nextVersion > beforeVersion) {
                    await promptDirectSaveAsForNewDocument('connector-save');
                }
                return;
            }
            if (nextVersion > beforeVersion) {
                await saveDirectSessionToKinPath(currentKinPath, { skipForceSave: true });
                log('Direct autosave synced version', nextVersion, 'to', currentKinPath);
            } else if (directSession && directSession.info) {
                await writeKinOnlyOfficeInfo(currentKinPath, directSession.info);
            }
        } catch (error) {
            log('Direct autosave sync failed:', error && error.message ? error.message : error);
        } finally {
            directSyncing = false;
        }
    }

    function startDirectStatePolling() {
        if (directStatePollingInterval) return;
        directStatePollingInterval = setInterval(function() {
            syncDirectAutosaveToKin();
        }, 4000);
    }

    function stopDirectStatePolling() {
        if (directStatePollingInterval) {
            clearInterval(directStatePollingInterval);
            directStatePollingInterval = null;
        }
    }

    async function openDirectEditor(session) {
        const url = directEditorUrl(session);
        if (!url) {
            throw new Error('Direct connector did not return an editor URL');
        }
        launchedTarget = true;
        iframeEl.src = url;
        startDirectStatePolling();
    }

    async function openDirectKinPath(kinPath) {
        const bytes = await readKinFileBytes(kinPath);
        const filename = kinPathBaseName(kinPath) || appConfig.defaultFilename;
        const fileType = fileTypeFromName(filename, appConfig.fileType);
        const info = await readKinOnlyOfficeInfo(kinPath);
        const session = await createDirectSession({
            filename,
            path: kinPath,
            file_type: fileType,
            data_base64: bytesToBase64(bytes),
            info
        });
        currentKinPath = kinPath;
        if (session.info) {
            await writeKinOnlyOfficeInfo(kinPath, session.info);
        }
        await openDirectEditor(session);
        return true;
    }

    async function openDirectBlankDocument() {
        const filename = appConfig.defaultFilename;
        const session = await createDirectSession({
            filename,
            file_type: appConfig.fileType
        });
        currentKinPath = null;
        await openDirectEditor(session);
    }

    async function directSaveAs(defaultName) {
        const targetKinPath = await requestFileDialog({
            mode: 'save',
            initialPath: dialogInitialPath,
            defaultFilename: defaultName || appConfig.defaultFilename
        });
        await withBusy('Saving to Kin path...', async function() {
            await saveDirectSessionToKinPath(targetKinPath);
        });
        await openAlert('Saved to ' + targetKinPath + '.', 'Saved');
    }

    async function promptDirectSaveAsForNewDocument(reason) {
        if (!directMode || currentKinPath || !directSessionId() || directSaveAsPromptOpen) return;
        const version = Number(directSession && directSession.version ? directSession.version : 0);
        if (version && directLastPromptedVersion === version) return;
        directSaveAsPromptOpen = true;
        directLastPromptedVersion = version;
        try {
            log('Prompting Save As for direct unsaved document:', reason || 'save');
            await directSaveAs(appConfig.defaultFilename);
        } catch (error) {
            if (!error || error.message !== 'cancel') {
                await openAlert(error && error.message ? error.message : String(error), 'Save failed');
            }
        } finally {
            directSaveAsPromptOpen = false;
        }
    }

    async function writeNextcloudFileBytes(nextcloudPath, bytes) {
        const response = await webDavRequest('PUT', nextcloudPath, {
            body: bytes,
            headers: {
                'Content-Type': 'application/octet-stream'
            },
            timeoutMs: 60000,
            retryCount: 2
        });
        if (!response || (response.status !== 201 && response.status !== 204)) {
            throw new Error('Could not upload file to Nextcloud (HTTP ' + (response ? response.status : 'unknown') + ')');
        }
    }

    async function importKinFileToNextcloud(kinPath) {
        const bytes = await readKinFileBytes(kinPath);
        const name = kinPathBaseName(kinPath) || ('Imported-' + Date.now() + '.bin');
        const safeName = name.replace(/[\\/]+/g, '_');
        const nextcloudPath = '/' + Date.now() + '-' + safeName;
        await writeNextcloudFileBytes(nextcloudPath, bytes);
        return nextcloudPath;
    }

    async function resolveFileId(nextcloudPath) {
        const body = [
            '<?xml version="1.0"?>',
            '<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">',
            '  <d:prop><oc:fileid/></d:prop>',
            '</d:propfind>'
        ].join('');
        const response = await webDavRequest('PROPFIND', nextcloudPath, {
            body,
            headers: {
                Depth: '0',
                'Content-Type': 'application/xml'
            }
        });
        if (response.status === 404) {
            throw new Error('File not found in Nextcloud: ' + nextcloudPath);
        }
        if (response.status < 200 || response.status >= 400) {
            throw new Error('WebDAV lookup failed (HTTP ' + response.status + ')');
        }
        const match = String(response.body || '').match(/<oc:fileid>(\d+)<\/oc:fileid>/i);
        if (!match) {
            throw new Error('Could not resolve Nextcloud file id for ' + nextcloudPath);
        }
        return match[1];
    }

    async function resolveFileIdWithRetry(nextcloudPath, attempts, delayMs) {
        const maxAttempts = typeof attempts === 'number' ? attempts : 5;
        const delay = typeof delayMs === 'number' ? delayMs : 400;
        let lastError = null;
        for (let index = 0; index < maxAttempts; index += 1) {
            try {
                return await resolveFileId(nextcloudPath);
            } catch (error) {
                lastError = error;
                if (index < maxAttempts - 1) {
                    await new Promise((resolve) => setTimeout(resolve, delay));
                }
            }
        }
        throw lastError || new Error('Could not resolve file id');
    }

    async function getOnlyOfficeContext() {
        const response = await bridgeRequest('kinBridgeGetOnlyOfficeContext', {});
        const context = response && response.context ? Object.assign({}, response.context, response) : response;
        if (context && context.filePath) {
            currentOnlyOfficePath = String(context.filePath);
        }
        return context;
    }

    async function openNextcloudPath(nextcloudPath) {
        const fileId = await resolveFileIdWithRetry(nextcloudPath, 8, 500);
        currentOnlyOfficePath = nextcloudPath;
        launchedTarget = true;
        sendToBridge('kinBridgeNavigate', {
            path: '/index.php/apps/onlyoffice/' + fileId + '?filePath=' + encodeURIComponent(nextcloudPath)
        });
        
        if (!currentKinPath) {
            setTimeout(async () => {
                await promptSaveToKin(nextcloudPath);
            }, 2000);
        }
    }
    
    async function promptSaveToKin(nextcloudPath) {
        const context = await getOnlyOfficeContext();
        if (!context || !context.filePath) return;
        if (currentKinPath) return;
        
        const fileName = splitNextcloudPath(nextcloudPath).name || 'Untitled';
        const shouldSave = confirm('Save this document to a Kin path?\n\nFile: ' + fileName + '\n\nChoose OK to save to Kin, or Cancel to keep in Nextcloud only.');
        if (shouldSave) {
            const targetKinPath = await requestFileDialog({
                mode: 'save',
                initialPath: dialogInitialPath,
                defaultFilename: fileName
            });
            if (targetKinPath) {
                const targetPath = toNextcloudPath(targetKinPath, nextcloudVolumeLabel);
                if (!targetPath) {
                    await withBusy('Saving to Kin path...', async function() {
                        await saveNextcloudFileToKinPath(nextcloudPath, targetKinPath);
                    });
                    currentKinPath = targetKinPath;
                    startAutosavePolling();
                    await openAlert('Saved to ' + targetKinPath + '.', 'Saved');
                }
            }
        }
    }

    async function openKinPath(kinPath) {
        if (directMode) {
            await openDirectKinPath(kinPath);
            return true;
        }

        const nextcloudPath = toNextcloudPath(kinPath, nextcloudVolumeLabel);
        if (nextcloudPath) {
            currentKinPath = kinPath;
            await openNextcloudPath(nextcloudPath);
            startAutosavePolling();
            return true;
        }

        const importedPath = await importKinFileToNextcloud(kinPath);
        currentKinPath = kinPath;
        await openNextcloudPath(importedPath);
        startAutosavePolling();
        return true;
    }

    async function copyNextcloudFile(sourcePath, targetPath) {
        const sourceWebDav = buildWebDavPath(sourcePath);
        const destinationWebDav = window.location.origin + buildWebDavPath(targetPath);
        const response = await webDavRequest('COPY', sourcePath, {
            path: sourceWebDav,
            headers: {
                Destination: destinationWebDav,
                Overwrite: 'T'
            }
        });
        if (response.status !== 201 && response.status !== 204) {
            throw new Error('Save As copy failed (HTTP ' + response.status + ')');
        }
    }

    async function handleMenuCommand(command) {
        if (command === MENU_LOGOUT_COMMAND) {
            stopBridgeHeartbeat();
            if (directMode) {
                stopDirectStatePolling();
                await openAlert('Direct ONLYOFFICE sessions are closed by closing the window.', 'OnlyOffice');
                return;
            }
            sendToBridge('kinBridgeLogout');
            return;
        }
        try {
            if (directMode) {
                if (command === MENU_OPEN_COMMAND) {
                    const kinPath = await requestFileDialog({ mode: 'load', initialPath: dialogInitialPath });
                    await withBusy('Opening document...', async function() {
                        await openDirectKinPath(kinPath);
                    });
                    return;
                }

                if (command === MENU_SAVE_COMMAND) {
                    if (!directSessionId()) {
                        await openAlert('Open a document first, then use Save.');
                        return;
                    }
                    if (!currentKinPath) {
                        await directSaveAs(appConfig.defaultFilename);
                        return;
                    }
                    await withBusy('Saving to Kin path...', async function() {
                        await saveDirectSessionToKinPath(currentKinPath);
                    });
                    return;
                }

                if (command === MENU_SAVE_AS_COMMAND) {
                    if (!directSessionId()) {
                        await openAlert('Open a document first, then use Save As.');
                        return;
                    }
                    const defaultName = currentKinPath ? kinPathBaseName(currentKinPath) : appConfig.defaultFilename;
                    await directSaveAs(defaultName);
                    return;
                }

                return;
            }

            if (command === MENU_OPEN_COMMAND) {
                const kinPath = await requestFileDialog({ mode: 'load', initialPath: dialogInitialPath });
                await withBusy('Opening document...', async function() {
                    await openKinPath(kinPath);
                });
                return;
            }

            if (command === MENU_STORAGE_CONNECT_COMMAND) {
                await connectNextcloudVolume();
                return;
            }

            if (command === MENU_STORAGE_STATUS_COMMAND) {
                await showNextcloudVolumeStatus();
                return;
            }

            if (command === MENU_STORAGE_DISCONNECT_COMMAND) {
                await disconnectNextcloudVolume();
                return;
            }

            if (command === MENU_SAVE_COMMAND) {
                const context = await getOnlyOfficeContext();
                const sourcePath = context && context.filePath ? String(context.filePath) : currentOnlyOfficePath;
                const currentKinIsExternal = currentKinPath && !toNextcloudPath(currentKinPath, nextcloudVolumeLabel);
                log('MENU_SAVE_COMMAND: sourcePath=', sourcePath, 'currentKinPath=', currentKinPath, 'currentKinIsExternal=', currentKinIsExternal);
                if (currentKinIsExternal && sourcePath) {
                    try {
                        await withBusy('Saving to Kin path...', async function() {
                            await saveNextcloudFileToKinPath(sourcePath, currentKinPath);
                        });
                    } catch (saveError) {
                        log('Save to Kin failed:', saveError && saveError.message ? saveError.message : saveError);
                        await openAlert('Save failed: ' + (saveError && saveError.message ? saveError.message : String(saveError)), 'Error');
                    }
                }
                return;
            }

            if (command === MENU_SAVE_AS_COMMAND) {
                const context = await getOnlyOfficeContext();
                const sourcePath = context && context.filePath ? String(context.filePath) : currentOnlyOfficePath;
                if (!sourcePath) {
                    await openAlert('Open a Nextcloud document first, then use Save As.');
                    return;
                }
                const defaultName = splitNextcloudPath(sourcePath).name || appConfig.defaultFilename;
                const targetKinPath = await requestFileDialog({
                    mode: 'save',
                    initialPath: dialogInitialPath,
                    defaultFilename: defaultName
                });
                const targetPath = toNextcloudPath(targetKinPath, nextcloudVolumeLabel);
                if (!targetPath) {
                    await withBusy('Saving to Kin path...', async function() {
                        await saveNextcloudFileToKinPath(sourcePath, targetKinPath);
                    });
                    currentKinPath = targetKinPath;
                    startAutosavePolling();
                    return;
                }
                await withBusy('Saving copy in Nextcloud...', async function() {
                    await copyNextcloudFile(sourcePath, targetPath);
                });
                currentKinPath = targetKinPath;
                startAutosavePolling();
                await withBusy('Opening saved file...', async function() {
                    await openNextcloudPath(targetPath);
                });
            }
        } catch (error) {
            if (error && error.message === 'cancel') return;
            await openAlert(error && error.message ? error.message : String(error));
        }
    }

    async function handleOnlyOfficeSaveAsRequest(data) {
        const saveData = data && data.saveData ? data.saveData : {};
        const defaultName = saveData.name || appConfig.defaultFilename;
        try {
            const targetKinPath = await requestFileDialog({
                mode: 'save',
                initialPath: dialogInitialPath,
                defaultFilename: defaultName
            });
            const targetPath = toNextcloudPath(targetKinPath, nextcloudVolumeLabel);
            log('Save As: targetKinPath=', targetKinPath, 'targetPath=', targetPath);
            if (!targetPath) {
                const context = await getOnlyOfficeContext();
                const sourcePath = context && context.filePath ? String(context.filePath) : currentOnlyOfficePath;
                if (!sourcePath) {
                    await openAlert('Open a Nextcloud document first, then use Save As.');
                    return;
                }
                log('Save As to Kin: sourcePath=', sourcePath, 'targetKinPath=', targetKinPath);
                await withBusy('Saving to Kin path...', async function() {
                    await saveNextcloudFileToKinPath(sourcePath, targetKinPath);
                });
                currentKinPath = targetKinPath;
                startAutosavePolling();
                return;
            }
            const split = splitNextcloudPath(targetPath);
            if (!split.name || !saveData.url) {
                await openAlert('OnlyOffice Save As payload is incomplete.');
                return;
            }
            const saveResult = await withBusy('Saving in Nextcloud...', async function() {
                return await bridgeRequest('kinBridgeOnlyOfficeSaveAs', {
                    saveData: {
                        name: split.name,
                        dir: split.dir,
                        url: saveData.url
                    }
                });
            });
            if (saveResult && saveResult.ok === false) {
                throw new Error(saveResult.error || 'OnlyOffice Save As failed');
            }
            await withBusy('Opening saved file...', async function() {
                await openNextcloudPath(targetPath);
            });
        } catch (error) {
            if (error && error.message === 'cancel') return;
            await openAlert(error && error.message ? error.message : String(error));
        }
    }

    async function handleDirectOnlyOfficeEvent(data) {
        if (!directMode || !data) return;
        if (data.sessionId && directSessionId() && String(data.sessionId) !== directSessionId()) {
            return;
        }
        if (data.event === 'ready') {
            await refreshDirectState().catch(function(error) {
                log('Direct state refresh failed:', error && error.message ? error.message : error);
            });
            return;
        }
        if (data.event === 'documentStateChange') {
            syncDirectAutosaveToKin();
            return;
        }
        if (data.event === 'editorKeydown') {
            const key = String(data.key || '').toLowerCase();
            if ((data.ctrlKey || data.metaKey) && key === 's' && !currentKinPath) {
                await promptDirectSaveAsForNewDocument('keyboard-save');
            } else {
                syncDirectAutosaveToKin();
            }
            return;
        }
        if (data.event === 'requestSaveAs') {
            const saveData = data.saveData || {};
            try {
                await directSaveAs(saveData.name || (currentKinPath ? kinPathBaseName(currentKinPath) : appConfig.defaultFilename));
            } catch (error) {
                if (!error || error.message !== 'cancel') {
                    await openAlert(error && error.message ? error.message : String(error), 'Save failed');
                }
            }
            return;
        }
        if (data.event === 'error') {
            log('Direct editor error:', data.error || 'unknown error');
        }
    }

    async function openTargetWhenReady(status) {
        if (!status || !status.isLoggedIn || launchedTarget || launchInProgress) {
            return;
        }
        launchInProgress = true;

        try {
            bridgeUser = status.currentUser || bridgeUser;

            const currentUrl = status.url || '';
            if (currentUrl.indexOf('/index.php/apps/onlyoffice/') !== -1) {
                launchedTarget = true;
                return;
            }

            if (kinOpenPath && !kinOpenPathAttempted) {
                kinOpenPathAttempted = true;
                try {
                    const opened = await openKinPath(kinOpenPath);
                    if (opened) {
                        return;
                    }
                } catch (error) {
                    log('Failed to open kin_open_path:', error && error.message ? error.message : error);
                    await openAlert('Could not open requested file:\n' + (error && error.message ? error.message : String(error)), 'Open failed');
                }
            }

            launchedTarget = true;
            sendToBridge('kinBridgeNavigate', { path: appConfig.targetPath });
        } finally {
            launchInProgress = false;
        }
    }

    async function handleBridgeMessage(data) {
        if (data.requestId) {
            if (data.type === 'kinBridgeError') {
                const consumed = settlePendingBridgeRequest(data.requestId, (pending) => {
                    pending.reject(new Error(data.error || 'Bridge request failed'));
                });
                if (consumed) return;
            }
            if (
                data.type === 'kinBridgeWebDAVResponse' ||
                data.type === 'kinBridgeOnlyOfficeContext' ||
                data.type === 'kinBridgeOnlyOfficeSaveAsResult' ||
                data.type === 'kinBridgeOnlyOfficeForceSaveResult'
            ) {
                const consumed = settlePendingBridgeRequest(data.requestId, (pending) => {
                    pending.resolve(data);
                });
                if (consumed) return;
            }
        }

        switch (data.type) {
            case 'kinBridgeReady':
            case 'kinBridgeHandshakeResponse':
            case 'kinBridgeStatus':
            case 'kinBridgeStatusChange':
                if (data.isLoggedIn) {
                    loginInProgress = false;
                    bridgeUser = data.currentUser || bridgeUser;
                    bridgeDead = false;
                    bridgeHeartbeatFailures = 0;
                    startBridgeHeartbeat();
                    await openTargetWhenReady(data);
                } else if (data.isLoginPage && !loginInProgress) {
                    loginInProgress = true;
                    sendToBridge('kinBridgeLogin');
                } else {
                    log('Bridge reports not logged in outside login page; waiting for page transition', data.url || '');
                }
                break;

            case 'kinBridgeOnlyOfficeRequestSaveAs':
                await handleOnlyOfficeSaveAsRequest(data);
                break;

            case 'kinBridgeEditorKeydown':
                scheduleAutosaveDebounce();
                break;

            case 'kinBridgeOpenWindow':
                window.parent.postMessage({ kinOpenWindow: true, url: data.url, target: data.target }, ORIGIN);
                break;

            case 'kinBridgeError':
                loginInProgress = false;
                log('Bridge error:', data.error, 'action:', data.action);
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

        if (data.type === 'kinDirectOnlyOfficeEvent') {
            handleDirectOnlyOfficeEvent(data);
            return;
        }

        if (data.type && data.type.indexOf('kinBridge') === 0) {
            handleBridgeMessage(data);
        }
    });

    registerMenus();
    if (directMode) {
        if (kinOpenPath) {
            withBusy('Opening document...', async function() {
                await openDirectKinPath(kinOpenPath);
            }).catch(function(error) {
                openAlert('Could not open requested file:\n' + (error && error.message ? error.message : String(error)), 'Open failed');
            });
        } else {
            withBusy('Creating document...', async function() {
                await openDirectBlankDocument();
            }).catch(function(error) {
                openAlert('Could not create document:\n' + (error && error.message ? error.message : String(error)), 'Open failed');
            });
        }
    } else {
        iframeEl.onload = function() {
            sendToBridge('kinBridgeHandshake');
            sendToBridge('kinBridgeGetStatus');
        };

        var initialPath = kinOpenPath ? '/index.php/apps/dashboard/' : appConfig.targetPath;
        iframeEl.src = NEXTCLOUD_ORIGIN + initialPath;
    }
}

function getInstanceId() {
    try {
        const url = new URL(window.location.href);
        return url.searchParams.get('kin_app_instance') || '';
    } catch (_error) {
        return '';
    }
}

function trimTrailingSlash(value) {
    return String(value || '').replace(/\/+$/, '');
}

function resolveNextcloudOrigin(params) {
    const originOverride = params.get('nextcloud_origin') || params.get('nextcloudOrigin');
    if (originOverride) {
        return trimTrailingSlash(originOverride);
    }

    const hostOverride = params.get('nextcloud_host') || params.get('nextcloudHost');
    if (hostOverride) {
        const port = params.get('nextcloud_port') || params.get('nextcloudPort') || '443';
        return 'https://' + hostOverride + ':' + port;
    }

    try {
        localStorage.removeItem('kin.nextcloud.host');
    } catch (_error) {
        // ignore storage failures
    }

    return trimTrailingSlash(window.location.origin) + '/kin-office';
}
