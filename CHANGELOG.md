# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and the format follows
[Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Fixed

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

The polished public release — now live on the [Comfy Registry](https://registry.comfy.org/nodes/comfyui-mcp-panel) and installable from ComfyUI-Manager.

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
