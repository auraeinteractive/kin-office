const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function isLoopbackHost(host) {
    return LOOPBACK_HOSTS.has((host || '').toLowerCase());
}

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

function kinPathToFileRoute(path) {
    const parsed = parseKinPath(path);
    if (!parsed) return null;
    const volume = String(parsed.volume || '').toLowerCase();
    if (volume !== 'home' && volume !== 'system') {
        return null;
    }
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

export function bootstrapOnlyOfficeApp(config) {
    const appConfig = Object.assign({
        appTag: 'kinonlyoffice',
        targetPath: '/index.php/apps/onlyoffice/new?name=New%20document.docx&dir=%2F',
        menuPrefix: 'onlyoffice.app',
        defaultFilename: 'Document.docx'
    }, config || {});

    const iframeEl = document.getElementById('iframe');
    if (!iframeEl) {
        throw new Error('Missing #iframe element');
    }

    const ORIGIN = window.location.origin;
    const params = new URLSearchParams(window.location.search);
    const nextcloudHost = resolveNextcloudHost(params);
    const nextcloudVolumeLabel = normalizeVolumeLabel(params.get('kin_nextcloud_volume') || params.get('nextcloud_volume') || 'Nextcloud');
    const nextcloudAssignTarget = String(params.get('kin_nextcloud_assign_target') || 'Home:.Mounts/nextcloud');
    const dialogInitialPath = 'Mountlist:';
    const kinOpenPath = params.get('kin_open_path') || params.get('path') || '';
    const NEXTCLOUD_ORIGIN = 'https://' + nextcloudHost + ':5002';

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
    let bridgeUser = null;
    let currentOnlyOfficePath = null;
    let currentKinPath = null;

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
        postToParent({
            kinAppRegisterMenus: true,
            instanceId,
            menus: {
                File: [
                    { name: 'Open...', command: MENU_OPEN_COMMAND },
                    { name: 'Save', command: MENU_SAVE_COMMAND },
                    { name: 'Save As...', command: MENU_SAVE_AS_COMMAND },
                    { name: 'Log out', command: MENU_LOGOUT_COMMAND }
                ],
                Storage: [
                    { name: 'Connect Nextcloud volume', command: MENU_STORAGE_CONNECT_COMMAND },
                    { name: 'Nextcloud volume status', command: MENU_STORAGE_STATUS_COMMAND },
                    { name: 'Disconnect Nextcloud volume', command: MENU_STORAGE_DISCONNECT_COMMAND }
                ]
            }
        });
    }

    function sendToBridge(type, payload) {
        try {
            iframeEl.contentWindow.postMessage(Object.assign({ type }, payload || {}), '*');
        } catch (error) {
            log('Bridge send failed:', error);
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
            sendToBridge(type, Object.assign({}, payload || {}, { requestId: reqId }));
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
            throw new Error((json && json.message) ? String(json.message) : ('HTTP ' + response.status));
        }
        return json || {};
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
        await ensureNextcloudAssign();
        requestWorkspaceRefresh();
        await showNextcloudVolumeStatus();
    }

    async function disconnectNextcloudVolume() {
        await runAssignCommand('remove');
        requestWorkspaceRefresh();
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
        const response = await bridgeRequest('kinBridgeWebDAV', {
            method,
            path,
            body: requestOptions.body || null,
            headers: requestOptions.headers || {},
            responseType: requestOptions.responseType || 'text'
        });
        return response;
    }

    async function readNextcloudFileBytes(nextcloudPath) {
        const response = await webDavRequest('GET', nextcloudPath, { responseType: 'base64' });
        if (!response || response.status < 200 || response.status >= 300) {
            throw new Error('Could not read Nextcloud file (HTTP ' + (response ? response.status : 'unknown') + ')');
        }
        return base64ToBytes(response.bodyBase64 || '');
    }

    async function writeKinBinaryFile(kinPath, bytes) {
        const response = await apiPostJson('/api/file/write_binary', {
            path: String(kinPath || ''),
            data_base64: bytesToBase64(bytes)
        });
        if (!response || response.response !== 'success') {
            throw new Error((response && response.message) ? String(response.message) : 'Could not write file to Kin path');
        }
    }

    async function saveNextcloudFileToKinPath(sourceNextcloudPath, targetKinPath) {
        const bytes = await readNextcloudFileBytes(sourceNextcloudPath);
        await writeKinBinaryFile(targetKinPath, bytes);
    }

    async function readKinFileBytes(kinPath) {
        const route = kinPathToFileRoute(kinPath);
        if (!route) {
            throw new Error('Open from this volume is not supported yet: ' + kinPath);
        }
        const response = await fetch(route, {
            method: 'GET',
            credentials: 'same-origin'
        });
        if (!response.ok) {
            throw new Error('Could not read Kin file (HTTP ' + response.status + ')');
        }
        const buffer = await response.arrayBuffer();
        return new Uint8Array(buffer);
    }

    async function ensureNextcloudImportDir() {
        const response = await webDavRequest('MKCOL', '/.KinImports', {
            headers: {
                'Content-Type': 'application/xml'
            }
        });
        if (!response) return;
        if (response.status === 201 || response.status === 405 || response.status === 301 || response.status === 302) return;
        if (response.status >= 200 && response.status < 300) return;
        if (response.status === 409) return;
        throw new Error('Could not prepare Nextcloud import folder (HTTP ' + response.status + ')');
    }

    async function writeNextcloudFileBytes(nextcloudPath, bytes) {
        const response = await webDavRequest('PUT', nextcloudPath, {
            body: bytes,
            headers: {
                'Content-Type': 'application/octet-stream'
            }
        });
        if (!response || (response.status !== 201 && response.status !== 204)) {
            throw new Error('Could not upload file to Nextcloud (HTTP ' + (response ? response.status : 'unknown') + ')');
        }
    }

    async function importKinFileToNextcloud(kinPath) {
        const bytes = await readKinFileBytes(kinPath);
        await ensureNextcloudImportDir();
        const name = kinPathBaseName(kinPath) || ('Imported-' + Date.now() + '.bin');
        const nextcloudPath = '/.KinImports/' + Date.now() + '-' + name;
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
            path: '/index.php/apps/onlyoffice/' + fileId + '?filePath=' + encodeURIComponent(nextcloudPath) + '&inframe=true'
        });
    }

    async function openKinPath(kinPath) {
        const nextcloudPath = toNextcloudPath(kinPath, nextcloudVolumeLabel);
        if (nextcloudPath) {
            currentKinPath = kinPath;
            await openNextcloudPath(nextcloudPath);
            return true;
        }

        const importedPath = await importKinFileToNextcloud(kinPath);
        currentKinPath = kinPath;
        await openNextcloudPath(importedPath);
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
            sendToBridge('kinBridgeLogout');
            return;
        }
        try {
            if (command === MENU_OPEN_COMMAND) {
                const kinPath = await requestFileDialog({ mode: 'load', initialPath: dialogInitialPath });
                await openKinPath(kinPath);
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
                if (currentKinIsExternal && sourcePath) {
                    await saveNextcloudFileToKinPath(sourcePath, currentKinPath);
                    await openAlert('Saved to ' + currentKinPath + '.', 'Saved');
                } else if (context && context.filePath) {
                    await openAlert('OnlyOffice autosaves this document in Nextcloud.\n\nCurrent file: ' + context.filePath, 'Saved');
                } else {
                    await openAlert('OnlyOffice autosaves documents after they are opened.');
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
                    await saveNextcloudFileToKinPath(sourcePath, targetKinPath);
                    currentKinPath = targetKinPath;
                    await openAlert('Saved to ' + targetKinPath + '.', 'Save As');
                    return;
                }
                await copyNextcloudFile(sourcePath, targetPath);
                currentKinPath = targetKinPath;
                await openNextcloudPath(targetPath);
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
            if (!targetPath) {
                const context = await getOnlyOfficeContext();
                const sourcePath = context && context.filePath ? String(context.filePath) : currentOnlyOfficePath;
                if (!sourcePath) {
                    await openAlert('Open a Nextcloud document first, then use Save As.');
                    return;
                }
                await saveNextcloudFileToKinPath(sourcePath, targetKinPath);
                currentKinPath = targetKinPath;
                await openAlert('Saved to ' + targetKinPath + '.', 'Save As');
                return;
            }
            const split = splitNextcloudPath(targetPath);
            if (!split.name || !saveData.url) {
                await openAlert('OnlyOffice Save As payload is incomplete.');
                return;
            }
            const saveResult = await bridgeRequest('kinBridgeOnlyOfficeSaveAs', {
                saveData: {
                    name: split.name,
                    dir: split.dir,
                    url: saveData.url
                }
            });
            if (saveResult && saveResult.ok === false) {
                throw new Error(saveResult.error || 'OnlyOffice Save As failed');
            }
            await openNextcloudPath(targetPath);
        } catch (error) {
            if (error && error.message === 'cancel') return;
            await openAlert(error && error.message ? error.message : String(error));
        }
    }

    async function openTargetWhenReady(status) {
        if (!status || !status.isLoggedIn || launchedTarget) {
            return;
        }

        bridgeUser = status.currentUser || bridgeUser;

        const currentUrl = status.url || '';
        if (currentUrl.indexOf('/index.php/apps/onlyoffice/') !== -1) {
            launchedTarget = true;
            return;
        }

        if (kinOpenPath) {
            try {
                const opened = await openKinPath(kinOpenPath);
                if (opened) {
                    return;
                }
            } catch (error) {
                log('Failed to open kin_open_path:', error && error.message ? error.message : error);
            }
        }

        launchedTarget = true;
        sendToBridge('kinBridgeNavigate', { path: appConfig.targetPath });
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
                data.type === 'kinBridgeOnlyOfficeSaveAsResult'
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
                    await openTargetWhenReady(data);
                } else if (!loginInProgress) {
                    loginInProgress = true;
                    sendToBridge('kinBridgeLogin', {
                        username: 'admin',
                        password: 'admin123'
                    });
                }
                break;

            case 'kinBridgeOnlyOfficeRequestSaveAs':
                await handleOnlyOfficeSaveAsRequest(data);
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

        if (data.type && data.type.indexOf('kinBridge') === 0) {
            handleBridgeMessage(data);
        }
    });

    iframeEl.onload = function() {
        sendToBridge('kinBridgeHandshake');
        sendToBridge('kinBridgeGetStatus');
    };

    registerMenus();
    iframeEl.src = NEXTCLOUD_ORIGIN + appConfig.targetPath;
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

    try {
        localStorage.removeItem('kin.nextcloud.host');
    } catch (_error) {
        // ignore storage failures
    }

    if (!isLoopbackHost(window.location.hostname)) {
        return window.location.hostname;
    }

    return window.location.hostname;
}
