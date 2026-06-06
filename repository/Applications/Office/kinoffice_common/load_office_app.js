function stripLegacyKinOfficeBuildParam() {
    try {
        const url = new URL(window.location.href);
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
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.setAttribute('data-kin-office-css', href);
        document.head.appendChild(link);
    });
}

async function readKinOfficeRelease() {
    const page = new URL(import.meta.url);
    const kinBuild = page.searchParams.get('v') || '';
    const releaseUrl = new URL('/repository/kinoffice_common/release.json', window.location.origin);
    if (kinBuild) releaseUrl.searchParams.set('v', kinBuild);
    const response = await fetch(releaseUrl, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
    });
    if (!response.ok) throw new Error('Could not read Kin Office release metadata.');
    const json = await response.json();
    const release = json && (json.release != null ? json.release : json.version);
    if (release == null || release === '') throw new Error('Kin Office release metadata is empty.');
    return String(release);
}

function kinOfficeAppModuleUrl(kinBuild, release) {
    const moduleUrl = new URL('/repository/kinoffice_common/office_app.js', window.location.origin);
    if (kinBuild) moduleUrl.searchParams.set('v', kinBuild);
    moduleUrl.searchParams.set('r', release);
    return moduleUrl.href;
}

export async function importOfficeApp() {
    stripLegacyKinOfficeBuildParam();
    ensureKinOfficeStyles();
    const page = new URL(import.meta.url);
    const kinBuild = page.searchParams.get('v') || '';
    const release = await readKinOfficeRelease();
    return import(kinOfficeAppModuleUrl(kinBuild, release));
}
