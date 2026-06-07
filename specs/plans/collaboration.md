# Collaboration Plan

This branch runs the Kin Office collaboration path by default. Deploying with `./deploy.sh --to-kin` writes `collab_config.json` with `enabled:true`, installs/starts `kinoffice-collab.service`, installs `kinoffice.cmd`, and runs `scripts/verify-kinoffice-collab-preflight.sh`.

The implementation is diagnostics-first: do not call the feature production-ready until the command bridge preflight and browser proof chain pass in Kin.

## Architectural Decision

Kin Office must not use Kin's generic `/stream-connection/ws` proxy for its loopback collaboration service. That proxy accepts browser-selected targets and correctly blocks private/local addresses as SSRF protection. We leave that protection intact.

Kin Office collaboration now uses the existing authenticated command endpoint instead:

```text
browser_editor_adapter.js
  -> POST /api/commands/kinoffice action=session
  -> POST /api/commands/kinoffice action=collab_join|collab_send|collab_poll|collab_leave
  -> kinoffice.cmd connects to configured loopback kinoffice-collab.service
```

The browser never supplies a TCP host or port. The repo-owned command bridges only to the configured repo-owned service.

## Proof Chain

Existing-file opens should log lines prefixed with:

```text
[KinOfficeBrowser] Collaboration
```

The browser adapter also maintains a bounded timeline:

```js
window.KinOfficeCollabTrace
window.KinOfficeCollabLast
```

Expected proof chain for an existing DOCX:

```text
adapter create
probe start
config { enabled:true, ... }
session response
session ready { bridge:"/api/commands/kinoffice", ... }
editor config decision { enabled:true, coEditingMode:"fast" }
CoAuthoringApi found
EuroOffice trace installed
URL gate { urlReady:true, ... }
user ready
init start
getSocketIO requested OR JQi socket factory requested OR direct transport install { installed:true }
command bridge join attempt
command bridge joined
direct transport connected OR EuroOffice callback firstConnect
force online wrapper
auth start
EuroOffice outbound { type:"auth" }
command bridge inbound { type:"auth", result:1, indexUser:... }
EuroOffice callback indexUser
EuroOffice callback authParticipants
command bridge inbound { type:"connectState", participants:... }
```

Typing/cursor proof chain after two sessions join the same document:

```text
EuroOffice outbound { type:"cursor" }
command bridge inbound { type:"cursor", messages:1 }
EuroOffice callback cursor
EuroOffice outbound { type:"saveChanges", changes:... }
command bridge inbound { type:"saveChanges", changes:..., changesIndex:..., endSaveChanges:true }
EuroOffice callback saveChanges
EuroOffice callback changesIndex
```

If any line is missing, debug the preceding boundary rather than changing later layers.

Euro-Office state `1` is `WaitAuth`, `2` is `Authorized`, and `4` is `ClosedAll`. Repeated `auth start` at `state:4` is a bug; state `4` must be logged as `closed before auth` and traced back to the preceding transport failure.

## Preflight

Before opening a browser document, `./scripts/verify-kinoffice-collab-preflight.sh` must pass. It proves:

```text
collab_config.json enabled:true
deployed adapter contains KinOfficeCollabTrace
kinoffice-collab.service is installed
kinoffice-collab.service is listening on configured host:port
kinoffice command is installed
collab_join returns connectState
collab_send {"type":"auth"} returns server auth
collab_poll returns success
collab_leave returns success
```

This is the key falsifiability requirement. If preflight fails, do not ask the browser to prove collaboration.

`kinoffice.cmd` must also cold-start the deployed repo-owned `kinoffice-collab.service` if the loopback listener is missing. `./deploy.sh --to-kin` rebuilds and installs the command and service before running preflight so stale C binaries are not a valid test state.

## Working Theory

Euro-Office already contains the co-authoring engine Kin Office needs. Kin Office is enabling that existing engine with a Kin-owned backend. It is not designing a separate collaboration model.

The realistic approach is:

1. Prove the command bridge independently.
2. Prove the repo-owned collaboration service independently.
3. Attach Euro-Office to that proven transport with the smallest adapter surface possible.
4. Harden server-format messages, locks, reconnect, and persistence.

## Rules

- Do not add Kin Office routes, services, manager workers, or build entries to `../kin`.
- Keep service source in `services/kinoffice-collab/` in this repository.
- Keep Euro-Office integration in `repository/Applications/Office/kinoffice_common/browser_editor_adapter.js` or repeatable patch scripts.
- Do not use `.info` files as authoritative live collaboration state.
- Do not reintroduce Document Server, `/ds/`, `/direct/`, Docker, Nextcloud, OIDC, or the old connector.
- Do not bypass the working local-byte open/save model for ordinary editing.
- Never hardcode browser-facing hostnames. Use `window.location.origin`, Kin config, `.config.ini`, or forwarded headers.
- Leave Kin stream proxy SSRF protection intact; do not require `KIN_PROXY_ALLOW_PRIVATE` for Kin Office collaboration.

## Current Implementation

Implemented pieces:

- `./deploy.sh --to-kin` enables collaboration by default on this branch.
- `kinoffice.cmd action=session` returns authenticated user/session metadata and canonical document id.
- `kinoffice.cmd action=collab_join|collab_send|collab_poll|collab_leave` bridges authenticated command calls to `kinoffice-collab.service`.
- `kinoffice.cmd` starts the deployed `kinoffice-collab.service` and retries when the loopback listener is missing.
- `kinoffice-collab.service` supports command-bridge clients with queued inboxes as well as plain TCP diagnostic clients.
- `browser_editor_adapter.js` installs a Socket.IO-compatible command bridge shim and direct minified transport compatibility path.
- `browser_editor_adapter.js` forces the outer packaged co-authoring wrapper online when the service transport is connected but `CDocsCoApi` did not set its own online flag.
- The service logs `join`, `leave`, `auth`, `saveChanges`, and `cursor`.
- The service transforms client `cursor` and `saveChanges` into server-format messages before broadcasting.

Known packaged Docs minified mappings from `20260606-cache25`:

```text
api.Il                         -> source api.CoAuthoringApi / CDocsCoApi wrapper
api.Il.Qe(...)                 -> source CDocsCoApi.init(...)
api.Il.i8b(url)                -> source CDocsCoApi.set_url(url)
api.Il.t1b()                   -> source CDocsCoApi.get_state()
api.Il.vxe()                   -> source CDocsCoApi.getUsers()
api.Il.On                      -> underlying DocsCoApi transport
api.Il.On.ccb                  -> private URL marker checked by On.YUe()
api.Il.On.i8b(url)             -> sets private URL marker
api.Il.On.YUe()                -> source isRightURL()
api.Il.On.q4h()                -> creates the socket transport
api.Il.On.zha                  -> current socket object
api.Il.On.w5h(message)         -> dispatches incoming server messages
api.Il.On.x5h()                -> handles socket connect and sets state to WaitAuth
AscCommon.JQi()                -> packaged Socket.IO factory lookup
```

## Server Protocol

Required message behavior:

- Participants use Euro-Office connection ids in `id` (`userId + indexUser`) and preserve Kin usernames in `idOriginal`.
- `saveChanges` broadcasts contain `changes` as an array of objects with `change`, `user`, `useridoriginal`, and `time`.
- `saveChanges` broadcasts include room-level `changesIndex`, `syncChangesIndex`, and `endSaveChanges:true`.
- `cursor` broadcasts contain a `messages` array with `cursor`, `user`, and `useridoriginal`.
- The service assigns monotonically increasing room `changesIndex` values.
- Lock messages are acknowledged and broadcast in the server shape expected by Docs first, then Sheets and Slides.

## Persistence

Final file persistence stays with Kin/DOS. `dos.service` already provides staged writes, `fsync`, atomic `rename`, and Office ZIP patch conflict checks. Collaboration should coordinate when to save, but should not bypass DOS persistence.

Initial persistence strategy:

1. Elect one browser editor as save leader for the room.
2. Save leader exports full OOXML with the existing browser export path.
3. Kin Office writes through existing `patch_binary` or staged upload/write APIs.
4. On save failure, preserve current recovery-copy behavior.

## Remaining Work

1. Prove two real browser sessions can auth through the command bridge.
2. Prove participant updates, cursor updates, and `saveChanges` render in the receiving editor.
3. Persist and replay ordered changes for reconnecting clients.
4. Complete lock semantics for Docs, Sheets, and Slides.
5. Add save-leader election and final OOXML persistence coordination.
6. Detect external file changes during active collaboration sessions.

## Verification

Before browser testing:

```bash
node --check repository/Applications/Office/kinoffice_common/browser_editor_adapter.js
./scripts/build-kinoffice-cmd.sh
make -C services/kinoffice-collab
./deploy.sh --to-kin
./scripts/verify-kinoffice-collab-preflight.sh
```
