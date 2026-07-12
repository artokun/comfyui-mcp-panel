# Per-Workflow Agent Sessions — Design Spec

**Date:** 2026-07-10
**Status:** Approved (design). Ready for implementation planning.
**Repos:** `comfyui-agent-panel` (frontend, primary) · `comfyui-mcp` (orchestrator, minimal)

## Goal

Each ComfyUI **workflow** gets its own agent conversation, instead of one shared
agent session across every workflow open in the panel. Switching ComfyUI workflow
tabs auto-swaps the chat to that workflow's conversation. Conversations persist with
saved workflows across restarts.

## Key finding (why this is small)

The backend is **already per-tab**. `PanelAgentManager` keeps
`agents = Map<tabId::backend → PanelAgent>` — each `tabId` already has its own
session, model, effort, history, and resume. The frontend already has a persistent
multi-thread system (`THREADS_KEY = "comfyui-mcp.panel.threads"` in `localStorage`,
`persistThreads()`, a thread switcher) and already knows the active workflow
(`app.extensionManager.workflow.activeWorkflow`).

The ONLY reason all workflows share one agent today: `getTabId()`
(comfyui-mcp-panel.js ~L258) mints **one UUID per browser session** (sessionStorage),
ignoring which workflow is open. Re-key that to the workflow and the existing
machinery does the rest.

## Locked decisions

1. **Identity:** hybrid — persistent for saved workflows, **adopt-on-save** for unsaved.
2. **View:** auto-follow — one sidebar chat view that swaps to the active workflow.
3. **Threads per workflow:** exactly one conversation per workflow.
4. **Background work:** a backgrounded workflow's agent keeps running (agents survive
   tab disconnect); live streaming is for the visible workflow, reconciled on return.

## Architecture

Frontend re-key. Backend essentially untouched.

### Identity — `workflowTabId()` replaces `getTabId()`

- Saved workflow (`wf.isPersisted` / has `wf.path`) → **`wf:<path>`** (stable across
  restarts → the conversation lives with the file).
- Unsaved / temporary (`wf.isTemporary === true` || `wf.isPersisted === false`) →
  **`tmp:<uuid>`**, where the uuid is minted once and kept in an in-memory
  `Map<wf.key, uuid>` for the app session.
- The chosen id becomes the `tab_id` the panel sends in its bridge `hello` frame.

Workflow identity fields available (verified): `wf.path`, `wf.filename`, `wf.key`,
`wf.isModified`, `wf.isPersisted`, `wf.isTemporary`.

### View — auto-follow

Subscribe to ComfyUI's active-workflow change (via
`app.extensionManager.workflow`). On change:
1. Compute the new `workflowTabId()`.
2. Select (or create) that workflow's single thread record.
3. Re-hello the **single** bridge socket under the new `tab_id`, and resume that
   workflow's `sessionId` via the existing `resume_session` frame.
4. Repaint the transcript from the persisted thread.

One conversation per workflow: the thread list is workflow-keyed (one thread per
workflow). "New chat" archives/clears that workflow's thread and starts a fresh
session.

### Adopt-on-save

When an unsaved workflow is saved (hook the save path — `programmaticSave` and/or
ComfyUI's save event), migrate the thread record `tmp:<uuid>` → `wf:<path>`, then
re-hello under the new `tab_id` passing the OLD `sessionId` via `resume_session`, so
the conversation started before saving carries over. Backend resume is keyed by
`sessionId` (provider-side), independent of `tabId`, so the session continues under
the new tab.

### Bridge / socket model

The bridge binds **one socket to one `tabId` at its `hello` frame**
(ui-bridge.ts: socket is anonymous until `hello`; per-frame `tab_id` is overwritten
by the hello identity). So a workflow switch = **re-hello the existing socket** under
the new `tab_id` (single client — reuse the current connect/hello path; do NOT open a
second client, to avoid the known same-`tab_id` reconnect storm). Agents for
non-visible workflows are NOT killed on the implicit disconnect (index.ts has no
kill-on-disconnect), so they keep running server-side.

## Data model

- **Thread record** (existing `threads[]`, persisted to `THREADS_KEY`): add
  `workflowKey` (the `wf:<path>` or `tmp:<uuid>` id) so each thread maps to one
  workflow. Thread selection becomes "find thread where workflowKey === current".
- **Temp-id map** (in-memory, app-session): `Map<wf.key, uuid>` for unsaved workflows.
- **Backend:** unchanged — `agents` keyed by `tabId::backend`; `sessionStore` keyed by
  `sessionId` for resume.

## Data flow

1. Panel loads → resolve active workflow → `workflowTabId()` → hello with that id →
   select that workflow's thread → resume its session → paint transcript.
2. User switches ComfyUI workflow tab → change event → new `tabId` → re-hello + resume
   + repaint. Previous workflow's agent keeps running server-side.
3. User saves an unsaved workflow → adopt-on-save migrates `tmp:` → `wf:` + re-hello +
   resume old session.
4. Backgrounded turn completes → on return, resume + persisted transcript reconcile
   the result into view.

## What changes

- **Frontend (`comfyui-mcp-panel.js`):**
  - `getTabId()` → `workflowTabId()` (workflow-derived + temp map).
  - Active-workflow change subscription → switch thread + re-hello.
  - Thread records gain `workflowKey`; selection keyed by workflow.
  - Adopt-on-save handler.
  - Ensure single bridge client re-hellos cleanly (no storm).
- **Backend (`comfyui-mcp`):** ~none. Confirm `resume_session` works across a
  `tabId` change (expected — keyed by `sessionId`). Optional (later): idle-agent
  reaping so closed workflows' agents don't accumulate.

## Edge cases

- **Multiple unsaved workflows:** each gets its own `tmp:<uuid>` via the temp map.
- **Same workflow in two browser tabs:** both derive the same `wf:<path>` → same
  `tab_id`. Last hello wins (bridge replaces the conn). Document as a known limitation.
- **Closed workflow:** thread persists (localStorage); agent idles server-side
  (reaping is a later optional).
- **Deleted workflow file:** orphan thread — prune lazily (e.g., on next full thread
  list load, drop `wf:` threads whose file no longer exists — optional).
- **Rename / move a saved workflow:** `wf:<path>` changes → effectively a new
  conversation. Acceptable v1; adopt-on-rename is a possible later enhancement.

## Verification (manual, in the browser)

1. Open two saved workflows; converse in each; switch back and forth → each shows its
   own thread.
2. Kick a long turn in workflow A; switch to B; return to A → the turn completed and is
   visible (background survival).
3. Start chatting in an "Unsaved Workflow"; save it → the conversation persists
   (adopt-on-save).
4. Reload ComfyUI → each saved workflow's thread is restored and resumes.

## Forward-compatibility (A2UI seam)

A separate, larger feature (**A2UI** — agent-rendered interactive UI in the chat:
diagrams, choice buttons, forms, with an expand/shrink choreography) is planned as its
own design cycle *after* this ships. To avoid foreclosing it, this build must satisfy
one small constraint — no A2UI scope enters here:

- The per-workflow **chat view is a self-contained component whose width/layout is
  state-driven, not hardcoded.** A future A2UI layer will (a) render a constrained
  component tree into this view and (b) expand it (~60%) and shrink it back. So keep
  the view's width/height a single piece of state the component owns, rather than
  fixed CSS scattered across the panel.

That is the ONLY A2UI concession in this spec. Everything else about A2UI (protocol
choice, safe renderer, interaction round-trip, agent emission) is out of scope here
and belongs to the A2UI spec.

## Non-goals (v1)

- Separate/detachable simultaneous chat windows (auto-follow only).
- Multiple threads per workflow.
- Server-side transcript storage (frontend localStorage remains the transcript home).
- Idle-agent reaping / orphan pruning (optional follow-ups).

## Implementation notes / anchors

- `getTabId()` — comfyui-mcp-panel.js ~L258; callers send `tab_id` per frame (~L4819,
  L4844, L4937) but the socket's hello identity is authoritative.
- Threads — `THREADS_KEY` ~L7142, `persistThreads()` ~L7155, `bindSession()` ~L7182,
  `resume_session` frame ~L8053.
- Active workflow — `app.extensionManager.workflow.activeWorkflow` (fields above);
  save path `programmaticSave()` ~L1237.
- Bridge hello/routing — ui-bridge.ts: `conns = Map<tabId, Conn>` ~L91, hello handling
  ~L317.
- Backend per-tab — panel-agent.ts: `PanelAgentManager.agents` ~L966, composite key
  `tabId::backend`; index.ts `agentKeyFor`/`panelTabOf`/`backendForTab`.
