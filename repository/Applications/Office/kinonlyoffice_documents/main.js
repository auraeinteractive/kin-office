( function() {
    function qp( name ) {
        try {
            return new URLSearchParams( location.search ).get( name ) || '';
        } catch ( _e ) {
            return '';
        }
    }
    function run() {
        if( !window.kin || !kin.classes || !kin.classes.Window ) {
            console.error( 'kinonlyoffice_documents: kin app API unavailable' );
            return;
        }
        var pkg = qp( 'kin_repo_package' ) || 'kinonlyoffice_documents';
        var q = {};
        var openPath = qp( 'kin_open_path' ) || qp( 'path' );
        if( openPath ) q.kin_open_path = openPath;
        q.onlyoffice_mode = qp( 'onlyoffice_mode' ) || qp( 'kin_onlyoffice_mode' ) || 'direct';
        new kin.classes.Window( {
            entry: 'app.js',
            packageId: pkg,
            title: 'OnlyOffice Documents',
            width: 1024,
            height: 768,
            quitOnClose: true,
            module: true,
            query: q,
            assets: [
                { type: 'css', href: '../kin_ui/theme/kin-ui.css' },
                { type: 'css', href: '../kinonlyoffice_common/onlyoffice-shell.css' }
            ]
        } );
    }
    run();
} )();
