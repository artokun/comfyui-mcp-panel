# ComfyUI Agent Panel

> ### 📦 On ComfyUI-Manager & the [Comfy Registry](https://registry.comfy.org/nodes/comfyui-agent-panel) as `comfyui-agent-panel`
> The polished public release — native ComfyUI design system, live activity cards for every
> agent edit, and multi-tab support. Search **`comfyui-agent-panel`** in ComfyUI-Manager to install,
> or see the [docs](https://comfyui-mcp.artokun.io/docs/panel).

**An autonomous AI agent embedded in the ComfyUI sidebar that drives your canvas — now on EITHER
Claude or ChatGPT (your own subscription, no API key).**

[![Deploy on RunPod](https://img.shields.io/badge/Deploy_on-RunPod-673AB7?style=for-the-badge)](https://console.runpod.io/deploy?template=bnqtkvcer3&ref=dkx71w9b) [![Join the Discord](https://img.shields.io/badge/Discord-Join_%26_get_help-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/cW9arBhzCu) &nbsp;**One-click GPU pod** — a ready-to-run ComfyUI with this panel + [comfyui-mcp](https://github.com/artokun/comfyui-mcp) + ComfyUI-Manager v2 preinstalled, on your own GPU. No setup.

**Stuck or have a question? [Join the Discord](https://discord.gg/cW9arBhzCu)** — or hit **🆘 Need help?** in the panel's Settings → About (it copies a diagnostics summary and opens the Discord for you).

### 🌐 Speaks your language

The whole panel — chat, settings, the CivitAI browser, the training wizard, the RunPod controls,
every tooltip — is translated into **12 languages**, and it follows ComfyUI's own language setting
automatically. Change it any time in **Settings → Panel language**.

**English · 한국어 · 日本語 · 中文 (简体) · 中文 (繁體) · Русский · Français · Español · Português (BR) · Türkçe · العربية · فارسی**

Arabic and Persian render right-to-left. Counted strings use each language's real plural rules —
Russian's four forms and Arabic's six, not an English one/other pair bolted on.

Pick a provider — **Claude** or **ChatGPT** — and the matching agent runs in the background on
*your* subscription, sees the graph you're looking at, and edits it live. Every provider is
**offered the same surface**: the same live-canvas tools, the same model knowledge, the same
one-shot workflow loads, the same cost guardrail. Offered, not guaranteed received — a provider
applies its own tool budget to what we hand it, and Codex was seen dropping the live-canvas tools
silently ([#291](https://github.com/artokun/comfyui-mcp-panel/issues/291)). That is fixed upstream,
and the panel now asks the agent to say so rather than improvise if it ever recurs — see
[What the agent can do](#what-the-agent-can-do).

Part of the **[comfyui-mcp](https://github.com/artokun/comfyui-mcp)** project — the local-first,
agent-native control plane for ComfyUI (MCP server + agent orchestrator). Full documentation at
**[comfyui-mcp.artokun.io/docs](https://comfyui-mcp.artokun.io/docs)**.

Type "add a KSampler and wire it to my checkpoint" in the panel and watch nodes
appear on the canvas. Every edit is undoable with **Ctrl+Z**.

**No API keys. No extra LLM costs.** The agent runs on your Claude *or* ChatGPT
subscription — a background [comfyui-mcp](https://github.com/artokun/comfyui-mcp)
**orchestrator** the panel starts for you when you click **Connect**. The panel
is just its window into your graph.

```
this panel ⇄ loopback bridge ⇄ comfyui-mcp orchestrator (background, Claude OR ChatGPT — your subscription) ⇄ your graph
```

Every provider shares one orchestrator on one loopback port (default
`ws://127.0.0.1:9199`; 9180 is a legacy fallback), so you pick a provider rather than juggle ports.

## Features

| Capability | What it does |
|---|---|
| **Pick a provider** | A backend picker with **Claude** / **ChatGPT** chips — choose the agent, not a port. Switching providers starts a fresh chat (sessions aren't shared across providers) and posts a system note. |
| **Provider onboarding** | Connect-time readiness detection per provider (CLI on PATH + a login on disk; macOS Keychain handled). An onboarding card shows only when neither provider is signed in; the panel auto-switches to a ready provider when your saved pick isn't usable (your saved preference is untouched), and a not-ready row becomes a "set up" action. |
| **Live-canvas building** | The agent adds, wires, moves, retitles, colors, collapses, groups, and lays out nodes on the graph you're viewing — all through a fixed `panel_*` allowlist (no arbitrary JS), every edit undoable with **Ctrl+Z**. |
| **One-shot workflow / pack load** | `panel_load_workflow` drops a whole graph onto the canvas in one call — load a bundled installer pack's local-GPU workflow by name without shuttling the JSON through the chat. |
| **Local-GPU vs paid-API awareness** | Bundled packs are local/free; for ad-hoc graphs the agent checks the runtime (`list_packs` `action:"check_runtime"`) and **asks before spending paid API credits**. |
| **Installer packs + skills** | The agent discovers bundled model-family skills and one-command installer packs, then applies the manifest and loads the ready workflow instead of hand-building a graph. |
| **Rewind & rollback** | Roll back **code** (graph), **conversation** (fork the session), or **both** from any past message, plus `/revert` and double-Esc quick rewind. |
| **Autonomous install → restart → continue** | Install custom nodes through your own ComfyUI Manager, restart ComfyUI to load them, and the panel auto-reconnects so the agent resumes its task. |
| **Reasoning effort + model selector** | A per-provider effort/model picker — Claude's models, or ChatGPT's GPT-5-class models via Codex — moved into the model selector; a chosen effort survives a provider switch by mapping to the nearest valid level. |
| **Pending-message tray + reconnect durability** | Queue messages while the agent is busy (edit / send-now / reorder), and reclaim a wedged orchestrator on Connect. |
| **Apps (micro-apps)** | Convert any workflow into a named, one-click **app** (name, description, thumbnail, chosen input/output endpoints) from the toolbar's **Apps** button — runs headless (the canvas is never touched), locally or on a connected RunPod pod, with best-effort hidden-workflow packaging and a publish/explore registry (`registry/`, Cloudflare Worker + D1 + R2) shared with the mobile app. |
| **Durable workflow chat history** | Keep multiple named or pinned chats per workflow, search across them, export/import JSON, survive ComfyUI/browser restarts through IndexedDB, and track the graph version used by every user turn. |

## Quickstart

1. **Install the pack** — search `comfyui-agent-panel` in ComfyUI-Manager, or
   `git clone https://github.com/artokun/comfyui-mcp-panel` into
   `ComfyUI/custom_nodes`. Restart ComfyUI; an **Agent** tab (💬) appears in the sidebar.
2. **Sign in to your provider once** so the agent can run on your subscription (Node ≥ 22):
   - Claude (via the Claude CLI): `claude` (or `claude setup-token`)
   - ChatGPT (via the Codex CLI): `codex login`
3. **Open the Agent tab**, pick **Claude** or **ChatGPT** in the backend picker,
   and click **Connect**. The panel starts that provider's background orchestrator
   on your subscription — no API keys — and the status pill turns green.
4. **Type a request** — "build a Flux txt2img graph and run it" — and watch the
   edits land on your canvas. **Disconnect** stops the agent; nothing is ever
   started without your click.

## Install

**Via ComfyUI-Manager** (recommended): search for `comfyui-agent-panel` and install.

**Via git:**

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/artokun/comfyui-mcp-panel
```

Restart ComfyUI. A new **Agent** tab (💬) appears in the sidebar.

## Connect

Sign in to the provider you want once so the agent can run on your subscription (Node ≥ 22):

```bash
claude        # Claude — or: claude setup-token
codex login   # ChatGPT (Codex)
```

Open the **Agent** tab, **pick a provider** in the backend picker (Claude /
ChatGPT chips), and click **Connect**. The panel starts that provider's
autonomous background agent — `npx -y comfyui-mcp@latest connect`, running
on your **subscription** (no API keys) — and the status pill turns green. Type a
request ("build a Flux txt2img graph and run it") and watch the edits land on
your canvas. **Disconnect** stops the agent; nothing is ever started without
your click.

Switching providers starts a fresh chat — conversations aren't shared across
Claude and ChatGPT — and the panel tells you so. Every provider shares one
orchestrator on one loopback port (default `ws://127.0.0.1:9199`, overridable via
`COMFYUI_MCP_BRIDGE_PORT`; 9180 is a legacy fallback so a live session there is
not stranded). The bridge is loopback-only. To run an orchestrator yourself, set
`COMFYUI_MCP_NO_AUTOSPAWN=1`, launch it manually, then click Connect (the Bridge
URL lives under **Advanced**).

Type `/` in the composer for commands — panel ones like **`/reload`** (pick up
new code, keep the chat), **`/reload-ui`** (reload just the panel), **`/revert`**
(undo the last turn's graph edits), **`/record-skill`** (save the open graph as a
reusable skill), and **`/restart`** (recover an unresponsive agent — kills the
orchestrator and its child tree, starts fresh). On the Claude backend, provider
slash commands (`/compact`, `/loop`, …) are available too.

## What the agent can do

The agent drives the workflow you're viewing through a **fixed allowlist** of
`panel_*` commands (no arbitrary JavaScript). Every graph mutation goes through
LiteGraph's change tracking, so ComfyUI's native **Ctrl+Z** reverts an agent
edit exactly like your own. The `panel_*` tools live in one shared definition
list, registered onto the in-process Claude Agent SDK server *and* a loopback
HTTP MCP the orchestrator hosts for the ChatGPT/Codex and other CLI backends, so
both surfaces are identical **as served**.

They are not automatically identical **as received**, and this page used to claim
they were. A backend applies its own tool budget to everything it is handed, and
Codex was observed silently dropping the entire panel MCP server once the ~250
headless comfyui tools saturated that budget — the tools were advertised, the
model never got them, and it improvised (saving a workflow file instead of
editing the canvas) rather than saying it could not
([#291](https://github.com/artokun/comfyui-mcp-panel/issues/291)). The cause is
fixed upstream in comfyui-mcp — the non-Claude lane now spawns comfyui in compact
mode, leaving budget for `panel_*` — so keep comfyui-mcp current.

Because the panel cannot see the agent's toolset, it does not pretend to check.
It asks the agent once per session to look, and to say so plainly instead of
improvising — both when the canvas tools are absent and when one is listed but
its call fails. If you ever see that message: update comfyui-mcp; unset
`COMFYUI_MCP_TOOL_MODE=full` and drop MCP servers you don't need from that
backend's own config; then `/restart`, or switch the chat to the Claude backend,
which receives `panel_*` by a different route.

**Read**

| Tool | Effect |
|---|---|
| `panel_graph_outline` | Orient in the graph you're viewing — a compact structural overview |
| `panel_query_graph` | Query the live canvas — filter, traverse, and project, token-bounded |
| `panel_get_subgraph` | Read inside a subgraph node's inner graph |
| `panel_get_errors` | Read the last execution error + per-node validation errors |
| `panel_list_workflows` | List open workflow tabs and which is active |
| `panel_list_nodes` | List installed custom-node packs (optional `search` or `query` filters by pack name) |
| `panel_list_mcp` | List connected MCP servers |
| `panel_get_content_mode` | Read the adult-content (NSFW) consent state |

**Edit the graph** (all undoable with Ctrl+Z)

| Tool | Effect |
|---|---|
| `panel_add_node` | Add a node by class_type |
| `panel_remove_node` | Remove a node, or several as one undo step (`node_ids`) |
| `panel_connect` / `panel_disconnect` | Wire / unwire slots (by name or index) |
| `panel_set_widget` | Change a widget value (steps, cfg, prompts, …) |
| `panel_set_property` | Set a node **property** (right-click → Properties), e.g. rgthree Fast Groups Bypasser `matchTitle` — the counterpart to `panel_set_widget` |
| `panel_edit_node` | Atomically move, resize, retitle, recolor, reshape, collapse, or pin one or more nodes |
| `panel_clear` | Remove every node — the whole wipe is one Ctrl+Z |

**Subgraphs**

| Tool | Effect |
|---|---|
| `panel_select_nodes` | Select nodes on the canvas (multi-selection) |
| `panel_create_subgraph` | Group selected nodes into a subgraph ("Convert to Subgraph") |
| `panel_enter_subgraph` | Drill into a subgraph to read/edit its inner nodes |
| `panel_exit_subgraph` | Return to the parent / root graph |

**Spatial layout** — the agent sees node positions/sizes + subgraph rails and arranges the canvas

| Tool | Effect |
|---|---|
| `panel_move_rail` | Move a subgraph's input / output rail so boundary wires stay short |
| `panel_create_group` / `panel_move_group` / `panel_edit_group` / `panel_remove_group` | Create, move, retitle/recolor/resize the box, or delete a labeled group box. `panel_edit_group({bounds})` writes the rectangle only — contained nodes stay put (`panel_move_group` translates them) |
| `panel_screenshot` | Render the canvas to a PNG so the agent can verify its own layout |

**Workflow tabs**

| Tool | Effect |
|---|---|
| `panel_new_workflow` | Open a fresh blank workflow in a NEW tab (never wipes the current one) |
| `panel_open_workflow` | Switch to a workflow by path / filename |
| `panel_rename_workflow` | Rename a workflow |
| `panel_close_workflow` | Close a tab (refuses unsaved changes unless forced) |
| `panel_save_workflow` | Save / save-as programmatically (no dialog pops) |

**Load a whole workflow in one shot**

| Tool | Effect |
|---|---|
| `panel_load_workflow` | Replace the live graph with a full workflow in one call — prefer `pack:<name>` to load a bundled installer pack's local-GPU workflow without shuttling the JSON through chat. The replaced graph becomes an undo point (double-Esc / revert). |

**Knowledge & cost awareness** — the agent (Claude *or* ChatGPT) discovers bundled expertise and checks runtime cost before spending credits

| Tool | Effect |
|---|---|
| `list_packs` `action:"skill_list"` / `action:"skill_read"` | Discover and read bundled model-family + workflow skills (the same knowledge Claude loads natively, exposed to any backend) |
| `list_packs` `action:"list"` / `action:"read_workflow"` | List one-command installer packs (custom nodes + weights + ready workflow; all local-GPU / free) and read a pack's graph |
| `list_packs` `action:"list_templates"` | List the official ComfyUI workflow templates available on the connected server |
| `list_packs` `action:"check_runtime"` | Classify a workflow as **local** (your GPU, free) or **api** / **mixed** / **unknown** (hosted API nodes = paid credits) — the agent asks before spending paid API credits |

**Run & view**

| Tool | Effect |
|---|---|
| `panel_run` | Queue the open workflow (same as pressing Queue Prompt) |
| `panel_canvas` | Fit, center on a node, pan, or zoom your view |

**Custom nodes — via your built-in ComfyUI Manager**

| Tool | Effect |
|---|---|
| `panel_search_nodes` | Search installable node packs (the Manager's own source; `limit` defaults to 15, max 40) |
| `panel_install_node` | Queue a pack install (registry id or git URL) |
| `panel_node_queue_status` | Check the Manager's install / update queue |
| `panel_restart_comfyui` | Restart ComfyUI to load new nodes — panel auto-reconnects and the agent resumes |

**MCP & session**

| Tool | Effect |
|---|---|
| `panel_add_mcp` / `panel_remove_mcp` | Connect / remove an MCP server in your agent's MCP config (Claude or Codex) |
| `panel_request_secret` | Securely collect an API token — the agent never sees the value |
| `panel_reload` | Soft-reload the orchestrator (new code/tools) or the panel UI, then resume |

**Working with you**

| Tool | Effect |
|---|---|
| `panel_ask` | Ask you to choose between options (renders a question card, waits for your pick) |
| `panel_set_todo` | Show a live TODO checklist in the footer tray |
| `panel_request_adult_consent` / `panel_disable_adult_mode` | Toggle the 18+ NSFW consent gate |

…plus the full comfyui-mcp tool surface (queue, models, custom nodes, workflows,
generation) — the agent is the MCP client, so it has everything. The headless
comfyui MCP is injected into both backends (in-process for Claude; declared to
`codex app-server` via `-c mcp_servers` for ChatGPT), so this surface is
identical across providers.

## Working in the panel

- **Rewind & rollback.** Hover any past message for a **✎ edit** button that
  opens a modal to roll back **code** (the graph), **conversation**
  (fork the session), or **both**, then resend an edited message. Plus
  **`/revert`** (undo the last turn's graph edits) and **double-Esc** (quick
  last-turn rewind — revert the graph and recall the message to edit). Graph
  reverts use per-turn snapshots.
- **Pending-message tray.** Messages sent while the agent is busy wait in a
  fixed **Pending** tray above the downloads tray — each with edit / send-now /
  delete buttons. **Send-now** interrupts the current turn to steer it; a drag
  handle (≡) reorders how the agent flushes them. On dequeue a message
  materializes at the **bottom** of the chat, so it flows in the exact order
  the agent (Claude or ChatGPT) processes it.
- **Destructive-op confirmation.** `panel_clear` and `panel_restart_comfyui`
  pop a yes / no card and only act on **yes**.
- **Reconnect durability.** A wedged orchestrator no longer strands the panel —
  **Connect** reclaims a zombie that still holds the bridge port.
- **Richer composer attachments.** Attach, drag, or paste **images, video,
  workflow `.json`, and text** files into the composer. Attachments show as
  expandable **chips** above the input (kind icon + label; click to preview the
  full content, × to remove), and **pasted text renders inline** in the sent
  bubble — verbatim, exactly as if you'd typed it, rather than a raw
  `[Pasted text #N]` token.
- **Rich media metadata.** When a render's media is pushed to the agent, the
  executed-event note includes each output's path (subfolder-relative), file
  size, pixel dimensions, asset-set grouping ("output K of N from this run" +
  sibling filenames), render duration, and completion time — videos add format +
  real frame count / fps.
- **Code-block tools.** Rendered fenced code blocks get a **Copy** button plus a
  persisted global **line-wrap** toggle (off by default); inline code gets Copy.
- **Streamed replies in background tabs.** Switching away from the ComfyUI tab
  mid-turn no longer leaves an empty bubble with a stuck cursor — the reply
  finalizes synchronously while the tab is hidden and flushes on
  `visibilitychange`, so long pipeline runs render even if you tab away.
- **Render-stall warning.** A tunable stall threshold (Settings → General;
  default 180s, range 15–3600) warns when a render wedges; it's pushed **live**,
  so changing it applies without a reconnect.

## Security notes

- The bridge binds to `127.0.0.1` only — nothing is reachable from your LAN.
- The panel executes a fixed command set; no `eval`, no DOM access for the agent.
- No tokens or keys are stored anywhere in this pack.

## Requirements

- ComfyUI with a frontend exposing `app.extensionManager.registerSidebarTab` (any 2024+ release)
- Node ≥ 22 for the orchestrator (`npx -y comfyui-mcp@latest connect`, started for you by **Connect**)
- A subscription login for the provider you pick — **Claude** via the Claude CLI (`claude`) or **ChatGPT** via the Codex CLI (`codex login`). The agent runs on your subscription, no API key.

## Roadmap

- Remote pairing via a relay (PartyKit-style room codes) for ComfyUI-on-a-server setups
- Migration to `@comfyorg/extension-api` v2 when it ships (v1 call sites tagged `// TODO(v2):`)

## License

[MIT](./LICENSE).

This pack contains **only original code** — no ComfyUI or LiteGraph source is
copied or bundled. It interoperates with GPL-3.0 ComfyUI at runtime through its
public extension API (`app.registerExtension`), the same pattern used by other
MIT/Apache-licensed packs (Crystools, rgthree, ComfyUI-Custom-Scripts). MIT is
GPL-compatible; the runtime combination on your machine is yours.
