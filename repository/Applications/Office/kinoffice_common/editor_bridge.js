(function() {
    'use strict';

    var API_URL = 'vendor/kin-office/packages/kin-office/7/web-apps/apps/api/documents/api.js';
    var apiPromise = null;
    var KINOFFICE_DEBUG = false;

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

    function normalizeBytes(value) {
        if (!value) return null;
        if (value instanceof Uint8Array) return value;
        if (value instanceof ArrayBuffer) return new Uint8Array(value);
        if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength);
        return null;
    }

    function isZipBytes(bytes) {
        return bytes && bytes.length >= 4 &&
            bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
    }

    function getInnerWindow() {
        var frame = document.querySelector('iframe[name="frameEditor"]');
        if (!frame || !frame.contentWindow) {
            throw new Error('Kin Office inner editor iframe is not available.');
        }
        return frame.contentWindow;
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

    function installDirectSaveHook(fileType, onSaveRequested) {
        if (typeof onSaveRequested !== 'function') return;
        var main = getMainController(fileType);
        var api = main.api;
        var inner = getInnerWindow();
        inner.KinOfficeDirectSave = function() {
            onSaveRequested();
            return true;
        };
        if (!api || api._kinDirectSaveInstalled) return;
        api._kinDirectSaveInstalled = true;
        api._kinOriginalAscSave = api.asc_Save;
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
        frame.contentWindow.postMessage({ command: command, data: data }, window.location.origin);
    }

    function describeEditorError(event) {
        var data = event && event.data;
        if (!data) return 'Kin Office local editor error';
        if (typeof data === 'string') return data;
        if (data.errorDescription) return String(data.errorDescription);
        if (data.message) return String(data.message);
        if (data.error) return String(data.error);
        if (data.errorCode) return 'Kin Office local editor error: ' + data.errorCode;
        try {
            return JSON.stringify(data);
        } catch (_error) {
            return 'Kin Office local editor error';
        }
    }

    function createInstance(options) {
        var opts = options || {};
        var fileName = String(opts.fileName || 'Document.docx');
        var fileType = String(opts.fileType || fileName.split('.').pop() || 'docx').replace(/^\./, '').toLowerCase();
        var containerId = String(opts.containerId || 'editor');
        var sourceUrl = String(opts.url || '');
        var editor = null;
        var pendingBinarySave = null;

        if (!sourceUrl) {
            return Promise.reject(new Error('No document URL was provided.'));
        }

        return loadApi().then(function() {
            var container = document.getElementById(containerId);
            if (!container) {
                throw new Error('Editor container not found: ' + containerId);
            }
            container.innerHTML = '';

            editor = new window.DocsAPI.DocEditor(containerId, {
                document: {
                    title: fileName,
                    url: sourceUrl,
                    fileType: fileType,
                    key: opts.documentKey || (fileName + '-' + Date.now()),
                    options: {
                        oform: false
                    },
                    permissions: {
                        edit: true,
                        download: true,
                        print: true,
                        review: true,
                        chat: false,
                        protect: false,
                        comment: false,
                        fillForms: false,
                        modifyFilter: true,
                        modifyContentControl: true,
                        copy: true,
                        canCoAuthoring: false
                    }
                },
                documentType: documentTypeFor(fileType),
                editorConfig: {
                    lang: opts.lang || 'en',
                    mode: 'edit',
                    canCoAuthoring: false,
                    user: {
                        id: 'kin-local-user',
                        name: 'Kin User'
                    },
                    coEditing: {
                        mode: 'strict',
                        change: false
                    },
                    customization: {
                        autosave: false,
                        forcesave: false,
                        help: false,
                        about: false,
                        feedback: false,
                        hideRightMenu: true,
                        anonymous: { request: false, label: 'Kin User' }
                    }
                },
                events: {
                    writeFile: function() {
                        postInnerEditorCommand('asc_writeFileCallback', { status: 'ok', data: 'ok' });
                    },
                    onDocumentReady: function() {
                        try {
                            installDirectSaveHookSoon(fileType, opts.onSaveRequested, opts.onError, 20);
                            if (opts.onReady) opts.onReady();
                        } catch (error) {
                            if (opts.onError) opts.onError(error);
                        }
                    },
                    onDocumentStateChange: function(event) {
                        if (opts.onDirty) opts.onDirty(!!(event && event.data));
                    },
                    onSave: function() {
                        if (opts.onSaveRequested) opts.onSaveRequested();
                    },
                    onSaveDocument: function(event) {
                        var bytes = normalizeBytes(event && event.data);
                        if (!bytes || !bytes.length) {
                            if (pendingBinarySave) pendingBinarySave.reject(new Error('Kin Office save returned empty data.'));
                            pendingBinarySave = null;
                            return;
                        }
                        if (pendingBinarySave) {
                            pendingBinarySave.resolve(bytes);
                            pendingBinarySave = null;
                        }
                    },
                    onError: function(event) {
                        var message = describeEditorError(event);
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
                    } : { err_code: 0 });
                    postInnerEditorCommand('processSaveResult', {
                        result: !!success,
                        message: message || ''
                    });
                },
                exportDocument: function() {
                    return new Promise(function(resolve, reject) {
                        var main = getMainController(fileType);
                        var api = main.api;
                        if (KINOFFICE_DEBUG) {
                            console.log('[kinoffice] binary save APIs:', {
                                checkSaveDocumentEvent: typeof api.checkSaveDocumentEvent,
                                asc_Save: typeof api.asc_Save
                            });
                        }
                        pendingBinarySave = { resolve: resolve, reject: reject };
                        setTimeout(function() {
                            if (!pendingBinarySave) return;
                            pendingBinarySave = null;
                            reject(new Error('Kin Office binary save timed out.'));
                        }, 30000);
                        if (api && typeof api.checkSaveDocumentEvent === 'function') {
                            api.checkSaveDocumentEvent(true);
                        } else if (api && typeof api.asc_Save === 'function') {
                            api.asc_Save();
                        } else {
                            pendingBinarySave = null;
                            reject(new Error('Kin Office binary save API is not available.'));
                        }
                    }).then(function(bytes) {
                        return { fileName: fileName, fileType: fileType, bytes: bytes };
                    });
                }
            };
        });
    }

    window.KinOfficeBrowser = { create: createInstance };
}());
