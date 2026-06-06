# Kin Office Collaboration

Kin Office collaboration is service-backed. Active users, cursors, locks, and ordered Euro-Office changes are not coordinated through per-file `.info` JSON files.

Runtime status: collaboration is intentionally disabled. See [Collaboration Future Plan](./plans/collaboration.md) before re-enabling it.

## Direction

Kin already has authenticated WebSocket routing. Kin Office uses those facilities through a dedicated collaboration service that lives in this repository, not in Kin core:

```text
Euro-Office editor
  -> Kin Office Socket.IO-compatible browser shim
  -> /api/commands/kinoffice action=session
  -> /api/stream-connection/ws-ticket
  -> /stream-connection/ws?ticket=...&host=127.0.0.1&port=19129&tls=0
  -> Kin stream proxy
  -> kin-office/services/kinoffice-collab/kinoffice-collab.service
  -> in-memory document sessions
  -> dos.service for final persistence
```

The `.info` file may later store diagnostic or last-known metadata, but it must not be the authoritative source for live presence, co-editing locks, cursors, or change ordering.

## Ownership Rule

Kin Office must not add service source, route handlers, manager worker entries, or build entries to `../kin`. The collaboration service is owned by this repo and is copied into Kin build/install locations by `deploy.sh` and the Debian package.

## Service Surface

`services/kinoffice-collab/` owns active Office collaboration sessions. It is a standalone loopback TCP service. Kin Office uses existing Kin HTTP facilities rather than adding Kin Office-specific endpoints to Kin:

1. Browser requests `POST /api/commands/kinoffice` with `action=session`, Kin path, and file type.
2. Kin command execution prepends the validated `username=` and `sessionid=` arguments; `kinoffice.cmd` returns user/session metadata and the configured collaboration host/port.
3. Browser requests `POST /api/stream-connection/ws-ticket` for a short-lived authenticated stream ticket.
4. Browser connects to `GET /stream-connection/ws?ticket=...&host=...&port=...&tls=0`.
5. The Kin stream proxy opens the loopback TCP connection to `kinoffice-collab.service`.
6. The browser sends an initial `hello` JSON message containing user, session, document id, Kin path, and file type.
7. `kinoffice-collab.service` owns the in-memory room for the canonical document id.

Ticket response shape:

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

## Browser Adapter

`browser_editor_adapter.js` requests session metadata and a stream ticket for existing Kin paths, then installs a small Socket.IO-compatible shim for Euro-Office's co-authoring layer. The shim exposes the methods used by `sdkjs/common/docscoapi.js`, but transports newline-delimited JSON over Kin's generic stream WebSocket proxy.

The adapter intentionally patches around a Euro-Office lifecycle mismatch without editing vendor assets:

- Kin opens document bytes locally through browser `x2t.wasm` and `editor.openDocument({ buffer })`.
- Euro-Office normally starts co-authoring from `api.asc_LoadDocument()`, but that path would also try to open the file through server URLs.
- For Kin collaboration, the adapter opens bytes first, then manually bootstraps `api.CoAuthoringApi` with the Kin document id and authenticated user, waits for the socket to reach `WaitAuth`, and calls `auth()`.
- Participant `id` values sent by `kinoffice-collab.service` must equal Euro-Office's connection id (`userId + indexUser`); the original Kin username is sent as `idOriginal`.

Packaged/minified Euro-Office caveat:

- Do not assume the runtime exposes `api.CoAuthoringApi` by that source name. Packaged `sdk-all-min.js` can minify or hide source property names.
- `browser_editor_adapter.js` must locate the co-authoring wrapper by behavior/method shape, scanning `main.api`, `Asc.editor`, `window.editor`, and `window.api`, including non-enumerable and prototype properties.
- The method-shape scan intentionally looks for the cluster used by `AscCommon.CDocsCoApi`/`DocsCoApi`: `init`, `auth`, `getUsers`, `saveChanges`, `askLock`, `unSaveLock`, and `disconnect`.
- In the `20260606-cache25` packaged Docs runtime, this wrapper was observed as `api.Il`; source `init(...)` was minified to `Qe(...)`, source `set_url(...)` was minified to `i8b(...)`, source `get_state()` was minified to `t1b()`, and source `getUsers()` was minified to `vxe()`. The adapter supports both source and minified names.
- The same runtime calls the Socket.IO factory through minified `AscCommon.JQi()` rather than source `AscCommon.getSocketIO()`. The adapter must install the Kin socket factory under both names before calling co-authoring init.
- The same runtime gates online co-authoring on `api.Il.On.YUe()`, which checks private `api.Il.On.ccb`. The adapter explicitly sets that URL marker before calling `api.Il.Qe(...)`; otherwise the wrapper takes the offline branch and `auth()` is buffered forever.
- The adapter forces `window.IS_NATIVE_EDITOR = false` before co-authoring init so the browser Socket.IO factory path is used. A SockJS-compatible fallback shim exists only as a guard; the expected path is `AscCommon.JQi()` -> Kin WebSocket shim.
- If the packaged runtime still bypasses the patched factory, the adapter installs the Kin WebSocket shim directly on `api.Il.On.zha`, forwards incoming messages to `api.Il.On.w5h(...)`, and calls `api.Il.On.x5h()` on WebSocket connect so `auth()` is not buffered forever.
- The same runtime calls authenticated user getters through minified methods (`vca`, `hna`, `hud`, `nud`). The adapter's fallback user object must provide those methods as well as source `asc_getId`, `asc_getUserName`, `asc_getFirstName`, and `asc_getLastName`.
- If the wrapper is found under a minified key, the adapter may alias it back to `api.CoAuthoringApi` and force the internal co-authoring URL marker to a non-empty value so Euro-Office does not stay in offline mode.
- If the wrapper is not found, preserve and use the adapter's `CoAuthoringApi candidates not found` diagnostics before changing the integration. Those diagnostics are part of the supported debugging workflow for future Euro-Office updates.

If Euro-Office changes `AscCommon.CDocsCoApi`, `DocsCoApi.isRightURL()`, `baseEditorsApi.asc_LoadDocument()`, co-authoring wrapper method names, minification behavior, or participant fields in `docscoapicommon.js`, revisit this integration before updating vendor packages.

Collaboration-capable sessions use real Kin user identity in `editorConfig.user` and enable:

```js
coEditing: {
    mode: 'fast',
    change: true
}
```

The existing direct local-byte open path remains in place for unsaved blank documents and fallback/debug scenarios.

## Current Implementation State

The first implementation adds the repo-owned service, browser session request, stream ticket request, and browser transport shim. The service currently provides the session and message-routing foundation: participants, basic lock handling, and raw Euro-Office message broadcast.

## Current Blocker

Collaborative editing is not working yet. Stop treating it as enabled until this section is resolved.

Observed state during testing with two users on `Work:TheHelloWorld2.docx`:

- Both browser sessions can open the same document.
- The adapter can find the packaged Docs co-authoring wrapper as `main.api.Il` with score `16`.
- The adapter can pass the packaged Docs online URL gate (`Collaboration URL ready=true`).
- The adapter can manually install a direct transport on `api.Il.On.zha` and drive co-authoring state far enough that `auth()` starts with state `4`.
- The actual WebSocket connection through Kin's generic stream proxy fails before it reaches `kinoffice-collab.service`:

```text
WebSocket connection to 'wss://localhost:9219/stream-connection/ws?ticket=...&host=127.0.0.1&port=19129&tls=0' failed
[KinOfficeBrowser] Collaboration WebSocket error
[KinOfficeBrowser] Collaboration WebSocket closed 1006
[KinOfficeBrowser] Collaboration auth start state=4
```

The service log showed only that the service was listening, not document joins/auth after this failure. That means the failure is currently before the collab service receives a TCP connection.

Do not continue by adding Kin Office routes or service source to `../kin`. The last user decision was explicit: Kin Office service source must remain in this repository and be deployed/packaged from here.

Failed/insufficient approaches tried:

- Adding Kin Office-specific routes and service source to `../kin` worked against project ownership rules and was removed.
- Relying on `.info` for live presence was rejected; live state belongs in a service.
- Installing only `AscCommon.getSocketIO()` was insufficient because the packaged runtime calls minified `AscCommon.JQi()`.
- Installing both `AscCommon.getSocketIO()` and `AscCommon.JQi()` still did not produce a `JQi socket factory requested` log in the tested path.
- Forcing `window.IS_NATIVE_EDITOR = false` did not make the runtime use the patched factory.
- Directly installing the Kin WebSocket shim on `api.Il.On.zha`, forwarding incoming messages to `api.Il.On.w5h(...)`, and calling `api.Il.On.x5h()` did get the co-authoring state moving, but the WebSocket still failed at the Kin stream proxy URL with close code `1006`.
- Broadcasting raw client `saveChanges`/`cursor` messages was wrong. The service was patched to shape server-format messages, but that path has not been validated because the WebSocket connection currently fails before service join/auth.

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

Next debugging should focus on why Kin's existing `/stream-connection/ws` proxy rejects or closes this WebSocket request before reaching `127.0.0.1:19129`. Validate the generic stream proxy with a minimal local echo/TCP service before continuing with Euro-Office co-authoring.

Important server-message shaping:

- Do not blindly rebroadcast client `saveChanges` messages. Euro-Office receivers expect server `saveChanges` messages with `changes` as an array of objects containing `change`, `user`, `useridoriginal`, and `time`, plus room-level `changesIndex`, `syncChangesIndex`, and `endSaveChanges:true`.
- Do not blindly rebroadcast client `cursor` messages. Euro-Office receivers expect `cursor` messages with a `messages` array containing `cursor`, `user`, and `useridoriginal`.
- The service is responsible for assigning monotonically increasing room `changesIndex` values and for using the sender's Euro-Office connection id (`userId + indexUser`) as `user`.

The remaining work is to harden the Euro-Office protocol implementation for production co-editing:

- Persist and replay ordered changes for reconnecting clients.
- Complete lock semantics for Docs, Sheets, and Slides.
- Add save-leader election and final OOXML persistence coordination.
- Detect external file changes during active collaboration sessions.
- Add recovery-copy behavior for failed final saves.

## Persistence

Final file persistence stays with Kin/DOS. `dos.service` already provides staged writes, `fsync`, atomic `rename`, and Office ZIP patch conflict checks. Collaboration should coordinate when to save, but should not bypass DOS persistence.

Initial persistence strategy:

1. Elect one browser editor as save leader for the room.
2. Save leader exports full OOXML with the existing browser export path.
3. Kin Office writes through existing `patch_binary` or staged upload/write APIs.
4. On save failure, preserve current recovery-copy behavior.

## Verification

After collaboration changes:

```bash
node --check repository/Applications/Office/kinoffice_common/browser_editor_adapter.js
node --check repository/Applications/Office/kinoffice_common/office_app.js
node --check repository/Applications/Office/kinoffice_docs/app.js
node --check repository/Applications/Office/kinoffice_sheets/app.js
node --check repository/Applications/Office/kinoffice_slides/app.js
python3 -m py_compile scripts/generate-kinoffice-allfonts.py scripts/patch-euro-office-save-hooks.py
```

Service checks should include building from this repo:

```bash
make -C services/kinoffice-collab
```
