# DSH backend and transcript support

This is the Agent Panel half of the native DeepSeek Harness (DSH) ACP proposal:
https://github.com/artokun/comfyui-mcp/issues/2938

Use it together with the companion comfyui-mcp backend. A panel-only update does
not install DSH or add an ACP executor to an older orchestrator. DSH must be
installed and configured on the orchestrator host, which may be outside the
ComfyUI container. The panel's Python probe reports authentication as unknown;
the orchestrator discovers the CLI and obtains the model list.

## User-visible behavior

- DSH appears in the backend selector and default-backend settings. Backend IDs
  remain untranslated protocol values; labels are resolved when settings render.
- `agent_status` may carry `session_id`, `used`, `context_window`, `context_pct`
  and `model`. Raw token counts are shown next to the circle and retained per
  browser conversation. A status for another session or a pending session switch
  cannot repaint the visible conversation. Older ratio-only backends still work.
- The companion adapter uses separate stream IDs on either side of a tool call.
  The final summary therefore appears after tool activity rather than replacing
  the first thinking bubble of the whole turn.
- `stream.phase="think_end"` closes a thought-only bubble, including in a hidden
  tab where animation frames pause. It does not discard an already-pending text
  commit. `stream.phase="process"` marks pre-tool text as foldable execution
  details; it tolerates a marker arriving before or after the typewriter commit.
  The explicit marker is stored with the chat message and respected on replay.

Nothing is classified by matching the model's wording. Existing unmarked chat
messages are not retroactively reordered or hidden. This change does not add a
DSH history-deletion RPC: deleting browser history remains a browser operation.

## Validation

The unit tests exercise thought-only completion, pending text commits, marker
ordering, reset behavior, shared-store persistence, session-scoped usage restore
and the actual renderer wiring. Existing context-ring/i18n tests include DSH.
Run `npm run test:unit`, `npm run typecheck`, and the Python provider tests.

For end-to-end tests, use an isolated orchestrator/port. Browser tabs on the same
production orchestrator can share a selected conversation; a fresh headless tab
is not isolation. Do not send synthetic prompts to a user's session or refresh
an unsaved workflow to verify this UI.
