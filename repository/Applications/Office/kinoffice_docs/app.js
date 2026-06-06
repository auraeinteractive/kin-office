(function() {
    function stripLegacyKinOfficeBuildParam() {
        try {
            var url = new URL(window.location.href);
            if (!url.searchParams.has('kinOfficeBuild')) return;
            url.searchParams.delete('kinOfficeBuild');
            window.history.replaceState(null, '', url.pathname + url.search + url.hash);
        } catch (_error) {}
    }

    function ensureKinOfficeStyles() {
        [
            '/repository/kin_ui/theme/kin-ui.css',
            '/repository/kinoffice_common/kinoffice-shell.css'
        ].forEach(function(href) {
            if (document.querySelector('link[data-kin-office-css="' + href + '"]')) return;
            var link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = href;
            link.setAttribute('data-kin-office-css', href);
            document.head.appendChild(link);
        });
    }

    function readKinOfficeRelease() {
        var releaseUrl = new URL('/repository/kinoffice_common/release.json', window.location.origin);
        var pageV = new URLSearchParams(window.location.search).get('v');
        if (pageV) releaseUrl.searchParams.set('v', pageV);
        return fetch(releaseUrl, {
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { Accept: 'application/json' }
        }).then(function(response) {
            if (!response.ok) throw new Error('Could not read Kin Office release metadata.');
            return response.json();
        }).then(function(json) {
            var release = json && (json.release != null ? json.release : json.version);
            if (release == null || release === '') throw new Error('Kin Office release metadata is empty.');
            return String(release);
        });
    }

    function importLoaderModule(release) {
        var moduleUrl = new URL('/repository/kinoffice_common/load_office_app.js', window.location.origin);
        var pageV = new URLSearchParams(window.location.search).get('v');
        if (pageV) moduleUrl.searchParams.set('v', pageV);
        moduleUrl.searchParams.set('r', release);
        return import(moduleUrl.href);
    }

    stripLegacyKinOfficeBuildParam();
    ensureKinOfficeStyles();
    readKinOfficeRelease()
        .catch(function() { return '0'; })
        .then(importLoaderModule)
        .then(function(mod) { return mod.importOfficeApp(); })
        .then(function(mod) {
            mod.bootstrapKinOfficeApp({
                appTag: 'kinoffice_docs',
                menuPrefix: 'kinoffice.docs',
                defaultFilename: 'Document.docx',
                fileType: 'docx',
                windowTitle: 'Docs'
            });
        })
        .catch(function(error) {
            console.error('kinoffice_docs failed to start', error);
        });
}());
