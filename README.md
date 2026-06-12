# ComfyUI MCP Panel

**An AI agent in your ComfyUI sidebar — chat with it, and it edits your graph live.**

Ask it to "add a KSampler and wire it up", "set steps to 30", or "why is my VAE
wrong?" — the agent reads your open graph, makes the edits, and every change is
undoable with **Ctrl+Z**.

This is the UI half of [comfyui-mcp](https://github.com/artokun/comfyui-mcp).
The pack ships a single JS file (no Python nodes, no dependencies); the agent
backend runs separately via the `comfyui-mcp` npm package, keeping your LLM API
keys out of the browser.

## Install

**Via ComfyUI-Manager** (recommended): search for `comfyui-mcp-panel` and install.

**Via git:**

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/artokun/comfyui-mcp-panel
```

Restart ComfyUI. A new **Agent** tab (💬) appears in the sidebar.

## Start the backend

The panel talks to the agent backend in the `comfyui-mcp` npm package
(Node ≥ 22 required). In a terminal:

```bash
COMFYUI_MCP_AGENT_POC=1 ANTHROPIC_API_KEY=sk-... npx -y comfyui-mcp
```

The server prints a URL (default `http://127.0.0.1:8765`) and a **session
token**. Paste both into the panel's **Connection** section and hit Save.

> Remote ComfyUI? Add `COMFYUI_MCP_AGENT_TUNNEL=1` to get a public
> `trycloudflare.com` URL instead.

Other providers: set `OPENAI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` and pick
the model with `COMFYUI_MCP_AGENT_MODEL` (e.g. `openai:gpt-4.1`). See the
[comfyui-mcp docs](https://comfyui-mcp.artokun.io/docs).

## What the agent can do to your graph

| Tool | Effect |
|---|---|
| `graph_get_state` | Read nodes, widget values, connections (read-only) |
| `graph_add_node` | Add a node by class_type |
| `graph_remove_node` | Remove a node |
| `graph_connect` / `graph_disconnect` | Wire / unwire slots (by name or index) |
| `graph_set_widget` | Change a widget value (steps, cfg, prompts, …) |

The tool surface is a **fixed allowlist** — the agent cannot run arbitrary
JavaScript in your browser. Every mutation goes through LiteGraph's standard
change tracking, so ComfyUI's native undo (Ctrl+Z) reverts agent edits exactly
like your own.

## Security notes

- The bearer token grants spend on **your** LLM provider keys. It lives in
  `localStorage` (per-origin). Restart the backend to rotate it.
- The backend binds to `127.0.0.1` by default — nothing is exposed unless you
  opt into the tunnel.

## Requirements

- ComfyUI with a frontend new enough to expose
  `app.extensionManager.registerSidebarTab` (any 2024+ release)
- Node ≥ 22 for the backend (`npx -y comfyui-mcp`)
- An API key for Anthropic, OpenAI, or Google

## Roadmap

- Server-side tool wiring: let the agent run the full comfyui-mcp tool set
  (86 tools — models, custom nodes, queue) from the same chat
- Migration to `@comfyorg/extension-api` v2 when it ships (every v1 call site
  is tagged `// TODO(v2):`)

## License

[MIT](./LICENSE)
