import { bootstrapKinOfficeApp } from '../kinoffice_common/office_app.js?kinOfficeBuild=20260604-cache16';

bootstrapKinOfficeApp({
    appTag: 'kinoffice_slides',
    menuPrefix: 'kinoffice.slides',
    defaultFilename: 'Presentation.pptx',
    fileType: 'pptx',
    windowTitle: 'Slides'
});
