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

/** Legacy hand-rolled OOXML stubs from early direct-connector (before DS templates).
 * Only block writes this small from overwriting a real on-disk document. */
const OFFICE_LEGACY_SKELETON_MAX = { docx: 1200, xlsx: 1900, pptx: 7500 };
const DIRECT_FLUSH_POLL_MS = 500;
const DIRECT_FLUSH_MAX_POLLS = 20;
const KIN_AUTOSAVE_DEBOUNCE_MS = 10000;
const KIN_AUTOSAVE_MAX_MS = 60000;
const KIN_AUTOSAVE_RETRY_MS = 5000;
const KIN_AUTOSAVE_BUSY_RETRY_MS = 1000;
/** Match Kin http.service KIN_HTTP_STAGE_THRESHOLD — use upload API for larger binary writes. */
const KIN_WRITE_UPLOAD_THRESHOLD = 16 * 1024;
const SAVE_CLOSE_TITLE_SUFFIX = ' — Waiting for save before closing';

function isZipLocalHeader(bytes) {
    return bytes && bytes.length >= 4 &&
        bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
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
    if (opts.allowOverwrite) {
        return;
    }
    const legacyMax = OFFICE_LEGACY_SKELETON_MAX[ft] || OFFICE_LEGACY_SKELETON_MAX.docx;
    const existingSize = typeof opts.existingSize === 'number' ? opts.existingSize : null;
    if (existingSize != null && existingSize > legacyMax) {
        if (bytes.length <= legacyMax) {
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
        fileType: 'docx',
        windowTitle: 'OnlyOffice'
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
    let directSyncing = false;
    let directSaveAsPromptOpen = false;
    let kinSaveFlowActive = false;
    let kinDirty = false;
    let kinAutosaveTimer = null;
    let kinAutosaveMaxTimer = null;
    let saveCloseHold = 0;
    let saveCloseGateWarned = false;
    let userRequestedClose = false;
    let saveDrainActive = false;
    let saveDrainPromise = null;

    const instanceId = getInstanceId();
    const baseWindowTitle = String(appConfig.windowTitle || 'OnlyOffice');
    const kinWindow = (typeof kin !== 'undefined' && kin.classes && kin.classes.Window && instanceId)
        ? new kin.classes.Window({ instanceId: instanceId })
        : null;

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

    function isKinWriteActive() {
        return saveCloseHold > 0 || directSyncing || directSaveAsPromptOpen || kinSaveFlowActive;
    }

    function needsKinSaveLocation() {
        return !!directSessionId() && !currentKinPath;
    }

    function isKinSaveActive() {
        return isKinWriteActive() || saveDrainActive;
    }

    function hasUnpersistedKinChanges() {
        if (!directSessionId()) {
            return false;
        }
        return kinDirty;
    }

    function discardUnpersistedKinChanges() {
        kinDirty = false;
        cancelKinAutosave();
    }

    async function releaseCloseGate() {
        await updateSaveCloseGate();
        if (kinWindow && !shouldBlockClose()) {
            await kinWindow.setCloseBlocked(false);
        }
    }

    async function confirmCloseWithoutSaving() {
        const ok = await openConfirm(
            'This document has not been saved to Kin.\n\nClose without saving?',
            'Unsaved changes',
            'Close without saving'
        );
        if (ok) {
            discardUnpersistedKinChanges();
            await releaseCloseGate();
        } else {
            userRequestedClose = false;
            await updateSaveCloseGate();
        }
    }

    function shouldBlockClose() {
        if (isKinSaveActive()) {
            return true;
        }
        if (hasUnpersistedKinChanges()) {
            return true;
        }
        return false;
    }

    function shouldShowCloseWaitingTitle() {
        return userRequestedClose && shouldBlockClose();
    }

    function ensureCloseWaitingOverlay() {
        var overlay = document.getElementById('kinOnlyOfficeCloseWaitingOverlay');
        if (overlay) return overlay;

        overlay = document.createElement('div');
        overlay.id = 'kinOnlyOfficeCloseWaitingOverlay';
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.zIndex = '100000';
        overlay.style.display = 'none';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.background = 'rgba(0,0,0,0.28)';

        var card = document.createElement('div');
        card.style.display = 'flex';
        card.style.alignItems = 'center';
        card.style.gap = '12px';
        card.style.padding = '16px 20px';
        card.style.borderRadius = '10px';
        card.style.background = 'rgba(20,20,20,0.94)';
        card.style.color = '#fff';
        card.style.fontFamily = 'monospace';
        card.style.fontSize = '13px';
        card.style.boxShadow = '0 10px 26px rgba(0,0,0,0.35)';

        var spinner = document.createElement('div');
        spinner.style.width = '18px';
        spinner.style.height = '18px';
        spinner.style.border = '2px solid rgba(255,255,255,0.35)';
        spinner.style.borderTopColor = '#fff';
        spinner.style.borderRadius = '50%';
        spinner.style.animation = 'kinOnlyOfficeCloseSpin 0.8s linear infinite';

        var text = document.createElement('div');
        text.textContent = 'Waiting to close...';

        var style = document.getElementById('kinOnlyOfficeCloseWaitingStyle');
        if (!style) {
            style = document.createElement('style');
            style.id = 'kinOnlyOfficeCloseWaitingStyle';
            style.textContent = '@keyframes kinOnlyOfficeCloseSpin { to { transform: rotate(360deg); } }';
            document.head.appendChild(style);
        }

        card.appendChild(spinner);
        card.appendChild(text);
        overlay.appendChild(card);
        document.body.appendChild(overlay);
        return overlay;
    }

    function setCloseWaitingOverlayVisible(visible) {
        var overlay = visible
            ? ensureCloseWaitingOverlay()
            : document.getElementById('kinOnlyOfficeCloseWaitingOverlay');
        if (!overlay) return;
        overlay.style.display = visible ? 'flex' : 'none';
    }

    function updateSaveCloseGate() {
        const block = shouldBlockClose();
        setCloseWaitingOverlayVisible(userRequestedClose && block);
        if (!kinWindow) {
            if (!saveCloseGateWarned) {
                saveCloseGateWarned = true;
                log('Save close gate unavailable (kin.classes.Window or instance id missing)');
            }
            return Promise.resolve();
        }
        const title = shouldShowCloseWaitingTitle()
            ? baseWindowTitle + SAVE_CLOSE_TITLE_SUFFIX
            : baseWindowTitle;
        return kinWindow.setCloseBlocked(block).then(function() {
            return kinWindow.setTitle(title);
        }).then(function() {
            if (!block) {
                userRequestedClose = false;
            }
        }).catch(function(err) {
            log('updateSaveCloseGate failed:', err && err.message ? err.message : err);
        });
    }

    async function drainSaveBeforeClose() {
        if (saveDrainPromise) {
            return saveDrainPromise;
        }
        saveDrainActive = true;
        saveDrainPromise = (async function() {
            try {
                for (let index = 0; index < DIRECT_FLUSH_MAX_POLLS; index += 1) {
                    if (!userRequestedClose) {
                        return;
                    }
                    await refreshDirectState();
                    if (!shouldBlockClose()) {
                        await releaseCloseGate();
                        return;
                    }
                    if (directSessionSavePending() && hasUnpersistedKinChanges()) {
                        await waitMs(DIRECT_FLUSH_POLL_MS);
                        continue;
                    }
                    if (hasUnpersistedKinChanges() && !currentKinPath) {
                        try {
                            await promptDirectSaveAsForNewDocument('close');
                        } catch (error) {
                            if (error && error.message === 'cancel') {
                                userRequestedClose = false;
                                return;
                            }
                        }
                        await refreshDirectState();
                        if (!hasUnpersistedKinChanges()) {
                            await releaseCloseGate();
                            return;
                        }
                        await confirmCloseWithoutSaving();
                        return;
                    }
                    if (hasUnpersistedKinChanges() && currentKinPath && !directSyncing && !directSessionSavePending()) {
                        try {
                            await saveDirectSessionToKinPath(currentKinPath);
                        } catch (error) {
                            log('Close drain save failed:', error && error.message ? error.message : error);
                            await confirmCloseWithoutSaving();
                            return;
                        }
                        await refreshDirectState();
                        if (!hasUnpersistedKinChanges()) {
                            await releaseCloseGate();
                            return;
                        }
                        continue;
                    }
                    if (isKinWriteActive()) {
                        await waitMs(DIRECT_FLUSH_POLL_MS);
                        continue;
                    }
                    await waitMs(DIRECT_FLUSH_POLL_MS);
                }
                if (userRequestedClose && shouldBlockClose()) {
                    log('Close drain timed out with unsaved changes still pending');
                    await confirmCloseWithoutSaving();
                }
            } catch (error) {
                if (error && error.message === 'cancel') {
                    userRequestedClose = false;
                } else {
                    log('drainSaveBeforeClose failed:', error && error.message ? error.message : error);
                    if (userRequestedClose) {
                        await confirmCloseWithoutSaving();
                    }
                }
            } finally {
                saveDrainActive = false;
                saveDrainPromise = null;
                await releaseCloseGate();
            }
        })();
        return saveDrainPromise;
    }

    function onUserRequestedClose() {
        userRequestedClose = true;
        void updateSaveCloseGate();
        void drainSaveBeforeClose();
    }

    function beginSaveCloseHold() {
        saveCloseHold += 1;
        void updateSaveCloseGate();
    }

    function endSaveCloseHold() {
        if (saveCloseHold > 0) {
            saveCloseHold -= 1;
        }
        void updateSaveCloseGate();
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
        const isSaveBusy = /sav/i.test(String(message || ''));
        if (isSaveBusy) {
            beginSaveCloseHold();
        }
        showBusy(message);
        try {
            return await operation();
        } finally {
            hideBusy();
            if (isSaveBusy) {
                endSaveCloseHold();
            }
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
            const preferredExt = String(
                dialogOptions.preferredExtension ||
                (Array.isArray(dialogOptions.preferredExtensions) && dialogOptions.preferredExtensions[0]) ||
                appConfig.preferredExtension ||
                appConfig.fileType ||
                ''
            ).trim().replace(/^\./, '');
            const msg = {
                kinOpenFileDialog: true,
                requestId: reqId,
                mode: dialogOptions.mode === 'save' ? 'save' : 'load',
                initialPath: dialogOptions.initialPath || dialogInitialPath,
                defaultFilename: dialogOptions.defaultFilename || ''
            };
            if (preferredExt.length) {
                msg.preferredExtension = preferredExt;
            }
            postToParent(msg);
        });
    }

    function openConfirm(message, title, confirmLabel) {
        return new Promise((resolve) => {
            const reqId = requestId('confirm');
            function onMsg(event) {
                const data = event.data;
                if (event.origin !== ORIGIN || !data || data.kinConfirmResult !== true || data.requestId !== reqId) {
                    return;
                }
                window.removeEventListener('message', onMsg);
                resolve(!!data.ok);
            }
            window.addEventListener('message', onMsg);
            postToParent({
                kinOpenConfirm: true,
                requestId: reqId,
                message: String(message || ''),
                title: title || 'OnlyOffice',
                confirmLabel: confirmLabel || 'OK'
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
            response = await apiPostJson('/api/file/write_binary', {
                path: String(kinPath || ''),
                data_base64: bytesToBase64(bytes)
            });
        }
        log('writeKinFileBytes response:', response);
        if (!response || response.response !== 'success') {
            throw new Error((response && response.message) ? String(response.message) : 'Could not write file to Kin path');
        }
    }

    async function writeKinFileBytesSafe(targetKinPath, bytes, fileType, writeOptions) {
        const ft = fileType || fileTypeFromName(kinPathBaseName(targetKinPath), appConfig.fileType);
        const stat = await kinFileStatOnDisk(targetKinPath);
        validateOfficeBytes(bytes, ft, {
            existingSize: stat.exists ? stat.size : null,
            allowOverwrite: !!(writeOptions && writeOptions.allowOverwrite)
        });
        await writeKinFileBytes(targetKinPath, bytes);
        const readback = await readKinFileBytes(targetKinPath);
        if (!readback || readback.length !== bytes.length) {
            throw new Error('Save verification failed (readback length mismatch)');
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
        void updateSaveCloseGate();
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

        const beforeVersion = Number(state.version || 0);
        let dsError = null;
        try {
            const forceResult = await directPostJson('/session/' + encodeURIComponent(id) + '/forcesave', {});
            dsError = forceResult && forceResult.error != null ? Number(forceResult.error) : null;
            if (forceResult && forceResult.accepted === true) {
                // fall through to version-bump poll below
            } else if (dsError === 4) {
                log('Direct force-save: Document Server has no pending changes; using current connector content.');
                return;
            } else {
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

    async function saveDirectSessionToKinPath(targetKinPath, saveOptions) {
        if (!directSessionId()) {
            throw new Error('No direct ONLYOFFICE document is open');
        }
        await ensureDirectSessionFlushed();
        const bytes = await fetchDirectContent();
        const ft = fileTypeFromName(kinPathBaseName(targetKinPath), appConfig.fileType);
        await writeKinFileBytesSafe(targetKinPath, bytes, ft, saveOptions);
        currentKinPath = targetKinPath;
        kinDirty = false;
        cancelKinAutosave();
        await refreshDirectState();
        await updateDirectDocumentMeta(targetKinPath);
        if (directSession && directSession.info) {
            writeKinOnlyOfficeInfo(targetKinPath, directSession.info).catch(function(err) {
                log('writeKinOnlyOfficeInfo (save) failed:', err && err.message ? err.message : err);
            });
        }
        requestWorkspaceRefresh();
        void updateSaveCloseGate();
    }

    async function updateDirectDocumentMeta(targetKinPath) {
        const id = directSessionId();
        if (!id || !targetKinPath) {
            return;
        }
        const title = kinPathBaseName(targetKinPath);
        try {
            const response = await directPostJson(
                '/session/' + encodeURIComponent(id) + '/document-meta',
                { title: title, path: targetKinPath }
            );
            if (response && response.metaError != null) {
                log('Direct document-meta failed:', response.metaError);
            }
            if (response && response.filename && directSession) {
                directSession.filename = response.filename;
            }
            if (kinWindow && title) {
                kinWindow.setTitle(baseWindowTitle + ' — ' + title).catch(function(err) {
                    log('setTitle after save failed:', err && err.message ? err.message : err);
                });
            }
        } catch (error) {
            log('Direct document-meta request failed:', error && error.message ? error.message : error);
        }
    }

    function cancelKinAutosave() {
        if (kinAutosaveTimer) {
            clearTimeout(kinAutosaveTimer);
            kinAutosaveTimer = null;
        }
        if (kinAutosaveMaxTimer) {
            clearTimeout(kinAutosaveMaxTimer);
            kinAutosaveMaxTimer = null;
        }
    }

    function scheduleKinAutosave(delayMs) {
        if (!currentKinPath || !directSessionId()) {
            return;
        }
        if (kinAutosaveTimer) {
            clearTimeout(kinAutosaveTimer);
        }
        const debounce = typeof delayMs === 'number' ? delayMs : KIN_AUTOSAVE_DEBOUNCE_MS;
        kinAutosaveTimer = setTimeout(function() {
            kinAutosaveTimer = null;
            void runKinAutosave();
        }, debounce);
        if (!kinAutosaveMaxTimer) {
            kinAutosaveMaxTimer = setTimeout(function() {
                kinAutosaveMaxTimer = null;
                void runKinAutosave();
            }, KIN_AUTOSAVE_MAX_MS);
        }
    }

    async function runKinAutosave() {
        if (!kinDirty || !currentKinPath || !directSessionId()) {
            cancelKinAutosave();
            return;
        }
        if (isKinWriteActive()) {
            scheduleKinAutosave(KIN_AUTOSAVE_BUSY_RETRY_MS);
            return;
        }
        cancelKinAutosave();
        directSyncing = true;
        beginSaveCloseHold();
        try {
            await saveDirectSessionToKinPath(currentKinPath);
            log('Kin autosave wrote', currentKinPath);
        } catch (error) {
            log('Kin autosave failed:', error && error.message ? error.message : error);
            if (kinDirty && currentKinPath) {
                scheduleKinAutosave(KIN_AUTOSAVE_RETRY_MS);
            }
        } finally {
            directSyncing = false;
            endSaveCloseHold();
        }
    }

    async function openDirectEditor(session) {
        const url = directEditorUrl(session);
        if (!url) {
            throw new Error('Direct connector did not return an editor URL');
        }
        iframeEl.src = url;
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
        kinDirty = false;
        cancelKinAutosave();
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
        kinDirty = false;
        cancelKinAutosave();
        await openDirectEditor(session);
    }

    async function ensureKinSaveLocation(reason) {
        if (!needsKinSaveLocation() || kinSaveFlowActive || directSaveAsPromptOpen) {
            return;
        }
        kinSaveFlowActive = true;
        directSaveAsPromptOpen = true;
        void updateSaveCloseGate();
        let targetKinPath = null;
        try {
            log('Prompting Save As for direct unsaved document:', reason || 'save');
            targetKinPath = await requestFileDialog({
                mode: 'save',
                initialPath: dialogInitialPath,
                defaultFilename: appConfig.defaultFilename
            });
            currentKinPath = targetKinPath;
            await withBusy('Saving to Kin path...', async function() {
                await saveDirectSessionToKinPath(targetKinPath, { allowOverwrite: true });
            });
            if (reason !== 'editor-save') {
                await openAlert('Saved to ' + targetKinPath + '.', 'Saved');
            }
        } catch (error) {
            if (targetKinPath) {
                currentKinPath = null;
            }
            if (error && error.message === 'cancel') {
                if (reason === 'close') {
                    throw error;
                }
                return;
            }
            await openAlert(error && error.message ? error.message : String(error), 'Save failed');
            if (reason === 'close') {
                throw error;
            }
        } finally {
            kinSaveFlowActive = false;
            directSaveAsPromptOpen = false;
            void updateSaveCloseGate();
        }
    }

    async function directSaveAs(defaultName) {
        if (kinSaveFlowActive || directSaveAsPromptOpen) {
            return;
        }
        kinSaveFlowActive = true;
        directSaveAsPromptOpen = true;
        void updateSaveCloseGate();
        let targetKinPath = null;
        try {
            targetKinPath = await requestFileDialog({
                mode: 'save',
                initialPath: dialogInitialPath,
                defaultFilename: defaultName || appConfig.defaultFilename
            });
            currentKinPath = targetKinPath;
            await withBusy('Saving to Kin path...', async function() {
                await saveDirectSessionToKinPath(targetKinPath, { allowOverwrite: true });
            });
            await openAlert('Saved to ' + targetKinPath + '.', 'Saved');
        } catch (error) {
            if (targetKinPath) {
                currentKinPath = null;
            }
            throw error;
        } finally {
            kinSaveFlowActive = false;
            directSaveAsPromptOpen = false;
            void updateSaveCloseGate();
        }
    }

    async function promptDirectSaveAsForNewDocument(reason) {
        if (currentKinPath || !directSessionId()) {
            return;
        }
        await ensureKinSaveLocation(reason === 'close' ? 'close' : reason);
    }

    async function runKinSaveOnPath(targetKinPath) {
        cancelKinAutosave();
        await withBusy('Saving to Kin path...', async function() {
            await saveDirectSessionToKinPath(targetKinPath);
        });
    }

    async function handleMenuCommand(command) {
        if (command === MENU_LOGOUT_COMMAND) {
            cancelKinAutosave();
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
                    await ensureKinSaveLocation('menu-save');
                    return;
                }
                await runKinSaveOnPath(currentKinPath);
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
                kinDirty = true;
                if (currentKinPath) {
                    scheduleKinAutosave();
                }
            }
            return;
        }
        if (data.event === 'editorKeydown') {
            const key = String(data.key || '').toLowerCase();
            if ((data.ctrlKey || data.metaKey) && key === 's') {
                if (!directSessionId()) {
                    return;
                }
                if (needsKinSaveLocation()) {
                    await ensureKinSaveLocation('keyboard-save');
                    return;
                }
                try {
                    await runKinSaveOnPath(currentKinPath);
                } catch (error) {
                    if (!error || error.message !== 'cancel') {
                        await openAlert(error && error.message ? error.message : String(error), 'Save failed');
                    }
                }
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
        if (event.origin !== ORIGIN) return;
        const data = event.data;
        if (!data) return;
        if (data.kinRepositoryCloseRequested === true) {
            onUserRequestedClose();
            return;
        }
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
        }).finally(function() {
            void updateSaveCloseGate();
        });
    } else {
        withBusy('Creating document...', async function() {
            await openDirectBlankDocument();
        }).catch(function(error) {
            openAlert('Could not create document:\n' + (error && error.message ? error.message : String(error)), 'Open failed');
        }).finally(function() {
            void updateSaveCloseGate();
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
