# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and the format follows
[Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [0.4.3] - 2026-06-27

### Fixed

- **Streamed replies now render when the ComfyUI tab is in the background.** The
  reply typewriter + its commit-finalize ran on `requestAnimationFrame`, which the
  browser **pauses in a hidden/background tab** — so if you switched away during an
  agent turn (common on long multi-stage pipeline runs), the reply never painted and
  the bubble sat empty with a stuck streaming cursor, looking like the agent was
  "stuck thinking / never draining the queue" even though the turn had finished. The
  commit now finalizes the reply **synchronously when the tab is hidden**, plus a
  `visibilitychange` handler flushes any pending reply on hide and resumes the
  typewriter on return. Foreground animation is unchanged.

## [0.4.2] - 2026-06-26

### Added

- **Subgraph rail I/O + expand/dissolve** — from inside a subgraph the agent can
  now wire an interior node to the boundary: `graph_expose_subgraph_output` /
  `graph_expose_subgraph_input` expose an interior node's output/input as a
  subgraph output/input (the host subgraph node gains the slot). `graph_get_state`'s
  `rails` now reports the input/output rail node ids + their slots, and
  `graph_connect` tolerates rail endpoints with a clear "enter the subgraph first"
  error at root. `graph_unpack_subgraph` **dissolves** a subgraph back into its
  parent (inlines the interior nodes, rewires external links) — the inverse of
  create-subgraph, Ctrl+Z-undoable.
- **Pasted text renders inline in sent bubbles** — a sent (or reloaded) user
  message no longer shows the raw `[Pasted text #N]` token. Each token is now
  replaced **inline with the actual pasted content**, rendered verbatim as plain
  text — exactly as if you had typed it (no chip or preview widget). The pasted
  content is persisted with the message (capped at 100,000 chars, marked
  truncated beyond that) so reloaded conversations re-render the full text. Tokens
  with no stored content fall back gracefully to their literal text. The raw
  `text` (with tokens) is unchanged — the agent, history, and edit/rollback still
  use it.
- **Expandable attachment chips** — composer attachments now show as a chip
  strip above the input (Claude-Code style) instead of only an opaque
  `[Pasted text #N]` token in the textarea. Each chip carries a kind icon +
  label (pasted text shows a dim char count; files show their name; images show
  a thumbnail). Click a text/pasted/file/workflow chip to expand an inline,
  read-only, scrollable monospace preview of the full content (one open at a
  time); click an image chip to see a larger thumbnail. A per-chip × removes the
  attachment and precisely strips its inline token (e.g. `[Pasted text #N]`)
  from the textarea. Purely additive — the send/resolve pipeline still resolves
  attachments by token-match against the textarea, unchanged.
- **Edit focus-follow** — when the agent changes a node's widget **value**, the
  canvas now smoothly darts to that node with 50% padding so you watch the change
  land. Once edits go quiet for ~5s, it animates back to a full fit so the whole
  graph is visible again. Scoped to value edits only (wiring and node placement
  don't move the view — those keep the existing gentle fit). Reuses the
  panel-aware "fit" insets and the native zoom easing. **On by default**; toggle
  via Settings → Comfy MCP Agent → General → **"Zoom to agent edits"**.

## [0.4.1] - 2026-06-26

### Added

- **`graph_set_node_mode`** — bypass / mute / activate a node on the live canvas
  (undo-able like every other edit), so the agent can enable a bypassed path (e.g. a
  pack's Ideogram-JSON prompt builder) instead of improvising. The graph read now
  surfaces each node's mode, so bypassed/muted nodes are visible. (#30)

### Fixed

- **Run outputs now name the FINAL result vs previews.** A run emits both preview
  images (`type:"temp"`, throwaway `/tmp` names) and the saved output (`type:"output"`,
  real filename); the panel now batches them into one event, orders finals first, and
  the note tells the agent which filename is the real saved result — so it stops citing
  a preview's temp name as the output. Applies to images and videos. (#31)

## [0.4.0] - 2026-06-26

### Added

- **Application Settings page** under ComfyUI Settings → **"Comfy MCP Agent"**, split
  into per-backend groups so each provider owns its own defaults (#20, #21, #27, #29):
  - **General** — Default agent backend, Auto-connect on load.
  - **Claude** / **ChatGPT (Codex)** — Default model (a dropdown of the backend's
    *fetched* models), Default reasoning effort (the backend's own scale), and a
    per-backend **Bridge URL** (`9180` for Claude, `9181` for Codex).
  - **About** — ⭐ Star on GitHub. **API tokens** — secure CivitAI / HuggingFace
    buttons (stored by the orchestrator, never in ComfyUI settings).
  - The comfyui-mcp logo in the panel header.

### Fixed

- **Reconnect storm eliminated at the root.** Only one bridge client may be live per
  page now — a re-rendered/restored sidebar no longer spawns a second client that
  shares the tab id and ping-pongs the connection (the bridge's close-old-on-new-hello
  was closing each socket in a ~1s loop). (#28)
- **Backend-switch storm.** Switching Claude↔Codex no longer re-enters the connect
  path via a settings `onChange`; a live switch produces exactly one connect. (#29)
- **Per-backend bridge ports.** The Codex backend connects to `9181` (not Claude's
  `9180`), and **Reconnect after a switch dials the right port** (the default URL is no
  longer mistaken for a manual override). (#25, #29)
- **Cold-start "stuck on connecting".** A handshake timeout now auto-redials (bounded)
  and recovers like Reconnect, instead of sitting idle while the agent spawns. (#29)
- **Settings-load reconnect storm** — ComfyUI fires `onChange` during its startup
  settings load; appliers are now gated until the panel is armed. (#22)
- **Steady connection status** — no connecting↔disconnected flicker, with
  backend-aware patience for slow Codex cold starts. (#24)

## [0.3.1] - 2026-06-25

### Fixed

- **`comfy_reboot` (restart_comfyui) no longer reports a false failure.** ComfyUI
  Desktop's Manager `exit(0)`s before answering the reboot POST, so the fetch
  rejected with "Failed to fetch" and the restart looked failed (auto-resume never
  armed). A dropped connection mid-request is now treated as a successful reboot,
  with an endpoint fallback chain and accurate errors otherwise.
- **Stuck soft-reload auto-recovers.** If a soft-reload's fresh orchestrator binds
  but the agent handshake stalls, the panel now auto-escalates to a clean reconnect
  (~11s) — what you'd do by clicking Reconnect — instead of sitting on "waiting for
  the panel agent."
- **Workflow tabs**: `save` keeps a renamed tab's title (no more "Untitled …"
  overwrite); merely opening a workflow no longer marks a clean tab modified.
- **Run output images batch at run-end.** A multi-output run now delivers all its
  images to the agent in ONE turn when the run completes (buffered per `prompt_id`,
  flushed on `execution_success`, with a debounce fallback) instead of a fragmented
  turn per node — while still painting each image live as it finishes.
- **Desktop-nested ComfyUI path self-heal** in `_detect_comfyui_path` (mirrors the
  orchestrator fix).

## [0.3.0] - 2026-06-25

### Added

- **Provider switcher in the model selector.** Pick Claude or ChatGPT from a
  PROVIDER section at the top of the model popup (Provider → Model → Effort).
- **`show_media` + `free_vram` panel commands**, **soft-reload ↔ auto-respawn
  interlock**, **pack force-reclaim** of a wedged orchestrator, **Desktop-nested
  ComfyUI path self-heal**, and **effort snaps to the nearest supported level** on a
  model/provider switch (no silent drop). New multi-provider branding (banner, icon,
  OG card).

- **Run errors interrupt the agent and show a widget.** When a queued render fails,
  the panel now names the failing node (e.g. `Ideogram4PromptBuilderKJ (node 200)`),
  pushes it to the agent as an urgent `run_error` event — the orchestrator
  **interrupts the live turn and front-queues it**, so the agent stops and fixes the
  error instead of carrying on as if the run succeeded — and immediately renders a
  red **error card** in the chat, so you see it without waiting on a check-errors
  call. (ComfyUI targets `execution_error` to the queuing client, so the panel is
  the right place to catch and forward it.)

- **Multi-provider agent: Claude + ChatGPT/Codex at full parity.** The panel is no
  longer Claude-only — a **backend picker** (Claude / ChatGPT chips) lets you choose
  a provider rather than a port, and each runs its own background orchestrator on
  *your* subscription (no API keys). Both providers reach **full feature parity**:
  - **Provider switch** posts a system message and starts a fresh chat (sessions
    aren't shared across providers), with a **per-backend composer placeholder**
    ("Ask Claude…" / "Ask ChatGPT…").
  - **Reasoning-effort + model selector** is per-provider; a chosen effort survives
    a provider switch by mapping to the nearest valid level for the target backend.
    The **provider switcher now lives inside the model selector** (Claude models vs
    ChatGPT/GPT-5 models via Codex), so picking an agent and a model is one control.
  - **Live-canvas tools** (`panel_*`) and the **headless comfyui MCP** are exposed
    identically to both backends — in-process for Claude, and over a loopback
    streamable-HTTP MCP plus `codex app-server -c mcp_servers` for ChatGPT — so the
    `panel_*` surface (incl. the destructive-confirm gating) is the same everywhere.
  - **Knowledge parity** — both backends can discover bundled skills, installer
    packs, and the connected server's official workflow templates
    (`list_skills` / `read_skill` / `list_packs` / `read_pack_workflow` /
    `list_workflow_templates`) with steering toward packs over hand-built graphs.
  - **Docs/README rebalanced multi-provider** — setup, sign-in, and usage copy now
    present Claude and ChatGPT (Codex) as equal first-class providers.
- **One-shot workflow / pack load (`panel_load_workflow`).** Drop a whole workflow
  onto the live canvas in one call — prefer `pack:<name>` to load a bundled
  installer pack's local-GPU workflow without shuttling the JSON through the chat.
  The replaced graph is captured as an undo point (double-Esc / `/revert`).
- **Local-GPU vs paid-API cost guardrail (`check_workflow_runtime`).** Bundled
  packs are local/free; for an ad-hoc or generated graph the agent classifies the
  runtime (local / api / mixed / unknown) and **asks before spending paid API
  credits** rather than silently using hosted API nodes.

## [0.2.0] - 2026-06-19

### Added

- **Rewind & rollback (#44).** A hover ✎ on any past message opens a rollback modal
  to undo **code**, **conversation**, or **both** and resend an edited message —
  graph reverts via per-turn snapshots, conversation rewinds via `forkSession`.
  **`/revert`** undoes the last turn's graph edits, and a quick **double-Esc** in
  the composer rewinds your last turn (revert graph + recall the message to edit).
- **Pending-message tray.** Messages sent while the agent is busy now wait in a
  fixed **Pending** tray above downloads (out of the chat flow), each with
  **edit / send-now / delete**. **Send-now** interrupts the current turn (steer);
  **drag the ≡ handle** to reorder how the agent flushes them. When the agent
  dequeues a message it **materializes at the bottom of the chat** — so the chat
  reads in the exact order Claude processes them.
- **Spatial layout control.** The agent can now see and arrange the canvas: reads
  include node positions/sizes and subgraph I/O rails; it can move rails, create
  and edit groups, collapse/recolor nodes, and **screenshot** the canvas to verify
  its own layout (with the "expose inputs/outputs" rule baked into a skill).
- **Attach more than images.** The composer's attach button, drag-drop, and paste
  now accept **video**, **workflows (`.json`)**, and **text files** alongside
  images. Images and video upload into ComfyUI's `input/` folder (video is
  delivered as an `input/` path the agent can wire into a Load Video node, since
  it can't be viewed inline); workflow `.json` and text files are read and inlined
  to the agent (a recognized ComfyUI graph is flagged so it can load/analyze/merge
  it). Each file drops a typed chip — `[Image #N]` / `[Video #N]` / `[Workflow #N]`
  / `[File #N]` — and the picker accepts multiple files at once.

### Fixed

- **Reconnect durability.** Connect now reclaims a lockfile-less orchestrator
  "zombie" (alive but no longer serving the bridge) that would otherwise survive
  reloads and a full ComfyUI restart and block reconnection — it finds the port
  owner, and if it's our orchestrator, kills its tree and respawns a clean one.
- **Rollback anchor stability** — the rewind anchor is stored as the turn's UUID in
  the message's own handler (not an array index), so a bounded-history eviction
  can't point a rollback at the wrong turn.
- **Save-card** rendering fix.

## [0.1.3] - 2026-06-19

### Added

- **Live-streaming chat** — extended-thinking in a collapsible "see thinking"
  accordion + character-by-character reply, with a live thinking-token counter.
- **SDK slash commands** in the composer `/` menu — `/compact`, `/context`,
  `/usage`, `/loop`, `/goal`, `/clear` (the SDK's useful built-ins).
- **`/restart` — one-click recovery for a wedged agent.** Kills the orchestrator
  **and its whole child tree** (clearing a dead Agent-SDK shell an in-place reload
  can't) and starts a **fresh** session — resuming would just restore the wedge.
  Pure-Python route, so it works even when the agent isn't answering.
- **Per-message delivery status** (queued → seen) with edit/cancel on a queued
  message, and a **live model-download progress** tray.
- **Subgraph authoring** — promote/retract inner widgets, node-title rename,
  workflow-tab tools, built-in Manager install→restart→resume.

### Changed

- **Rebranded to "ComfyUI Agent Panel"** (registry slug `comfyui-agent-panel`);
  license declared as the Comfy-correct `{ file = "LICENSE" }` table form.
- **Removed all `--channels` plumbing.** The panel runs only on the autonomous
  orchestrator (dedicated bridge `9180`); reload/restart live as slash commands
  (`/reload`, `/reload-ui`, `/restart`), not header buttons.

### Fixed

- **Pid-reuse-safe orchestrator kill** — identity (cmdline + creation time) is
  re-verified immediately before every terminate/kill, for the orchestrator and
  each child, so a recycled pid is never mistaken for ours and a user's unrelated
  process is never signalled.
- **Connect honors the Bridge URL field** (previously only Reconnect did).
- **Deferred extension registration** so a Vite/Rolldown early module eval can't
  throw and deadlock the loader (adapted from a community PR, thanks
  @FreesoSaiFared).
- **Truthful "connected".** The panel now turns green only after the orchestrator
  handshake (its `models` frame) arrives — a non-orchestrator squatting the
  bridge port (e.g. a stray `comfyui-mcp --channels` server from another
  Claude/Cursor/codex session) leaves it on "connecting…" with a clear warning
  instead of a silent dead connection.
- **Dedicated bridge port `9180`.** The panel/orchestrator bridge moved off
  `9101` (now reserved for the legacy `--channels` path) so a `--channels` server
  can't steal it. Saved bridge URLs on the old `9101` default auto-migrate.
- **Sticky auto-reconnect.** Once you connect, the panel reconnects on its own —
  respawning the orchestrator if it died (e.g. after a ComfyUI reboot) — on every
  open, until you explicitly **Disconnect**.
- **Drop-zone** appears only while dragging a file and is scoped to the composer
  (was permanently visible over the whole panel).
- **Registry-safe `__init__.py`.** Nothing executes at import except registering
  the Connect/disconnect/reload routes; the only subprocess the pack ever runs is
  the orchestrator spawn behind an explicit **Connect** (POST). Process
  start-time and process-kill are psutil-only — no constructed PowerShell scripts
  or `taskkill`, so the security scanner sees no shell-exec surface.

### Added

- **Drag-drop / paste images** and **paste-large-text chips**, delivered to the
  agent as inline image blocks — chips, `@input:`/`@node:` mentions, and
  end-of-run output — with no fetch round-trip.
- **Smooth animated zoom-to-fit** after the agent makes structural edits.
- **Programmatic save** (no Save/Rename dialog) and a persistent **"working"**
  indicator with cycling status words.

## [0.4.1] - 2026-06-17

Start the agent with a **Connect** button instead of auto-spawning it on load.
The Comfy Registry's security scanner flagged 0.4.0 because the pack launched a
subprocess (`npx … --panel-orchestrator`) at import time. Now nothing spawns
until you explicitly click Connect — the registry-safe pattern — and the panel
still auto-connects when a bridge is already running.

### Changed

- **Connect button replaces import-time auto-spawn.** `__init__.py` no longer
  starts the orchestrator when ComfyUI imports the pack. Instead it registers a
  small local API on ComfyUI's own server (`/comfyui_mcp_panel/{status,connect,
  disconnect}`), and the panel's **Connect** button starts the orchestrator on
  demand — an explicit, authenticated, local action. On load the panel only
  auto-connects if a bridge is *already* running (you started it, or another
  tab did); otherwise it waits behind the Connect button. A **Disconnect**
  button stops an orchestrator the pack started. `COMFYUI_MCP_NO_AUTOSPAWN=1`
  now makes Connect report status without spawning; `COMFYUI_MCP_BRIDGE_PORT`
  still overrides the port. Fixes the `NodeVersionStatusFlagged` 0.4.0 release.

## [0.4.0] - 2026-06-17

The panel now drives itself: it auto-starts an autonomous background agent on
your Claude subscription, so you just open ComfyUI and type.

### Added

- **Auto-start the panel orchestrator on load.** The pack launches
  `npx -y comfyui-mcp --panel-orchestrator` when ComfyUI loads it — idempotent
  (skips if the bridge port is already owned), auto-detects this ComfyUI's
  `COMFYUI_URL`, and runs on your Claude **subscription** (no API key). The agent
  is a background Claude Agent SDK session per tab that loads comfyui-mcp's
  bundled skills (model expertise), so the only prerequisite is being signed in
  to Claude (`claude` once). Opt out with `COMFYUI_MCP_NO_AUTOSPAWN=1`; override
  the port with `COMFYUI_MCP_BRIDGE_PORT`. Requires comfyui-mcp ≥ 0.14.
- **Lifecycle beacon.** The pack passes its PID so the orchestrator shuts down
  when ComfyUI exits — including crashes/hard-kills — with an `atexit` teardown
  on clean shutdown too. No orphan left holding the bridge port.

### Changed

- **Connection UI reflects the orchestrator model.** The settings help text and
  header no longer tell you to wire the MCP into your interactive session with
  `--channels` (which would steal the bridge port from the orchestrator); they
  now describe the autonomous background agent and the one-time
  `npx -y comfyui-mcp --panel-orchestrator` fallback.

## [0.3.0] - 2026-06-16

The polished public release — now live on the [Comfy Registry](https://registry.comfy.org/nodes/comfyui-agent-panel) and installable from ComfyUI-Manager.

### Added

- **Registry banner & SEO listing.** Added a 21:9 brand banner
  (`assets/banner.png`) so the registry/social card uses a custom image
  instead of the generic OG fallback, and rewrote the pack description to
  lead with the terms people actually search (Claude Code, MCP / Model
  Context Protocol, AI agent, live graph editing).

- **Capability-aware empty state.** The onboarding hero now reflects the
  agent's full surface — build/edit the live graph, generate images **and
  audio** (`generate_audio`, ACE Step 1.5 / Stable Audio 3), run the workflow
  and read its errors, and find models on Civitai — with clickable example
  prompts that prefill the composer. Requires comfyui-mcp ≥ 0.13.
- **Native ComfyUI design system.** The panel is restyled on the same
  PrimeVue semantic tokens (`--p-content-background`, `--p-form-field-*`,
  `--p-primary-color`, border radii, Inter) the built-in sidebar panels use —
  it tracks your ComfyUI theme automatically. Header with live status dot,
  empty-state onboarding, animated message bubbles, auto-growing composer.
- **Activity cards.** Every graph edit the agent makes renders as a human-
  readable card in the chat feed — "➕ Added KSampler (id 26)",
  "🔗 Connected 4.MODEL → 26.model", "🎚 Set steps = 30 (was 20)" — so you
  can watch Claude work.
- **Multi-tab support.** Each ComfyUI browser tab holds its own bridge
  connection, identified by a per-tab session id plus the open workflow's
  title. The agent sees every tab (`panel_status`), routes edits per tab,
  and knows which tab you typed in. Requires comfyui-mcp ≥ 0.12.
- **Markdown-lite agent bubbles** — `code` and **bold** rendering, safely.
- **"Claude is working…" indicator.** Sending a message shows an animated
  typing indicator immediately; incoming graph edits keep it alive (and bump
  it below the newest activity card), the agent's reply retires it, and a
  45-second quiet period swaps it for a hint explaining that the agent reads
  panel messages by polling its inbox. (Claude Code doesn't stream its
  internal reasoning to MCP servers — narration + activity cards + this
  indicator are the feedback surface.)
- **`graph_clear` command** — wipes every node in a single
  `beforeChange`/`afterChange` pair, so one Ctrl+Z restores the whole graph.
  Exposed as the `panel_clear` MCP tool (comfyui-mcp ≥ 0.12).
- **Full programmatic graph & app control.** New executor commands (each
  with a matching `panel_*` MCP tool): `graph_move_node`, `graph_canvas`
  (fit / center-on-node / pan / zoom), `graph_run` (queue the open workflow,
  surfacing frontend validation errors), `graph_get_errors` (last
  `execution_error` event + `lastNodeErrors`), `workflow_save` (Ctrl+S
  path) and `workflow_save_as` (duplicate to `workflows/<name>.json`).
- **Subgraph-aware reads.** Executors target the graph you're *viewing*
  (root or an opened subgraph); `graph_get_state` reports `viewing`, marks
  subgraph nodes `is_subgraph` with an inner node count (boundary slots +
  widgets only), and `graph_get_subgraph` drills inside on demand.
- **Zed-style composer.** Rounded composer card with a context-window ring
  (radial fill — wired to `agent_status` frames; data source pending host
  support), model chip, attach button (uploads straight into ComfyUI's
  `input/` folder and inserts an `@input:` mention), and voice dictation
  via the browser's speech recognition.
- **Slash commands & @ mentions.** `/new`, `/fit`, `/run`, `/errors`,
  `/help` run locally with arrow-key + Enter completion; `@` autocompletes
  the current workflow, graph nodes, subgraphs, and registered node types.
  Outgoing messages stamp the workflow + opened subgraph so the agent has
  the context without asking.
- **Chat threads.** New-chat and history buttons in the header; threads
  persist to localStorage (last 20) and replay verbatim, activity cards
  included.

## [0.2.0] - 2026-06-12

### Changed

- **BREAKING: MCP-driven, no API keys.** Dropped the AI-SDK `/api/chat`
  backend entirely. The panel is now a WebSocket client of
  [comfyui-mcp](https://github.com/artokun/comfyui-mcp)'s `--channels`
  bridge (`ws://127.0.0.1:9101`): **your own Claude Code session is the
  agent**, subscription-billed, zero LLM API keys anywhere in the path.
  Settings reduced to one field (bridge URL); SSE parser and bearer token
  removed.

### Fixed

- `import { app } from "/scripts/app.js"` — `window.app` is no longer
  assigned at extension-eval time on ComfyUI frontend 1.4x, so the v1
  global-read pattern silently failed and the sidebar tab never registered.

## [0.1.0] - 2026-06-12

### Added

- Initial release: sidebar **Agent** tab with a chat UI, six-tool graph
  executor (`get_state`, `add_node`, `remove_node`, `connect`, `disconnect`,
  `set_widget`) wrapped in `beforeChange`/`afterChange` for native Ctrl+Z
  undo, talking to the comfyui-mcp AI-SDK backend.

[0.2.0]: https://github.com/artokun/comfyui-mcp-panel/releases/tag/v0.2.0
[0.1.0]: https://github.com/artokun/comfyui-mcp-panel/commits/4f22ed0
