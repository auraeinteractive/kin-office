# Kin Office Specs

This directory is the working specification set for Kin Office. Agents should treat these files as the source of truth before changing runtime architecture, build scripts, save/open behavior, or Euro-Office integration details.

## Specs

- [Euro-Office Browser Runtime](./euro-office-browser-runtime.md)
- [Kin Office Architecture](./kin-office-architecture.md)
- [Kin Office Collaboration](./kin-office-collaboration.md)
- [Font rendering bug (resolved)](./problems/font-problem.md)

## Current Scope

Kin Office runs Docs, Sheets, and Slides inside Kin using Euro-Office browser assets. It opens and saves DOCX, XLSX, and PPTX files directly through Kin filesystem APIs without a Docker runtime, Document Server, direct connector, Nextcloud, OIDC, or standalone static server.

Collaboration uses Kin's authenticated stream WebSocket layer through this repo's `services/kinoffice-collab/`; live presence and locks are not stored in per-file `.info` files. Kin Office must not add service source, manager entries, routes, or build rules to the Kin core repository.

Collaboration is currently disabled pending the follow-up work in [Collaboration Future Plan](./plans/collaboration.md).

The current implementation deliberately uses a browser-owned open/export path:

1. Kin app shell reads bytes from Kin or asks `kinoffice.cmd` for blank templates.
2. `browser_editor.html` hosts Euro-Office in an iframe.
3. `browser_editor_adapter.js` converts OOXML bytes to Euro-Office internal bin data with browser `x2t.wasm`, using explicit DOCX/XLSX/PPTX-to-canvas format IDs.
4. Euro-Office opens the converted payload through `editor.openDocument({ buffer })` / `openDocumentFromBinary`, not direct `onEndLoadFile()` calls.
5. The adapter preserves valid no-base64 `DOCY/XLSY/PPTY` payloads and only wraps raw serializer bytes.
6. Euro-Office edits in desktop-flavored browser mode.
7. Kin-owned save hooks serialize editor state, convert back to OOXML bytes, and write through Kin file APIs.

## Font Note

Euro-Office canvas text uses `AscFonts`, `AllFonts.js`, and ODTTF font files — not HTML/CSS fonts. A blank `g_fonts_selection_bin` in generated `AllFonts.js` caused the picker to fall back to symbol font `ASCW3` (zeros/boxes on canvas while copied text stayed correct). This is **resolved** in `20260606-cache22`; see [Font problem (resolved)](./problems/font-problem.md) and [Euro-Office Browser Runtime: Fonts](euro-office-browser-runtime.md#fonts).

## Non-Goals

- Do not reintroduce Docker.
- Do not add `/ds/`, `/direct/`, Document Server, Nextcloud, OIDC, or the old Python connector unless the user explicitly asks for a rollback.
- Do not make Kin Office depend on a standalone dev/static server.
- Do not hand-edit downloaded Euro-Office vendor files; encode repeatable changes in scripts.
