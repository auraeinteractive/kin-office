( function() {
    var DOCS_ENTRY = 'app.js';

    function qp( name ) {
        try {
            return new URLSearchParams( location.search ).get( name ) || '';
        } catch ( _e ) {
            return '';
        }
    }

    function dropLegacyKinOfficeBuildParam() {
        try {
            var url = new URL( location.href );
            if( !url.searchParams.has( 'kinOfficeBuild' ) ) return;
            url.searchParams.delete( 'kinOfficeBuild' );
            history.replaceState( null, '', url.pathname + url.search + url.hash );
        } catch ( _e ) {}
    }

    function run() {
        dropLegacyKinOfficeBuildParam();
        if( !window.kin || !kin.classes || !kin.classes.Window ) {
            console.error( 'kinoffice_docs: kin app API unavailable' );
            return;
        }
        var pkg = qp( 'kin_repo_package' ) || 'kinoffice_docs';
        var q = {};
        var openPath = qp( 'kin_open_path' ) || qp( 'path' );
        if( openPath ) q.kin_open_path = openPath;
        q.kinoffice_mode = qp( 'kinoffice_mode' ) || 'local';
        new kin.classes.Window( {
            entry: DOCS_ENTRY,
            packageId: pkg,
            title: 'Docs',
            width: 1024,
            height: 768,
            quitOnClose: true,
            query: q,
            assets: [
                { type: 'css', href: '../kin_ui/theme/kin-ui.css' },
                { type: 'css', href: '../kinoffice_common/kinoffice-shell.css' }
            ]
        } );
    }
    run();
} )();
