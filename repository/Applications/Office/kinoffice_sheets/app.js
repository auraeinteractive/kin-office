import { bootstrapKinOfficeApp } from '../kinoffice_common/office_app.js';

bootstrapKinOfficeApp({
    appTag: 'kinoffice_sheets',
    menuPrefix: 'kinoffice.sheets',
    defaultFilename: 'Spreadsheet.xlsx',
    fileType: 'xlsx',
    windowTitle: 'Sheets'
});
