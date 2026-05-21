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

function requestId(prefix) {
    return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
}

/** Upper bound for blank OOXML templates from direct-connector (with margin). */
const OFFICE_SKELETON_MAX = { docx: 1200, xlsx: 1900, pptx: 7500 };
const DIRECT_FLUSH_POLL_MS = 500;
const DIRECT_FLUSH_MAX_POLLS = 20;
const DIRECT_SAVE_SYNC_POLLS = 30;
const DIRECT_SAVE_SYNC_POLL_MS = 400;
const DIRECT_POLL_IDLE_MS = 4000;
const DIRECT_POLL_PENDING_MS = 500;
const DIRECT_REFRESH_DEBOUNCE_MS = 300;
/** Match Kin http.service KIN_HTTP_STAGE_THRESHOLD — use upload API for larger binary writes. */
const KIN_WRITE_UPLOAD_THRESHOLD = 16 * 1024;

function isZipLocalHeader(bytes) {
    return bytes && bytes.length >= 4 &&
        bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function kinTempPartPath(kinPath) {
    return String(kinPath || '').trim() + '.kinpart';
}

function validateOfficeBytes(bytes, fileType, options) {
    const opts = options || {};
    const ft = fileType || 'docx';
    if (!bytes || !bytes.length) {
        throw new Error('File is empty');
    }
    if (!isZipLocalHeader(bytes)) {
        throw new Error('File is not a valid Office document (missing ZIP header)');
    }
    const skeletonMax = OFFICE_SKELETON_MAX[ft] || OFFICE_SKELETON_MAX.docx;
    const existingSize = typeof opts.existingSize === 'number' ? opts.existingSize : null;
    if (existingSize != null && existingSize > skeletonMax) {
        if (bytes.length <= skeletonMax) {
            throw new Error('Refusing to overwrite document with blank template');
        }
        if (bytes.length < Math.floor(existingSize * 0.9)) {
            throw new Error('Refusing to overwrite document with much smaller file');
        }
    }
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
        menuPrefix: 'onlyoffice.app',
        defaultFilename: 'Document.docx',
        fileType: 'docx'
    }, config || {});

    const iframeEl = ensureOnlyOfficeIframeShell();

    const ORIGIN = window.location.origin;
    const params = new URLSearchParams(window.location.search);
    const KIN_OFFICE_BASE = resolveKinOfficeBase(params);
    const dialogInitialPath = 'Mountlist:';
    const kinOpenPath = params.get('kin_open_path') || params.get('path') || '';
    const directOrigin = String(
        params.get('onlyoffice_direct_origin') ||
        params.get('kin_onlyoffice_direct_origin') ||
        params.get('kin_office_base') ||
        KIN_OFFICE_BASE
    ).replace(/\/+$/, '');
    const directApiBase = directOrigin + '/direct/api';

    const MENU_OPEN_COMMAND = appConfig.menuPrefix + '.open';
    const MENU_SAVE_COMMAND = appConfig.menuPrefix + '.save';
    const MENU_SAVE_AS_COMMAND = appConfig.menuPrefix + '.saveAs';
    const MENU_LOGOUT_COMMAND = appConfig.menuPrefix + '.logout';

    let currentKinPath = null;
    let directSession = null;
    let directStatePollingInterval = null;
    let directSyncing = false;
    let directSaveAsPromptOpen = false;
    let directLastPromptedVersion = 0;
    let directLastPersistedVersion = 0;
    let directRefreshDebounceTimer = null;

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
        postToParent({
            kinAppRegisterMenus: true,
            instanceId,
            menus
        });
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

    function waitMs(duration) {
        return new Promise((resolve) => setTimeout(resolve, duration));
    }

    async function apiKinCommand(command, fields) {
        const params = new URLSearchParams();
        const formFields = fields || {};
        Object.keys(formFields).forEach(function(key) {
            params.set(key, String(formFields[key] || ''));
        });
        const response = await fetch('/api/commands/' + encodeURIComponent(command), {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                Accept: 'application/json'
            },
            body: params.toString()
        });
        const json = await response.json().catch(function() { return null; });
        if (!response.ok || !json || json.response !== 'success') {
            throw new Error((json && json.message) ? String(json.message) : ('Command ' + command + ' failed'));
        }
        return json;
    }

    async function kinFileStatOnDisk(kinPath) {
        try {
            const bytes = await readKinFileBytes(kinPath);
            return { exists: true, size: bytes.length };
        } catch (_error) {
            return { exists: false, size: 0 };
        }
    }

    async function uploadKinFileBytes(kinPath, bytes) {
        const path = String(kinPath || '');
        const name = kinPathBaseName(path) || 'file.bin';
        const size = bytes ? bytes.length : 0;
        let uploadId = null;
        try {
            const beginResult = await apiPostJson('/api/file/upload_begin', { path, name, size });
            if (!beginResult || beginResult.response !== 'success' || !beginResult.upload_id) {
                throw new Error((beginResult && beginResult.message) ? String(beginResult.message) : 'Upload begin failed');
            }
            uploadId = beginResult.upload_id;
            const chunkSize = Math.max(256 * 1024, Math.min(beginResult.chunk_size || (8 * 1024 * 1024), 16 * 1024 * 1024));
            let offset = Number(beginResult.offset || 0);
            while (offset < size) {
                const end = Math.min(offset + chunkSize, size);
                const chunk = bytes.subarray(offset, end);
                const res = await fetch(
                    '/api/file/upload_chunk?upload_id=' + encodeURIComponent(uploadId) +
                    '&offset=' + encodeURIComponent(String(offset)),
                    {
                        method: 'POST',
                        credentials: 'same-origin',
                        headers: { 'Content-Type': 'application/octet-stream', Accept: 'application/json' },
                        body: chunk
                    }
                );
                const json = await res.json().catch(function() { return null; });
                if (!res.ok || !json || json.response !== 'success') {
                    throw new Error((json && json.message) ? String(json.message) : 'Chunk upload failed');
                }
                offset = Number(json.offset != null ? json.offset : end);
            }
            const finishResult = await apiPostJson('/api/file/upload_finish', { upload_id: uploadId });
            uploadId = null;
            return finishResult;
        } catch (uploadError) {
            if (uploadId) {
                fetch('/api/file/upload_abort', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ upload_id: uploadId })
                }).catch(function() {});
            }
            throw uploadError;
        }
    }

    async function writeKinFileBytes(kinPath, bytes) {
        const byteLen = bytes ? bytes.length : 0;
        log('writeKinFileBytes: path=', kinPath, 'bytes=', byteLen);
        let response;
        if (byteLen >= KIN_WRITE_UPLOAD_THRESHOLD) {
            response = await uploadKinFileBytes(kinPath, bytes);
        } else {
            response = await apiPostJson('/api/file/write', {
                path: String(kinPath || ''),
                data: bytesToBase64(bytes)
            });
        }
        log('writeKinFileBytes response:', response);
        if (!response || response.response !== 'success') {
            throw new Error((response && response.message) ? String(response.message) : 'Could not write file to Kin path');
        }
    }

    async function writeKinFileBytesSafe(targetKinPath, bytes, fileType) {
        const ft = fileType || fileTypeFromName(kinPathBaseName(targetKinPath), appConfig.fileType);
        const stat = await kinFileStatOnDisk(targetKinPath);
        validateOfficeBytes(bytes, ft, { existingSize: stat.exists ? stat.size : null });

        const tempPath = kinTempPartPath(targetKinPath);
        await writeKinFileBytes(tempPath, bytes);

        const readback = await readKinFileBytes(tempPath);
        if (!readback || readback.length !== bytes.length) {
            try {
                await apiKinCommand('delete', { path: tempPath, mode: 'PERM' });
            } catch (_error) {
                // ignore cleanup failure
            }
            throw new Error('Save verification failed (temp readback length mismatch)');
        }

        try {
            await apiKinCommand('move', { from: tempPath, to: targetKinPath });
        } catch (moveError) {
            try {
                await apiKinCommand('delete', { path: tempPath, mode: 'PERM' });
            } catch (_error) {
                // ignore cleanup failure
            }
            throw moveError;
        }
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

    function directSessionState() {
        return directSession && directSession.state ? directSession.state : null;
    }

    function directSessionVersion() {
        const state = directSessionState();
        if (state && state.version != null) {
            return Number(state.version);
        }
        return Number(directSession && directSession.version != null ? directSession.version : 0);
    }

    function directSessionSavePending() {
        const state = directSessionState();
        return !!(state && state.savePending);
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

    async function ensureDirectSessionFlushed() {
        const id = directSessionId();
        if (!id) return;

        const stateResponse = await refreshDirectState();
        const state = stateResponse && stateResponse.state ? stateResponse.state : null;
        if (!state) {
            throw new Error('Save blocked: could not read editor session state');
        }

        const version = Number(state.version || 0);
        const savePending = !!state.savePending;
        if (version > directLastPersistedVersion && !savePending) {
            return;
        }

        const beforeVersion = version;
        try {
            const forceResult = await directPostJson('/session/' + encodeURIComponent(id) + '/forcesave', {});
            if (!forceResult || forceResult.accepted !== true) {
                log('Direct force-save was not accepted by Document Server', forceResult && forceResult.body ? forceResult.body : '');
            }
        } catch (error) {
            log('Direct force-save request failed:', error && error.message ? error.message : error);
        }

        for (let index = 0; index < DIRECT_FLUSH_MAX_POLLS; index += 1) {
            await waitMs(DIRECT_FLUSH_POLL_MS);
            const polled = await refreshDirectState();
            const polledState = polled && polled.state ? polled.state : null;
            if (!polledState) continue;
            const nextVersion = Number(polledState.version || 0);
            if (nextVersion > beforeVersion && polledState.savePending === false) {
                return;
            }
        }
        throw new Error('Save blocked: document not ready from editor');
    }

    async function saveDirectSessionToKinPath(targetKinPath) {
        if (!directSessionId()) {
            throw new Error('No direct ONLYOFFICE document is open');
        }
        await ensureDirectSessionFlushed();
        const bytes = await fetchDirectContent();
        const ft = fileTypeFromName(kinPathBaseName(targetKinPath), appConfig.fileType);
        await writeKinFileBytesSafe(targetKinPath, bytes, ft);
        currentKinPath = targetKinPath;
        directLastPersistedVersion = Number(directSession && directSession.version ? directSession.version : directLastPersistedVersion);
        if (directSession && directSession.info) {
            writeKinOnlyOfficeInfo(targetKinPath, directSession.info).catch(function(err) {
                log('writeKinOnlyOfficeInfo (save) failed:', err && err.message ? err.message : err);
            });
        }
        requestWorkspaceRefresh();
    }

    async function syncDirectAutosaveToKin() {
        if (directSyncing || !directSessionId()) return;
        directSyncing = true;
        try {
            const beforeVersion = directSessionVersion();
            const stateResponse = await refreshDirectState();
            const nextVersion = directSessionVersion();
            const savePending = directSessionSavePending();
            if (!currentKinPath) {
                if (nextVersion > beforeVersion && !savePending) {
                    await promptDirectSaveAsForNewDocument('connector-save');
                }
                return;
            }
            if (nextVersion > beforeVersion && !savePending) {
                await saveDirectSessionToKinPath(currentKinPath);
                log('Direct autosave synced version', nextVersion, 'to', currentKinPath);
            } else if (directSession && directSession.info) {
                writeKinOnlyOfficeInfo(currentKinPath, directSession.info).catch(function(err) {
                    log('writeKinOnlyOfficeInfo (autosave) failed:', err && err.message ? err.message : err);
                });
            }
        } catch (error) {
            log('Direct autosave sync failed:', error && error.message ? error.message : error);
        } finally {
            directSyncing = false;
        }
    }

    async function syncAfterEditorReportedSaved() {
        const persistedBefore = directLastPersistedVersion;

        async function trySyncFromConnector() {
            const version = directSessionVersion();
            if (version > persistedBefore && !directSessionSavePending()) {
                await syncDirectAutosaveToKin();
                return true;
            }
            return false;
        }

        for (let index = 0; index < DIRECT_SAVE_SYNC_POLLS; index += 1) {
            if (index > 0) {
                await waitMs(DIRECT_SAVE_SYNC_POLL_MS);
            }
            await refreshDirectState();
            if (await trySyncFromConnector()) {
                return;
            }
        }

        log('Direct save: connector version did not advance; requesting Document Server force-save...');
        try {
            await ensureDirectSessionFlushed();
        } catch (error) {
            const state = directSessionState() || {};
            const callbackHint = state.lastCallbackStatus != null
                ? (' last callback status ' + state.lastCallbackStatus)
                : '';
            const message = (error && error.message ? error.message : String(error)) + callbackHint;
            log('Editor reported saved but Kin could not confirm connector save:', message);
            if (currentKinPath) {
                await openAlert(
                    'ONLYOFFICE reported saved, but the file on Kin was not updated.\n\n' +
                    message +
                    '\n\nUse File → Save to retry. Server logs: journalctl -u kin-office | grep direct-connector',
                    'Save failed'
                );
            }
            return;
        }

        await refreshDirectState();
        if (await trySyncFromConnector()) {
            return;
        }

        log('Editor reported saved but connector session version did not advance (check onlyoffice-direct logs)');
        if (currentKinPath) {
            await openAlert(
                'ONLYOFFICE reported saved, but Kin did not receive the updated document.\n\n' +
                'Use File → Save to retry.',
                'Save failed'
            );
        }
    }


    function updateDirectPollInterval() {
        if (directStatePollingInterval) {
            clearInterval(directStatePollingInterval);
            directStatePollingInterval = null;
        }
        const ms = directSessionSavePending() ? DIRECT_POLL_PENDING_MS : DIRECT_POLL_IDLE_MS;
        directStatePollingInterval = setInterval(function() {
            syncDirectAutosaveToKin();
        }, ms);
    }

    function scheduleDirectRefreshDebounce() {
        if (directRefreshDebounceTimer) clearTimeout(directRefreshDebounceTimer);
        directRefreshDebounceTimer = setTimeout(function() {
            directRefreshDebounceTimer = null;
            refreshDirectState().then(function() {
                updateDirectPollInterval();
                syncDirectAutosaveToKin();
            }).catch(function(err) {
                log('Debounced refresh failed:', err && err.message ? err.message : err);
            });
        }, DIRECT_REFRESH_DEBOUNCE_MS);
    }

    function startDirectStatePolling() {
        if (directStatePollingInterval) return;
        updateDirectPollInterval();
    }

    function stopDirectStatePolling() {
        if (directStatePollingInterval) {
            clearInterval(directStatePollingInterval);
            directStatePollingInterval = null;
        }
        if (directRefreshDebounceTimer) {
            clearTimeout(directRefreshDebounceTimer);
            directRefreshDebounceTimer = null;
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
        const ft = fileTypeFromName(kinPathBaseName(kinPath), appConfig.fileType);
        validateOfficeBytes(bytes, ft, {});
        const filename = kinPathBaseName(kinPath) || appConfig.defaultFilename;
        const fileType = fileTypeFromName(filename, appConfig.fileType);
        const session = await createDirectSession({
            filename,
            path: kinPath,
            file_type: fileType,
            data_base64: bytesToBase64(bytes),
            reloadFromDisk: true
        });
        currentKinPath = kinPath;
        directLastPersistedVersion = Number(session && session.version ? session.version : 1);
        if (session.info) {
            writeKinOnlyOfficeInfo(kinPath, session.info).catch(function(err) {
                log('writeKinOnlyOfficeInfo (open) failed:', err && err.message ? err.message : err);
            });
        }
        await openDirectEditor(session);
        return true;
    }

    async function openDirectBlankDocument() {
        const filename = appConfig.defaultFilename;
        const session = await createDirectSession({
            filename,
            file_type: appConfig.fileType,
            reloadFromDisk: true
        });
        currentKinPath = null;
        directLastPersistedVersion = Number(session && session.version ? session.version : 1);
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
        if (currentKinPath || !directSessionId() || directSaveAsPromptOpen) return;
        const version = directSessionVersion();
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

    async function handleMenuCommand(command) {
        if (command === MENU_LOGOUT_COMMAND) {
            stopDirectStatePolling();
            await openAlert('ONLYOFFICE sessions end when you close this window.', 'OnlyOffice');
            return;
        }
        try {
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
        } catch (error) {
            if (error && error.message === 'cancel') return;
            await openAlert(error && error.message ? error.message : String(error));
        }
    }

    async function handleDirectOnlyOfficeEvent(data) {
        if (!data) return;
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
            if (data.changed === true) {
                scheduleDirectRefreshDebounce();
                updateDirectPollInterval();
            } else if (data.changed === false) {
                syncAfterEditorReportedSaved().catch(function(error) {
                    log('Post-save Kin sync failed:', error && error.message ? error.message : error);
                });
            }
            return;
        }
        if (data.event === 'editorKeydown') {
            const key = String(data.key || '').toLowerCase();
            if ((data.ctrlKey || data.metaKey) && key === 's' && !currentKinPath) {
                await promptDirectSaveAsForNewDocument('keyboard-save');
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


    window.addEventListener('message', (event) => {
        const data = event.data;
        if (!data) return;
        if (data.kinMenuCommand === true) {
            handleMenuCommand(data.command);
            return;
        }
        if (data.type === 'kinDirectOnlyOfficeEvent') {
            handleDirectOnlyOfficeEvent(data);
        }
    });

    registerMenus();
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

function resolveKinOfficeBase(params) {
    const baseOverride = params.get('kin_office_base') || params.get('kin_office_origin');
    if (baseOverride) {
        return trimTrailingSlash(baseOverride);
    }
    return trimTrailingSlash(window.location.origin) + '/kin-office';
}
