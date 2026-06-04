# Kin Office Specs

This directory is the working specification set for Kin Office. Agents should treat these files as the source of truth before changing runtime architecture, build scripts, save/open behavior, or Euro-Office integration details.

## Specs

- [Euro-Office Browser Runtime](./euro-office-browser-runtime.md)
- [Kin Office Architecture](./kin-office-architecture.md)

## Current Scope

Kin Office runs Docs, Sheets, and Slides inside Kin using Euro-Office browser assets. It opens and saves DOCX, XLSX, and PPTX files directly through Kin filesystem APIs without a Docker runtime, Document Server, direct connector, Nextcloud, OIDC, or standalone static server.

The current implementation deliberately uses a browser-owned open/export path:

1. Kin app shell reads bytes from Kin or asks `kinoffice.cmd` for blank templates.
2. `browser_editor.html` hosts Euro-Office in an iframe.
3. `browser_editor_adapter.js` converts OOXML bytes to Euro-Office internal bin data with browser `x2t.wasm`.
4. Euro-Office edits in desktop-flavored browser mode.
5. Kin-owned save hooks serialize editor state, convert back to OOXML bytes, and write through Kin file APIs.

## Known Caveat

Fonts are still an active issue. Euro-Office canvas text is not rendered with normal HTML/CSS fonts; it uses its own font registry and font loader. The current generated font pack maps CJK aliases such as `等线`, `DengXian`, `Microsoft YaHei`, and `SimSun` to `DroidSansFallbackFull.ttf` and writes ODTTF-obfuscated font files, but user testing still reports square/tofu boxes in some app text. Future work must debug the Euro-Office font engine and generated `AllFonts.js`/font files, not browser CSS.

## Non-Goals

- Do not reintroduce Docker.
- Do not add `/ds/`, `/direct/`, Document Server, Nextcloud, OIDC, or the old Python connector unless the user explicitly asks for a rollback.
- Do not make Kin Office depend on a standalone dev/static server.
- Do not hand-edit downloaded Euro-Office vendor files; encode repeatable changes in scripts.
