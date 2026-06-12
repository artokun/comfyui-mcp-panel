# ComfyUI MCP Panel

**Your Claude Code session, inside ComfyUI's sidebar — it sees your graph and edits it live.**

Type "add a KSampler and wire it to my checkpoint" in the panel (or in your
Claude terminal) and watch nodes appear on the canvas. Every edit is undoable
with **Ctrl+Z**.

**No API keys. No extra LLM costs.** The agent is your own Claude Code
(or any MCP client) session — subscription-billed, connected through the
[comfyui-mcp](https://github.com/artokun/comfyui-mcp) server's channels mode.
The panel is just its window into your graph.

```
you ⇄ Claude Code ⇄ comfyui-mcp (--channels) ⇄ ws://127.0.0.1:9101 ⇄ this panel ⇄ your graph
```

## Install

**Via ComfyUI-Manager** (recommended): search for `comfyui-mcp-panel` and install.

**Via git:**

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/artokun/comfyui-mcp-panel
```

Restart ComfyUI. A new **Agent** tab (💬) appears in the sidebar.

## Connect your Claude session

Add `comfyui-mcp` to Claude Code with channels mode (Node ≥ 22):

```bash
claude mcp add comfyui -- npx -y comfyui-mcp --channels
```

That's it. The panel auto-connects to the bridge at `ws://127.0.0.1:9101`
(configurable in the panel's Connection section / `COMFYUI_MCP_BRIDGE_PORT`).
The status pill turns green when both sides are up.

Then either:
- **talk in your Claude terminal**: "check panel_status, then add a CheckpointLoaderSimple to my graph" — Claude uses the `panel_*` tools and the edits appear live;
- **or type in the panel**: messages are queued for Claude (`panel_inbox`) and pushed as channel events on hosts that support them. Tell Claude once — "watch the ComfyUI panel and act on what I type there" — and the loop is hands-free.

## What the agent can do to your graph

| MCP tool | Effect |
|---|---|
| `panel_status` | Is the panel connected? |
| `panel_get_graph` | Read nodes, widget values, connections (read-only) |
| `panel_add_node` | Add a node by class_type |
| `panel_remove_node` | Remove a node |
| `panel_connect` / `panel_disconnect` | Wire / unwire slots (by name or index) |
| `panel_set_widget` | Change a widget value (steps, cfg, prompts, …) |
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
- Node ≥ 22 for the MCP server (`npx -y comfyui-mcp --channels`)
- An MCP client you already use: Claude Code, Claude Desktop, Cursor, …

## Roadmap

- Remote pairing via a relay (PartyKit-style room codes) for ComfyUI-on-a-server setups
- Migration to `@comfyorg/extension-api` v2 when it ships (v1 call sites tagged `// TODO(v2):`)

## License

[MIT](./LICENSE)
