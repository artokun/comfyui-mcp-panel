# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and the format follows
[Keep a Changelog](https://keepachangelog.com/).

## Unreleased — v0.3.0, coming soon to the Comfy Registry 🚧

The polished public release. In progress:

### Added

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
