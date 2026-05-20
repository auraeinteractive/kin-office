# WBS: Full KinFS Integration with Nextcloud/OnlyOffice

## Overview
This WBS describes how to use JavaScript injections into Nextcloud and OnlyOffice to override their native load/save functionality, routing all file operations through Kin FS disks instead of the built-in Nextcloud storage.

## Technical Decisions

- **Shadow DOM** - Kin apps use Shadow DOM (not light DOM) to encapsulate styles and enable proper web component development
- No `prototype/` folder - all code goes directly into `repository/Applications/`

## Architecture

```
Kin Workspace
       |
       v
kinnextcloud app (iframe)
       |
       v
kin-bridge.js (injected into Nextcloud pages)
       |
       +-- OnlyOffice (via /ds/ proxy)
       |      |
       |      v
       |   office_app.js (OnlyOffice launcher)
       |
       v
Nextcloud (behind nginx proxy)
```

## 1. Override Save Functionality

### 1.1 Autosave Interception

**Approach**: Use OnlyOffice's `editorRequestSave` event (if available) or poll the document status.

The current implementation in `kin-bridge.js` already supports:
- `kinBridgeOnlyOfficeForceSave` - triggers a force-save command to OnlyOffice
- `flushOnlyOfficeEdits()` in `office_app.js` - waits for edits to be flushed

**Implementation Plan**:
1. Monitor OnlyOffice document status via polling or events
2. On each autosave, copy the file to the Kin FS path tracked by `currentKinFile`
3. Use WebDAV to read the file from Nextcloud, write to Kin FS via `/api/file/write_binary`

**Key Code Points**:
- `office_app.js:703` - `saveNextcloudFileToKinPath(sourceNextcloudPath, targetKinPath)`
- `office_app.js:644` - `flushOnlyOfficeEdits(sourcePath)` - ensures pending edits are flushed

### 1.2 Normal Save Interception

**Current Implementation**:
- Menu "Save" command triggers `saveNextcloudFileToKinPath()` when `currentKinPath` is set
- The `currentKinPath` variable tracks the corresponding Kin FS path

**Implementation Plan**:
1. Track `currentKinFile` variable in the app state
2. When user triggers save (via menu or keyboard), copy Nextcloud file to Kin FS
3. Verify the write by reading back

### 1.3 Save As Interception

**Current Implementation**:
- OnlyOffice's `editorRequestSaveAs` event is captured in `kin-bridge.js:544`
- Forwarded to parent via `kinBridgeOnlyOfficeRequestSaveAs`
- `office_app.js:936` - `handleOnlyOfficeSaveAsRequest()` handles this

**Implementation Plan**:
1. On Save As, show Kin file dialog
2. If target is a Kin FS path (not Nextcloud volume), copy file directly to Kin FS
3. If target is Nextcloud volume, use WebDAV COPY to save in Nextcloud
4. Update `currentKinFile` to the new path

**Key Code Points**:
- `office_app.js:900-929` - Save As menu handler
- `office_app.js:936-984` - Handle OnlyOffice's Save As request

## 2. Track Current Kin File Path

### 2.1 Variable Definition

```javascript
// In office_app.js state
let currentKinPath = null;  // e.g., "Home:/Documents/report.docx"
let currentOnlyOfficePath = null;  // e.g., "/report.docx"
```

### 2.2 Initial File Assignment

When a file is opened:
1. If opened via Kin file dialog, `currentKinPath` is set from the dialog result
2. If opened directly in OnlyOffice (no Kin path), leave `currentKinPath` unset
3. Show prompt to save to Kin path via file dialog

### 2.3 Save As Updates Path

When user chooses "Save As" and picks a new Kin path:
- Update `currentKinPath` to the new path
- The new file is now the "current" file

## 3. Hide Nextcloud Toolbar

**Note**: This only applies to the OnlyOffice iframe. The main Nextcloud app (kinnextcloud) should not have any CSS hiding.

### 3.1 CSS Injection for OnlyOffice

The nginx proxy injects CSS into the OnlyOffice iframe via sub_filter to hide the Nextcloud header and maximize the content area:

```css
/* Hide Nextcloud header/toolbar */
#header {
    display: none !important;
}

/* Remove top margin and set full height */
#content {
    margin-top: 0 !important;
    height: 100% !important;
}

/* Make the iframe fill the content area */
#content > #app > iframe {
    height: 100% !important;
}
```

### 3.2 Nginx sub_filter Injection

Add to `nginx/conf.d/nextcloud.conf` in the main location block:

```nginx
sub_filter_once on;
sub_filter_types text/html;
sub_filter '</head>' '<style>#header{display:none!important}#content{margin-top:0!important;height:100%!important}#content>#app>iframe{height:100%!important}</style><script src="/kin-bridge.js"></script></head>';
```

This CSS applies only to OnlyOffice (proxied at /ds/) since that's where the Nextcloud header appears within the editor context.

### 3.3 Integration with kin-bridge.js

Optionally add JS-based CSS injection in kin-bridge.js as fallback for dynamic content.

## 4. Intercept New Window Requests

### 4.1 Problem Description

When users click links or buttons that open new browser tabs/windows:
- Nextcloud may open settings, notifications, or file details in new windows
- OnlyOffice may open help, about, or external links

### 4.2 Detection Approach

```javascript
// In kin-bridge.js
function interceptNewWindowAttempts() {
    // Override window.open
    const originalWindowOpen = window.open;
    window.open = function(url, name, features) {
        // Forward to parent app to handle
        postToParent({
            type: 'kinBridgeOpenWindow',
            url: url,
            target: name
        });
        return null; // Block the native open
    };

    // Intercept anchor clicks that target _blank
    document.addEventListener('click', function(e) {
        const anchor = e.target.closest('a[target="_blank"]');
        if (anchor) {
            e.preventDefault();
            postToParent({
                type: 'kinBridgeOpenWindow',
                url: anchor.href,
                target: '_blank'
            });
        }
    }, true);
}
```

### 4.3 Kin Workspace Integration

When `kinBridgeOpenWindow` is received, the parent app should:
1. Post to workspace with `kinOpenWindow: true`
2. The workspace opens a new Kin window with the URL

## 5. File Dialog Integration

### 5.1 Open Flow

1. User clicks "Open" in Kin app menu
2. Show Kin file dialog (mode: load, initialPath: `Mountlist:`)
3. If selected path is Home:/ or System:/, import to Nextcloud first
4. Open in OnlyOffice and set `currentKinPath`

### 5.2 Save Flow

1. User clicks "Save" in Kin app menu
2. If `currentKinPath` is set, copy Nextcloud file to Kin path
3. If not set, prompt to "Save As" to choose Kin path

### 5.3 Save As Flow

1. User clicks "Save As" or OnlyOffice triggers Save As
2. Show Kin file dialog (mode: save, defaultFilename from current file)
3. Save to selected path and update `currentKinPath`

## 6. Implementation Tasks

### Task 1: Enhance kin-bridge.js for toolbar hiding
- [x] Add CSS to hide Nextcloud header
- [x] Add window.open interception
- [x] Add anchor target="_blank" interception

### Task 2: Enhance office_app.js for autosave sync
- [x] Add polling mechanism to detect OnlyOffice autosaves
- [x] On each autosave, copy to `currentKinPath` if set
- [x] Add option to disable autosave sync (for files without Kin path)

### Task 3: Window opening handler in kinnextcloud app
- [x] Receive `kinBridgeOpenWindow` messages
- [x] Forward to workspace to open new Kin window

### Task 4: Handle files without Kin path
- [x] When opening a Nextcloud file directly (no Kin path), prompt to save to Kin
- [x] Add "Save to Kin" button in UI

### Task 5: Verification and testing
- [ ] Test autosave to Kin FS
- [ ] Test manual save to Kin FS
- [ ] Test Save As to different Kin paths
- [ ] Test Save As back to Nextcloud
- [ ] Test new window interception

## 7. API Reference

### kin-bridge.js Messages (outgoing to parent)

| Message | Payload | Description |
|---------|---------|-------------|
| `kinBridgeOpenWindow` | `{url, target}` | User attempted to open new window |

### office_app.js Messages (to workspace)

| Message | Description |
|---------|-------------|
| `kinOpenWindow: true` | Request workspace to open new window |

## 8. Related Files

- `nginx/kin-bridge.js` - Bridge script injected into Nextcloud
- `repository/Applications/Office/kinonlyoffice_common/office_app.js` - OnlyOffice launcher
- `repository/Applications/Internet/kinnextcloud/app.js` - Nextcloud launcher
- `nginx/conf.d/nextcloud.conf` - Nginx configuration

## 9. Additional Kin Apps

### 9.1 Kin Nextcloud Mail

The Mail app opens `/apps/mail/` directly (without `index.php` prefix):

```javascript
// kinnextcloud_mail/app.js
const targetPath = '/apps/mail/';
```

This works because Nextcloud handles URLs without `index.php` through its rewrite rules.