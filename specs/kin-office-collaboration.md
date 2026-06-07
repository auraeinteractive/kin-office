# Kin Office Collaboration

Kin Office collaboration is service-backed. Active users, cursors, locks, and ordered Euro-Office changes are not coordinated through per-file `.info` JSON files.

Runtime status: this collaboration branch deploys the collaboration path by default with `./deploy.sh --to-kin`. The implementation is still diagnostics-first: treat the command bridge preflight and browser traces as the source of truth before calling a browser session healthy.

`browser_editor_adapter.js` logs collaboration decisions for existing-file opens. If no console lines prefixed with `[KinOfficeBrowser] Collaboration` appear, the deployed adapter is stale or the opened document did not reach the browser adapter path.

For browser-side debugging, inspect:

```js
window.KinOfficeCollabTrace
window.KinOfficeCollabLast
```

These entries intentionally follow Euro-Office's existing `CDocsCoApi`/`DocsCoApi` lifecycle: URL gate, socket factory or direct transport install, command bridge join, `connect` -> `WaitAuth`, outbound `auth`, inbound server `auth`, participants, `connectState`, cursor, locks, and `saveChanges`.

## Direction

Kin Office uses Euro-Office's existing browser co-authoring engine, but the transport is owned by Kin Office:

```text
Euro-Office editor
  -> Kin Office Socket.IO-compatible browser shim
  -> POST /api/commands/kinoffice action=session
  -> POST /api/commands/kinoffice action=collab_join|collab_send|collab_poll|collab_leave
  -> kinoffice.cmd loopback bridge
  -> kin-office/services/kinoffice-collab/kinoffice-collab.service
  -> in-memory document sessions
  -> dos.service for final persistence
```

Kin's generic `/stream-connection/ws` proxy is deliberately not used for Kin Office collaboration. That proxy accepts browser-selected network targets, so its SSRF protection must continue blocking private/local targets such as `127.0.0.1`. Kin Office's browser never supplies a host or port for collaboration traffic; the authenticated `kinoffice.cmd` connects only to the configured repo-owned collaboration service.

The `.info` file may later store diagnostic or last-known metadata, but it must not be the authoritative source for live presence, co-editing locks, cursors, or change ordering.

## Ownership Rule

Kin Office must not add service source, route handlers, manager worker entries, or build entries to `../kin`. The collaboration service and command bridge are owned by this repo and are copied into Kin build/install locations by `deploy.sh` and the Debian package.

## Service Surface

`services/kinoffice-collab/` owns active Office collaboration sessions. It is a standalone loopback TCP service. Kin Office uses existing Kin HTTP command execution rather than adding Kin Office-specific endpoints to Kin:

1. Browser requests `POST /api/commands/kinoffice` with `action=session`, Kin path, and file type.
2. Kin command execution prepends validated `username=` and `sessionid=` arguments; `kinoffice.cmd` returns user/session metadata and the canonical collaboration document id.
3. Browser creates a per-editor `clientId`.
4. Browser joins with `action=collab_join`, then sends Euro-Office messages with `action=collab_send` and polls queued server messages with `action=collab_poll`.
5. `kinoffice.cmd` bridges those operations to `kinoffice-collab.service` over configured loopback TCP. Browser parameters never choose the TCP destination.
6. If the configured loopback service is not reachable, `kinoffice.cmd` starts the repo-owned deployed `kinoffice-collab.service` and retries the connection before returning failure.
7. `kinoffice-collab.service` owns the in-memory room for the canonical document id.

Session response shape:

```json
{
  "response": "success",
  "action": "session",
  "documentId": "kin-office-...",
  "path": "Work:Docs/myfile.docx",
  "fileType": "docx",
  "user": {
    "id": "hogne",
    "name": "hogne"
  },
  "collab": {
    "host": "127.0.0.1",
    "port": 19129,
    "tls": false
  }
}
```

Bridge response shape:

```json
{
  "response": "success",
  "messages": [
    { "type": "connectState", "participants": [] },
    { "type": "auth", "result": 1, "indexUser": 1 }
  ]
}
```

## Browser Adapter

`browser_editor_adapter.js` requests session metadata for existing Kin paths, then installs a small Socket.IO-compatible shim for Euro-Office's co-authoring layer. The shim exposes the methods used by `sdkjs/common/docscoapi.js`, but transports JSON through authenticated `kinoffice.cmd` bridge calls instead of Kin's generic stream WebSocket proxy.

The adapter intentionally patches around a Euro-Office lifecycle mismatch without editing vendor assets:

- Kin opens document bytes locally through browser `x2t.wasm` and `editor.openDocument({ buffer })`.
- Euro-Office normally starts co-authoring from `api.asc_LoadDocument()`, but that path would also try to open the file through server URLs.
- For Kin collaboration, the adapter opens bytes first, then manually bootstraps `api.CoAuthoringApi` with the Kin document id and authenticated user, waits for the command bridge transport to reach `WaitAuth`, and calls `auth()`.
- Participant `id` values sent by `kinoffice-collab.service` must equal Euro-Office's connection id (`userId + indexUser`); the original Kin username is sent as `idOriginal`.

Packaged/minified Euro-Office caveat:

- Do not assume the runtime exposes `api.CoAuthoringApi` by that source name. Packaged `sdk-all-min.js` can minify or hide source property names.
- `browser_editor_adapter.js` must locate the co-authoring wrapper by behavior/method shape, scanning `main.api`, `Asc.editor`, `window.editor`, and `window.api`, including non-enumerable and prototype properties.
- The method-shape scan intentionally looks for the cluster used by `AscCommon.CDocsCoApi`/`DocsCoApi`: `init`, `auth`, `getUsers`, `saveChanges`, `askLock`, `unSaveLock`, and `disconnect`.
- In the `20260606-cache25` packaged Docs runtime, this wrapper was observed as `api.Il`; source `init(...)` was minified to `Qe(...)`, source `set_url(...)` was minified to `i8b(...)`, source `get_state()` was minified to `t1b()`, and source `getUsers()` was minified to `vxe()`. The adapter supports both source and minified names.
- The same runtime calls the Socket.IO factory through minified `AscCommon.JQi()` rather than source `AscCommon.getSocketIO()`. The adapter must install the Kin socket factory under both names before calling co-authoring init.
- The same runtime gates online co-authoring on `api.Il.On.YUe()`, which checks private `api.Il.On.ccb`. The adapter explicitly sets that URL marker before calling `api.Il.Qe(...)`; otherwise the wrapper takes the offline branch and `auth()` is buffered forever.
- The adapter forces `window.IS_NATIVE_EDITOR = false` before co-authoring init so the browser Socket.IO factory path is used. A SockJS-compatible fallback shim exists only as a guard; the expected path is `AscCommon.JQi()` -> Kin command bridge shim.
- If the packaged runtime still bypasses the patched factory, the adapter installs the Kin command bridge shim directly on `api.Il.On.zha`, forwards incoming messages to `api.Il.On.w5h(...)`, and calls `api.Il.On.x5h()` on bridge connect so `auth()` is not buffered forever.
- Packaged `CDocsCoApi` can report a ready URL gate and still leave the outer wrapper offline after init. If `connectState` arrives but `EuroOffice outbound { type:"auth" }` does not, the wrapper did not enter online mode. The adapter forces the wrapper online before calling `auth()` and logs `force online wrapper` for this boundary.
- The same runtime calls authenticated user getters through minified methods (`vca`, `hna`, `hud`, `nud`). The adapter's fallback user object must provide those methods as well as source `asc_getId`, `asc_getUserName`, `asc_getFirstName`, and `asc_getLastName`.
- If the wrapper is found under a minified key, the adapter may alias it back to `api.CoAuthoringApi` and force the internal co-authoring URL marker to a non-empty value so Euro-Office does not stay in offline mode.
- If the wrapper is not found, preserve and use the adapter's `CoAuthoringApi candidates not found` diagnostics before changing the integration. Those diagnostics are part of the supported debugging workflow for future Euro-Office updates.

Collaboration-capable sessions use real Kin user identity in `editorConfig.user` and enable:

```js
coEditing: {
    mode: 'fast',
    change: true
}
```

The existing direct local-byte open path remains in place for unsaved blank documents and fallback/debug scenarios.

## Server Message Shape

Do not blindly rebroadcast client messages. The service must emit server-format messages expected by `docscoapi.js` and the packaged runtime:

- Participants use Euro-Office connection ids in `id` (`userId + indexUser`) and preserve Kin usernames in `idOriginal`.
- `saveChanges` broadcasts contain `changes` as an array of objects with `change`, `user`, `useridoriginal`, and `time`.
- `saveChanges` broadcasts include room-level `changesIndex`, `syncChangesIndex`, and `endSaveChanges:true`.
- `cursor` broadcasts contain a `messages` array with `cursor`, `user`, and `useridoriginal`.
- The service assigns monotonically increasing room `changesIndex` values.
- Lock messages are acknowledged and broadcast in the server shape expected by Docs first, then Sheets and Slides.

## Debugging

Before opening a browser document, `./scripts/verify-kinoffice-collab-preflight.sh` must pass. It proves:

```text
collab_config.json enabled:true
deployed adapter contains KinOfficeCollabTrace
kinoffice-collab.service is installed
kinoffice-collab.service is listening on configured host:port
kinoffice command bridge can collab_join
kinoffice command bridge can collab_send {"type":"auth"} and receive auth
kinoffice command bridge can collab_poll
kinoffice command bridge can collab_leave
```

The deployed command is also expected to recover from a missing listener by cold-starting the deployed service. A browser log of `command bridge join failed Collaboration service is not reachable` means this command-side autostart boundary failed or the machine is running a stale command binary.

Expected browser trace after opening an existing DOCX:

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

If any line is missing, debug the preceding boundary rather than changing later layers.

Euro-Office connection state `1` is `WaitAuth`, `2` is `Authorized`, and `4` is `ClosedAll`. Do not treat `state:4` as auth-ready; it means the transport closed before auth, usually after a failed bridge join/connect.

## Persistence

Final file persistence stays with Kin/DOS. `dos.service` already provides staged writes, `fsync`, atomic `rename`, and Office ZIP patch conflict checks. Collaboration should coordinate when to save, but should not bypass DOS persistence.

Initial persistence strategy:

1. Elect one browser editor as save leader for the room.
2. Save leader exports full OOXML with the existing browser export path.
3. Kin Office writes through existing `patch_binary` or staged upload/write APIs.
4. On save failure, preserve current recovery-copy behavior.

## Remaining Work

- Persist and replay ordered changes for reconnecting clients.
- Complete lock semantics for Docs, Sheets, and Slides.
- Add save-leader election and final OOXML persistence coordination.
- Detect external file changes during active collaboration sessions.
- Add recovery-copy behavior for failed final saves.

## Verification

After collaboration changes:

```bash
node --check repository/Applications/Office/kinoffice_common/browser_editor_adapter.js
node --check repository/Applications/Office/kinoffice_common/office_app.js
node --check repository/Applications/Office/kinoffice_docs/app.js
node --check repository/Applications/Office/kinoffice_sheets/app.js
node --check repository/Applications/Office/kinoffice_slides/app.js
python3 -m py_compile scripts/generate-kinoffice-allfonts.py scripts/patch-euro-office-save-hooks.py
make -C services/kinoffice-collab
./scripts/build-kinoffice-cmd.sh
./scripts/verify-kinoffice-collab-preflight.sh
```
