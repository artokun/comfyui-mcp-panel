# ComfyUI MCP Panel

> ### ✅ v0.3 is live on ComfyUI-Manager & the [Comfy Registry](https://registry.comfy.org/nodes/comfyui-mcp-panel)
> The polished public release — native ComfyUI design system, live activity cards for every
> agent edit, and multi-tab support. Search **`comfyui-mcp-panel`** in ComfyUI-Manager to install,
> or see the [docs](https://comfyui-mcp.artokun.io/docs/panel).

**Your Claude Code session, inside ComfyUI's sidebar — it sees your graph and edits it live.**

Part of the **[comfyui-mcp](https://github.com/artokun/comfyui-mcp)** project — the Claude Code
plugin + MCP server for ComfyUI (88 tools, 15 AI skills). Full documentation at
**[comfyui-mcp.artokun.io/docs](https://comfyui-mcp.artokun.io/docs)**.

Type "add a KSampler and wire it to my checkpoint" in the panel (or in your
Claude terminal) and watch nodes appear on the canvas. Every edit is undoable
with **Ctrl+Z**.

**No API keys. No extra LLM costs.** The agent runs on your Claude
subscription — a background [comfyui-mcp](https://github.com/artokun/comfyui-mcp)
**orchestrator** the panel starts for you when you click **Connect**. The panel
is just its window into your graph.

```
this panel ⇄ ws://127.0.0.1:9180 ⇄ comfyui-mcp orchestrator (background, your Claude subscription) ⇄ your graph
```

> Your normal `comfyui-mcp` MCP server (in Claude Code / Cursor / etc.) should
> **not** use `--channels` — the orchestrator owns the bridge port. A stray
> `--channels` session steals port 9101 and the panel will connect to it with no
> agent ("connected" but unresponsive). See *Advanced* below.

## Install

**Via ComfyUI-Manager** (recommended): search for `comfyui-mcp-panel` and install.

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

### Advanced: drive the graph from your own Claude Code session

Prefer to use *your own* interactive session as the agent? Run the bridge in
channels mode instead, then click Connect:

```bash
claude mcp add comfyui -- npx -y comfyui-mcp --channels
```

- **talk in your Claude terminal**: "check panel_status, then add a CheckpointLoaderSimple to my graph" — Claude uses the `panel_*` tools and the edits appear live;
- **or type in the panel**: messages are pushed straight into your Claude Code session as channel events — Claude replies into the panel with `panel_say`. (Hosts without channel support can pull via `panel_inbox`.)

## What the agent can do to your graph

| MCP tool | Effect |
|---|---|
| `panel_status` | Is the panel connected? |
| `panel_get_graph` | Read the graph you're viewing — subgraphs summarized shallowly |
| `panel_get_subgraph` | Drill into a subgraph node's inner graph |
| `panel_add_node` | Add a node by class_type |
| `panel_remove_node` | Remove a node |
| `panel_move_node` | Move a node to a new canvas position |
| `panel_clear` | Remove every node — the whole wipe is one Ctrl+Z |
| `panel_connect` / `panel_disconnect` | Wire / unwire slots (by name or index) |
| `panel_set_widget` | Change a widget value (steps, cfg, prompts, …) |
| `panel_canvas` | Fit, center on a node, pan, zoom your view |
| `panel_run` | Queue the open workflow (same as pressing Queue Prompt) |
| `panel_get_errors` | Read the last execution error + node validation errors |
| `panel_save_workflow` | Save (Ctrl+S) or save-as/duplicate the open workflow |
| `panel_say` | Post a message into this panel's chat feed |
| `panel_inbox` | Drain messages you typed into the panel |

…plus the full comfyui-mcp tool surface (88 tools: queue, models, custom
nodes, workflows) — the agent is the MCP client, so it has everything.

The graph-mutation surface is a **fixed allowlist** — the agent cannot run
arbitrary JavaScript in your browser. Every mutation goes through LiteGraph's
standard change tracking, so ComfyUI's native undo reverts agent edits exactly
like your own.

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
