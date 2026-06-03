import { bootstrapKinOfficeApp } from '../kinoffice_common/office_app.js?kinOfficeBuild=20260603-cache10';

bootstrapKinOfficeApp({
    appTag: 'kinoffice_docs',
    menuPrefix: 'kinoffice.docs',
    defaultFilename: 'Document.docx',
    fileType: 'docx',
    windowTitle: 'Docs'
});
