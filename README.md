# Kin Office

Kin Office is a browser-only Kin app wrapper around the OnlyOffice/Euro-Office editor runtime.

The practical goal is simple: open DOCX/XLSX/PPTX files inside Kin and save the edited bytes back to a Kin path without a Document Server, Docker service, Nextcloud, or separate backend.

## Current Direction

We should step back from trying to run the entire unminified editor source directly in the browser. That path turns Kin Office into a large editor fork and creates endless runtime dependency work: source loading order, font WASM paths, socket shims, local desktop shims, missing assets, and app/runtime mismatches.

The immediate problem is narrower:

1. Use the packaged SDK/browser runtime that already opens the editor.
2. Do not fork the editor runtime unless absolutely necessary.
3. Find the existing save/export API surface inside that runtime.
4. Trigger that API from the editor save button / `Ctrl+S` / Kin save action.
5. Capture the produced `ArrayBuffer`/bytes and write them to Kin.

In short: we have an office editor. The missing piece is reliable save access.

## Important Notes

- The source-loader experiment should not be the main path forward. It proved useful for reading source and mapping function intent, but not as the runtime strategy.
- The unminified Euro-Office source is still useful as a reference for understanding the minified SDK functions.
- The runtime should be restored to the packaged `sdk-all-min.js` path, then save should be investigated against that working runtime.
- Keep the scope tight. Avoid turning this repo into a maintained fork of OnlyOffice/Euro-Office.

## Save Investigation Pointers

Useful source-level functions found in Euro-Office:

- `baseEditorsApi.prototype.getFileAsFromChanges()`
- `asc_nativeGetFile3()`
- `asc_nativeGetFileData()`
- app-specific native binary writers behind those functions

The likely job is to map these source-level functions to the packaged runtime’s available methods or expose a small stable bridge around them, then feed the result into Kin’s existing file-write path.

## Next Step

Restore the editor runtime to the packaged SDK/minified path and verify Docs opens again. After that, inspect the live editor API object in the iframe and identify which save/export functions are actually present at runtime.
