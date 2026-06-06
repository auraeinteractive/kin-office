( function() {
    var BUILD_ID = '20260606-cache25';
    var DOCS_ENTRY = 'app.js';

    function qp( name ) {
        try {
            return new URLSearchParams( location.search ).get( name ) || '';
        } catch ( _e ) {
            return '';
        }
    }
    function run() {
        if( !window.kin || !kin.classes || !kin.classes.Window ) {
            console.error( 'kinoffice_docs: kin app API unavailable' );
            return;
        }
        var pkg = qp( 'kin_repo_package' ) || 'kinoffice_docs';
        var q = {};
        var openPath = qp( 'kin_open_path' ) || qp( 'path' );
        if( openPath ) q.kin_open_path = openPath;
        q.kinoffice_mode = qp( 'kinoffice_mode' ) || 'local';
        q.kinOfficeBuild = BUILD_ID;
        console.log( 'kinoffice_docs launcher', BUILD_ID, {
            packageId: pkg,
            entry: DOCS_ENTRY,
            query: q
        } );
        new kin.classes.Window( {
            entry: DOCS_ENTRY,
            packageId: pkg,
            title: 'Docs',
            width: 1024,
            height: 768,
            quitOnClose: true,
            module: true,
            query: q,
            assets: [
                { type: 'css', href: '../kin_ui/theme/kin-ui.css' },
                { type: 'css', href: '../kinoffice_common/kinoffice-shell.css' }
            ]
        } );
    }
    run();
} )();
