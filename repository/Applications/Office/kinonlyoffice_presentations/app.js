import { bootstrapOnlyOfficeApp } from '../kinonlyoffice_common/office_app.js';

bootstrapOnlyOfficeApp({
    appTag: 'kinonlyoffice_presentations',
    targetPath: '/index.php/apps/onlyoffice/new?name=New%20presentation.pptx&dir=%2F',
    menuPrefix: 'onlyoffice.presentations',
    defaultFilename: 'Presentation.pptx',
    fileType: 'pptx'
});
