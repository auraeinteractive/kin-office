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
const KIN_AUTOSAVE_IDLE_MS = 12000;
const KIN_AUTOSAVE_MIN_INTERVAL_MS = 30000;
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

function bytesEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(function(v) {
        return v.toString(16).padStart(2, '0');
    }).join('');
}

function readAscii(bytes, offset, len) {
    let out = '';
    for (let i = 0; i < len; i += 1) out += String.fromCharCode(bytes[offset + i]);
    return out;
}

function parseOfficeZipEntries(bytes) {
    if (!bytes || bytes.length < 22 || !isZipLocalHeader(bytes)) throw new Error('Invalid Office ZIP');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) {
        if (view.getUint32(i, true) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error('Office ZIP central directory not found');
    const count = view.getUint16(eocd + 10, true);
    const cdOffset = view.getUint32(eocd + 16, true);
    const entries = new Map();
    let pos = cdOffset;
    const decoder = new TextDecoder();
    for (let i = 0; i < count; i += 1) {
        if (pos + 46 > bytes.length || view.getUint32(pos, true) !== 0x02014b50) {
            throw new Error('Invalid Office ZIP central directory entry');
        }
        const flags = view.getUint16(pos + 8, true);
        const method = view.getUint16(pos + 10, true);
        const modTime = view.getUint16(pos + 12, true);
        const modDate = view.getUint16(pos + 14, true);
        const crc32 = view.getUint32(pos + 16, true);
        const compressedSize = view.getUint32(pos + 20, true);
        const uncompressedSize = view.getUint32(pos + 24, true);
        const nameLen = view.getUint16(pos + 28, true);
        const extraLen = view.getUint16(pos + 30, true);
        const commentLen = view.getUint16(pos + 32, true);
        const localOffset = view.getUint32(pos + 42, true);
        const nameBytes = bytes.subarray(pos + 46, pos + 46 + nameLen);
        const name = (flags & 0x0800) ? decoder.decode(nameBytes) : readAscii(nameBytes, 0, nameBytes.length);
        if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) {
            throw new Error('Invalid Office ZIP local header');
        }
        const localNameLen = view.getUint16(localOffset + 26, true);
        const localExtraLen = view.getUint16(localOffset + 28, true);
        const dataOffset = localOffset + 30 + localNameLen + localExtraLen;
        const dataEnd = dataOffset + compressedSize;
        if (dataEnd > bytes.length) throw new Error('Invalid Office ZIP member size');
        entries.set(name, {
            path: name,
            method,
            flags,
            modTime,
            modDate,
            crc32,
            compressedSize,
            uncompressedSize,
            data: bytes.subarray(dataOffset, dataEnd)
        });
        pos += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

function zipEntrySame(a, b) {
    return !!a && !!b &&
        a.method === b.method &&
        a.crc32 === b.crc32 &&
        a.compressedSize === b.compressedSize &&
        a.uncompressedSize === b.uncompressedSize &&
        bytesEqual(a.data, b.data);
}

function patchMetaSame(a, b) {
    return !!a && !!b &&
        a.method === b.method &&
        a.crc32 === b.crc32 &&
        a.compressedSize === b.compressedSize &&
        a.uncompressedSize === b.uncompressedSize;
}

function setU64(view, offset, value) {
    const n = BigInt(value || 0);
    view.setUint32(offset, Number(n & 0xffffffffn), true);
    view.setUint32(offset + 4, Number((n >> 32n) & 0xffffffffn), true);
}

function createOfficePackagePatchBytes(baseBytes, targetBytes) {
    const baseEntries = parseOfficeZipEntries(baseBytes);
    const targetEntries = parseOfficeZipEntries(targetBytes);
    const encoder = new TextEncoder();
    const changes = [];
    targetEntries.forEach(function(target, path) {
        const base = baseEntries.get(path);
        if (zipEntrySame(base, target)) return;
        changes.push({ op: 1, path, base: base || null, target });
    });
    baseEntries.forEach(function(base, path) {
        if (targetEntries.has(path)) return;
        changes.push({ op: 2, path, base, target: null });
    });
    let total = 8;
    const encoded = changes.map(function(change) {
        const pathBytes = encoder.encode(change.path);
        const data = change.target ? change.target.data : new Uint8Array(0);
        total += 1 + 2 + 2 + 4 + 8 + 8 + 2 + 4 + 8 + 8 + 8 + pathBytes.length + data.length;
        return { change, pathBytes, data };
    });
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    out.set([0x4b, 0x4f, 0x50, 0x31], 0); // KOP1
    view.setUint32(4, changes.length, true);
    let off = 8;
    encoded.forEach(function(item) {
        const change = item.change;
        const base = change.base;
        const target = change.target;
        out[off] = change.op; off += 1;
        view.setUint16(off, item.pathBytes.length, true); off += 2;
        view.setUint16(off, target ? target.method : 0, true); off += 2;
        view.setUint32(off, target ? target.crc32 : 0, true); off += 4;
        setU64(view, off, target ? target.compressedSize : 0); off += 8;
        setU64(view, off, target ? target.uncompressedSize : 0); off += 8;
        view.setUint16(off, base ? base.method : 0xffff, true); off += 2;
        view.setUint32(off, base ? base.crc32 : 0, true); off += 4;
        setU64(view, off, base ? base.compressedSize : 0xffffffffffffffffn); off += 8;
        setU64(view, off, base ? base.uncompressedSize : 0xffffffffffffffffn); off += 8;
        setU64(view, off, item.data.length); off += 8;
        out.set(item.pathBytes, off); off += item.pathBytes.length;
        out.set(item.data, off); off += item.data.length;
    });
    return out;
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
    try {
        const pageUrl = new URL(window.location.href);
        if (pageUrl.searchParams.has('kinOfficeBuild')) {
            pageUrl.searchParams.delete('kinOfficeBuild');
            window.history.replaceState(null, '', pageUrl.pathname + pageUrl.search + pageUrl.hash);
        }
    } catch (_error) {}

    const appConfig = Object.assign({
        appTag: 'kinoffice',
        menuPrefix: 'kinoffice.app',
        defaultFilename: 'Document.docx',
        fileType: 'docx',
        windowTitle: 'Kin Office'
    }, config || {});

    const iframeEl = ensureKinOfficeIframeShell();
    const ORIGIN = window.location.origin;
    const LOCAL_EDITOR_URL = new URL('./browser_editor.html', import.meta.url).href;
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
    let currentBaselineBytes = null;
    let currentBaselineSha256 = '';
    let autosaveTimer = null;
    let autosaveInFlight = false;
    let autosavePaused = false;
    let lastAutosaveAt = 0;
    const pendingExports = new Map();

    function postToParent(message) {
        try {
            window.parent.postMessage(message, ORIGIN);
        } catch (_error) {}
    }

    function postToEditor(message) {
        if (!iframeEl.contentWindow) throw new Error('Kin Office editor iframe is not ready');
        iframeEl.contentWindow.postMessage(Object.assign({ type: 'kinOfficeEditorCommand' }, message || {}), ORIGIN);
    }

    function statusTime() {
        try {
            return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch (_error) {
            const now = new Date();
            return String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
        }
    }

    function setEditorStatus(message, options) {
        try {
            postToEditor(Object.assign({
                command: 'statusMessage',
                message: String(message || '')
            }, options || {}));
        } catch (_error) {}
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

    function kinApiErrorFromRawBytes(bytes) {
        if (!bytes || bytes.length === 0 || bytes.length > 4096) return null;
        const text = new TextDecoder().decode(bytes).trimStart();
        if (!text.startsWith('{')) return null;
        try {
            const json = JSON.parse(text);
            if (json && json.response === 'fail') {
                return json.message ? String(json.message) : 'Read failed';
            }
        } catch (_error) {}
        return null;
    }

    async function readKinFileBytes(kinPath) {
        const path = String(kinPath || '').trim();
        if (!parseKinPath(path)) throw new Error('Open from this volume is not supported yet: ' + path);
        const response = await fetch('/api/file/raw', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/octet-stream' },
            body: JSON.stringify({ path })
        });
        const bytes = new Uint8Array(await response.arrayBuffer());
        const apiError = kinApiErrorFromRawBytes(bytes);
        if (apiError) throw new Error(apiError);
        if (!response.ok) {
            throw new Error('Could not read Kin file (HTTP ' + response.status + ')');
        }
        return bytes;
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

    async function updateBaseline(bytes) {
        currentBaselineBytes = bytes ? new Uint8Array(bytes) : null;
        currentBaselineSha256 = currentBaselineBytes ? await sha256Hex(currentBaselineBytes) : '';
    }

    function clearAutosaveTimer() {
        if (autosaveTimer) clearTimeout(autosaveTimer);
        autosaveTimer = null;
    }

    function autosaveRecoveryPath() {
        if (!currentKinPath) return '';
        const parsed = parseKinPath(currentKinPath);
        if (!parsed) return '';
        const slash = parsed.relative.lastIndexOf('/');
        const dir = slash >= 0 ? parsed.relative.slice(0, slash + 1) : '';
        const base = kinPathBaseName(currentKinPath) || currentFilename || appConfig.defaultFilename;
        return parsed.volume + ':' + dir + '.~autosave-' + Date.now() + '-' + base;
    }

    async function writeAutosaveRecovery(bytes) {
        const recoveryPath = autosaveRecoveryPath();
        if (!recoveryPath) return false;
        try {
            await writeKinFileBytesSafe(recoveryPath, bytes);
            return true;
        } catch (_error) {}
        return false;
    }

    async function applyKinOfficePatch(targetPath, fileType, baseSha256, targetSha256, patchBytes, reason) {
        const response = await fetch('/api/file/patch_binary', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
                path: targetPath,
                fileType: fileType || currentFileType,
                baseSha256: baseSha256 || '',
                targetSha256: targetSha256 || '',
                reason: reason || 'save',
                patch_base64: bytesToBase64(patchBytes)
            })
        });
        const json = await response.json().catch(function() { return null; });
        if (!response.ok || !json || json.response !== 'success') {
            throw new Error((json && json.message) ? String(json.message) : 'Patch save failed');
        }
        return json;
    }

    async function patchCurrentDocument(reason) {
        if (!currentKinPath) throw new Error('Save As is required before this document can be patch-saved.');
        if (!currentBaselineBytes || !currentBaselineSha256) throw new Error('No trusted save baseline is available. Use Save As.');
        const exported = await exportLocalDocument();
        const bytes = exported.bytes;
        validateOfficeBytes(bytes);
        const targetSha256 = await sha256Hex(bytes);
        if (targetSha256 === currentBaselineSha256) {
            currentDirty = false;
            return { bytes, skipped: true };
        }
        const patchBytes = createOfficePackagePatchBytes(currentBaselineBytes, bytes);
        await applyKinOfficePatch(currentKinPath, currentFileType, currentBaselineSha256, targetSha256, patchBytes, reason || 'save');
        await updateBaseline(bytes);
        currentDirty = false;
        postToParent({ kinWorkspace: true, action: 'refreshAllDirectoryViews' });
        return { bytes, skipped: false };
    }

    function scheduleAutosave() {
        clearAutosaveTimer();
        if (!editorOpen || !currentDirty || !currentKinPath || autosavePaused) return;
        const wait = Math.max(KIN_AUTOSAVE_IDLE_MS, KIN_AUTOSAVE_MIN_INTERVAL_MS - (Date.now() - lastAutosaveAt));
        autosaveTimer = setTimeout(function() {
            autosaveTimer = null;
            runAutosave();
        }, wait);
    }

    async function runAutosave() {
        if (autosaveInFlight || saveInFlight || !editorOpen || !currentDirty || !currentKinPath || autosavePaused) return;
        autosaveInFlight = true;
        setEditorStatus('Autosaving...', { force: true });
        try {
            const result = await patchCurrentDocument('autosave');
            lastAutosaveAt = Date.now();
            if (!result.skipped) {
                const message = 'Autosaved ' + statusTime();
                setEditorStatus(message, { force: true, delay: 3000 });
                sendSaveResult(true, message);
            }
        } catch (error) {
            autosavePaused = true;
            let recoverySaved = false;
            try {
                const exported = await exportLocalDocument();
                if (exported && exported.bytes) recoverySaved = await writeAutosaveRecovery(exported.bytes);
            } catch (_recoveryError) {}
            const message = recoverySaved
                ? 'Autosave paused. Recovery saved.'
                : 'Autosave failed. Use Save As now.';
            setEditorStatus(message, { force: true });
            console.warn('[KinOffice] Autosave paused:', error && error.message ? error.message : error);
        } finally {
            autosaveInFlight = false;
            if (currentDirty && !autosavePaused) scheduleAutosave();
        }
    }

    async function loadBlankTemplateBytes(fileType) {
        const json = await kinOfficeCommand({ action: 'template', type: fileType || appConfig.fileType });
        const bytes = base64ToBytes(json.data_base64 || '');
        return bytes;
    }

    async function loadDebugDefaultDocumentBytes() {
        if (!appConfig.debugDefaultDocumentUrl) return null;
        const url = new URL(appConfig.debugDefaultDocumentUrl, import.meta.url).href;
        const response = await fetch(url, {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store'
        });
        if (!response.ok) {
            throw new Error('Could not load Kin Office debug document: HTTP ' + response.status);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        validateOfficeBytes(bytes);
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
        try {
            await opened;
            editorOpen = true;
            setEditorStatus('Ready', { force: true, delay: 2000 });
        } catch (error) {
            if (currentSession === session) currentSession = null;
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
            if (!opts.forceSaveAs && currentKinPath) {
                clearAutosaveTimer();
                setEditorStatus('Saving...', { force: true });
                await patchCurrentDocument('manual-save');
                const message = 'Saved ' + statusTime();
                setEditorStatus(message, { force: true, delay: 3000 });
                sendSaveResult(true, message);
                return;
            }
            setEditorStatus('Saving...', { force: true });
            const targetPath = await chooseSavePath(currentKinPath ? kinPathBaseName(currentKinPath) : currentFilename);
            const exported = await exportLocalDocument();
            const bytes = exported.bytes;
            validateOfficeBytes(bytes);
            await writeKinFileBytesSafe(targetPath, bytes);
            currentKinPath = targetPath;
            currentFilename = kinPathBaseName(targetPath) || exported.fileName || currentFilename;
            currentFileType = fileTypeFromName(currentFilename, exported.fileType || currentFileType);
            await updateBaseline(bytes);
            currentDirty = false;
            autosavePaused = false;
            lastAutosaveAt = Date.now();
            const message = 'Saved ' + statusTime();
            setEditorStatus(message, { force: true, delay: 3000 });
            sendSaveResult(true, message);
            postToParent({ kinWorkspace: true, action: 'refreshAllDirectoryViews' });
        })();
        try {
            await saveInFlight;
        } catch (error) {
            if (!error || error.message !== 'cancel') {
                const message = error && error.message ? error.message : String(error);
                setEditorStatus('Save failed: ' + message, { force: true });
                sendSaveResult(false, message);
            }
            throw error;
        } finally {
            saveInFlight = null;
        }
    }

    async function openKinPath(kinPath) {
        currentKinPath = kinPath;
        currentDirty = false;
        clearAutosaveTimer();
        autosavePaused = false;
        const bytes = await readKinFileBytes(kinPath);
        await updateBaseline(bytes);
        await openLocalDocument({
            kinPath,
            fileName: kinPathBaseName(kinPath) || appConfig.defaultFilename,
            fileType: fileTypeFromName(kinPathBaseName(kinPath), appConfig.fileType),
            bytes,
            isNew: false
        });
    }

    async function openBlankDocument() {
        currentKinPath = null;
        currentDirty = false;
        clearAutosaveTimer();
        autosavePaused = false;
        await updateBaseline(null);
        const debugBytes = await loadDebugDefaultDocumentBytes();
        if (debugBytes) {
            await updateBaseline(debugBytes);
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
            await openAlert(error && error.message ? error.message : String(error), 'Kin Office');
        }
    }

    async function handleEditorEvent(data) {
        if (!data) return;
        if (data.event === 'ready') {
            if (pendingOpen) {
                const pending = pendingOpen;
                pendingOpen = null;
                pending.resolve();
            }
            return;
        }
        if (data.event === 'documentStateChange') {
            currentDirty = !!data.changed;
            if (currentDirty) {
                setEditorStatus(currentKinPath ? 'Unsaved changes' : 'Save As required before autosave', { force: true });
                scheduleAutosave();
            } else {
                clearAutosaveTimer();
            }
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
            const pending = pendingExports.get(data.requestId || '');
            if (!pending) return;
            pendingExports.delete(data.requestId || '');
            pending.reject(new Error(data.error || 'Kin Office export failed'));
            return;
        }
        if (data.event === 'error') {
            const message = data.error || 'unknown error';
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
