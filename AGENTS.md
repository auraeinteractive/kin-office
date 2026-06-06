# Project: kin-office — Kin Office for Kin

This repository runs Kin Office editing directly in Kin using Euro-Office browser SDK assets and direct Kin filesystem integration.

Before changing architecture, runtime loading, save/open behavior, fonts, build scripts, or deployment, read the specs:

- [Specs index](specs/README.md)
- [Euro-Office Browser Runtime](specs/euro-office-browser-runtime.md)
- [Kin Office Architecture](specs/kin-office-architecture.md)
- [Kin Office Collaboration](specs/kin-office-collaboration.md)

## Current Goal

Kin Office should open and save DOCX, XLSX, and PPTX files inside Kin through browser-only Euro-Office runtime assets. There is no Docker runtime, Document Server, direct connector, Nextcloud, OIDC, or standalone static server.

## Agent Rules

- Do not reintroduce Docker, `/ds/`, `/direct/`, Document Server, Nextcloud, OIDC, or the old Python connector unless the user explicitly asks for a rollback.
- Use `scripts/fetch-euro-office-browser-sdk.sh` and `scripts/build-euro-office-browser-packages.sh` to refresh Euro-Office browser runtime assets.
- Use `scripts/generate-kinoffice-allfonts.py` for `AllFonts.js` and browser font files.
- Use `scripts/patch-euro-office-save-hooks.py` for repeatable patches to generated Euro-Office web-app assets.
- Do not hand-edit downloaded/generated vendor files when a script can express the change.
- Keep Kin file persistence in `repository/Applications/Office/kinoffice_common/office_app.js`.
- Keep Euro-Office browser adaptation in `repository/Applications/Office/kinoffice_common/browser_editor_adapter.js`.
- Keep Kin Office collaboration service source in `services/kinoffice-collab/`; do not add Kin Office services, routes, manager workers, or build entries to the Kin core repository.
- Kin Office must run inside Kin. Do not start standalone static servers outside Kin.
- Never hardcode hostnames. Use `window.location.origin`, Kin config, `.config.ini`, or forwarded headers as appropriate.

## Important Current Caveat

Fonts are still an active issue. Euro-Office document/canvas text is rendered by its own font engine, not normal HTML/CSS fonts. Future work should debug `AscFonts`, generated `AllFonts.js`, ODTTF font files, face indexes, and glyph coverage. See [Euro-Office Browser Runtime: Fonts](specs/euro-office-browser-runtime.md#fonts).

## Main Paths

```text
repository/Applications/Office/kinoffice_docs/
repository/Applications/Office/kinoffice_sheets/
repository/Applications/Office/kinoffice_slides/
repository/Applications/Office/kinoffice_common/
commands/kinoffice.cmd/
services/kinoffice-collab/
scripts/
specs/
```

## Commands

```bash
./scripts/fetch-euro-office-browser-sdk.sh
./scripts/build-euro-office-browser-packages.sh
python3 scripts/generate-kinoffice-allfonts.py
python3 scripts/patch-euro-office-save-hooks.py repository/Applications/Office/kinoffice_common/vendor/kin-office/packages/kin-office/7/web-apps
./scripts/build-kinoffice-cmd.sh
./scripts/build-kinoffice-collab-service.sh
./deploy.sh --to-kin
sudo ./deploy.sh --deploy-mode
./build-apps.sh
```

## Quick Verification

```bash
node --check repository/Applications/Office/kinoffice_common/browser_editor_adapter.js
node --check repository/Applications/Office/kinoffice_common/office_app.js
node --check repository/Applications/Office/kinoffice_docs/app.js
node --check repository/Applications/Office/kinoffice_sheets/app.js
node --check repository/Applications/Office/kinoffice_slides/app.js
python3 -m py_compile scripts/generate-kinoffice-allfonts.py scripts/patch-euro-office-save-hooks.py
make -C services/kinoffice-collab
```

Deploy with `./deploy.sh --to-kin` for Kin-build testing. The deploy script installs only `kinoffice_*` apps, the `kinoffice` Kin command, and the repo-owned `kinoffice-collab.service` into the Kin build; it does not modify Kin source or reload Kin nginx.


## House cleaning

Don't put stuff directly in the kin repository. We are kin-office, and we install stuff to kin, but we are not merging into or tainting the kin repository. If a Kin Office feature needs a service, route, command, or package asset, keep its source in this repo and deploy/package it from this repo.
