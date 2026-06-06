(function() {
    'use strict';

    var API_URL = 'vendor/kin-office/packages/kin-office/7/web-apps/apps/api/documents/api.js';
    var X2T_URL = 'vendor/kin-office/packages/kin-office/7/wasm/x2t/x2t.js';
    var apiPromise = null;
    var x2tPromise = null;
    var cachePurgePromise = null;
    var workingDirsReady = false;
    // Collaboration is intentionally disabled for now. The service/transport
    // prototype did not complete a reliable Euro-Office co-authoring handshake;
    // see specs/plans/collaboration.md before re-enabling.
    var KIN_OFFICE_COLLAB_ENABLED = false;

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

    function purgeEuroOfficeBrowserCaches() {
        if (cachePurgePromise) return cachePurgePromise;
        cachePurgePromise = Promise.all([
            (navigator.serviceWorker && navigator.serviceWorker.getRegistrations
                ? navigator.serviceWorker.getRegistrations().then(function(registrations) {
                    return Promise.all(registrations.map(function(registration) {
                        var scope = String(registration && registration.scope || '');
                        if (scope.indexOf('/repository/kinoffice_common/vendor/kin-office/') === -1) {
                            return false;
                        }
                        return registration.unregister();
                    }));
                }).catch(function(error) {
                })
                : Promise.resolve()),
            (window.caches && window.caches.keys
                ? window.caches.keys().then(function(keys) {
                    return Promise.all(keys.map(function(key) {
                        if (!/^document_editor_(static|dynamic)_/.test(String(key))) {
                            return false;
                        }
                        return window.caches.delete(key);
                    }));
                }).catch(function(error) {
                })
                : Promise.resolve())
        ]).then(function() {
        });
        return cachePurgePromise;
    }

    function loadApi() {
        if (window.DocsAPI && window.DocsAPI.DocEditor) {
            return Promise.resolve();
        }
        if (!apiPromise) {
            apiPromise = purgeEuroOfficeBrowserCaches().then(function() {
                return loadScript(API_URL);
            }).then(function() {
                if (!window.DocsAPI || !window.DocsAPI.DocEditor) {
                    throw new Error('Kin Office browser SDK loaded without DocsAPI.DocEditor.');
                }
                });
        }
        return apiPromise;
    }

    function innerFontPath(inner) {
        try {
            var marker = '/web-apps/apps/';
            var href = inner.location.href;
            var idx = href.indexOf(marker);
            if (idx !== -1) return href.slice(0, idx) + '/fonts/';
            return new URL('../../../../fonts/', href).href;
        } catch (_error) {
            return '../../../../fonts/';
        }
    }

    function describeInnerFont(fonts, name) {
        var map = fontNameMap(fonts);
        var infos = fontInfos(fonts);
        var index = map && map[name];
        var info = index !== undefined && infos ? infos[index] : null;
        if (!info) return null;
        return {
            name: info.Name || info.ya,
            indexR: info.indexR !== undefined ? info.indexR : info.N3,
            faceIndexR: info.faceIndexR !== undefined ? info.faceIndexR : info.Ldb,
            indexI: info.indexI !== undefined ? info.indexI : info.hda,
            faceIndexI: info.faceIndexI !== undefined ? info.faceIndexI : info.rnc,
            indexB: info.indexB !== undefined ? info.indexB : info.rP,
            faceIndexB: info.faceIndexB !== undefined ? info.faceIndexB : info.pnc
        };
    }

    function fontFiles(fonts) {
        return fonts && (fonts.g_font_files || fonts.Snc) || null;
    }

    function fontInfos(fonts) {
        return fonts && (fonts.g_font_infos || fonts.i4a) || null;
    }

    function fontNameMap(fonts) {
        return fonts && (fonts.g_map_font_index || fonts.y0b) || null;
    }

    function fontApplication(fonts) {
        return fonts && (fonts.g_fontApplication || fonts.CQ) || null;
    }

    function fontFileId(file) {
        return file && (file.Id || file.Va || file.id || file.name);
    }

    function fontInfoName(info) {
        return info && (info.Name || info.ya);
    }

    function installInnerFontProbe(reason, fileType) {
        var inner = getInnerWindow();
        var fonts = inner.AscFonts;
        var loader = inner.AscCommon && inner.AscCommon.g_font_loader;
        var files = fontFiles(fonts);
        var infos = fontInfos(fonts);
        var map = fontNameMap(fonts);
        var app = fontApplication(fonts);
        if (loader && !loader._kinParentFontPathForced) {
            loader._kinParentFontPathForced = true;
            loader.fontFilesPath = innerFontPath(inner);
        }
        if (!fonts || !files || !infos || !app || !map) {
            return false;
        }
        installInnerPackagedFontPicker(inner, fonts);
        installInnerFontDropdownLabels(inner, fileType);
        return true;
    }

    function installInnerFontDropdownLabels(inner, fileType) {
        if (fileType !== 'docx') return;
        try {
            if (inner._kinParentFontDropdownLabelsInstalled) return;
            var app = inner.DE;
            if (!app || typeof app.getController !== 'function') return;
            var toolbarCtrl = app.getController('Toolbar');
            var combo = toolbarCtrl && toolbarCtrl.toolbar && toolbarCtrl.toolbar.cmbFontName;
            if (!combo || !combo.store || !combo.el) return;
            inner._kinParentFontDropdownLabelsInstalled = true;

            function ensureLabels() {
                var $ = inner.$ || inner.jQuery;
                if (!$) return;
                $(combo.el).find('a.font-item').each(function(index, anchor) {
                    if (anchor.querySelector('.font-item-label')) return;
                    var li = anchor.closest('li');
                    var record = li && li.id ? combo.store.get(li.id) : combo.store.at(index);
                    var name = record && record.get ? record.get('name') : '';
                    if (!name) return;
                    var span = inner.document.createElement('span');
                    span.className = 'font-item-label';
                    span.textContent = name;
                    span.style.cssText = 'display:inline-block;padding:0 8px;line-height:28px;position:relative;z-index:1;';
                    anchor.appendChild(span);
                });
            }

            combo.on('show:after', ensureLabels);
            if (inner.Common && inner.Common.NotificationCenter) {
                inner.Common.NotificationCenter.on('fonts:load', function() {
                    inner.setTimeout(ensureLabels, 0);
                });
            }
            ensureLabels();
        } catch (_error) {}
    }

    function installInnerPackagedFontPicker(inner, fonts) {
        var app = fonts && fonts.g_fontApplication;
        var map = fontNameMap(fonts);
        var infos = fontInfos(fonts);
        app = fontApplication(fonts);
        if (!app || !map || app._kinParentFontPickerInstalled) return;
        app._kinParentFontPickerInstalled = true;

        function has(name) {
            return name !== undefined && name !== null && map[String(name)] !== undefined;
        }
        function hasCjk(value) {
            var text = String(value || '');
            for (var i = 0; i < text.length; i += 1) {
                var code = text.charCodeAt(i);
                if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) return true;
            }
            return false;
        }
        function resolve(name) {
            var requested = String(name || '').replace(/^[\s'"]+|[\s'"]+$/g, '');
            if (has(requested)) return requested;
            var lower = requested.toLowerCase();
            if (lower === 'serif') return has('Times New Roman') ? 'Times New Roman' : 'Noto Serif';
            if (lower === 'monospace') return has('Courier New') ? 'Courier New' : 'Liberation Mono';
            if (lower === 'sans-serif' || !requested) return has('Arial') ? 'Arial' : 'Liberation Sans';
            if (hasCjk(requested)) return has('Noto Sans CJK SC') ? 'Noto Sans CJK SC' : 'DengXian';
            return has('Arial') ? 'Arial' : (has('Liberation Sans') ? 'Liberation Sans' : Object.keys(map)[0]);
        }
        function pick(name, style) {
            var resolved = resolve(name);
            return { m_wsFontName: resolved, m_lStyle: style || 0 };
        }
        function pickMinified(name, style) {
            var resolved = resolve(name);
            return { uda: resolved, m_wsFontName: resolved, dL: String(name || '') };
        }

        if (fonts.g_fontApplication) {
            app.GetFontFileWeb = pick;
            app.GetFontFile = pick;
            app.GetFontInfoName = function(name, objDst) {
                var resolved = resolve(name);
                if (objDst !== undefined) {
                    objDst.Name = resolved;
                    objDst.Replace = app.CheckReplaceGlyphsMap ? app.CheckReplaceGlyphsMap(name, objDst) : null;
                }
                return resolved;
            };
            app.GetFontInfoWithoutEmbed = function(name, _style, objDst) {
                var resolved = resolve(name);
                if (objDst !== undefined) {
                    objDst.Name = resolved;
                    objDst.Replace = app.CheckReplaceGlyphsMap ? app.CheckReplaceGlyphsMap(name, objDst) : null;
                }
                return infos[map[resolved]];
            };
            app.GetFontInfo = app.GetFontInfoWithoutEmbed;
            app.LoadFontWithoutEmbed = function(name, _fontLoader, fontManager, size, style, horDpi, verDpi, transform, objDst) {
                var info = app.GetFontInfoWithoutEmbed(name, style, objDst);
                return info.LoadFont(inner.AscCommon.g_font_loader, fontManager, size, style, horDpi, verDpi, transform);
            };
            app.LoadFont = app.LoadFontWithoutEmbed;
        } else {
            if (app.v1d) app.v1d = {};
            app.Yed = pickMinified;
            app.mEc = function(name) {
                return resolve(name);
            };
            app.bC = app.Wof = app.sah = function(name, _style, objDst) {
                var selected = pickMinified(name, _style);
                if (objDst !== undefined) {
                    objDst.ya = selected.uda;
                    objDst.SS = app.sgf ? app.sgf(name, objDst) : null;
                }
                return infos[map[selected.uda]];
            };
        }
    }

    function watchInnerFontProbe(reason, attemptsLeft, fileType) {
        try {
            if (installInnerFontProbe(reason, fileType)) return;
        } catch (error) {
        }
        if ((attemptsLeft || 0) <= 0) {
            return;
        }
        setTimeout(function() {
            watchInnerFontProbe(reason, attemptsLeft - 1, fileType);
        }, 100);
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

    function isInternalBinBytes(value) {
        var bytes = value instanceof Uint8Array ? value : (ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength) : null);
        if (!bytes || bytes.length < 5) return false;
        var prefix = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]);
        return prefix === 'DOCY;' || prefix === 'XLSY;' || prefix === 'PPTY;';
    }

    function isInternalBinPayload(value) {
        return isInternalBinString(value) || isInternalBinBytes(value);
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

    function x2tInputFormatFor(fileType) {
        if (fileType === 'xlsx') return 0x0101;
        if (fileType === 'pptx') return 0x0081;
        return 0x0041;
    }

    function x2tCanvasFormatFor(fileType) {
        if (fileType === 'xlsx') return 0x2002;
        if (fileType === 'pptx') return 0x2003;
        return 0x2001;
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

    // Emscripten FS.readFile(..., { encoding: 'binary' }) returns a JS string whose
    // char codes are raw bytes 0-255. TextEncoder would UTF-8-encode those and corrupt ZIP/bin data.
    function latin1StringToUint8Array(value) {
        if (typeof value !== 'string' || !value.length) return null;
        var out = new Uint8Array(value.length);
        for (var i = 0; i < value.length; i += 1) {
            var code = value.charCodeAt(i);
            if (code > 255) return null;
            out[i] = code;
        }
        return out;
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
                // Not base64; fall through to Latin-1 binary or UTF-8 text.
            }
            var latin1 = latin1StringToUint8Array(value);
            if (latin1) return latin1;
            return new TextEncoder().encode(value);
        }
        if (value && value.buffer instanceof ArrayBuffer) return new Uint8Array(value.buffer);
        return null;
    }

    function payloadToArrayBuffer(value) {
        if (value instanceof ArrayBuffer) return value;
        if (value instanceof Uint8Array) {
            return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        }
        if (ArrayBuffer.isView(value)) {
            return value.buffer.slice(value.byteOffset || 0, (value.byteOffset || 0) + value.byteLength);
        }
        if (typeof value === 'string') {
            var latin1 = latin1StringToUint8Array(value);
            if (latin1) {
                return latin1.buffer.slice(latin1.byteOffset, latin1.byteOffset + latin1.byteLength);
            }
            return new TextEncoder().encode(value).buffer;
        }
        var bytes = normalizeBytes(value);
        if (bytes && bytes.length) return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        throw new Error('Kin Office has no binary payload to open.');
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
            opts.formatFrom !== undefined ? '  <m_nFormatFrom>' + escapeXml(opts.formatFrom) + '</m_nFormatFrom>' : '',
            opts.formatTo !== undefined ? '  <m_nFormatTo>' + escapeXml(opts.formatTo) + '</m_nFormatTo>' : '',
            '  <m_bIsNoBase64>true</m_bIsNoBase64>',
            '  <m_sThemeDir>' + escapeXml(themeDir) + '</m_sThemeDir>',
            '  <m_sFontDir>' + escapeXml(fontDir) + '</m_sFontDir>',
            '  <m_bEmbeddedFonts>false</m_bEmbeddedFonts>',
        '</TaskQueueDataConvert>'
        ].filter(function(line) { return line !== ''; });
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
            var outputPath = '/working/' + stem + '-' + unique + '.bin';
            var paramsPath = '/working/open-params-' + unique + '.xml';
            module.FS.writeFile(inputPath, inputBytes);
            module.FS.writeFile(paramsPath, createConversionParams(inputPath, outputPath, {
                formatFrom: x2tInputFormatFor(inputExt),
                formatTo: x2tCanvasFormatFor(inputExt)
            }));
            var code = module.ccall('main1', 'number', ['string'], [paramsPath]);
            if (code !== 0) throw new Error('Kin Office x2t open conversion failed with code: ' + code);
            var rawBin = module.FS.readFile(outputPath, { encoding: 'binary' });
            var rawBytes = latin1StringToUint8Array(rawBin) || normalizeBytes(rawBin);
            if (!rawBytes || !rawBytes.length) {
                throw new Error('Kin Office x2t open conversion produced empty output.');
            }
            if (isZipBytes(rawBytes)) {
                throw new Error('Kin Office x2t open conversion returned document bytes instead of editor bin.');
            }
            var bin = wrapInternalBinPayload(rawBin, inputExt, bytesForNewDocument(inputExt));
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
                    var mediaBytes = latin1StringToUint8Array(fileData) || normalizeBytes(fileData);
                    if (mediaBytes && mediaBytes.length) {
                        media['media/' + file] = window.URL.createObjectURL(new Blob([mediaBytes]));
                    }
                } catch (_error) {}
            });
        } catch (_error) {}
        return media;
    }

    function wrapInternalBinPayload(rawPayload, fileType, templatePayload) {
        if (isInternalBinPayload(rawPayload)) return rawPayload;
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
        if (isInternalBinPayload(data)) return data;
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

    function getEditorApp(fileType) {
        var inner = getInnerWindow();
        return fileType === 'xlsx' ? inner.SSE : (fileType === 'pptx' ? inner.PE : inner.DE);
    }

    function findStatusLabel(inner, fileType) {
        if (!inner || !inner.document) return null;
        if (fileType === 'pptx') {
            return inner.document.querySelector('.status-group #status-label-action') ||
                inner.document.querySelector('#status-label-action');
        }
        return inner.document.querySelector('.status-group #label-action') ||
            inner.document.querySelector('#label-action') ||
            inner.document.querySelector('.status-group [data-layout-name="statusBar-actionStatus"]');
    }

    function setInnerStatusMessage(fileType, message, options) {
        var opts = options || {};
        var text = String(message || '');
        var delay = Number(opts.delay || 0);
        var force = opts.force !== false;
        try {
            var app = getEditorApp(fileType);
            var controller = app && typeof app.getController === 'function' ? app.getController('Statusbar') : null;
            if (controller && typeof controller.setStatusCaption === 'function') {
                controller.setStatusCaption(text, force, delay);
                return true;
            }
        } catch (_error) {}
        try {
            var inner = getInnerWindow();
            var label = findStatusLabel(inner, fileType);
            if (label) {
                label.textContent = text;
                return true;
            }
        } catch (_error) {}
        return false;
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

    function installInnerSaveShortcutHook(fileType, onSaveRequested) {
        if (typeof onSaveRequested !== 'function') return;
        var inner = getInnerWindow();
        if (!inner || !inner.document || inner._kinSaveShortcutInstalled) return;
        inner._kinSaveShortcutInstalled = true;
        inner._kinLastSaveShortcutAt = 0;

        function onKeydown(event) {
            var key = String(event && event.key || '').toLowerCase();
            if (!(event && (event.ctrlKey || event.metaKey) && key === 's')) return;
            try { event.preventDefault(); } catch (_error) {}
            try { event.stopPropagation(); } catch (_error) {}
            try { event.stopImmediatePropagation(); } catch (_error) {}

            var now = Date.now();
            if (now - inner._kinLastSaveShortcutAt < 500) return;
            inner._kinLastSaveShortcutAt = now;
            onSaveRequested();
        }

        inner.document.addEventListener('keydown', onKeydown, true);
        inner.addEventListener('keydown', onKeydown, true);
    }

    function installDirectSaveHookSoon(fileType, onSaveRequested, onError, attemptsLeft) {
        try {
            installDirectSaveHook(fileType, onSaveRequested);
            installInnerSaveShortcutHook(fileType, onSaveRequested);
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
        var payload = {
            command: command,
            data: data
        };
        frame.contentWindow.postMessage(JSON.stringify(payload), window.location.origin);
    }

    function mintCollabSession(opts) {
        if (!KIN_OFFICE_COLLAB_ENABLED) return Promise.resolve(null);
        if (!opts || opts.isNew || !opts.kinPath) return Promise.resolve(null);
        var sessionInfo = null;
        var configInfo = null;
        return fetch('/api/commands/kinoffice', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams({
                action: 'session',
                path: opts.kinPath,
                type: opts.fileType || 'docx'
            }).toString()
        }).then(function(response) {
            return response.json().catch(function() { return null; }).then(function(json) {
                if (!response.ok || !json || json.response !== 'success') {
                    throw new Error((json && json.message) ? String(json.message) : 'Kin Office collaboration service is unavailable.');
                }
                sessionInfo = json;
                return fetch('collab_config.json', {
                    method: 'GET',
                    credentials: 'same-origin',
                    cache: 'no-store',
                    headers: { Accept: 'application/json' }
                }).then(function(configResponse) {
                    return configResponse.ok ? configResponse.json().catch(function() { return null; }) : null;
                }).catch(function() { return null; });
            });
        }).then(function(configJson) {
            configInfo = configJson && typeof configJson === 'object' ? configJson : null;
            return fetch('/api/stream-connection/ws-ticket', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { Accept: 'application/json' }
            });
        }).then(function(response) {
            return response.json().catch(function() { return null; }).then(function(json) {
                if (!response.ok || !json || json.response !== 'ok' || !json.ticket) {
                    throw new Error((json && json.message) ? String(json.message) : 'Kin Office collaboration WebSocket ticket unavailable.');
                }
                var collab = sessionInfo || {};
                collab.ticket = json.ticket;
                collab.wsPath = json.wsPath || '/stream-connection/ws';
                collab.path = collab.path || opts.kinPath;
                collab.fileType = collab.fileType || opts.fileType || 'docx';
                collab.collab = Object.assign({}, collab.collab || {}, configInfo || {});
                if (!collab.collab.host) collab.collab.host = '127.0.0.1';
                if (!collab.collab.port) collab.collab.port = 19129;
                return collab;
            });
        })
        .catch(function(error) {
            console.warn('[KinOfficeBrowser] Collaboration disabled:', error && error.message ? error.message : error);
            return null;
        });
    }

    function createKinOfficeSocketFactory(collab) {
        return function kinOfficeSocketFactory() {
            var handlers = {};
            var socket = null;
            var connected = false;
            var closed = false;
            var lineBuffer = '';

            function emitLocal(name, data) {
                var list = handlers[name] || [];
                list.slice().forEach(function(handler) {
                    try { handler(data); } catch (error) { setTimeout(function() { throw error; }, 0); }
                });
            }
            function connect() {
                if (socket || closed || !collab || !collab.ticket || !collab.wsPath) return;
                var url = new URL(collab.wsPath, window.location.origin);
                url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                url.searchParams.set('ticket', collab.ticket);
                url.searchParams.set('host', collab.collab && collab.collab.host ? collab.collab.host : '127.0.0.1');
                url.searchParams.set('port', String(collab.collab && collab.collab.port ? collab.collab.port : 19129));
                url.searchParams.set('tls', collab.collab && collab.collab.tls ? '1' : '0');
                socket = new WebSocket(url.href);
                socket.onopen = function() {
                    console.log('[KinOfficeBrowser] Collaboration WebSocket open ' + url.href);
                    socket.send(JSON.stringify({
                        type: 'hello',
                        user: collab.user && collab.user.id ? collab.user.id : 'kin-user',
                        name: collab.user && collab.user.name ? collab.user.name : 'Kin User',
                        sessionId: collab.sessionId || '',
                        documentId: collab.documentId || '',
                        path: collab.path || '',
                        fileType: collab.fileType || 'docx'
                    }) + '\n');
                    connected = true;
                    emitLocal('connect');
                };
                socket.onmessage = function(event) {
                    lineBuffer += String(event.data || '');
                    var index;
                    while ((index = lineBuffer.indexOf('\n')) !== -1) {
                        var line = lineBuffer.slice(0, index).trim();
                        lineBuffer = lineBuffer.slice(index + 1);
                        if (!line) continue;
                        var data = null;
                        try { data = JSON.parse(line); } catch (_error) { data = null; }
                        if (data) emitLocal('message', data);
                    }
                };
                socket.onerror = function(event) {
                    console.warn('[KinOfficeBrowser] Collaboration WebSocket error', event);
                    emitLocal('connect_error', event);
                };
                socket.onclose = function(event) {
                    console.warn('[KinOfficeBrowser] Collaboration WebSocket closed', event && event.code, event && event.reason);
                    socket = null;
                    if (connected) emitLocal('disconnect', event && event.reason ? event.reason : 'closed');
                    connected = false;
                };
            }
            var shim = {
                io: {
                    opts: {},
                    on: function(name, handler) {
                        if (name === 'reconnect_failed') shim.on(name, handler);
                        return shim.io;
                    },
                    reconnectionAttempts: function() { return shim.io; },
                    reconnectionDelay: function() { return shim.io; },
                    reconnectionDelayMax: function() { return shim.io; },
                    setOpenToken: function(value) { shim.io.opts.openToken = value; return shim.io; },
                    setSessionToken: function(value) { shim.io.opts.sessionToken = value; return shim.io; },
                    zIg: function(value) { shim.io.opts.openToken = value; return shim.io; },
                    YIg: function(value) { shim.io.opts.sessionToken = value; return shim.io; }
                },
                auth: {},
                on: function(name, handler) {
                    if (!handlers[name]) handlers[name] = [];
                    handlers[name].push(handler);
                    return shim;
                },
                emit: function(name, data) {
                    if (name !== 'message') return shim;
                    if (!socket || socket.readyState !== WebSocket.OPEN) connect();
                    if (socket && socket.readyState === WebSocket.OPEN) {
                        socket.send(JSON.stringify(data || {}) + '\n');
                    } else {
                        setTimeout(function() {
                            if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data || {}) + '\n');
                        }, 50);
                    }
                    return shim;
                },
                connect: function() { connect(); return shim; },
                disconnect: function() {
                    closed = true;
                    if (socket) socket.close();
                    socket = null;
                    connected = false;
                    return shim;
                }
            };
            setTimeout(connect, 0);
            return shim;
        };
    }

    function installCollabSocketShim(collab) {
        if (!collab) return;
        try {
            var inner = getInnerWindow();
            inner.KinOfficeCollab = collab;
            inner.IS_NATIVE_EDITOR = false;
            inner.AscCommon = inner.AscCommon || {};
            inner.AscCommon.getSocketIO = function() {
                console.log('[KinOfficeBrowser] Collaboration getSocketIO requested');
                return createKinOfficeSocketFactory(collab);
            };
            inner.AscCommon.JQi = function() {
                console.log('[KinOfficeBrowser] Collaboration JQi socket factory requested');
                return createKinOfficeSocketFactory(collab);
            };
            inner.SockJS = createKinOfficeSockJsBridge(collab);
            inner.io = createKinOfficeSocketFactory(collab);
            return true;
        } catch (_error) {}
        return false;
    }

    function createKinOfficeSockJsBridge(collab) {
        var socket = null;
        var owner = null;
        return {
            open: function(settings) {
                console.log('[KinOfficeBrowser] Collaboration SockJS bridge open');
                owner = this;
                var factory = createKinOfficeSocketFactory(collab);
                socket = factory(settings || {});
                socket.on('connect', function() {
                    if (owner && typeof owner.onMessage === 'function') owner.onMessage('connect');
                });
                socket.on('disconnect', function(reason) {
                    if (owner && typeof owner.onMessage === 'function') owner.onMessage('disconnect', reason || 'closed');
                });
                socket.on('connect_error', function(error) {
                    if (owner && typeof owner.onMessage === 'function') owner.onMessage('connect_error', error || {});
                });
                socket.on('message', function(data) {
                    if (owner && typeof owner.onMessage === 'function') owner.onMessage('message', data);
                });
                socket.connect();
                return socket;
            },
            send: function(message) {
                if (!socket) return;
                var data = message;
                if (typeof message === 'string') {
                    try { data = JSON.parse(message); } catch (_error) { data = message; }
                }
                socket.emit('message', data);
            },
            close: function() {
                if (socket && typeof socket.disconnect === 'function') socket.disconnect();
                socket = null;
            }
        };
    }

    function installCollabSocketShimSoon(collab, attemptsLeft) {
        if (!collab) return;
        if (installCollabSocketShim(collab)) return;
        if ((attemptsLeft || 0) <= 0) return;
        setTimeout(function() {
            installCollabSocketShimSoon(collab, attemptsLeft - 1);
        }, 50);
    }

    function createLocalDocumentInfo(fileName, fileType, collab) {
        return {
            title: fileName,
            key: collab && collab.documentId ? collab.documentId : 'kin-office-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
            url: '',
            fileType: fileType,
            options: { oform: false },
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
                copy: true
            }
        };
    }

    function ensureCoAuthoringUser(inner, api, collab) {
        if (!inner || !api || !collab || !collab.user) return null;
        var id = String(collab.user.id || 'kin-user');
        var name = String(collab.user.name || collab.user.id || 'Kin User');
        var user = api.User;
        if (!user && inner.AscCommon && inner.AscCommon.asc_CUser) user = new inner.AscCommon.asc_CUser();
        if (!user) user = {};
        user.id = id;
        user.idOriginal = id;
        user.userName = name;
        user.firstName = name;
        user.lastName = '';
        if (typeof user.setId === 'function') user.setId(id);
        if (typeof user.setUserName === 'function') user.setUserName(name);
        if (typeof user.setFirstName === 'function') user.setFirstName(name);
        if (typeof user.setLastName === 'function') user.setLastName('');
        user.asc_getId = user.asc_getId || function() { return user.id; };
        user.asc_getUserName = user.asc_getUserName || function() { return user.userName; };
        user.asc_getFirstName = user.asc_getFirstName || function() { return user.firstName; };
        user.asc_getLastName = user.asc_getLastName || function() { return user.lastName; };
        user.asc_getIdOriginal = user.asc_getIdOriginal || function() { return user.idOriginal || user.id; };
        // Minified packaged builds call these instead of the source asc_get* names.
        user.vca = user.vca || user.asc_getId;
        user.hna = user.hna || user.asc_getUserName;
        user.hud = user.hud || user.asc_getFirstName;
        user.nud = user.nud || user.asc_getLastName;
        api.User = user;
        return user;
    }

    function coAuthoringScore(value) {
        if (!value || typeof value !== 'object') return 0;
        var score = 0;
        if (typeof value.init === 'function') score += 4;
        if (typeof value.Qe === 'function') score += 4; // minified CDocsCoApi.init
        if (typeof value.auth === 'function') score += 4;
        if (typeof value.set_url === 'function') score += 2;
        if (typeof value.i8b === 'function') score += 2; // minified CDocsCoApi.set_url
        if (typeof value.getUsers === 'function') score += 2;
        if (typeof value.saveChanges === 'function') score += 2;
        if (typeof value.OXa === 'function') score += 2; // minified CDocsCoApi.saveChanges
        if (typeof value.askLock === 'function') score += 2;
        if (typeof value.Ctb === 'function') score += 2; // minified CDocsCoApi.askLock
        if (typeof value.unSaveLock === 'function') score += 1;
        if (typeof value.zUd === 'function') score += 1; // minified CDocsCoApi.unSaveLock
        if (typeof value.disconnect === 'function') score += 1;
        return score;
    }

    function coAuthoringInit(coApi, user, docId, callbackUrl, token, editorId, formatSave, docInfo, shardKey, wopiSrc, userSessionId, headingsColor, openCmd) {
        if (coApi && typeof coApi.init === 'function') {
            return coApi.init(user, docId, callbackUrl, token, editorId, formatSave, docInfo, shardKey, wopiSrc, userSessionId, headingsColor, openCmd);
        }
        if (coApi && typeof coApi.Qe === 'function') {
            return coApi.Qe(user, docId, callbackUrl, token, editorId, formatSave, docInfo, shardKey, wopiSrc, userSessionId, headingsColor, openCmd);
        }
        throw new Error('CoAuthoring init method is not ready.');
    }

    function coAuthoringSetUrl(coApi, url) {
        var changed = false;
        if (coApi && typeof coApi.set_url === 'function') {
            coApi.set_url(url);
            changed = true;
        }
        if (coApi && typeof coApi.i8b === 'function') {
            coApi.i8b(url);
            changed = true;
        }
        // In 20260606-cache25 Docs, CDocsCoApi stores its real transport as On,
        // and online init is gated by On.YUe() checking private On.ccb.
        ['On', 'Nva'].forEach(function(key) {
            var transport = coApi && coApi[key];
            if (!transport || typeof transport !== 'object') return;
            try {
                if (typeof transport.i8b === 'function') {
                    transport.i8b(url);
                    changed = true;
                }
                if (typeof transport.ccb === 'string') {
                    transport.ccb = url;
                    changed = true;
                }
            } catch (_error) {}
        });
        return changed;
    }

    function coAuthoringUrlReady(coApi) {
        if (!coApi) return false;
        try {
            if (coApi.On && typeof coApi.On.YUe === 'function') return !!coApi.On.YUe();
            if (coApi.Nva && typeof coApi.Nva.YUe === 'function') return !!coApi.Nva.YUe();
        } catch (_error) {}
        return true;
    }

    function coAuthoringOnline(coApi) {
        if (!coApi) return false;
        if (typeof coApi.get_onlineWork === 'function') return !!coApi.get_onlineWork();
        if (typeof coApi.cV !== 'undefined') return !!coApi.cV; // minified _onlineWork
        return false;
    }

    function coAuthoringState(coApi) {
        if (!coApi) return 0;
        if (typeof coApi.get_state === 'function') return Number(coApi.get_state() || 0);
        if (typeof coApi.t1b === 'function') return Number(coApi.t1b() || 0); // minified CDocsCoApi.get_state
        return 0;
    }

    function coAuthoringGetUsers(coApi) {
        if (!coApi) return;
        if (typeof coApi.getUsers === 'function') return coApi.getUsers();
        if (typeof coApi.vxe === 'function') return coApi.vxe(); // minified CDocsCoApi.getUsers
    }

    function installDirectCoAuthoringTransport(coApi, collab) {
        var transport = coApi && (coApi.On || coApi.Nva);
        if (!transport || transport._kinDirectTransportInstalled) return false;
        var socket = createKinOfficeSocketFactory(collab)({});
        transport._kinDirectTransportInstalled = true;
        transport.zha = socket;
        socket.on('connect', function() {
            console.log('[KinOfficeBrowser] Collaboration direct transport connected');
            try {
                if (typeof transport.x5h === 'function') transport.x5h();
                else transport.KK = 1;
            } catch (_error) {}
        });
        socket.on('message', function(data) {
            try {
                if (typeof transport.w5h === 'function') transport.w5h(data);
            } catch (error) {
                console.warn('[KinOfficeBrowser] Collaboration direct message failed:', error && error.message ? error.message : error);
            }
        });
        socket.on('disconnect', function(reason) {
            try {
                if (typeof transport.nje === 'function') transport.nje(false);
                if (typeof transport.FCa === 'function') transport.FCa(reason || 'closed');
            } catch (_error) {}
        });
        socket.on('connect_error', function(error) {
            try {
                if (typeof transport.nje === 'function') transport.nje(true);
                if (typeof transport.FCa === 'function') transport.FCa(error && error.message ? error.message : 'connect_error');
            } catch (_error) {}
        });
        socket.connect();
        return true;
    }

    function objectPropertyNames(value) {
        var names = [];
        var seen = {};
        var cur = value;
        var depth = 0;
        while (cur && depth < 4) {
            try {
                Object.getOwnPropertyNames(cur).forEach(function(name) {
                    if (!seen[name]) {
                        seen[name] = true;
                        names.push(name);
                    }
                });
            } catch (_error) {}
            cur = Object.getPrototypeOf(cur);
            depth += 1;
        }
        return names;
    }

    function coAuthoringApiCandidates(inner, mainApi) {
        var candidates = [];
        function add(label, value) {
            if (value && typeof value === 'object') candidates.push({ label: label, value: value });
        }
        add('main.api', mainApi);
        try { add('Asc.editor', inner && inner.Asc && inner.Asc.editor); } catch (_error) {}
        try { add('window.editor', inner && inner.editor); } catch (_error) {}
        try { add('window.api', inner && inner.api); } catch (_error) {}
        return candidates;
    }

    function findCoAuthoringApi(inner, api) {
        if (!api || typeof api !== 'object') return null;
        if (coAuthoringScore(api.CoAuthoringApi) >= 8) return api.CoAuthoringApi;
        var best = null;
        var bestScore = 0;
        var bestKey = '';
        coAuthoringApiCandidates(inner, api).forEach(function(root) {
            if (coAuthoringScore(root.value && root.value.CoAuthoringApi) >= 8) {
                best = root.value.CoAuthoringApi;
                bestScore = coAuthoringScore(best);
                bestKey = root.label + '.CoAuthoringApi';
                return;
            }
            objectPropertyNames(root.value).forEach(function(key) {
                var value;
                try { value = root.value[key]; } catch (_error) { return; }
                var score = coAuthoringScore(value);
                if (score > bestScore) {
                    best = value;
                    bestScore = score;
                    bestKey = root.label + '.' + key;
                }
            });
        });
        if (bestScore >= 8) {
            if (!api.CoAuthoringApi) api.CoAuthoringApi = best;
            console.log('[KinOfficeBrowser] Found CoAuthoringApi as ' + bestKey + ' score=' + bestScore);
            return best;
        }
        try {
            var details = coAuthoringApiCandidates(inner, api).map(function(root) {
                var names = objectPropertyNames(root.value);
                return {
                    label: root.label,
                    keys: names.slice(0, 80),
                    methodKeys: names.filter(function(key) {
                        try { return typeof root.value[key] === 'function'; } catch (_error) { return false; }
                    }).slice(0, 80),
                    objectKeys: names.filter(function(key) {
                        try { return root.value[key] && typeof root.value[key] === 'object'; } catch (_error) { return false; }
                    }).slice(0, 80)
                };
            });
            console.warn('[KinOfficeBrowser] CoAuthoringApi candidates not found. API diagnostics:', details);
        } catch (_error) {}
        return null;
    }

    function forceCoAuthoringUrlOnObject(value, url, depth) {
        if (!value || typeof value !== 'object' || depth > 2) return false;
        var changed = false;
        if (typeof value.set_url === 'function') {
            try {
                value.set_url(url);
                changed = true;
            } catch (_error) {}
        }
        Object.keys(value).forEach(function(key) {
            var item;
            try { item = value[key]; } catch (_error) { return; }
            if (key === '_url' && typeof item === 'string') {
                value[key] = url;
                changed = true;
                return;
            }
            if (item && typeof item === 'object') {
                var looksLikeTransport = coAuthoringScore(item) >= 6 ||
                    typeof item.connect === 'function' ||
                    typeof item.saveChanges === 'function' ||
                    typeof item.getAuthCommand === 'function';
                if (looksLikeTransport) {
                    Object.keys(item).forEach(function(childKey) {
                        try {
                            if ((childKey === '_url' || childKey.toLowerCase().indexOf('url') >= 0) && typeof item[childKey] === 'string') {
                                item[childKey] = url;
                                changed = true;
                            } else if (item[childKey] === '' && typeof item.auth === 'function' && typeof item.connect === 'function') {
                                item[childKey] = url;
                                changed = true;
                            }
                        } catch (_error) {}
                    });
                    if (forceCoAuthoringUrlOnObject(item, url, depth + 1)) changed = true;
                }
            }
        });
        return changed;
    }

    function startKinCoAuthoring(fileType, collab, attemptsLeft) {
        if (!collab) return;
        try {
            var inner = getInnerWindow();
            var main = getMainController(fileType);
            var api = main && main.api;
            var coApi = findCoAuthoringApi(inner, api);
            if (!api || !coApi || (!coApi.init && !coApi.Qe) || typeof coApi.auth !== 'function') {
                throw new Error('CoAuthoringApi is not ready.');
            }
            if (coAuthoringOnline(coApi)) return;
            coAuthoringSetUrl(coApi, '/stream-connection/ws');
            forceCoAuthoringUrlOnObject(coApi, '/stream-connection/ws', 0);
            console.log('[KinOfficeBrowser] Collaboration URL ready=' + coAuthoringUrlReady(coApi));
            var user = ensureCoAuthoringUser(inner, api, collab);
            if (!user) throw new Error('CoAuthoring user is not ready.');
            api.documentId = collab.documentId || api.documentId;
            api.documentShardKey = collab.documentId || api.documentShardKey;
            if (api.DocInfo && collab.documentId && typeof api.DocInfo.put_Id === 'function') api.DocInfo.put_Id(collab.documentId);
            coAuthoringInit(
                coApi,
                user,
                collab.documentId || api.documentId,
                api.documentCallbackUrl || '',
                '',
                api.editorId,
                api.documentFormatSave,
                api.DocInfo,
                collab.documentId || api.documentShardKey,
                api.documentWopiSrc,
                api.documentUserSessionId,
                api.headingsColor,
                null
            );
            installDirectCoAuthoringTransport(coApi, collab);
            waitAndAuthCoAuthoring(coApi, 50);
            console.log('[KinOfficeBrowser] Collaboration connected for ' + (collab.path || collab.documentId || 'document'));
        } catch (error) {
            if ((attemptsLeft || 0) <= 0) {
                console.warn('[KinOfficeBrowser] Collaboration could not start:', error && error.message ? error.message : error);
                return;
            }
            setTimeout(function() {
                startKinCoAuthoring(fileType, collab, attemptsLeft - 1);
            }, 100);
        }
    }

    function waitAndAuthCoAuthoring(coApi, attemptsLeft) {
        try {
            if (!coApi || typeof coApi.auth !== 'function') return;
            if (coAuthoringState(coApi) > 0) {
                console.log('[KinOfficeBrowser] Collaboration auth start state=' + coAuthoringState(coApi));
                coApi.auth(false, null);
                setTimeout(function() { try { coAuthoringGetUsers(coApi); } catch (_error) {} }, 500);
                return;
            }
        } catch (_error) {}
        if ((attemptsLeft || 0) <= 0) {
            console.warn('[KinOfficeBrowser] Collaboration socket did not become ready for auth.');
            return;
        }
        setTimeout(function() {
            waitAndAuthCoAuthoring(coApi, attemptsLeft - 1);
        }, 100);
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
        var sourcePromise = opts.isNew
            ? Promise.resolve({ bin: bytesForNewDocument(fileType), media: {} })
            : convertDocumentToBin(opts.bytes, fileName, fileType);
        var collabPromise = mintCollabSession(opts);
        var editor = null;
        var sourcePayload = null;
        var sourceMedia = {};
        var collabSession = null;
        var readySent = false;
        var binaryOpenSent = false;

        if (!opts.isNew && !opts.bytes) {
            throw new Error('No document bytes were provided.');
        }

        function markReady() {
            if (readySent) return;
            readySent = true;
            installDirectSaveHookSoon(fileType, opts.onSaveRequested, opts.onError, 20);
            if (opts.onReady) opts.onReady();
        }

        function watchInnerDocumentReady(attemptsLeft) {
            try {
                var main = getMainController(fileType);
                if (main && main._isDocReady) {
                    markReady();
                    return;
                }
            } catch (_error) {}
            if ((attemptsLeft || 0) <= 0 || readySent) {
                return;
            }
            setTimeout(function() {
                watchInnerDocumentReady(attemptsLeft - 1);
            }, 100);
        }

        function openEditorBinPayload(main, payload) {
            if (!editor || typeof editor.openDocument !== 'function') {
                throw new Error('Kin Office binary open API is not available.');
            }
            if (!main || !main.api) {
                throw new Error('Kin Office editor API is not ready.');
            }
            if (payload === undefined || payload === null || payload === '') {
                throw new Error('Kin Office has no editor payload to open.');
            }
            var api = main.api;
            if (typeof api.asc_setLocalRestrictions === 'function') {
                api.asc_setLocalRestrictions(0);
            }
            // Kin skips asc_LoadDocument when opening from local bytes (no document URL).
            // That path normally sets ServerIdWaitComplete via co-auth; without it the
            // SDK never reaches asc_onDocumentContentReady and the UI hangs loading.
            api.ServerIdWaitComplete = true;
            editor.openDocument({
                buffer: payloadToArrayBuffer(payload)
            });
            startKinCoAuthoring(fileType, collabSession, 50);
        }

        function openBinaryAfterPermissions(attemptsLeft) {
            if (binaryOpenSent) return;
            try {
                var main = getMainController(fileType);
                if (main && main._isPermissionsInited) {
                    binaryOpenSent = true;
                    watchInnerFontProbe('before openDocument', 300, fileType);
                    openEditorBinPayload(main, sourcePayload);
                    watchInnerFontProbe('after openDocument', 300, fileType);
                    watchInnerDocumentReady(300);
                    return;
                }
            } catch (error) {
                if ((attemptsLeft || 0) <= 0) {
                    if (opts.onError) opts.onError(error);
                    return;
                }
            }
            if ((attemptsLeft || 0) <= 0) {
                if (opts.onError) opts.onError(new Error('Kin Office editor permissions did not initialize.'));
                return;
            }
            setTimeout(function() {
                openBinaryAfterPermissions(attemptsLeft - 1);
            }, 100);
        }

        return Promise.all([sourcePromise, collabPromise]).then(function(results) {
            sourcePayload = results[0].bin;
            sourceMedia = results[0].media || {};
            collabSession = results[1] || null;
            return loadApi();
        }).then(function() {
            var container = document.getElementById(containerId);
            if (!container) {
                throw new Error('Editor container not found: ' + containerId);
            }
            container.innerHTML = '';

            editor = new window.DocsAPI.DocEditor(containerId, {
                documentType: documentTypeFor(fileType),
                editorConfig: {
                    lang: opts.lang || 'en-US',
                    mode: 'edit',
                    canSaveDocumentToBinary: true,
                    user: {
                        id: collabSession && collabSession.user ? collabSession.user.id : 'kin-local-user',
                        name: collabSession && collabSession.user ? collabSession.user.name : 'Kin User'
                    },
                    coEditing: {
                        mode: collabSession ? 'fast' : 'strict',
                        change: !!collabSession
                    },
                    customization: {
                        font: {
                            name: 'Arial',
                            size: '11px'
                        },
                        locale: 'en-US',
                        forceWesternFontSize: true,
                        autosave: false,
                        forcesave: false,
                        help: false,
                        about: false,
                        feedback: false,
                        compactHeader: false,
                        hideRightMenu: true,
                        layout: {
                            header: {
                                users: !!collabSession,
                                user: !!collabSession
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
                            installCollabSocketShim(collabSession);
                            watchInnerFontProbe('onAppReady', 300, fileType);
                            postInnerEditorCommand('openDocument', {
                                doc: createLocalDocumentInfo(fileName, fileType, collabSession)
                            });
                            openBinaryAfterPermissions(300);
                            if (sourceMedia && Object.keys(sourceMedia).length) {
                                postInnerEditorCommand('asc_setImageUrls', { urls: sourceMedia });
                            }
                        } catch (error) {
                            if (opts.onError) opts.onError(error);
                        }
                    },
                    onDocumentReady: function() {
                        markReady();
                    },
                    onDocumentStateChange: function(event) {
                        if (opts.onDirty) opts.onDirty(!!(event && event.data));
                    },
                    onSaveDocument: function(event) {
                        extractEventBytes(event);
                        if (opts.onSaveRequested) {
                            opts.onSaveRequested();
                        }
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
                        var message = describeEditorError(event);
                        if (opts.onError) opts.onError(new Error(message));
                    }
                },
                type: 'desktop',
                width: '100%',
                height: '100%'
            });
            installCollabSocketShimSoon(collabSession, 300);

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
                setStatusMessage: function(message, options) {
                    setInnerStatusMessage(fileType, message, options || {});
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
