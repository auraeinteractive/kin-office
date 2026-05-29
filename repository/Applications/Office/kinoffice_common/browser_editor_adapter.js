(function() {
    'use strict';

    var API_URL = 'vendor/kin-office/packages/kin-office/7/web-apps/apps/api/documents/api.js';
    var X2T_URL = 'vendor/kin-office/packages/kin-office/7/wasm/x2t/x2t.js';
    var apiPromise = null;
    var x2tPromise = null;
    var workingDirsReady = false;

    function loadScript(src) {
        return new Promise(function(resolve, reject) {
            var existing = document.querySelector('script[data-kin-office-src="' + src + '"]');
            if (existing) {
                if (existing.getAttribute('data-kin-loaded') === 'true') {
                    resolve();
                    return;
                }
                existing.addEventListener('load', function() { resolve(); });
                existing.addEventListener('error', function() { reject(new Error('Could not load ' + src)); });
                return;
            }
            var script = document.createElement('script');
            script.setAttribute('data-kin-office-src', src);
            script.src = src;
            script.onload = function() {
                script.setAttribute('data-kin-loaded', 'true');
                resolve();
            };
            script.onerror = function() {
                reject(new Error('Could not load Kin Office browser SDK from ' + src));
            };
            document.head.appendChild(script);
        });
    }

    function loadApi() {
        if (window.DocsAPI && window.DocsAPI.DocEditor) {
            return Promise.resolve();
        }
        if (!apiPromise) {
            apiPromise = loadScript(API_URL).then(function() {
                if (!window.DocsAPI || !window.DocsAPI.DocEditor) {
                    throw new Error('Kin Office browser SDK loaded without DocsAPI.DocEditor.');
                }
            });
        }
        return apiPromise;
    }

    function documentTypeFor(fileType) {
        if (fileType === 'xlsx') return 'cell';
        if (fileType === 'pptx') return 'slide';
        return 'word';
    }

    function isZipBytes(bytes) {
        return bytes && bytes.length >= 4 &&
            bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
    }

    function isInternalBinString(value) {
        return typeof value === 'string' && /^(DOCY|XLSY|PPTY);/.test(value);
    }

    function internalBinPrefixFor(fileType) {
        if (fileType === 'xlsx') return 'XLSY';
        if (fileType === 'pptx') return 'PPTY';
        return 'DOCY';
    }

    function defaultInternalBinVersion(fileType) {
        if (fileType === 'xlsx') return '2';
        if (fileType === 'pptx') return '10';
        return '5';
    }

    function parseInternalBinHeader(value) {
        var match = typeof value === 'string' ? /^(DOCY|XLSY|PPTY);v([^;]+);/.exec(value) : null;
        return match ? { prefix: match[1], version: match[2] } : null;
    }

    function bytesToBase64(bytes) {
        var binary = '';
        var chunk = 0x8000;
        for (var i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
    }

    function normalizeBytes(value) {
        if (!value) return null;
        if (value instanceof Uint8Array) return value;
        if (value instanceof ArrayBuffer) return new Uint8Array(value);
        if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength);
        if (typeof value === 'string') {
            if (isInternalBinString(value)) return null;
            try {
                var binary = atob(value);
                if (binary && binary.length) {
                    var decoded = new Uint8Array(binary.length);
                    for (var i = 0; i < binary.length; i += 1) decoded[i] = binary.charCodeAt(i);
                    if (decoded.length) return decoded;
                }
            } catch (_error) {
                // Not base64; fall through to the internal text representation.
            }
            return new TextEncoder().encode(value);
        }
        if (value && value.buffer instanceof ArrayBuffer) return new Uint8Array(value.buffer);
        return null;
    }

    function findFirstUsefulPayload(value) {
        if (!value) return null;
        var direct = normalizeBytes(value);
        if (direct && direct.length) return value;
        if (typeof value !== 'object') return null;
        var keys = [
            'data', 'url', 'file', 'document', 'buffer', 'arrayBuffer', 'output',
            'payload', 'bin', 'content', 'result'
        ];
        for (var i = 0; i < keys.length; i += 1) {
            if (value[keys[i]] === undefined || value[keys[i]] === null) continue;
            var found = findFirstUsefulPayload(value[keys[i]]);
            if (found) return found;
        }
        return null;
    }

    function extractEventBytes(event) {
        var raw = extractEventPayload(event);
        var bytes = normalizeBytes(raw);
        return bytes && bytes.length ? bytes : null;
    }

    function extractEventPayload(event) {
        var data = event && event.data !== undefined ? event.data : event;
        return findFirstUsefulPayload(data);
    }

    function bytesForNewDocument(fileType) {
        var key = '.' + String(fileType || 'docx').replace(/^\./, '').toLowerCase();
        var templates = window.KinOfficeEmptyBin || {};
        if (!templates[key]) {
            throw new Error('No local blank template is available for ' + key);
        }
        return templates[key];
    }

    function sanitizeFileName(name) {
        var clean = String(name || 'Document.docx')
            .replace(/[/?<>\\:*|"]/g, '')
            .replace(/[\x00-\x1f\x80-\x9f]/g, '')
            .replace(/[&'%!"{}[\]]/g, '')
            .trim();
        return clean || 'Document.docx';
    }

    function escapeXml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    function createConversionParams(fromPath, toPath, options) {
        var opts = options || {};
        var fontDir = opts.fontDir === undefined ? '/working/fonts/' : opts.fontDir;
        var themeDir = opts.themeDir === undefined ? '/working/themes' : opts.themeDir;
        var lines = [
            '<?xml version="1.0" encoding="utf-8"?>',
            '<TaskQueueDataConvert xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">',
            '  <m_sFileFrom>' + escapeXml(fromPath) + '</m_sFileFrom>',
            '  <m_sFileTo>' + escapeXml(toPath) + '</m_sFileTo>',
            '  <m_bIsNoBase64>true</m_bIsNoBase64>',
            '  <m_sThemeDir>' + escapeXml(themeDir) + '</m_sThemeDir>',
            '  <m_sFontDir>' + escapeXml(fontDir) + '</m_sFontDir>',
            '  <m_bEmbeddedFonts>false</m_bEmbeddedFonts>',
            '</TaskQueueDataConvert>'
        ];
        return lines.join('\n');
    }

    function ensureX2T() {
        if (window.Module && window.Module.FS && typeof window.Module.ccall === 'function') {
            return Promise.resolve(window.Module);
        }
        if (x2tPromise) return x2tPromise;
        x2tPromise = new Promise(function(resolve, reject) {
            var previousModule = window.Module || {};
            window.Module = previousModule;
            previousModule.noInitialRun = true;
            previousModule.noExitRuntime = true;
            previousModule.onRuntimeInitialized = function() {
                if (!window.Module || !window.Module.FS || typeof window.Module.ccall !== 'function') {
                    reject(new Error('X2T WASM initialized without FS/ccall.'));
                    return;
                }
                resolve(window.Module);
            };
            loadScript(X2T_URL).catch(reject);
        });
        return x2tPromise;
    }

    function ensureWorkingDirs(module) {
        if (workingDirsReady) return;
        ['/working', '/working/media', '/working/fonts', '/working/themes'].forEach(function(dir) {
            try { module.FS.mkdir(dir); } catch (_error) {}
        });
        workingDirsReady = true;
    }

    function convertDocumentToBin(bytes, fileName, fileType) {
        var inputExt = String(fileType || 'docx').replace(/^\./, '').toLowerCase();
        return ensureX2T().then(function(module) {
            ensureWorkingDirs(module);
            var inputBytes = normalizeBytes(bytes);
            if (!isZipBytes(inputBytes)) throw new Error('Kin Office can only open valid Office ZIP bytes from Kin.');
            var cleanName = sanitizeFileName(fileName || ('Document.' + inputExt));
            var stem = cleanName.replace(/\.[^/.]+$/, '') || 'Document';
            var unique = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            var inputPath = '/working/' + stem + '-' + unique + '.' + inputExt;
            var outputPath = inputPath + '.bin';
            var paramsPath = '/working/open-params-' + unique + '.xml';
            module.FS.writeFile(inputPath, inputBytes);
            module.FS.writeFile(paramsPath, createConversionParams(inputPath, outputPath));
            var code = module.ccall('main1', 'number', ['string'], [paramsPath]);
            if (code !== 0) throw new Error('Kin Office x2t open conversion failed with code: ' + code);
            var bin = module.FS.readFile(outputPath, { encoding: 'binary' });
            return {
                bin: bin,
                media: readMediaFiles(module)
            };
        });
    }

    function readMediaFiles(module) {
        var media = {};
        try {
            module.FS.readdir('/working/media/').forEach(function(file) {
                if (file === '.' || file === '..') return;
                try {
                    var fileData = module.FS.readFile('/working/media/' + file, { encoding: 'binary' });
                    media['media/' + file] = window.URL.createObjectURL(new Blob([fileData]));
                } catch (_error) {}
            });
        } catch (_error) {}
        return media;
    }

    function wrapInternalBinPayload(rawPayload, fileType, templatePayload) {
        if (isInternalBinString(rawPayload)) return rawPayload;
        var bytes = normalizeBytes(rawPayload);
        if (!bytes || !bytes.length) {
            throw new Error('Kin Office serializer returned empty editor data.');
        }
        var templateHeader = parseInternalBinHeader(templatePayload);
        var prefix = templateHeader && templateHeader.prefix ? templateHeader.prefix : internalBinPrefixFor(fileType);
        var version = templateHeader && templateHeader.version ? templateHeader.version : defaultInternalBinVersion(fileType);
        // x2t does not accept the raw native serializer bytes alone. It expects
        // the same internal envelope used by Euro-Office bin files.
        return prefix + ';v' + version + ';' + bytes.length + ';' + bytesToBase64(bytes);
    }

    function wrapNativeFileParts(data, header, fileType) {
        if (isInternalBinString(data)) return data;
        var bytes = normalizeBytes(data);
        if (!bytes || !bytes.length) {
            throw new Error('Kin Office native serializer returned empty editor data.');
        }
        if (isZipBytes(bytes)) return bytes;
        var cleanHeader = typeof header === 'string' ? header : '';
        if (!/^(DOCY|XLSY|PPTY);v[^;]+;\d+;$/.test(cleanHeader)) {
            cleanHeader = internalBinPrefixFor(fileType) + ';v' + defaultInternalBinVersion(fileType) + ';' + bytes.length + ';';
        }
        return cleanHeader + bytesToBase64(bytes);
    }

    function convertBinToDocument(rawPayload, fileName, fileType, templatePayload) {
        var targetExt = String(fileType || 'docx').replace(/^\./, '').toLowerCase();
        return ensureX2T().then(function(module) {
            ensureWorkingDirs(module);
            var stem = sanitizeFileName(fileName || ('Document.' + targetExt)).replace(/\.[^/.]+$/, '') || 'Document';
            var unique = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            var inputPath = '/working/' + stem + '-' + unique + '.' + internalBinPrefixFor(targetExt).toLowerCase();
            var outputPath = '/working/' + stem + '-' + unique + '.' + targetExt;
            var data = wrapInternalBinPayload(rawPayload, targetExt, templatePayload);
            if (!data || (data.length !== undefined && data.length === 0)) {
                throw new Error('Kin Office export returned empty editor data.');
            }
            module.FS.writeFile(inputPath, data);
            module.FS.writeFile('/working/params-' + unique + '.xml', createConversionParams(inputPath, outputPath));
            var code = module.ccall('main1', 'number', ['string'], ['/working/params-' + unique + '.xml']);
            if (code !== 0) throw new Error('Kin Office x2t conversion failed with code: ' + code);
            return normalizeBytes(module.FS.readFile(outputPath, { encoding: 'binary' }));
        }).then(function(bytes) {
            if (!isZipBytes(bytes)) throw new Error('Kin Office export did not produce an Office ZIP file.');
            return bytes;
        });
    }

    function getInnerFrame() {
        var frame = document.querySelector('iframe[name="frameEditor"]');
        if (!frame || !frame.contentWindow) {
            throw new Error('Kin Office inner editor iframe is not available.');
        }
        return frame;
    }

    function getInnerWindow() {
        return getInnerFrame().contentWindow;
    }

    function getMainController(fileType) {
        var inner = getInnerWindow();
        var app = fileType === 'xlsx' ? inner.SSE : (fileType === 'pptx' ? inner.PE : inner.DE);
        if (!app || typeof app.getController !== 'function') {
            throw new Error('Kin Office ' + fileType + ' controller is not available yet.');
        }
        var main = app.getController('Main');
        if (!main || !main.api) {
            throw new Error('Kin Office Main controller API is not ready.');
        }
        return main;
    }

    function serializeViaNativeFileData(api, fileType) {
        if (!api || typeof api.asc_nativeGetFileData !== 'function') return null;
        var inner = getInnerWindow();
        var nativeHost = inner.native || (inner.native = {});
        var originalSaveEnd = nativeHost.Save_End;
        var capturedHeader = '';
        nativeHost.Save_End = function(header) {
            capturedHeader = typeof header === 'string' ? header : '';
        };
        try {
            var data = api.asc_nativeGetFileData();
            if (!capturedHeader) return null;
            return wrapNativeFileParts(data, capturedHeader, fileType);
        } finally {
            nativeHost.Save_End = originalSaveEnd;
        }
    }

    function serializeCurrentBin(fileType) {
        var main = getMainController(fileType);
        var api = main.api;
        if (api && typeof api.getFileAsFromChanges === 'function') {
            // Source-level Euro-Office save helper. It wraps asc_nativeGetFile3()
            // and applies editor-specific state guards before serialization.
            var changedFile = api.getFileAsFromChanges();
            return wrapNativeFileParts(changedFile && changedFile.data, changedFile && changedFile.header, fileType);
        }
        if (api && typeof api.asc_nativeGetFile3 === 'function') {
            // Euro-Office source exposes one native save API for documents,
            // sheets, and slides. It returns raw bin bytes plus the x2t header.
            var nativeFile = api.asc_nativeGetFile3();
            return wrapNativeFileParts(nativeFile && nativeFile.data, nativeFile && nativeFile.header, fileType);
        }
        var nativeFileData = serializeViaNativeFileData(api, fileType);
        if (nativeFileData) return nativeFileData;
        throw new Error('Kin Office source-level native serializer is not available for ' + fileType + '.');
    }

    function installDirectSaveHook(fileType, onSaveRequested) {
        if (typeof onSaveRequested !== 'function') return;
        var main = getMainController(fileType);
        var api = main.api;
        var inner = getInnerWindow();
        // Vendored UI patches call this before they can enter the upstream
        // native save UI. The api.asc_Save override is the fallback path.
        inner.KinOfficeDirectSave = function() {
            onSaveRequested();
            return true;
        };
        if (!api || api._kinDirectSaveInstalled) return;
        api._kinDirectSaveInstalled = true;
        api._kinOriginalAscSave = api.asc_Save;
        // Redirect the save button and keyboard save path. The native
        // handler calls api.asc_Save(), but Kin owns persistence directly.
        api.asc_Save = function() {
            onSaveRequested();
            return true;
        };
    }

    function installDirectSaveHookSoon(fileType, onSaveRequested, onError, attemptsLeft) {
        try {
            installDirectSaveHook(fileType, onSaveRequested);
        } catch (error) {
            if ((attemptsLeft || 0) <= 0) {
                if (onError) onError(error);
                return;
            }
            setTimeout(function() {
                installDirectSaveHookSoon(fileType, onSaveRequested, onError, attemptsLeft - 1);
            }, 100);
        }
    }

    function postInnerEditorCommand(command, data) {
        var frame = document.querySelector('iframe[name="frameEditor"]');
        if (!frame || !frame.contentWindow) return;
        frame.contentWindow.postMessage({
            command: command,
            data: data
        }, window.location.origin);
    }

    function createInstance(options) {
        var opts = options || {};
        var fileName = String(opts.fileName || 'Document.docx');
        var fileType = String(opts.fileType || fileName.split('.').pop() || 'docx').replace(/^\./, '').toLowerCase();
        var containerId = String(opts.containerId || 'editor');
        var sourcePromise = opts.isNew
            ? Promise.resolve({ bin: bytesForNewDocument(fileType), media: {} })
            : convertDocumentToBin(opts.bytes, fileName, fileType);
        var editor = null;
        var sourcePayload = null;
        var sourceMedia = {};

        if (!opts.isNew && !opts.bytes) {
            throw new Error('No document bytes were provided.');
        }

        return sourcePromise.then(function(source) {
            sourcePayload = source.bin;
            sourceMedia = source.media || {};
            return loadApi();
        }).then(function() {
            var container = document.getElementById(containerId);
            if (!container) {
                throw new Error('Editor container not found: ' + containerId);
            }
            container.innerHTML = '';

            editor = new window.DocsAPI.DocEditor(containerId, {
                document: {
                    title: fileName,
                    url: fileName,
                    fileType: fileType,
                    permissions: {
                        edit: true,
                        download: true,
                        print: true,
                        review: true,
                        chat: false,
                        protect: false
                    }
                },
                documentType: documentTypeFor(fileType),
                editorConfig: {
                    lang: opts.lang || 'en',
                    mode: 'edit',
                    customization: {
                        autosave: false,
                        forcesave: false,
                        help: false,
                        about: false,
                        feedback: false,
                        compactHeader: false,
                        hideRightMenu: true,
                        layout: {
                            header: {
                                users: false,
                                user: false
                            }
                        },
                        anonymous: {
                            request: false,
                            label: 'Kin User'
                        }
                    }
                },
                events: {
                    writeFile: function(event) {
                        extractEventBytes(event);
                        postInnerEditorCommand('asc_writeFileCallback', {
                            status: 'ok',
                            data: 'ok'
                        });
                    },
                    onAppReady: function() {
                        try {
                            if (sourceMedia && Object.keys(sourceMedia).length && typeof editor.sendCommand === 'function') {
                                editor.sendCommand({
                                    command: 'asc_setImageUrls',
                                    data: { urls: sourceMedia }
                                });
                            }
                            editor.sendCommand({
                                command: 'asc_openDocument',
                                data: { buf: sourcePayload }
                            });
                        } catch (error) {
                            if (opts.onError) opts.onError(error);
                        }
                    },
                    onDocumentReady: function() {
                        installDirectSaveHookSoon(fileType, opts.onSaveRequested, opts.onError, 20);
                        if (opts.onReady) opts.onReady();
                    },
                    onDocumentStateChange: function(event) {
                        if (opts.onDirty) opts.onDirty(!!(event && event.data));
                    },
                    onSave: function(event) {
                        extractEventBytes(event);
                        if (opts.onSaveRequested) {
                            opts.onSaveRequested();
                        }
                    },
                    onDownloadAs: function(event) {
                        extractEventBytes(event);
                    },
                    onError: function(event) {
                        var message = event && event.data ? String(event.data) : 'Kin Office local editor error';
                        if (opts.onError) opts.onError(new Error(message));
                    }
                },
                type: 'desktop',
                width: '100%',
                height: '100%'
            });

            return {
                destroy: function() {
                    if (editor && typeof editor.destroyEditor === 'function') {
                        try { editor.destroyEditor(); } catch (_error) {}
                    }
                    editor = null;
                },
                processSaveResult: function(success, message) {
                    postInnerEditorCommand('asc_onSaveCallback', success === false ? {
                        err_code: 1,
                        message: message || 'Save failed'
                    } : {
                        err_code: 0
                    });
                    postInnerEditorCommand('processSaveResult', {
                        result: !!success,
                        message: message || ''
                    });
                },
                forceSaveComplete: function(success, message) {
                    this.processSaveResult(success !== false, message || '');
                },
                exportDocument: function() {
                    return new Promise(function(resolve, reject) {
                        if (!editor) {
                            reject(new Error('Kin Office editor is not available.'));
                            return;
                        }
                        // Kin direct-save path: do not call asc_Save() or downloadAs().
                        // Those APIs enter the upstream server/collaboration save state machine.
                        var bin = serializeCurrentBin(fileType);
                        if (isZipBytes(bin)) {
                            resolve({ fileName: fileName, fileType: fileType, bytes: bin });
                            return;
                        }
                        convertBinToDocument(bin, fileName, fileType, sourcePayload)
                            .then(function(bytes) { resolve({ fileName: fileName, fileType: fileType, bytes: bytes }); })
                            .catch(reject);
                    });
                }
            };
        });
    }

    window.KinOfficeBrowser = {
        create: createInstance
    };
}());
