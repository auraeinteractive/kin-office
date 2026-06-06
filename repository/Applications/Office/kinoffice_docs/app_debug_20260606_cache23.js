(function() {
    console.log('kinoffice_docs debug entry 20260606-cache23', window.location.href);
    import('../kinoffice_common/office_app.js?kinOfficeBuild=20260606-cache23')
        .then(function(mod) {
            mod.bootstrapKinOfficeApp({
                appTag: 'kinoffice_docs',
                menuPrefix: 'kinoffice.docs',
                defaultFilename: 'Document.docx',
                debugDefaultDocumentUrl: './debug/test.docx',
                debugDefaultFilename: 'Debug Arial Test.docx',
                debugForceDefaultDocument: true,
                fileType: 'docx',
                windowTitle: 'Docs'
            });
        })
        .catch(function(error) {
            console.error('kinoffice_docs debug entry failed', error);
        });
})();
