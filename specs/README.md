# kin-office specifications

kin-office provides **OnlyOffice Document Server** and a **direct connector** for Kin workspace apps. Files live on Kin volumes (`Home:`, etc.); there is no Nextcloud stack.

## Components

| Piece | Role |
|-------|------|
| `onlyoffice` (Docker) | Document Server at host `:5003`, proxied as `/kin-office/ds/` |
| `onlyoffice-direct` (Docker) | Python connector: sessions, download/callback URLs for DS |
| `kinonlyoffice_*` apps | Kin launchers; open/save via `/api/file/*` and `/kin-office/direct/` |

## Docs

- [Architecture](architecture.md)
- [WBS: KinFS + direct editor](wbs/01-onlyoffice-direct-kinfs.md)

## Deploy

See [AGENTS.md](../AGENTS.md) and `deploy.sh` / `kin-office.service`.
