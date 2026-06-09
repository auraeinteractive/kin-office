# Sheets Save And Bottom Tabs

**Status:** Active guardrails in place

**Scope:** Sheets (`xlsx`) only. Do not change Docs (`docx`) or Slides (`pptx`) save/open/export paths when working on these issues unless the user explicitly asks.

## Symptoms

- Initial Sheets Save As could appear to work, but later Save or Autosave through the patch path could fail with `Patched Office ZIP is missing required members.`
- Some saved Sheets files reopened as empty workbooks when an experimental serializer path was used.
- Immediate `Ctrl+S` sometimes reported `Saved` but did not include the just-typed cell value, while Autosave later saved correctly.
- Bottom sheet tabs rendered as visible tab boxes with missing text until the user edited/interacted with the workbook.

## Root Causes Learned

- Save As and normal Save were different paths. Save As wrote a full XLSX and verified readback length. Normal Save and Autosave used the KOP1 ZIP-member patch backend.
- The Sheets patch path was not reliable for browser-exported XLSX packages. DOS validates patched XLSX output by requiring `[Content_Types].xml` and `xl/workbook.xml`; the patch rebuild could fail that validation.
- The packaged/minified Sheets serializer `api.OZi()` looks like source `asc_nativeGetFile3()` and returns `{ data, hv }`, but using it caused bad results: empty reopened workbooks or patch validation failures. It must not be reintroduced without a targeted Sheets regression test.
- `Ctrl+S` can run while the active cell editor/formula bar still owns the pending edit. The file write can succeed while serializing the previous workbook model state. Autosave looked more reliable because the idle delay allowed the cell edit to commit first.
- Bottom sheet-tab labels are normal HTML UI chrome from `Common.UI.TabBar`, not Euro-Office canvas text. The tab element stores the sheet name in `data-label`; the visible `<span>` could be blank before later UI refreshes.

## Current Fixes

- `office_app.js` handles `xlsx` normal Save and Autosave as full verified writes instead of KOP1 patch saves. Docs and Slides keep patch saves.
- `office_app.js` validates exported `xlsx` packages contain `[Content_Types].xml` and `xl/workbook.xml` before writing.
- `browser_editor_adapter.js` calls `api.asc_closeCellEditor()` and waits one browser frame before `xlsx` export so immediate keyboard Save includes the active cell value.
- `browser_editor_adapter.js` installs an `xlsx`-only tab-label repair. It observes `#statusbar_bottom li.list-item[data-label] > span` and fills blank text from the parent tab's `data-label`.

## Explicit Non-Fixes

- Do not switch Sheets back to KOP1 patch saves until a regression test covers repeated Save, Autosave, Save As, reopen, active-cell `Ctrl+S`, and required XLSX members.
- Do not use `api.OZi()` as the primary Sheets serializer without proving the exported workbook contains user data and required XLSX members after reopen.
- Do not change Docs save/open/export behavior while fixing Sheets. Docs was known-good and was regressed by broad serializer/x2t changes.
- Do not change Slides save/open/export behavior while fixing Sheets. Slides was restored by removing experimental PPTY serializer/export changes.

## Manual Verification Checklist

1. Open a fresh blank Sheets workbook.
2. Type a value into a cell and press `Ctrl+S` while the cell editor/formula bar is still active.
3. Reopen the file and confirm the value is present.
4. Edit another cell and wait for Autosave; reopen and confirm the value is present.
5. Save repeatedly and confirm no `Patched Office ZIP is missing required members` error appears.
6. Confirm bottom sheet tabs show names before and after editing.
7. Smoke-test Docs and Slides only to confirm they still open and save; do not alter their persistence paths unless they fail.
