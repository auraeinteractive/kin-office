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
            console.error( 'kinnextcloud_mail: kin app API unavailable' );
            return;
        }
        var pkg = qp( 'kin_repo_package' ) || 'kinnextcloud_mail';
        new kin.classes.Window( {
            entry: 'app.js',
            packageId: pkg,
            title: 'Nextcloud Mail',
            width: 1024,
            height: 768,
            quitOnClose: true,
            module: true,
            assets: [
                { type: 'css', href: '../kin_ui/theme/kin-ui.css' },
                { type: 'css', href: 'mail-view.css' }
            ]
        } );
    }
    run();
} )();
