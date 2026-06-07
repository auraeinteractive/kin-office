# Collaboration Future Plan

Kin Office collaboration is intentionally disabled in runtime code as of the current state. Re-enable it only after the staged checks below pass in Kin.

## Working Theory

Euro-Office already contains the co-authoring engine Kin Office needs. The failed attempt likely missed one ordinary boundary condition, not a need for a new collaboration architecture.

The font work in `specs/problems/font-problem.md` is the model for the next pass: stop guessing at the visible symptom, instrument the exact layer that should have made the transition, and prove each boundary with a minimal test before changing the next one. In the collaboration attempt, Kin Office jumped into a minified Euro-Office co-authoring state machine while the generic Kin stream WebSocket path had not yet been proven from a Kin app iframe. The observed `1006` close happened before `kinoffice-collab.service` received a TCP connection, so service protocol changes and Euro-Office message shaping could not have fixed that test.

The realistic approach is therefore:

1. Prove Kin's existing stream proxy independently.
2. Prove the repo-owned collaboration service independently.
3. Attach Euro-Office to that proven transport with the smallest adapter surface possible.
4. Only then harden server-format messages, locks, reconnect, and persistence.

## Current Stop Condition

The prototype reached Euro-Office co-authoring wrapper discovery but did not achieve a reliable end-to-end co-authoring session.

Observed successful pieces:

- `browser_editor_adapter.js` can locate packaged Docs co-authoring wrapper `main.api.Il`.
- The adapter can pass the packaged URL gate by setting `api.Il.On.ccb` / `api.Il.On.i8b(...)`.
- The adapter can install a direct transport on `api.Il.On.zha` and call `api.Il.On.x5h()`.
- The repo-owned `kinoffice-collab.service` can listen on `127.0.0.1:19129` and is deployable from this repository.
- `kinoffice-collab.service` has visible logs for `join`, `auth`, `saveChanges`, and `cursor`, which are useful as the first service-side truth source.

Observed blockers:

- The generic Kin `/stream-connection/ws` path failed with browser WebSocket close code `1006` before the collab service received a join.
- Euro-Office did not reliably call the patched `AscCommon.JQi()` socket factory.
- Directly wiring `api.Il.On.zha` moved the state machine further, but the transport still did not complete a usable auth/join path.
- The attempted service protocol work could not be validated because the browser never reached the service during the failing test.

## Rules

- Do not add Kin Office routes, services, manager workers, or build entries to `../kin`.
- Keep service source in `services/kinoffice-collab/` in this repository.
- Keep Euro-Office integration in `repository/Applications/Office/kinoffice_common/browser_editor_adapter.js` or repeatable patch scripts.
- Do not use `.info` files as authoritative live collaboration state.
- Do not reintroduce Document Server, `/ds/`, `/direct/`, Docker, Nextcloud, OIDC, or the old connector.
- Do not bypass the working local-byte open/save model for ordinary editing. A document URL/session experiment is allowed only as a diagnostic to understand Euro-Office's native co-authoring lifecycle.
- Never hardcode hostnames. Use `window.location.origin`, Kin config, `.config.ini`, or forwarded headers.

## Phase 1: Prove Kin Stream Transport

Build a tiny diagnostic that runs inside Kin, not as a standalone static server. It should live under `repository/Applications/Office/kinoffice_common/debug/` or another Kin Office-owned path and be reachable from the existing Kin app environment.

This diagnostic should:

- Request `POST /api/stream-connection/ws-ticket` with the same credentials and origin as Kin Office.
- Open `new WebSocket(new URL(wsPath, window.location.origin))` using the returned ticket, host, port, and tls fields.
- Send newline-delimited JSON to a tiny local loopback TCP echo service.
- Display and `console.log` ticket response, final WebSocket URL with the ticket redacted, `open`, `message`, `error`, `close.code`, and `close.reason`.
- Confirm whether the stream proxy expects exact query parameter names, host allow-listing, TLS flags, subprotocols, message framing, or a different ticket request shape.

Success criteria:

- A Kin app iframe can connect through `/stream-connection/ws` to a local echo service.
- The echo service receives bytes and the browser receives them back.
- The documented URL/ticket shape is updated if Kin's stream proxy differs from the current assumption.

Do not touch Euro-Office co-authoring again until this succeeds.

## Phase 2: Prove The Collab Service As A Plain Socket Peer

After Phase 1 succeeds, point the same diagnostic at `services/kinoffice-collab/kinoffice-collab.service`.

This check should:

- Start the service from this repo or use the deployed service.
- Send the exact initial `hello` JSON that `browser_editor_adapter.js` intends to send.
- Send a minimal Euro-Office-like `auth` message if the service expects one after `hello`.
- Verify service logs show `join user=... document=...` and `auth user=...`.
- Verify the browser receives participant/auth responses in the shape Euro-Office will later consume.

Success criteria:

- The service receives a TCP connection through Kin's stream proxy.
- The service logs a join and auth for a canonical document id.
- Two diagnostic browser sessions in the same Kin workspace can see participant updates without loading Euro-Office.

## Phase 3: Attach Euro-Office With Minimal Adapter Changes

Once the transport and service are proven, reconnect Euro-Office.

Prefer the most native Euro-Office path that does not break Kin's working local-byte open/save:

- Keep the current local `editor.openDocument({ buffer })` path as the production open path.
- Before manually poking minified members, retry installing the socket factory at both `AscCommon.getSocketIO()` and `AscCommon.JQi()` and capture whether either factory is called.
- If the factory is still bypassed, keep the direct `api.Il.On.zha` transport injection as a targeted compatibility path, but treat it as a packaged-runtime shim rather than the primary design.
- Keep forcing the non-empty co-authoring URL marker because `DocsCoApi.isRightURL()` gates online mode on it.
- Keep `window.IS_NATIVE_EDITOR = false` in the inner editor before co-authoring init.

Add diagnostics similar to the successful font debugging:

- Log when the wrapper is found, including path, score, source/minified method names, and state before/after init.
- Log whether `AscCommon.getSocketIO()` or `AscCommon.JQi()` was requested.
- Log direct transport install, WebSocket `open`, first outbound message type, first inbound message type, and `auth()` state.
- Log service-side `join` and `auth` with the same document id and user so browser and service logs can be matched.

Success criteria:

- Euro-Office sends `auth` through the proven Kin stream path.
- The service logs `auth user=... document=...`.
- Euro-Office reaches an online co-authoring state without buffering `auth()` forever.

## Phase 4: Implement Only The Server Protocol Euro-Office Expects

Do not blindly rebroadcast client messages. The service must emit server-format messages expected by `docscoapi.js` and the packaged runtime.

Required message behavior:

- Participants use Euro-Office connection ids in `id` (`userId + indexUser`) and preserve Kin usernames in `idOriginal`.
- `saveChanges` broadcasts contain `changes` as an array of objects with `change`, `user`, `useridoriginal`, and `time`.
- `saveChanges` broadcasts include room-level `changesIndex`, `syncChangesIndex`, and `endSaveChanges:true`.
- `cursor` broadcasts contain a `messages` array with `cursor`, `user`, and `useridoriginal`.
- The service assigns monotonically increasing room `changesIndex` values.
- Lock messages are acknowledged and broadcast in the server shape expected by Docs first, then Sheets and Slides.

Success criteria:

- Two Docs editors on the same Kin path receive participant updates.
- Cursor movement from one editor renders in the other editor.
- Typing in one editor produces `saveChanges` from the sender, a transformed server message from the service, and visible document changes in the receiver.

## Phase 5: Persistence And Recovery

Final file persistence stays with Kin/DOS. Collaboration coordinates when to save; it must not bypass DOS staged writes, atomic rename, ZIP patch conflict checks, or recovery-copy behavior.

Initial production strategy:

1. Elect one browser editor as save leader for the room.
2. Save leader exports full OOXML with the existing browser export path.
3. Kin Office writes through the existing `patch_binary` or staged upload/write APIs.
4. On save failure, preserve current recovery-copy behavior.
5. Detect external file changes during active collaboration sessions and pause collaborative save until the user resolves the conflict.

Success criteria:

- A collaborative Docs session can save to the original Kin path.
- Save failure does not corrupt the original file.
- A recovery copy is created on failed final save or autosave conflict.
- The trusted save baseline is updated only after Kin reads back and verifies the saved bytes.

## Phase 6: Broaden Beyond Docs

After Docs works, repeat the same transport and protocol checks for Sheets and Slides. Do not assume their minified co-authoring wrappers or lock message shapes are identical to Docs.

Success criteria:

- XLSX and PPTX sessions can join the same service architecture.
- Sheet cell/range locks work enough to prevent obvious conflicting edits.
- Slide object locks work enough to prevent obvious conflicting edits.
- Save leader and recovery behavior remains shared through Kin Office persistence, not duplicated per editor type.

## Re-Enable Criteria

Before setting `KIN_OFFICE_COLLAB_ENABLED = true` or writing `collab_config.json` with `enabled:true`, prove these independently:

1. A minimal browser WebSocket can connect through Kin's `/stream-connection/ws` to a local loopback echo service.
2. The same path can connect to `services/kinoffice-collab/kinoffice-collab.service` and produce a visible `join` log.
3. Two diagnostic sessions can exchange participant messages without Euro-Office loaded.
4. Euro-Office can be made to send `auth` and the service logs `auth user=...`.
5. Two editors on the same document receive participant updates.
6. Cursor messages are emitted by one editor, transformed by the service, and rendered by the other editor.
7. `saveChanges` messages are emitted by one editor, transformed by the service, and applied by the other editor.
8. Save/persistence behavior is defined and tested, including recovery on conflict/failure.

## Known Minified Docs Mappings

From `20260606-cache25` packaged Docs:

```text
api.Il                         -> source CoAuthoringApi / CDocsCoApi wrapper
api.Il.Qe(...)                 -> source CDocsCoApi.init(...)
api.Il.i8b(url)                -> source CDocsCoApi.set_url(...)
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

These mappings are diagnostic aids, not stable API. If a future package changes them, preserve the method-shape scanner and diagnostics in `browser_editor_adapter.js` before updating the mapping table.
