import { bootstrapOnlyOfficeApp } from '../kinonlyoffice_common/office_app.js';

bootstrapOnlyOfficeApp({
    appTag: 'kinonlyoffice_spreadsheets',
    targetPath: '/index.php/apps/onlyoffice/new?name=New%20spreadsheet.xlsx&dir=%2F',
    menuPrefix: 'onlyoffice.spreadsheets',
    defaultFilename: 'Spreadsheet.xlsx'
});
