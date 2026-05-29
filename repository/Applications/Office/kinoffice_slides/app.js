import { bootstrapKinOfficeApp } from '../kinoffice_common/office_app.js';

bootstrapKinOfficeApp({
    appTag: 'kinoffice_slides',
    menuPrefix: 'kinoffice.slides',
    defaultFilename: 'Presentation.pptx',
    fileType: 'pptx',
    windowTitle: 'Slides'
});
