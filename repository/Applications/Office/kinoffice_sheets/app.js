import { bootstrapKinOfficeApp } from '../kinoffice_common/office_app.js?kinOfficeBuild=20260603-cache10';

bootstrapKinOfficeApp({
    appTag: 'kinoffice_sheets',
    menuPrefix: 'kinoffice.sheets',
    defaultFilename: 'Spreadsheet.xlsx',
    fileType: 'xlsx',
    windowTitle: 'Sheets'
});
