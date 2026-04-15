# WBS: 02 - OIDC for Nextcloud (kin-office perspective)

**Project**: Self-hosted Nextcloud stack in Docker, Kin launcher apps, and Nginx bridge — authenticated via Kin as OpenID Connect IdP (`user_oidc`).  
**This repo**: `kin-office` (`docker-compose.yml`, `nginx/`, `repository/Applications/`, optional `nextcloud/` init).  
**IdP / canonical WBS**: sibling `../kin/specs/wbs/02-oidc-for-nextcloud.md` (Kin HTTP OIDC implementation and Phase A acceptance).

---

## Overview

Kin apps embed Nextcloud in an iframe and use `postMessage` through `nginx/kin-bridge.js`. **Nextcloud passwords must not** be embedded in Kin apps; login is delegated to **Nextcloud `user_oidc`**, which talks to Kin’s OIDC endpoints.

**Primary integration surfaces (this repo)**

| Area | Path / artifact |
|------|-----------------|
| Reverse proxy + headers | `nginx/conf.d/nextcloud.conf` |
| Bridge (login, WebDAV, OCS) | `nginx/kin-bridge.js` |
| Nextcloud iframe app | `repository/Applications/Internet/kinnextcloud/app.js` |
| OnlyOffice launchers | `repository/Applications/Office/kinonlyoffice_common/office_app.js` |
| Mail launcher | `repository/Applications/Office/kinnextcloud_mail/app.js` |
| Compose + optional OIDC bootstrap | `docker-compose.yml`, `nextcloud/oidc-init.sh` |

---

## Goals

1. **Silent SSO from Kin**: With a valid Kin workspace session, opening Nextcloud from Kin should not require typing Nextcloud (or Kin) credentials in the common case.
2. **Same-origin proxy**: Nginx on `:5002` (per `AGENTS.md`) keeps the iframe same-origin for bridge behavior; TLS and trusted-proxy settings must stay consistent with `user_oidc` and discovery fetches.
3. **Operational runbook**: Clear steps for LAN, self-signed Kin TLS, and **non-localhost** discovery URLs from inside Docker (see Phase D).

---

## Non-goals

- Implementing the Kin IdP itself (lives in `../kin/services/http/oidc/`).
- Full IdP admin UI, refresh-token policies, or multi-tenant provider management.

---

## Work breakdown

### Phase A — Kin OIDC provider

Implemented and tracked in **`../kin`** (discovery, JWKS, authorize, token, userinfo, `deploy.sh` env). This repo only **consumes** those endpoints.

**Acceptance (cross-ref)**

- [ ] Discovery + JWKS reachable at the **issuer / URL strategy** agreed for production (see Phase D).
- [ ] Authorize with `prompt=none` and valid `kin_session` returns redirect with `code` (no HTML login).

---

### Phase B — Nextcloud `user_oidc` (runtime + config)

#### B.1 Install and enable app

- [x] `occ app:install user_oidc` / `occ app:enable user_oidc` (in at least one dev environment).

#### B.2 Provider configuration

- [x] Provider id (e.g. `kin`), discovery URL → Kin `/.well-known/openid-configuration`.
- [x] Claim / UID mapping aligned with Kin usernames (`preferred_username` or agreed claim).
- [x] `check-bearer` / bearer validation direction per operator policy (validate against installed `user_oidc` docs).

#### B.3 Global settings (proxy, TLS, OIDC client hints)

- [x] `trusted_proxies` includes `nginx_nextcloud_proxy` (example in this repo’s docs).
- [x] `overwriteprotocol = https` where reverse proxy terminates TLS.
- [x] Self-signed Kin: `user_oidc.httpclient.allowselfsigned = true` when required.
- [x] Silent path: `user_oidc.prompt = none` (confirm for your Nextcloud / app version).

**Acceptance criteria**

- [ ] From **inside** the `nextcloud` container, `curl` to the configured discovery URL returns **200** and valid JSON (no `LocalServerException` / “violates local access rules”).
- [ ] Browser: `https://<nc-host>:5002/index.php/login` redirects through `user_oidc` to Kin authorize (not a broken discovery / 404 chain).

---

### Phase C — kin-office (bridge + Kin apps + automation)

#### C.1 Remove embedded Nextcloud credentials

- [x] `nginx/kin-bridge.js`: credential-less flow; navigate to `/index.php/login` for OIDC takeover.
- [x] `kinnextcloud`, OnlyOffice common launcher, Mail: `kinBridgeLogin` without credentials.

**Acceptance criteria**

- [ ] No default `admin` / `admin123` (or similar) strings in these integration paths (grep / review gate).

#### C.2 Compose / init reliability

- [ ] `nextcloud_oidc_init` (or equivalent): **do not** override the Nextcloud image entrypoint in a way that skips staging of `/var/www/html/occ`. Prefer `docker exec` into the running `nextcloud` container or an entrypoint-compatible hook.

**Acceptance criteria**

- [ ] `docker compose up` brings the stack up; init is **idempotent** and safe to re-run.

---

### Phase D — Cross-network correctness (blocking “done”)

Nextcloud may block outbound requests to **localhost** when fetching OIDC discovery from inside Docker (`LocalServerException: violates local access rules`).

**Tasks**

- [ ] Choose a stable **server-side** discovery base URL (host gateway, `extra_hosts`, dedicated hostname, same public hostname as Kin, or policy-approved `allow_local_remote_servers`).
- [ ] Align **`KIN_OIDC_ISSUER`** / JWT `iss` with what `user_oidc` expects (no mismatch between internal fetch URL and issuer string unless explicitly designed).

**Acceptance criteria**

- [ ] `occ user_oidc:provider …` shows a discovery endpoint that works from inside the `nextcloud` container.
- [ ] Nextcloud logs show **no** localhost access-rule violations during login / discovery fetch.

---

## Verification / test matrix

### Nextcloud + Docker

- [ ] Fresh session: login completes via OIDC when Kin session exists.
- [ ] Admin direct login escape hatch still works if required (`?direct=1` or local policy).

### Bridge + apps

- [ ] `kinnextcloud` iframe reaches dashboard / targets without hanging on “Signing in…”.
- [ ] OnlyOffice and Mail launchers behave consistently with the same session model.

### WebDAV / API

- [ ] With bearer checking enabled, validate a real WebDAV or OCS call per `user_oidc` version docs (may need extra keys such as userinfo validation).

---

## Implementation pointers

**This repo**

- `nginx/conf.d/nextcloud.conf` — proxy, iframe-related headers, OnlyOffice `/ds/` routing.
- `nginx/kin-bridge.js` — `kinBridgeLogin`, navigation, WebDAV/OCS, OnlyOffice hooks.
- Apps under `repository/Applications/` as listed in the table above.
- `docker-compose.yml`, `nextcloud/oidc-init.sh` — automation (repair per Phase C.2 as needed).

**Kin (IdP)**

- `../kin/services/http/oidc/oidc.c`, `../kin/services/http/server/server.c`, `../kin/services/http/Makefile`, `../kin/deploy.sh`.
- Runtime note from Kin WBS: Kin may run **`build/services/http.service`**; refresh that binary after rebuild when not in use.

---

## Open questions

1. **Canonical issuer / discovery hostname** for production (LAN vs DNS vs path).
2. **Token lifetimes** and whether refresh tokens are needed on the Kin side later.
3. **Email / profile claims** for Nextcloud provisioning (may be minimal today).
4. **Security posture** of `allow_local_remote_servers` vs a proper non-loopback discovery URL.

---

## Definition of Done (epic)

- [ ] End-to-end silent login from Kin workspace into Nextcloud for a non-admin Kin user (no Nextcloud password entry).
- [ ] Nextcloud user provisioned or pre-provisioned with UID aligned to Kin username per policy.
- [ ] OnlyOffice + Mail work under the same session model.
- [ ] Documented operator steps for Docker + LAN + certs.
- [ ] Reliable automated or documented init for `user_oidc` (`docker compose` or `occ` runbook).
