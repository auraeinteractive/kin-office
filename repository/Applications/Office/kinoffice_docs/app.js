import { bootstrapKinOfficeApp } from '../kinoffice_common/office_app.js';

bootstrapKinOfficeApp({
    appTag: 'kinoffice_docs',
    menuPrefix: 'kinoffice.docs',
    defaultFilename: 'Document.docx',
    fileType: 'docx',
    windowTitle: 'Docs'
});
