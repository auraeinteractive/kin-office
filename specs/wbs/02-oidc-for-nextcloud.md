# WBS: 02 - OIDC for Nextcloud (kin-office perspective)

**Project**: Self-hosted Nextcloud stack in Docker, Kin launcher apps, and Nginx bridge — authenticated via Kin as OpenID Connect IdP (`user_oidc`).  
**This repo**: `kin-office` (`docker-compose.yml`, `nginx/`, `repository/Applications/`, optional `nextcloud/` init).  
**IdP / canonical WBS**: sibling `../kin/specs/wbs/02-oidc-for-nextcloud.md` (Kin HTTP OIDC implementation and Phase A acceptance).

---

## Overview

Kin apps embed Nextcloud in an iframe and use `postMessage` through `nginx/kin-bridge.js`. **Nextcloud passwords must not** be embedded in Kin apps; login is delegated to **Nextcloud `user_oidc`**, which talks to Kin’s OIDC endpoints.

### Current stack wiring (from this repo)

- **Nextcloud container**: `nextcloud` (`nextcloud:latest`) exposed on host `http://<host>:8081/` (plain HTTP, for debugging only).
- **Reverse proxy (canonical access)**: `nginx_nextcloud_proxy` terminates TLS and serves Nextcloud at `https://<host>:5002/`.
- **OnlyOffice**: `onlyoffice` proxied same-origin under `https://<host>:5002/ds/` and also separately at `https://<host>:5003/`.
- **Bridge injection**: `nginx/conf.d/nextcloud.conf` uses `sub_filter` to inject `<script src="/kin-bridge.js"></script>` into HTML pages.
- **OIDC discovery default (container → host)**: Compose sets `KIN_OIDC_DISCOVERY_URI` default to `https://host.docker.internal:9219/.well-known/openid-configuration` and adds `extra_hosts: host.docker.internal:host-gateway` so Nextcloud can reach a Kin IdP running on the Docker host.

**Primary integration surfaces (this repo)**

| Area | Path / artifact |
|------|-----------------|
| Reverse proxy + headers | `nginx/conf.d/nextcloud.conf` |
| Bridge (login, WebDAV, OCS) | `nginx/kin-bridge.js` |
| Nextcloud iframe app | `repository/Applications/Internet/kinnextcloud/app.js` |
| OnlyOffice launchers | `repository/Applications/Office/kinonlyoffice_common/office_app.js` |
| Mail launcher | `repository/Applications/Office/kinnextcloud_mail/app.js` |
| Compose + optional OIDC bootstrap | `docker-compose.yml`, documented `occ` runbook |

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

**Concrete configuration (admin UI)**

The `user_oidc` app exposes an admin page under Nextcloud settings (exact menu name varies by Nextcloud/app version; commonly under **Settings → Administration → OpenID Connect**).

Minimum fields to set for the Kin provider:

- **Identifier**: `kin` (or `${KIN_OIDC_PROVIDER_ID}`, keep stable).
- **Discovery URI**: `${KIN_OIDC_DISCOVERY_URI}` (see Phase D: this must be reachable from inside the `nextcloud` container).
- **Client ID / secret**: `${KIN_OIDC_CLIENT_ID}` / `${KIN_OIDC_CLIENT_SECRET}`.
- **Scope**: `openid profile email` (start with `openid profile`; add `email` only if Kin provides it).
- **User ID claim**: `preferred_username` (or whatever Kin emits as stable username).
- **Auto provisioning**: enable only if you want Nextcloud accounts created on first login; otherwise pre-create users and map via claim.

**Redirect URI**

Register the Nextcloud redirect URI at the Kin provider (or configure Kin to accept it). With the Nginx proxy, the canonical redirect base is:

- `https://<host>:5002/index.php/apps/user_oidc/code/kin`

The exact path segment after `/code/` is the provider identifier you configured (e.g. `kin`).

#### B.3 Global settings (proxy, TLS, OIDC client hints)

- [x] `trusted_proxies` includes `nginx_nextcloud_proxy` (example in this repo’s docs).
- [x] `overwriteprotocol = https` where reverse proxy terminates TLS.
- [x] Self-signed Kin: `user_oidc.httpclient.allowselfsigned = true` when required.
- [x] Silent path: `user_oidc.prompt = none` (confirm for your Nextcloud / app version).

**Concrete `occ` runbook (host shell)**

These commands assume your containers are named as in `docker-compose.yml`.

- Proxy correctness (required for correct redirect URIs and secure cookies):

```bash
docker exec --user www-data nextcloud php occ config:system:set trusted_proxies 0 --value "nginx_nextcloud_proxy"
docker exec --user www-data nextcloud php occ config:system:set overwriteprotocol --value "https"
```

- Optional LAN/dev “any host” mode (matches the guidance in `AGENTS.md`):

```bash
docker exec --user www-data nextcloud php occ config:system:set trusted_domains 0 --value "*"
docker exec --user www-data nextcloud php occ config:system:delete overwritehost
```

- If discovery fetch is blocked by “local access rules”, one operator option is:

```bash
docker exec --user www-data nextcloud php occ config:system:set allow_local_remote_servers --value true --type boolean
```

Prefer fixing the discovery hostname (Phase D) over leaving this enabled broadly.

**Acceptance criteria**

- [ ] From **inside** the `nextcloud` container, `curl` to the configured discovery URL returns **200** and valid JSON (no `LocalServerException` / “violates local access rules”).
- [ ] Browser: `https://<nc-host>:5002/index.php/login` redirects through `user_oidc` to Kin authorize (not a broken discovery / 404 chain).

**Container-side verification**

Run a discovery fetch from inside the container network namespace (use `-k` only for self-signed dev):

```bash
docker exec -it nextcloud bash -lc 'curl -k -sS -D- "${KIN_OIDC_DISCOVERY_URI:-https://host.docker.internal:9219/.well-known/openid-configuration}" | head'
```

---

### Phase C — kin-office (bridge + Kin apps + automation)

#### C.1 Remove embedded Nextcloud credentials

- [x] `nginx/kin-bridge.js`: credential-less flow; navigate to `/index.php/login` for OIDC takeover.
- [x] `kinnextcloud`, OnlyOffice common launcher, Mail: `kinBridgeLogin` without credentials.

**Acceptance criteria**

- [ ] No default `admin` / `admin123` (or similar) strings in these integration paths (grep / review gate).

#### C.2 Compose / init reliability

- [x] `nextcloud_oidc_init` (or equivalent): **do not** override the Nextcloud image entrypoint in a way that skips staging of `/var/www/html/occ`. Using runbook-only approach.

**Chosen approach for this repo**

Using runbook-only (simplest):
- Removed `nextcloud_oidc_init` from compose.
- Operator uses documented `docker exec` runbook (Phase B.3 + "configure provider" checklist in Operator runbook).

**Acceptance criteria**

- [x] `docker compose up` brings the stack up without errors.
- [x] Chosen runbook-only approach: removed broken `nextcloud_oidc_init` service from `docker-compose.yml`; operator uses documented `docker exec` runbook.

---

### Phase D — Cross-network correctness (blocking “done”)

Nextcloud may block outbound requests to **localhost** when fetching OIDC discovery from inside Docker (`LocalServerException: violates local access rules`).

**Tasks**

- [ ] Choose a stable **server-side** discovery base URL (host gateway, `extra_hosts`, dedicated hostname, same public hostname as Kin, or policy-approved `allow_local_remote_servers`).
- [ ] Align **`KIN_OIDC_ISSUER`** / JWT `iss` with what `user_oidc` expects (no mismatch between internal fetch URL and issuer string unless explicitly designed).

**Recommended default for this repo (dev/LAN)**

This repo already sets up the “container → host” path using:

- `extra_hosts: ["host.docker.internal:host-gateway"]` on `nextcloud`
- default `KIN_OIDC_DISCOVERY_URI=https://host.docker.internal:9219/.well-known/openid-configuration`

Recommended strategy:

- Run Kin HTTP OIDC on the Docker host, listening on `0.0.0.0:9219`.
- Ensure the TLS served on `:9219` is either trusted by Nextcloud’s container, or enable the `user_oidc` “allow self-signed” option **only in dev**.
- Keep `issuer` consistent: Kin discovery should report `issuer: https://host.docker.internal:9219` if that is what Nextcloud uses to fetch discovery, unless `user_oidc` is configured to not enforce issuer validation.

**Production note**

For production, prefer a real DNS name and a cert trusted by clients, and avoid `host.docker.internal` (Docker convenience name).

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

## Operator runbook (quick)

### Restart checklist (dev/LAN)

#### 1) Start Kin (IdP)

- Start Kin using its `deploy.sh` so it serves HTTPS on `:9219` and proxies to Kin HTTP on `:9119`.
- For LAN/dev, make the **issuer** a LAN-reachable URL (not `localhost`), otherwise Nextcloud may refuse it or it won’t work from other devices.

Example (pick your machine’s LAN IP/hostname):

```bash
cd ../kin
KIN_OIDC_ISSUER="https://<lan-host-or-ip>:9219" ./deploy.sh
```

Sanity checks:

```bash
curl -k https://<lan-host-or-ip>:9219/.well-known/openid-configuration | head
curl -k https://<lan-host-or-ip>:9219/oidc/jwks | head
```

#### 2) Start Nextcloud stack (this repo)

```bash
docker compose up -d
```

#### 3) One-time Nextcloud settings for OIDC-in-Docker

Nextcloud may block requests to private/LAN endpoints by default (“violates local access rules”). For dev/LAN OIDC, allow local remote servers:

```bash
docker exec --user www-data nextcloud php occ config:system:set allow_local_remote_servers --type boolean --value true
```

Also (dev/LAN), allow Kin’s self-signed TLS for the `user_oidc` HTTP client and enable silent auth:

```bash
docker exec --user www-data nextcloud php occ config:system:set user_oidc httpclient.allowselfsigned --type boolean --value true
docker exec --user www-data nextcloud php occ config:system:set user_oidc prompt --type string --value none
docker exec --user www-data nextcloud php occ config:app:set --type=string --value=0 user_oidc allow_multiple_user_backends
```

#### 4) Configure the Nextcloud `user_oidc` provider discovery URL

The provider discovery URL must match the Kin issuer you started:

```bash
docker exec --user www-data nextcloud php occ user_oidc:provider kin \
  --discoveryuri="https://<lan-host-or-ip>:9219/.well-known/openid-configuration" \
  --clientid="kin-nextcloud"
```

Check it:

```bash
docker exec --user www-data nextcloud php occ user_oidc:provider kin --output=json_pretty | head -n 40
```

#### 5) Verify redirect chain (no manual Nextcloud password)

```bash
curl -k -I https://<nextcloud-host>:5002/index.php/login | head
```

You should see a redirect to `/apps/user_oidc/login/<id>` and then a redirect to Kin `/oidc/authorize?...prompt=none`.

### Environment variables

Create a `.env` (not committed) with at least:

- `NEXTCLOUD_ADMIN_USER`
- `NEXTCLOUD_ADMIN_PASSWORD`
- `KIN_OIDC_PROVIDER_ID=kin`
- `KIN_OIDC_CLIENT_ID=kin-nextcloud`
- `KIN_OIDC_CLIENT_SECRET=...`
- `KIN_OIDC_DISCOVERY_URI=https://host.docker.internal:9219/.well-known/openid-configuration`

### Bring up services

```bash
docker compose up -d
```

Then apply the proxy/trust settings from Phase B.3, install/enable `user_oidc` if needed, and configure the provider in Nextcloud’s admin UI.

### Expected UX

- Opening `https://<host>:5002/` inside Kin should land on the Nextcloud dashboard after a silent OIDC redirect.
- The `kin-bridge.js` behavior when not logged in is: navigate to `/index.php/login` and rely on `user_oidc` to redirect to the IdP; admins can bypass via `?direct=1`.

---

## Implementation pointers

**This repo**

- `nginx/conf.d/nextcloud.conf` — proxy, iframe-related headers, OnlyOffice `/ds/` routing.
- `nginx/kin-bridge.js` — `kinBridgeLogin`, navigation, WebDAV/OCS, OnlyOffice hooks.
- Apps under `repository/Applications/` as listed in the table above.
- `docker-compose.yml` — automation removed; see Operator runbook for OIDC setup via `occ`.

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
