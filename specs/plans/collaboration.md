# Collaboration Future Plan

Kin Office collaboration is intentionally disabled in runtime code as of the current state.

## Current Stop Condition

The prototype reached Euro-Office co-authoring wrapper discovery but did not achieve a reliable end-to-end co-authoring session.

Observed successful pieces:

- `browser_editor_adapter.js` can locate packaged Docs co-authoring wrapper `main.api.Il`.
- The adapter can pass the packaged URL gate by setting `api.Il.On.ccb` / `api.Il.On.i8b(...)`.
- The adapter can install a direct transport on `api.Il.On.zha` and call `api.Il.On.x5h()`.
- The repo-owned `kinoffice-collab.service` can listen on `127.0.0.1:19129` and is deployable from this repository.

Observed blockers:

- The generic Kin `/stream-connection/ws` path failed with browser WebSocket close code `1006` before the collab service received a join.
- Euro-Office did not reliably call the patched `AscCommon.JQi()` socket factory.
- Directly wiring `api.Il.On.zha` moved the state machine further, but the transport still did not complete a usable auth/join path.

## Rules

- Do not add Kin Office routes, services, manager workers, or build entries to `../kin`.
- Keep service source in `services/kinoffice-collab/` in this repository.
- Keep Euro-Office integration in `repository/Applications/Office/kinoffice_common/browser_editor_adapter.js` or repeatable patch scripts.
- Do not use `.info` files as authoritative live collaboration state.
- Do not reintroduce Document Server, `/ds/`, `/direct/`, Docker, Nextcloud, OIDC, or the old connector.

## Re-Enable Criteria

Before setting `KIN_OFFICE_COLLAB_ENABLED = true` or writing `collab_config.json` with `enabled:true`, prove these independently:

1. A minimal browser WebSocket can connect through Kin's `/stream-connection/ws` to a local loopback echo service.
2. The same path can connect to `services/kinoffice-collab/kinoffice-collab.service` and produce a visible `join` log.
3. Euro-Office can be made to send `auth` and the service logs `auth user=...`.
4. Two editors on the same document receive participant updates.
5. Cursor messages are emitted by one editor, transformed by the service, and rendered by the other editor.
6. `saveChanges` messages are emitted by one editor, transformed by the service, and applied by the other editor.
7. Save/persistence behavior is defined and tested, including recovery on conflict/failure.

## Suggested Next Debugging Steps

1. Build a tiny local TCP echo service and verify `/stream-connection/ws?host=127.0.0.1&port=<port>&tls=0` works from a Kin app iframe.
2. If the stream proxy requires a different ticket/query shape, document and adapt the browser shim.
3. Add an explicit diagnostics page under `kinoffice_common/debug/` that tests stream WebSocket connectivity outside Euro-Office.
4. Only after generic stream WebSocket works, re-enable the adapter path behind an explicit development flag.
5. Revisit whether Euro-Office can be opened through a proper document URL/session instead of local-binary `openDocument({ buffer })`; that may be closer to its native co-authoring lifecycle.

## Known Minified Docs Mappings

From `20260606-cache25` packaged Docs:

```text
api.Il                         -> source CoAuthoringApi / CDocsCoApi wrapper
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
