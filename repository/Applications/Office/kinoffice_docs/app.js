(function() {
    console.log('kinoffice_docs app direct entry 20260606-cache25', window.location.href);
    import('../kinoffice_common/office_app.js?kinOfficeBuild=20260606-cache25')
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
            console.error('kinoffice_docs app direct entry failed', error);
        });
})();
