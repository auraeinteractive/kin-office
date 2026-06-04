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
    const parts = String(parsed.relative || '').split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
}

function fileTypeFromName(name, fallback) {
    const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    if (match && (match[1] === 'docx' || match[1] === 'xlsx' || match[1] === 'pptx')) return match[1];
    return fallback || 'docx';
}

function requestId(prefix) {
    return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
}

const KIN_WRITE_UPLOAD_THRESHOLD = 16 * 1024;
const OFFICE_MIME_TYPES = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};

function isZipLocalHeader(bytes) {
    return bytes && bytes.length >= 4 &&
        bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function validateOfficeBytes(bytes) {
    if (!bytes || !bytes.length) throw new Error('File is empty');
    if (!isZipLocalHeader(bytes)) throw new Error('File is not a valid Office document (missing ZIP header)');
}

function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

function base64ToBytes(base64) {
    const binary = atob(String(base64 || ''));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
}

function ensureKinOfficeIframeShell() {
    document.documentElement.style.height = '100%';
    document.body.style.margin = '0';
    document.body.style.padding = '0';
    document.body.style.height = '100%';
    document.body.style.overflow = 'hidden';
    let iframe = document.getElementById('iframe');
    if (!iframe) {
        document.body.replaceChildren();
        iframe = document.createElement('iframe');
        iframe.id = 'iframe';
        iframe.title = 'Kin Office';
        iframe.style.width = '100%';
        iframe.style.height = '100%';
        iframe.style.border = 'none';
        document.body.appendChild(iframe);
    }
    return iframe;
}

async function kinOfficeCommand(args) {
    const response = await fetch('/api/commands/kinoffice', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(args || {}).toString()
    });
    const text = await response.text();
    let json = null;
    if (text) {
        try { json = JSON.parse(text); } catch (_error) { json = null; }
    }
    if (!response.ok) {
        throw new Error((json && json.message) ? String(json.message) : 'HTTP ' + response.status);
    }
    if (!json || json.response !== 'success') {
        throw new Error((json && json.message) ? String(json.message) : 'Kin Office command failed');
    }
    return json;
}

export function bootstrapKinOfficeApp(config) {
    const appConfig = Object.assign({
        appTag: 'kinoffice',
        menuPrefix: 'kinoffice.app',
        defaultFilename: 'Document.docx',
        fileType: 'docx',
        windowTitle: 'Kin Office'
    }, config || {});

    const iframeEl = ensureKinOfficeIframeShell();
    const ORIGIN = window.location.origin;
    const KIN_OFFICE_BUILD_ID = '20260604-cache16';
    const LOCAL_EDITOR_URL = new URL('./browser_editor.html?kinOfficeBuild=' + KIN_OFFICE_BUILD_ID, import.meta.url).href;
    const params = new URLSearchParams(window.location.search);
    const kinOpenPath = params.get('kin_open_path') || params.get('path') || '';
    const instanceId = getInstanceId();

    const MENU_OPEN_COMMAND = appConfig.menuPrefix + '.open';
    const MENU_SAVE_COMMAND = appConfig.menuPrefix + '.save';
    const MENU_SAVE_AS_COMMAND = appConfig.menuPrefix + '.saveAs';
    const dialogInitialPath = 'Mountlist:';

    let currentKinPath = null;
    let currentFilename = appConfig.defaultFilename;
    let currentFileType = appConfig.fileType;
    let editorOpen = false;
    let saveInFlight = null;
    let shellReady = false;
    let shellReadyPromise = null;
    let pendingOpen = null;
    let currentDirty = false;
    let currentSession = null;
    const pendingExports = new Map();

    function log() {
        console.log.apply(console, ['[' + appConfig.appTag + ']'].concat(Array.prototype.slice.call(arguments)));
    }

    log('bootstrap', KIN_OFFICE_BUILD_ID, window.location.href, {
        kinOpenPath,
        debugDefaultDocumentUrl: appConfig.debugDefaultDocumentUrl || '',
        debugForceDefaultDocument: !!appConfig.debugForceDefaultDocument
    });

    function postToParent(message) {
        try {
            window.parent.postMessage(message, ORIGIN);
        } catch (_error) {}
    }

    function postToEditor(message) {
        if (!iframeEl.contentWindow) throw new Error('Kin Office editor iframe is not ready');
        iframeEl.contentWindow.postMessage(Object.assign({ type: 'kinOfficeEditorCommand' }, message || {}), ORIGIN);
    }

    function sendSaveResult(success, message) {
        try {
            postToEditor({ command: 'saveResult', success: success !== false, message: message || '' });
        } catch (_error) {}
    }

    function createDocumentSession(options) {
        const opts = options || {};
        const fileType = opts.fileType || fileTypeFromName(opts.fileName, appConfig.fileType);
        const bytes = opts.bytes || null;
        if (bytes) {
            validateOfficeBytes(opts.bytes);
        }
        if (!opts.isNew && !bytes) throw new Error('No document bytes were available for Kin Office.');
        return {
            id: requestId('session'),
            kinPath: opts.kinPath || null,
            fileName: opts.fileName || appConfig.defaultFilename,
            fileType,
            isNew: !!opts.isNew,
            bytes
        };
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
                    { name: 'Save As...', command: MENU_SAVE_AS_COMMAND }
                ]
            }
        });
    }

    function requestFileDialog(options) {
        const opts = options || {};
        return new Promise((resolve, reject) => {
            const reqId = requestId('fd');
            function onMsg(event) {
                const data = event.data;
                if (event.origin !== ORIGIN || !data || data.kinFileDialogResult !== true || data.requestId !== reqId) return;
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
                mode: opts.mode === 'save' ? 'save' : 'load',
                initialPath: opts.initialPath || dialogInitialPath,
                defaultFilename: opts.defaultFilename || '',
                preferredExtension: String(opts.preferredExtension || appConfig.fileType || '').replace(/^\./, '')
            });
        });
    }

    function openAlert(message, title) {
        return new Promise((resolve) => {
            const reqId = requestId('alert');
            function onMsg(event) {
                const data = event.data;
                if (event.origin !== ORIGIN || !data || data.kinAlertResult !== true || data.requestId !== reqId) return;
                window.removeEventListener('message', onMsg);
                resolve();
            }
            window.addEventListener('message', onMsg);
            postToParent({
                kinOpenAlert: true,
                requestId: reqId,
                message: String(message || ''),
                title: title || 'Kin Office'
            });
        });
    }

    async function readKinFileBytes(kinPath) {
        log('readKinFileBytes:start', kinPath);
        const parsed = parseKinPath(kinPath);
        if (!parsed) throw new Error('Open from this volume is not supported yet: ' + kinPath);
        const segs = String(parsed.relative || '').split('/').filter(Boolean).map(encodeURIComponent);
        const route = '/file/' + encodeURIComponent(parsed.volume) + '/' + segs.join('/');
        const response = await fetch(route + '?_kin_ts=' + Date.now(), {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' }
        });
        if (!response.ok) throw new Error('Could not read Kin file (HTTP ' + response.status + ')');
        const bytes = new Uint8Array(await response.arrayBuffer());
        log('readKinFileBytes:done', kinPath, bytes.length);
        return bytes;
    }

    function kinFileUrlForPath(kinPath) {
        const parsed = parseKinPath(kinPath);
        if (!parsed) throw new Error('Open from this volume is not supported yet: ' + kinPath);
        const segs = String(parsed.relative || '').split('/').filter(Boolean).map(encodeURIComponent);
        return '/file/' + encodeURIComponent(parsed.volume) + '/' + segs.join('/') + '?_kin_ts=' + Date.now();
    }

    async function uploadKinFileBytes(kinPath, bytes) {
        const begin = await fetch('/api/file/upload_begin', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
                path: kinPath,
                name: kinPathBaseName(kinPath) || 'file.bin',
                size: bytes.length
            })
        }).then(function(r) { return r.json(); });
        if (!begin || begin.response !== 'success' || !begin.upload_id) {
            throw new Error((begin && begin.message) ? String(begin.message) : 'Upload begin failed');
        }
        const uploadId = begin.upload_id;
        const chunkSize = Math.max(256 * 1024, Math.min(begin.chunk_size || (8 * 1024 * 1024), 16 * 1024 * 1024));
        let offset = Number(begin.offset || 0);
        try {
            while (offset < bytes.length) {
                const end = Math.min(offset + chunkSize, bytes.length);
                const response = await fetch(
                    '/api/file/upload_chunk?upload_id=' + encodeURIComponent(uploadId) + '&offset=' + encodeURIComponent(String(offset)),
                    {
                        method: 'POST',
                        credentials: 'same-origin',
                        headers: { 'Content-Type': 'application/octet-stream', Accept: 'application/json' },
                        body: bytes.subarray(offset, end)
                    }
                );
                const json = await response.json().catch(function() { return null; });
                if (!response.ok || !json || json.response !== 'success') {
                    throw new Error((json && json.message) ? String(json.message) : 'Chunk upload failed');
                }
                offset = Number(json.offset != null ? json.offset : end);
            }
            const finish = await fetch('/api/file/upload_finish', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ upload_id: uploadId })
            }).then(function(r) { return r.json(); });
            if (!finish || finish.response !== 'success') {
                throw new Error((finish && finish.message) ? String(finish.message) : 'Upload finish failed');
            }
        } catch (error) {
            fetch('/api/file/upload_abort', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ upload_id: uploadId })
            }).catch(function() {});
            throw error;
        }
    }

    async function writeKinFileBytes(kinPath, bytes) {
        if (bytes.length >= KIN_WRITE_UPLOAD_THRESHOLD) {
            await uploadKinFileBytes(kinPath, bytes);
            return;
        }
        const response = await fetch('/api/file/write_binary', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ path: kinPath, data_base64: bytesToBase64(bytes) })
        });
        const json = await response.json().catch(function() { return null; });
        if (!response.ok || !json || json.response !== 'success') {
            throw new Error((json && json.message) ? String(json.message) : 'Could not write file to Kin path');
        }
    }

    async function writeKinFileBytesSafe(kinPath, bytes) {
        validateOfficeBytes(bytes);
        await writeKinFileBytes(kinPath, bytes);
        const readback = await readKinFileBytes(kinPath);
        if (!readback || readback.length !== bytes.length) {
            throw new Error('Save verification failed (readback length mismatch)');
        }
    }

    async function loadBlankTemplateBytes(fileType) {
        log('loadBlankTemplateBytes:start', fileType || appConfig.fileType);
        const json = await kinOfficeCommand({ action: 'template', type: fileType || appConfig.fileType });
        const bytes = base64ToBytes(json.data_base64 || '');
        log('loadBlankTemplateBytes:done', fileType || appConfig.fileType, bytes.length);
        return bytes;
    }

    async function loadDebugDefaultDocumentBytes() {
        if (!appConfig.debugDefaultDocumentUrl) return null;
        const url = new URL(appConfig.debugDefaultDocumentUrl, import.meta.url).href;
        log('loadDebugDefaultDocumentBytes:start', url, {
            configured: appConfig.debugDefaultDocumentUrl,
            importMetaUrl: import.meta.url
        });
        const response = await fetch(url, {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store'
        });
        log('loadDebugDefaultDocumentBytes:response', response.status, response.url);
        if (!response.ok) {
            throw new Error('Could not load Kin Office debug document: HTTP ' + response.status);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        validateOfficeBytes(bytes);
        log('loadDebugDefaultDocumentBytes:done', bytes.length);
        return bytes;
    }

    function ensureEditorShell() {
        if (shellReady) return Promise.resolve();
        if (shellReadyPromise) return shellReadyPromise;
        shellReadyPromise = new Promise((resolve, reject) => {
            const timer = setTimeout(function() {
                reject(new Error('Kin Office editor shell did not become ready.'));
            }, 15000);
            window.addEventListener('message', function onShell(event) {
                if (event.origin !== ORIGIN || !event.data || event.data.type !== 'kinOfficeEditorEvent') return;
                if (event.data.event !== 'shellReady') return;
                window.removeEventListener('message', onShell);
                clearTimeout(timer);
                shellReady = true;
                resolve();
            });
        });
        iframeEl.src = LOCAL_EDITOR_URL;
        return shellReadyPromise;
    }

    async function openLocalDocument(options) {
        const session = createDocumentSession(options || {});
        log('openLocalDocument:start', {
            fileName: session.fileName,
            fileType: session.fileType,
            isNew: session.isNew,
            bytes: session.bytes ? session.bytes.length : 0,
            kinPath: session.kinPath || ''
        });
        await ensureEditorShell();
        currentSession = session;
        currentFilename = session.fileName;
        currentFileType = session.fileType;
        editorOpen = false;
        currentDirty = false;
        const reqId = requestId('open');
        const opened = new Promise((resolve, reject) => {
            pendingOpen = { requestId: reqId, resolve, reject };
            setTimeout(function() {
                if (pendingOpen && pendingOpen.requestId === reqId) {
                    pendingOpen = null;
                    reject(new Error('Kin Office editor did not finish opening the document.'));
                }
            }, 30000);
        });
        postToEditor({
            command: 'open',
            requestId: reqId,
            sessionId: session.id,
            fileName: currentFilename,
            fileType: currentFileType,
            isNew: session.isNew,
            data_base64: session.bytes ? bytesToBase64(session.bytes) : '',
            lang: 'en-US'
        });
        log('openLocalDocument:posted', {
            requestId: reqId,
            fileName: currentFilename,
            fileType: currentFileType,
            isNew: session.isNew,
            base64Length: session.bytes ? bytesToBase64(session.bytes).length : 0
        });
        try {
            await opened;
            editorOpen = true;
            log('openLocalDocument:ready', session.fileName, session.fileType);
        } catch (error) {
            if (currentSession === session) currentSession = null;
            log('openLocalDocument:failed', error && error.message ? error.message : String(error));
            throw error;
        }
    }

    function exportLocalDocument() {
        return new Promise((resolve, reject) => {
            const reqId = requestId('export');
            pendingExports.set(reqId, { resolve, reject });
            setTimeout(function() {
                if (!pendingExports.has(reqId)) return;
                pendingExports.delete(reqId);
                reject(new Error('Kin Office export timed out.'));
            }, 30000);
            postToEditor({ command: 'export', requestId: reqId });
        });
    }

    async function chooseSavePath(defaultName) {
        return requestFileDialog({
            mode: 'save',
            initialPath: dialogInitialPath,
            defaultFilename: defaultName || currentFilename || appConfig.defaultFilename
        });
    }

    async function saveCurrentDocument(options) {
        if (saveInFlight) return saveInFlight;
        const opts = options || {};
        saveInFlight = (async function() {
            if (!editorOpen) throw new Error('Open a document first, then use Save.');
            const targetPath = opts.forceSaveAs || !currentKinPath
                ? await chooseSavePath(currentKinPath ? kinPathBaseName(currentKinPath) : currentFilename)
                : currentKinPath;
            const exported = await exportLocalDocument();
            const bytes = exported.bytes;
            validateOfficeBytes(bytes);
            await writeKinFileBytesSafe(targetPath, bytes);
            currentKinPath = targetPath;
            currentFilename = kinPathBaseName(targetPath) || exported.fileName || currentFilename;
            currentFileType = fileTypeFromName(currentFilename, exported.fileType || currentFileType);
            currentDirty = false;
            sendSaveResult(true, '');
            postToParent({ kinWorkspace: true, action: 'refreshAllDirectoryViews' });
        })();
        try {
            await saveInFlight;
        } catch (error) {
            if (!error || error.message !== 'cancel') {
                sendSaveResult(false, error && error.message ? error.message : String(error));
            }
            throw error;
        } finally {
            saveInFlight = null;
        }
    }

    async function openKinPath(kinPath) {
        currentKinPath = kinPath;
        currentDirty = false;
        await openLocalDocument({
            kinPath,
            fileName: kinPathBaseName(kinPath) || appConfig.defaultFilename,
            fileType: fileTypeFromName(kinPathBaseName(kinPath), appConfig.fileType),
            bytes: await readKinFileBytes(kinPath),
            isNew: false
        });
    }

    async function openBlankDocument() {
        currentKinPath = null;
        currentDirty = false;
        const debugBytes = await loadDebugDefaultDocumentBytes();
        if (debugBytes) {
            await openLocalDocument({
                fileName: appConfig.debugDefaultFilename || appConfig.defaultFilename,
                fileType: appConfig.fileType,
                bytes: debugBytes,
                isNew: false
            });
            return;
        }
        await openLocalDocument({
            fileName: appConfig.defaultFilename,
            fileType: appConfig.fileType,
            isNew: true
        });
    }

    async function openInitialDocument() {
        if (appConfig.debugForceDefaultDocument) {
            log('openInitialDocument:forcing debug default', {
                debugDefaultDocumentUrl: appConfig.debugDefaultDocumentUrl || '',
                ignoredKinOpenPath: kinOpenPath || ''
            });
            await openBlankDocument();
            return;
        }
        if (kinOpenPath) {
            await openKinPath(kinOpenPath);
            return;
        }
        await openBlankDocument();
    }

    async function handleMenuCommand(command) {
        try {
            if (command === MENU_OPEN_COMMAND) {
                await openKinPath(await requestFileDialog({ mode: 'load', initialPath: dialogInitialPath }));
                return;
            }
            if (command === MENU_SAVE_COMMAND) {
                await saveCurrentDocument();
                return;
            }
            if (command === MENU_SAVE_AS_COMMAND) {
                await saveCurrentDocument({ forceSaveAs: true });
            }
        } catch (error) {
            if (error && error.message === 'cancel') return;
            log('operation failed:', error && error.message ? error.message : error);
            await openAlert(error && error.message ? error.message : String(error), 'Kin Office');
        }
    }

    async function handleEditorEvent(data) {
        if (!data) return;
        if (data.event === 'ready') {
            log('editor event:ready');
            if (pendingOpen) {
                const pending = pendingOpen;
                pendingOpen = null;
                pending.resolve();
            }
            return;
        }
        if (data.event === 'documentStateChange') {
            log('editor event:dirty', !!data.changed);
            currentDirty = !!data.changed;
            return;
        }
        if (data.event === 'saveRequested' || data.event === 'editorKeydown') {
            const key = String(data.key || '').toLowerCase();
            if (data.event === 'saveRequested' || ((data.ctrlKey || data.metaKey) && key === 's')) {
                try {
                    await saveCurrentDocument();
                } catch (error) {
                    if (!error || error.message !== 'cancel') {
                        await openAlert(error && error.message ? error.message : String(error), 'Save failed');
                    }
                }
            }
            return;
        }
        if (data.event === 'exported') {
            log('editor event:exported', data.requestId || '', data.fileName || '', data.fileType || '', String(data.data_base64 || '').length);
            const pending = pendingExports.get(data.requestId || '');
            if (!pending) return;
            pendingExports.delete(data.requestId || '');
            pending.resolve({
                fileName: data.fileName || currentFilename,
                fileType: data.fileType || currentFileType,
                bytes: base64ToBytes(data.data_base64 || '')
            });
            return;
        }
        if (data.event === 'exportFailed') {
            log('editor event:exportFailed', data.requestId || '', data.error || '');
            const pending = pendingExports.get(data.requestId || '');
            if (!pending) return;
            pendingExports.delete(data.requestId || '');
            pending.reject(new Error(data.error || 'Kin Office export failed'));
            return;
        }
        if (data.event === 'error') {
            const message = data.error || 'unknown error';
            log('Local editor error:', message);
            if (pendingOpen) {
                const pending = pendingOpen;
                pendingOpen = null;
                pending.reject(new Error(message));
            }
        }
    }

    window.addEventListener('message', (event) => {
        if (event.origin !== ORIGIN) return;
        const data = event.data;
        if (!data) return;
        if (data.kinMenuCommand === true) {
            handleMenuCommand(data.command);
            return;
        }
        if (data.type === 'kinOfficeEditorEvent') handleEditorEvent(data);
    });

    registerMenus();
    openInitialDocument().catch(function(error) {
        openAlert('Could not open document:\n' + (error && error.message ? error.message : String(error)), 'Open failed');
    });
}

function getInstanceId() {
    try {
        return new URL(window.location.href).searchParams.get('kin_app_instance') || '';
    } catch (_error) {
        return '';
    }
}
