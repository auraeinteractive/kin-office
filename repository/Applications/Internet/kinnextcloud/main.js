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
            console.error( 'kinnextcloud: kin app API unavailable' );
            return;
        }
        var pkg = qp( 'kin_repo_package' ) || 'kinnextcloud';
        new kin.classes.Window( {
            entry: 'app.js',
            packageId: pkg,
            title: 'Nextcloud',
            width: 1024,
            height: 768,
            quitOnClose: true,
            module: true,
            assets: [
                { type: 'css', href: '../kin_ui/theme/kin-ui.css' },
                { type: 'css', href: 'nextcloud-view.css' }
            ]
        } );
    }
    run();
} )();
