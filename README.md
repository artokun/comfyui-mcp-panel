# ComfyUI Agent Panel

> ### 📦 On ComfyUI-Manager & the [Comfy Registry](https://registry.comfy.org/nodes/comfyui-agent-panel) as `comfyui-agent-panel`
> The polished public release — native ComfyUI design system, live activity cards for every
> agent edit, and multi-tab support. Search **`comfyui-agent-panel`** in ComfyUI-Manager to install,
> or see the [docs](https://comfyui-mcp.artokun.io/docs/panel).

**Your Claude Code session, inside ComfyUI's sidebar — it sees your graph and edits it live.**

Part of the **[comfyui-mcp](https://github.com/artokun/comfyui-mcp)** project — the Claude Code
plugin + MCP server for ComfyUI (88 tools, 15 AI skills). Full documentation at
**[comfyui-mcp.artokun.io/docs](https://comfyui-mcp.artokun.io/docs)**.

Type "add a KSampler and wire it to my checkpoint" in the panel and watch nodes
appear on the canvas. Every edit is undoable with **Ctrl+Z**.

**No API keys. No extra LLM costs.** The agent runs on your Claude
subscription — a background [comfyui-mcp](https://github.com/artokun/comfyui-mcp)
**orchestrator** the panel starts for you when you click **Connect**. The panel
is just its window into your graph.

```
this panel ⇄ ws://127.0.0.1:9180 ⇄ comfyui-mcp orchestrator (background, your Claude subscription) ⇄ your graph
```

## Install

**Via ComfyUI-Manager** (recommended): search for `comfyui-agent-panel` and install.

**Via git:**

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/artokun/comfyui-mcp-panel
```

Restart ComfyUI. A new **Agent** tab (💬) appears in the sidebar.

## Connect

Sign in to Claude once so the agent can run on your subscription (Node ≥ 22):

```bash
claude        # or: claude setup-token
```

Open the **Agent** tab and click **Connect**. The panel starts an autonomous
background agent — `npx -y comfyui-mcp --panel-orchestrator`, running on your
Claude **subscription** (no API keys) — and the status pill turns green. Type a
request ("build a Flux txt2img graph and run it") and watch the edits land on
your canvas. **Disconnect** stops the agent; nothing is ever started without
your click.

The bridge is loopback-only (`ws://127.0.0.1:9180`, set via
`COMFYUI_MCP_BRIDGE_PORT`). To run the orchestrator yourself, set
`COMFYUI_MCP_NO_AUTOSPAWN=1` and launch it manually, then click Connect.

## What the agent can do

The agent drives the workflow you're viewing through a **fixed allowlist** of
`panel_*` commands (no arbitrary JavaScript). Every graph mutation goes through
LiteGraph's change tracking, so ComfyUI's native **Ctrl+Z** reverts an agent
edit exactly like your own.

**Read**

| Tool | Effect |
|---|---|
| `panel_get_graph` | Read the graph you're viewing — subgraphs summarized shallowly |
| `panel_get_subgraph` | Read inside a subgraph node's inner graph |
| `panel_get_errors` | Read the last execution error + per-node validation errors |
| `panel_list_workflows` | List open workflow tabs and which is active |
| `panel_list_nodes` | List installed custom-node packs |
| `panel_list_mcp` | List connected MCP servers |
| `panel_get_content_mode` | Read the adult-content (NSFW) consent state |

**Edit the graph** (all undoable with Ctrl+Z)

| Tool | Effect |
|---|---|
| `panel_add_node` | Add a node by class_type |
| `panel_remove_node` | Remove a node |
| `panel_connect` / `panel_disconnect` | Wire / unwire slots (by name or index) |
| `panel_set_widget` | Change a widget value (steps, cfg, prompts, …) |
| `panel_move_node` | Move a node on the canvas |
| `panel_set_node_title` | Rename a node's header title |
| `panel_clear` | Remove every node — the whole wipe is one Ctrl+Z |

**Subgraphs**

| Tool | Effect |
|---|---|
| `panel_select_nodes` | Select nodes on the canvas (multi-selection) |
| `panel_create_subgraph` | Group selected nodes into a subgraph ("Convert to Subgraph") |
| `panel_enter_subgraph` | Drill into a subgraph to read/edit its inner nodes |
| `panel_exit_subgraph` | Return to the parent / root graph |

**Workflow tabs**

| Tool | Effect |
|---|---|
| `panel_new_workflow` | Open a fresh blank workflow in a NEW tab (never wipes the current one) |
| `panel_open_workflow` | Switch to a workflow by path / filename |
| `panel_rename_workflow` | Rename a workflow |
| `panel_close_workflow` | Close a tab (refuses unsaved changes unless forced) |
| `panel_save_workflow` | Save / save-as programmatically (no dialog pops) |

**Run & view**

| Tool | Effect |
|---|---|
| `panel_run` | Queue the open workflow (same as pressing Queue Prompt) |
| `panel_canvas` | Fit, center on a node, pan, or zoom your view |

**Custom nodes — via your built-in ComfyUI Manager**

| Tool | Effect |
|---|---|
| `panel_search_nodes` | Search installable node packs (the Manager's own source) |
| `panel_install_node` | Queue a pack install (registry id or git URL) |
| `panel_node_queue_status` | Check the Manager's install / update queue |
| `panel_restart_comfyui` | Restart ComfyUI to load new nodes — panel auto-reconnects and the agent resumes |

**MCP & session**

| Tool | Effect |
|---|---|
| `panel_add_mcp` / `panel_remove_mcp` | Connect / remove an MCP server in your Claude config |
| `panel_request_secret` | Securely collect an API token — the agent never sees the value |
| `panel_reload` | Soft-reload the orchestrator (new code/tools) or the panel UI, then resume |

**Working with you**

| Tool | Effect |
|---|---|
| `panel_ask` | Ask you to choose between options (renders a question card, waits for your pick) |
| `panel_set_todo` | Show a live TODO checklist in the footer tray |
| `panel_request_adult_consent` / `panel_disable_adult_mode` | Toggle the 18+ NSFW consent gate |

…plus the full comfyui-mcp tool surface (88 tools: queue, models, custom
nodes, workflows) — the agent is the MCP client, so it has everything.

## Security notes

- The bridge binds to `127.0.0.1` only — nothing is reachable from your LAN.
- The panel executes a fixed command set; no `eval`, no DOM access for the agent.
- No tokens or keys are stored anywhere in this pack.

## Requirements

- ComfyUI with a frontend exposing `app.extensionManager.registerSidebarTab` (any 2024+ release)
- Node ≥ 22 for the orchestrator (`npx -y comfyui-mcp --panel-orchestrator`, started for you by **Connect**)
- A Claude login (run `claude` once) — the agent runs on your subscription, no API key

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
