# Kin Office Specifications

Kin Office provides browser-only document editing for Kin workspace apps using Euro-Office source-aligned components. Files live on Kin volumes (`Home:`, etc.); there is no Nextcloud, WebDAV bridge, Docker runtime, or Document Server.

## Components

| Piece | Role |
|-------|------|
| `kinoffice_docs`, `kinoffice_sheets`, `kinoffice_slides` | Kin launchers; disk via `GET /file`, `write_binary`, and upload APIs |
| `browser_editor.html` | Same-origin iframe shell that hosts the local editor |
| `vendor/kin-office/` | Euro-Office source snapshots, generated browser assets, blank templates, and x2t assets |
| `scripts/fetch-euro-office-browser-sdk.sh` | Reproducible source/artifact fetch script |

## Docs

- [Architecture](architecture.md)
- [WBS: KinFS + browser-local editor](wbs/01-kinoffice-kinfs.md)

## Deploy

See [AGENTS.md](../AGENTS.md), `deploy.sh`, and `make-debian.sh`.
