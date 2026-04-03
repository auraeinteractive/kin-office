import { bootstrapOnlyOfficeApp } from '../kinonlyoffice_common/office_app.js';

bootstrapOnlyOfficeApp({
    appTag: 'kinonlyoffice_documents',
    targetPath: '/index.php/apps/onlyoffice/new?name=New%20document.docx&dir=%2F',
    menuPrefix: 'onlyoffice.documents',
    defaultFilename: 'Document.docx'
});
