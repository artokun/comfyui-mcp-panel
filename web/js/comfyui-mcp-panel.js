// =============================================================================
// ComfyUI MCP Panel — sidebar window into your own Claude Code session.
//
// Shipped as a UI-only custom node pack (served via WEB_DIRECTORY). The panel
// connects to the loopback WebSocket bridge hosted by the `comfyui-mcp` MCP
// server when it runs in channels mode:
//
//     npx -y comfyui-mcp --channels
//
// The AGENT is the user's own Claude Code (or any MCP client) session — there
// are NO LLM API keys anywhere in this path. Claude drives the graph through
// the server's panel_* MCP tools; the bridge forwards each rid-correlated
// command here, where a fixed allowlist of executors mutates the open
// LiteGraph graph. Messages the user types below travel the other way:
// panel → bridge → agent session (channel event / panel_inbox tool).
//
// Wire protocol (mirrors node-lab's mcp/protocol.ts):
//   inbound  { rid, cmd, ...args }  → execute → reply { rid, ok, result }
//                                              or    { rid, ok:false, error }
//   inbound  { type: "say", text }  → render an agent bubble (no reply)
//   outbound { type: "user_message", text }
//
// All graph mutations are wrapped in beforeChange/afterChange so ComfyUI's
// native Ctrl+Z undoes agent edits exactly like the user's own.
//
// V1→V2 MIGRATION: registration uses `app.registerExtension(...)` (app imported
// from /scripts/app.js) +
// `app.extensionManager.registerSidebarTab(...)`, and the executors touch
// `app.graph` / `LiteGraph` directly. When `@comfyorg/extension-api` ships,
// the equivalents are `defineExtension()`, `defineSidebarTab()`, and
// `NodeHandle`/`WidgetHandle`. v1 call sites are tagged `// TODO(v2):`.
// =============================================================================

// ComfyUI loads extension files as ES modules; on modern frontends (1.4x+)
// `window.app` is no longer assigned before extension eval, so the module
// import is the canonical access path. The absolute specifier works from any
// nesting depth under /extensions/<pack>/.
import { app } from "/scripts/app.js";

// ---------------------------------------------------------------------------
// localStorage-backed settings.
// ---------------------------------------------------------------------------
const STORAGE_KEY_BRIDGE = "comfyui-mcp.panel.bridgeUrl";
const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:9101";

function loadBridgeUrl() {
  try {
    return window.localStorage.getItem(STORAGE_KEY_BRIDGE) || DEFAULT_BRIDGE_URL;
  } catch {
    return DEFAULT_BRIDGE_URL;
  }
}

function saveBridgeUrl(url) {
  try {
    window.localStorage.setItem(STORAGE_KEY_BRIDGE, url);
  } catch {
    // localStorage unavailable — session-scoped settings only.
  }
}

// Per-TAB session id: sessionStorage is scoped to the tab and survives
// reloads, so each ComfyUI tab keeps a stable identity on the bridge while
// two tabs never collide. (localStorage would be shared across tabs.)
const TAB_ID_KEY = "comfyui-mcp.panel.tabSessionId";
function getTabId() {
  try {
    let id = window.sessionStorage.getItem(TAB_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      window.sessionStorage.setItem(TAB_ID_KEY, id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

/** Current workflow title for this tab (shown in panel_status). */
function getWorkflowTitle() {
  // document.title is "<name> - ComfyUI" with a leading "*" when unsaved.
  const t = document.title.replace(/ - ComfyUI$/, "").replace(/^\*/, "").trim();
  return t || "untitled";
}

// ---------------------------------------------------------------------------
// Graph-edit executor — the client side of the agent's panel_* tools.
//
// Fixed allowlist of mutations against the open LiteGraph graph. Every entry
// returns a JSON-serializable result object; failures throw and the error
// string rides back to the agent so it can self-correct. All mutations are
// sandwiched in beforeChange/afterChange for native undo integration.
//
// TODO(v2): replace direct app.graph / LiteGraph access with NodeHandle /
// WidgetHandle from @comfyorg/extension-api once it ships.
// ---------------------------------------------------------------------------

const MAX_STATE_NODES = 100;

function getGraphCtx() {
  const graph = app?.graph;
  const LG = window.LiteGraph ?? globalThis.LiteGraph;
  if (!app || !graph || !LG) {
    throw new Error("ComfyUI graph is not available (app.graph / LiteGraph missing)");
  }
  return { app, graph, LG };
}

/** Summarize one LiteGraph node for the agent — id, type, title, widget
 *  values, and input link sources. Deliberately NOT the full serialization
 *  (positions, colors, internal state) to keep token cost low. */
function summarizeNode(node) {
  const widgets = {};
  for (const w of node.widgets ?? []) {
    if (w && typeof w.name === "string") widgets[w.name] = w.value;
  }
  const inputs = (node.inputs ?? []).map((inp, i) => {
    let from = null;
    if (inp.link != null) {
      const link = node.graph?.links?.[inp.link];
      if (link) from = { node_id: link.origin_id, output_slot: link.origin_slot };
    }
    return { slot: i, name: inp.name, type: inp.type, connected_from: from };
  });
  const outputs = (node.outputs ?? []).map((out, i) => ({
    slot: i,
    name: out.name,
    type: out.type,
    links: out.links?.length ?? 0,
  }));
  return {
    id: node.id,
    type: node.type,
    title: node.title,
    widgets,
    inputs,
    outputs,
  };
}

function resolveNode(graph, nodeId) {
  const node = graph.getNodeById(Number(nodeId));
  if (!node) throw new Error(`No node with id ${nodeId} in the current graph`);
  return node;
}

/** Resolve a slot reference (name string or numeric index) to an index in
 *  the given slot array. Names are matched case-insensitively. */
function resolveSlot(slots, ref, kind) {
  if (typeof ref === "number" && Number.isInteger(ref)) {
    if (ref < 0 || ref >= (slots?.length ?? 0)) {
      throw new Error(`${kind} slot index ${ref} out of range (node has ${slots?.length ?? 0})`);
    }
    return ref;
  }
  const name = String(ref).toLowerCase();
  const idx = (slots ?? []).findIndex((s) => s?.name?.toLowerCase() === name);
  if (idx === -1) {
    const names = (slots ?? []).map((s) => s?.name).join(", ");
    throw new Error(`No ${kind} slot named "${ref}" (available: ${names || "none"})`);
  }
  return idx;
}

/** Place a new node: explicit [x, y], else cascade right from the last node
 *  in the graph so repeated adds don't stack at the origin. */
function placementFor(graph, pos) {
  if (Array.isArray(pos) && pos.length === 2) return [Number(pos[0]), Number(pos[1])];
  const nodes = graph._nodes ?? [];
  const last = nodes[nodes.length - 1];
  if (last?.pos) return [last.pos[0] + (last.size?.[0] ?? 200) + 60, last.pos[1]];
  return [100, 100];
}

const GRAPH_TOOL_EXECUTORS = {
  graph_get_state() {
    const { graph } = getGraphCtx();
    const nodes = (graph._nodes ?? []).slice(0, MAX_STATE_NODES).map(summarizeNode);
    return {
      node_count: graph._nodes?.length ?? 0,
      truncated: (graph._nodes?.length ?? 0) > MAX_STATE_NODES,
      nodes,
    };
  },

  graph_add_node({ class_type, pos, title }) {
    const { graph, LG } = getGraphCtx();
    if (!class_type || typeof class_type !== "string") {
      throw new Error("class_type (string) is required");
    }
    const node = LG.createNode(class_type);
    if (!node) {
      throw new Error(
        `Unknown node type "${class_type}" — check the exact class_type via graph_get_state or the node search`,
      );
    }
    graph.beforeChange();
    try {
      node.pos = placementFor(graph, pos);
      if (title && typeof title === "string") node.title = title;
      graph.add(node);
    } finally {
      graph.afterChange();
    }
    graph.setDirtyCanvas(true, true);
    return { added: summarizeNode(node) };
  },

  graph_remove_node({ node_id }) {
    const { graph } = getGraphCtx();
    const node = resolveNode(graph, node_id);
    const summary = summarizeNode(node);
    graph.beforeChange();
    try {
      graph.remove(node);
    } finally {
      graph.afterChange();
    }
    graph.setDirtyCanvas(true, true);
    return { removed: summary };
  },

  graph_connect({ from_node_id, from_output, to_node_id, to_input }) {
    const { graph } = getGraphCtx();
    const origin = resolveNode(graph, from_node_id);
    const target = resolveNode(graph, to_node_id);
    const outIdx = resolveSlot(origin.outputs, from_output ?? 0, "output");
    const inIdx = resolveSlot(target.inputs, to_input ?? 0, "input");
    graph.beforeChange();
    let link;
    try {
      link = origin.connect(outIdx, target, inIdx);
    } finally {
      graph.afterChange();
    }
    graph.setDirtyCanvas(true, true);
    if (!link) {
      throw new Error(
        `connect refused — output "${origin.outputs?.[outIdx]?.name}" (${origin.outputs?.[outIdx]?.type}) ` +
          `is not compatible with input "${target.inputs?.[inIdx]?.name}" (${target.inputs?.[inIdx]?.type})`,
      );
    }
    return {
      connected: {
        from: { node_id: origin.id, output: origin.outputs?.[outIdx]?.name ?? outIdx },
        to: { node_id: target.id, input: target.inputs?.[inIdx]?.name ?? inIdx },
      },
    };
  },

  graph_disconnect({ node_id, input }) {
    const { graph } = getGraphCtx();
    const node = resolveNode(graph, node_id);
    const inIdx = resolveSlot(node.inputs, input ?? 0, "input");
    graph.beforeChange();
    try {
      node.disconnectInput(inIdx);
    } finally {
      graph.afterChange();
    }
    graph.setDirtyCanvas(true, true);
    return {
      disconnected: { node_id: node.id, input: node.inputs?.[inIdx]?.name ?? inIdx },
    };
  },

  graph_set_widget({ node_id, widget, value }) {
    const { app, graph } = getGraphCtx();
    const node = resolveNode(graph, node_id);
    const w = (node.widgets ?? []).find(
      (cand) => cand?.name?.toLowerCase() === String(widget).toLowerCase(),
    );
    if (!w) {
      const names = (node.widgets ?? []).map((cand) => cand?.name).join(", ");
      throw new Error(
        `Node ${node.id} (${node.type}) has no widget "${widget}" (available: ${names || "none"})`,
      );
    }
    graph.beforeChange();
    const previous = w.value;
    try {
      w.value = value;
      // Fire the widget's own callback so combo/number side effects run —
      // the same path a manual UI edit takes.
      w.callback?.(value, app.canvas, node, node.pos, undefined);
    } finally {
      graph.afterChange();
    }
    graph.setDirtyCanvas(true, true);
    return {
      set: { node_id: node.id, widget: w.name, previous, value: w.value },
    };
  },
};

// ---------------------------------------------------------------------------
// Bridge client: WS connection to the comfyui-mcp server with auto-reconnect.
// ---------------------------------------------------------------------------

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

function createBridgeClient({ onStatus, onSay, onLog, onCommand }) {
  let sock = null;
  let url = loadBridgeUrl();
  let closed = false;
  let attempt = 0;
  let reconnectTimer = null;

  function connect() {
    if (closed) return;
    onStatus("connecting");
    try {
      sock = new WebSocket(url);
    } catch (err) {
      onStatus("disconnected");
      scheduleReconnect();
      return;
    }

    sock.addEventListener("open", () => {
      attempt = 0;
      onStatus("connected");
      onLog(`Connected to ${url}`);
      sendHello();
    });

    sock.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      if (msg && typeof msg.rid === "string" && typeof msg.cmd === "string") {
        // Agent command — execute against the graph, reply with the rid.
        let reply;
        try {
          const executor = GRAPH_TOOL_EXECUTORS[msg.cmd];
          if (!executor) throw new Error(`Unknown command "${msg.cmd}"`);
          reply = { rid: msg.rid, ok: true, result: executor(msg) };
        } catch (err) {
          reply = {
            rid: msg.rid,
            ok: false,
            error: err && err.message ? err.message : String(err),
          };
        }
        try {
          sock.send(JSON.stringify(reply));
        } catch {
          // Socket died between receive and reply — agent side times out.
        }
        // Surface the action in the chat feed as an activity card.
        onCommand?.(msg.cmd, msg, reply);
        return;
      }
      if (msg && msg.type === "say" && typeof msg.text === "string") {
        onSay(msg.text);
      }
      // "echo" frames are ignored — we render the user bubble locally on send.
    });

    sock.addEventListener("close", () => {
      sock = null;
      if (!closed) {
        onStatus("disconnected");
        scheduleReconnect();
      }
    });

    sock.addEventListener("error", () => {
      // close fires after error; reconnect handled there.
    });
  }

  function sendHello() {
    if (!sock || sock.readyState !== WebSocket.OPEN) return;
    try {
      sock.send(
        JSON.stringify({ type: "hello", tab_id: getTabId(), title: getWorkflowTitle() }),
      );
    } catch {
      // Reconnect path will retry.
    }
  }

  // Re-hello when the workflow title changes (rename / open different file)
  // so panel_status stays accurate.
  const titleEl = document.querySelector("title");
  const titleObserver = titleEl
    ? new MutationObserver(() => sendHello())
    : null;
  titleObserver?.observe(titleEl, { childList: true });

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  return {
    start() {
      closed = false;
      connect();
    },
    sendUserMessage(text) {
      if (!sock || sock.readyState !== WebSocket.OPEN) return false;
      try {
        sock.send(JSON.stringify({ type: "user_message", text }));
        return true;
      } catch {
        return false;
      }
    },
    setUrl(next) {
      url = next || DEFAULT_BRIDGE_URL;
      saveBridgeUrl(url);
      attempt = 0;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        sock?.close();
      } catch {}
      sock = null;
      connect();
    },
    currentUrl() {
      return url;
    },
    destroy() {
      closed = true;
      titleObserver?.disconnect();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        sock?.close();
      } catch {}
      sock = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Panel DOM — styled on ComfyUI's own design system. Every color, radius,
// and font below consumes the PrimeVue semantic tokens (`--p-*`) the native
// sidebar panels use, with hard fallbacks for older frontends, so the panel
// tracks the user's theme (light/dark/custom) automatically.
// ---------------------------------------------------------------------------

const PANEL_CSS = `
.cmcp-root {
  display: flex; flex-direction: column; height: 100%;
  font-family: var(--font-inter, "Inter", ui-sans-serif, system-ui, sans-serif);
  font-size: 0.8125rem; line-height: 1.5;
  color: var(--p-text-color, #fff);
  background: var(--p-content-background, #18181b);
}
.cmcp-header {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--p-content-border-color, #3f3f46);
}
.cmcp-title { font-size: 0.9375rem; font-weight: 600; }
.cmcp-status { display: flex; align-items: center; gap: 0.375rem; margin-left: auto;
  font-size: 0.6875rem; color: var(--p-text-muted-color, #a1a1aa); }
.cmcp-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--p-red-400, #f87171); flex: none; }
.cmcp-dot.connected { background: var(--p-green-400, #4ade80); }
.cmcp-dot.connecting { background: var(--p-yellow-400, #facc15); animation: cmcp-pulse 1.2s ease-in-out infinite; }
@keyframes cmcp-pulse { 50% { opacity: 0.3; } }

.cmcp-settings {
  margin: 0.625rem 0.75rem 0;
  border: 1px solid var(--p-content-border-color, #3f3f46);
  border-radius: var(--p-border-radius-lg, 8px);
  background: var(--p-surface-800, #27272a);
}
.cmcp-settings > summary {
  padding: 0.5rem 0.75rem; cursor: pointer; user-select: none;
  font-size: 0.75rem; font-weight: 600; color: var(--p-text-muted-color, #a1a1aa);
  list-style: none; display: flex; align-items: center; gap: 0.375rem;
}
.cmcp-settings > summary::before { content: "▸"; transition: transform 0.15s; }
.cmcp-settings[open] > summary::before { transform: rotate(90deg); }
.cmcp-settings-body { padding: 0 0.75rem 0.75rem; display: flex; flex-direction: column; gap: 0.5rem; }
.cmcp-label { font-size: 0.6875rem; color: var(--p-text-muted-color, #a1a1aa); }
.cmcp-input {
  width: 100%; box-sizing: border-box;
  padding: var(--p-form-field-padding-y, 0.5rem) var(--p-form-field-padding-x, 0.75rem);
  background: var(--p-form-field-background, #09090b);
  border: 1px solid var(--p-form-field-border-color, #52525b);
  border-radius: var(--p-border-radius-md, 6px);
  color: var(--p-form-field-color, #fff);
  font: inherit; outline: none; transition: border-color 0.15s;
}
.cmcp-input:focus { border-color: var(--p-focus-ring-color, #60a5fa); }
.cmcp-btn {
  padding: 0.4375rem 0.875rem; cursor: pointer; align-self: flex-start;
  background: var(--p-button-primary-background, var(--p-primary-color, #60a5fa));
  color: var(--p-button-primary-color, var(--p-primary-contrast-color, #18181b));
  border: none; border-radius: var(--p-border-radius-md, 6px);
  font: inherit; font-weight: 600; transition: opacity 0.15s;
}
.cmcp-btn:hover { opacity: 0.85; }
.cmcp-btn:disabled { opacity: 0.4; cursor: default; }
.cmcp-help { font-size: 0.6875rem; color: var(--p-text-muted-color, #a1a1aa); line-height: 1.55; }
.cmcp-cmd {
  display: block; margin-top: 0.25rem; padding: 0.375rem 0.5rem;
  background: var(--p-form-field-background, #09090b);
  border: 1px solid var(--p-content-border-color, #3f3f46);
  border-radius: var(--p-border-radius-sm, 4px);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.6875rem;
  user-select: all; cursor: copy; color: var(--p-text-color, #fff);
  overflow-x: auto; white-space: nowrap;
}

.cmcp-log {
  flex: 1 1 auto; overflow-y: auto; padding: 0.75rem;
  display: flex; flex-direction: column; gap: 0.5rem;
}
.cmcp-empty {
  margin: auto; text-align: center; max-width: 230px;
  color: var(--p-text-muted-color, #a1a1aa);
}
.cmcp-empty .pi { font-size: 1.75rem; display: block; margin-bottom: 0.5rem; opacity: 0.5; }
.cmcp-empty-title { font-weight: 600; color: var(--p-text-color, #fff); margin-bottom: 0.25rem; }

.cmcp-bubble {
  padding: 0.5rem 0.75rem; max-width: 92%;
  border-radius: var(--p-border-radius-lg, 8px);
  white-space: pre-wrap; word-wrap: break-word;
  animation: cmcp-in 0.18s ease-out;
}
@keyframes cmcp-in { from { opacity: 0; transform: translateY(4px); } }
.cmcp-bubble.user {
  align-self: flex-end;
  background: var(--p-highlight-background, rgba(96,165,250,0.16));
  border: 1px solid color-mix(in srgb, var(--p-primary-color, #60a5fa), transparent 70%);
}
.cmcp-bubble.agent {
  align-self: flex-start;
  background: var(--p-surface-800, #27272a);
  border: 1px solid var(--p-content-border-color, #3f3f46);
}
.cmcp-bubble.agent code, .cmcp-bubble.user code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.75rem;
  background: var(--p-form-field-background, #09090b);
  padding: 0.0625rem 0.25rem; border-radius: var(--p-border-radius-sm, 4px);
}
.cmcp-sys {
  align-self: center; font-size: 0.6875rem; font-style: italic;
  color: var(--p-text-muted-color, #a1a1aa);
  animation: cmcp-in 0.18s ease-out;
}
.cmcp-card {
  align-self: flex-start; max-width: 92%; width: 100%; box-sizing: border-box;
  padding: 0.5rem 0.625rem;
  background: var(--p-surface-800, #27272a);
  border: 1px solid var(--p-content-border-color, #3f3f46);
  border-left: 3px solid var(--p-primary-color, #60a5fa);
  border-radius: var(--p-border-radius-md, 6px);
  font-size: 0.75rem;
  animation: cmcp-in 0.18s ease-out;
}
.cmcp-card.error { border-left-color: var(--p-red-400, #f87171); }
.cmcp-card-head { display: flex; align-items: center; gap: 0.375rem; font-weight: 600; }
.cmcp-card-head .pi { font-size: 0.75rem; color: var(--p-primary-color, #60a5fa); }
.cmcp-card.error .cmcp-card-head .pi { color: var(--p-red-400, #f87171); }
.cmcp-card-detail {
  margin-top: 0.25rem; color: var(--p-text-muted-color, #a1a1aa);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.6875rem;
  overflow-x: auto; white-space: pre-wrap; word-break: break-word;
  max-height: 7.5rem; overflow-y: auto;
}

.cmcp-inputrow {
  display: flex; gap: 0.5rem; padding: 0.75rem;
  border-top: 1px solid var(--p-content-border-color, #3f3f46);
}
.cmcp-textarea {
  flex: 1; resize: none; min-height: 2.25rem; max-height: 7.5rem;
  padding: var(--p-form-field-padding-y, 0.5rem) var(--p-form-field-padding-x, 0.75rem);
  background: var(--p-form-field-background, #09090b);
  border: 1px solid var(--p-form-field-border-color, #52525b);
  border-radius: var(--p-border-radius-md, 6px);
  color: var(--p-form-field-color, #fff);
  font: inherit; outline: none; transition: border-color 0.15s;
}
.cmcp-textarea:focus { border-color: var(--p-focus-ring-color, #60a5fa); }
.cmcp-send {
  align-self: flex-end; width: 2.25rem; height: 2.25rem; flex: none;
  display: flex; align-items: center; justify-content: center;
  background: var(--p-button-primary-background, var(--p-primary-color, #60a5fa));
  color: var(--p-button-primary-color, var(--p-primary-contrast-color, #18181b));
  border: none; border-radius: var(--p-border-radius-md, 6px); cursor: pointer;
  transition: opacity 0.15s;
}
.cmcp-send:hover { opacity: 0.85; }
.cmcp-send .pi { font-size: 0.875rem; }
`;

let styleInjected = false;
function ensureStyles() {
  if (styleInjected) return;
  const tag = document.createElement("style");
  tag.id = "comfyui-mcp-panel-styles";
  tag.textContent = PANEL_CSS;
  document.head.appendChild(tag);
  styleInjected = true;
}

/** Human-readable one-liner for an executed agent command. */
function describeCommand(cmd, msg, reply) {
  if (!reply.ok) return { icon: "pi-exclamation-triangle", text: `${cmd} failed`, detail: reply.error };
  const r = reply.result ?? {};
  switch (cmd) {
    case "graph_get_state":
      return { icon: "pi-eye", text: `Read graph — ${r.node_count} node${r.node_count === 1 ? "" : "s"}` };
    case "graph_add_node":
      return { icon: "pi-plus-circle", text: `Added ${r.added?.type ?? "node"} (id ${r.added?.id})` };
    case "graph_remove_node":
      return { icon: "pi-minus-circle", text: `Removed ${r.removed?.type ?? "node"} (id ${r.removed?.id})` };
    case "graph_connect":
      return {
        icon: "pi-link",
        text: `Connected ${r.connected?.from?.node_id}.${r.connected?.from?.output} → ${r.connected?.to?.node_id}.${r.connected?.to?.input}`,
      };
    case "graph_disconnect":
      return { icon: "pi-times-circle", text: `Disconnected ${r.disconnected?.node_id}.${r.disconnected?.input}` };
    case "graph_set_widget":
      return {
        icon: "pi-sliders-h",
        text: `Set ${r.set?.widget} = ${JSON.stringify(r.set?.value)} on node ${r.set?.node_id}`,
        detail: `was ${JSON.stringify(r.set?.previous)}`,
      };
    default:
      return { icon: "pi-bolt", text: cmd, detail: JSON.stringify(r).slice(0, 300) };
  }
}

/** Minimal markdown for agent bubbles: `code` spans + **bold**. textContent-safe. */
function renderRichText(el, text) {
  const parts = String(text).split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  for (const part of parts) {
    if (part.startsWith("`") && part.endsWith("`")) {
      const c = document.createElement("code");
      c.textContent = part.slice(1, -1);
      el.appendChild(c);
    } else if (part.startsWith("**") && part.endsWith("**")) {
      const b = document.createElement("strong");
      b.textContent = part.slice(2, -2);
      el.appendChild(b);
    } else if (part) {
      el.appendChild(document.createTextNode(part));
    }
  }
}

function buildPanel() {
  ensureStyles();

  const root = document.createElement("div");
  root.className = "cmcp-root";

  // ---- Header: title + status dot ----
  const header = document.createElement("div");
  header.className = "cmcp-header";
  const title = document.createElement("span");
  title.className = "cmcp-title";
  title.textContent = "Agent";
  const status = document.createElement("span");
  status.className = "cmcp-status";
  const dot = document.createElement("span");
  dot.className = "cmcp-dot";
  const statusText = document.createElement("span");
  statusText.textContent = "disconnected";
  status.append(dot, statusText);
  header.append(title, status);
  root.appendChild(header);

  // ---- Connection settings ----
  const settingsBox = document.createElement("details");
  settingsBox.className = "cmcp-settings";
  const settingsSummary = document.createElement("summary");
  settingsSummary.textContent = "Connection";
  const settingsBody = document.createElement("div");
  settingsBody.className = "cmcp-settings-body";

  const urlLabel = document.createElement("label");
  urlLabel.className = "cmcp-label";
  urlLabel.textContent = "Bridge URL";
  const urlInput = document.createElement("input");
  urlInput.className = "cmcp-input";
  urlInput.type = "text";
  urlInput.value = loadBridgeUrl();
  urlInput.placeholder = DEFAULT_BRIDGE_URL;

  const saveBtn = document.createElement("button");
  saveBtn.className = "cmcp-btn";
  saveBtn.type = "button";
  saveBtn.textContent = "Reconnect";

  const helpDiv = document.createElement("div");
  helpDiv.className = "cmcp-help";
  helpDiv.textContent =
    "This panel is a window into your own Claude Code session — no API keys. Add comfyui-mcp with channels mode:";
  const helpCmd = document.createElement("code");
  helpCmd.className = "cmcp-cmd";
  helpCmd.textContent = "claude mcp add comfyui -- npx -y comfyui-mcp --channels";
  helpCmd.title = "Click to copy";
  helpCmd.addEventListener("click", () => {
    navigator.clipboard?.writeText(helpCmd.textContent).then(
      () => appendSystem("Command copied."),
      () => {},
    );
  });
  helpDiv.appendChild(helpCmd);

  settingsBody.append(urlLabel, urlInput, saveBtn, helpDiv);
  settingsBox.append(settingsSummary, settingsBody);
  root.appendChild(settingsBox);

  // ---- Message log + empty state ----
  const log = document.createElement("div");
  log.className = "cmcp-log";
  const empty = document.createElement("div");
  empty.className = "cmcp-empty";
  const emptyIcon = document.createElement("i");
  emptyIcon.className = "pi pi-comments";
  const emptyTitle = document.createElement("div");
  emptyTitle.className = "cmcp-empty-title";
  emptyTitle.textContent = "Claude is at your canvas";
  const emptyBody = document.createElement("div");
  emptyBody.textContent =
    "Ask for nodes, connections, or parameter changes — every edit lands live on the graph and undoes with Ctrl+Z.";
  empty.append(emptyIcon, emptyTitle, emptyBody);
  log.appendChild(empty);
  root.appendChild(log);

  function clearEmpty() {
    if (empty.parentElement) empty.remove();
  }

  // ---- Input row ----
  const form = document.createElement("form");
  form.className = "cmcp-inputrow";
  const input = document.createElement("textarea");
  input.className = "cmcp-textarea";
  input.placeholder = "Message Claude…";
  input.rows = 1;
  const sendBtn = document.createElement("button");
  sendBtn.className = "cmcp-send";
  sendBtn.type = "submit";
  sendBtn.title = "Send (Enter)";
  const sendIcon = document.createElement("i");
  sendIcon.className = "pi pi-send";
  sendBtn.appendChild(sendIcon);
  form.append(input, sendBtn);
  root.appendChild(form);

  // ---- feed renderers ----
  function scrollLog() {
    log.scrollTop = log.scrollHeight;
  }

  function appendUser(text) {
    clearEmpty();
    const b = document.createElement("div");
    b.className = "cmcp-bubble user";
    b.textContent = text;
    log.appendChild(b);
    scrollLog();
  }

  function appendAgent(text) {
    clearEmpty();
    const b = document.createElement("div");
    b.className = "cmcp-bubble agent";
    renderRichText(b, text);
    log.appendChild(b);
    scrollLog();
  }

  function appendSystem(text) {
    const b = document.createElement("div");
    b.className = "cmcp-sys";
    b.textContent = text;
    log.appendChild(b);
    scrollLog();
  }

  function appendActivity(cmd, msg, reply) {
    clearEmpty();
    const { icon, text, detail } = describeCommand(cmd, msg, reply);
    const card = document.createElement("div");
    card.className = "cmcp-card" + (reply.ok ? "" : " error");
    const head = document.createElement("div");
    head.className = "cmcp-card-head";
    const i = document.createElement("i");
    i.className = `pi ${icon}`;
    const t = document.createElement("span");
    t.textContent = text;
    head.append(i, t);
    card.appendChild(head);
    if (detail) {
      const d = document.createElement("div");
      d.className = "cmcp-card-detail";
      d.textContent = detail;
      card.appendChild(d);
    }
    log.appendChild(card);
    scrollLog();
  }

  // ---- bridge wiring ----
  const client = createBridgeClient({
    onStatus(state) {
      statusText.textContent = state;
      dot.className = "cmcp-dot" + (state === "connected" ? " connected" : state === "connecting" ? " connecting" : "");
      settingsBox.open = state !== "connected";
    },
    onSay(text) {
      appendAgent(text);
    },
    onLog(text) {
      appendSystem(text);
    },
    onCommand(cmd, msg, reply) {
      appendActivity(cmd, msg, reply);
    },
  });

  saveBtn.addEventListener("click", () => {
    client.setUrl(urlInput.value.trim());
    appendSystem(`Reconnecting to ${client.currentUrl()}…`);
  });

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const sent = client.sendUserMessage(text);
    if (sent) {
      appendUser(text);
      input.value = "";
      input.style.height = "auto";
    } else {
      appendSystem("Not connected — start the bridge (see Connection) and try again.");
      settingsBox.open = true;
    }
  });

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      form.requestSubmit();
    }
  });
  // Auto-grow the textarea up to its CSS max-height.
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  });

  client.start();

  return {
    root,
    destroy() {
      client.destroy();
      root.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// v1 registration via the imported app module.
// ---------------------------------------------------------------------------
if (!app || typeof app.registerExtension !== "function") {
  console.error(
    "[comfyui-mcp-panel] app.registerExtension is unavailable — incompatible ComfyUI frontend version.",
  );
} else {
  // TODO(v2): replace with `defineExtension({ name, setup() {...} })`.
  app.registerExtension({
    name: "comfyui-mcp.agent-panel",
    async setup() {
      const tabId = "comfyui-mcp.agent";
      let mounted = null; // { root, destroy }

      const tabSpec = {
        id: tabId,
        title: "Agent",
        // ComfyUI ships PrimeIcons; `pi-comments` is the closest "chat" glyph.
        icon: "pi pi-comments",
        tooltip: "ComfyUI MCP Panel — your Claude session's window into this graph",
        type: "custom",
        render: (container) => {
          if (mounted) mounted.destroy();
          mounted = buildPanel();
          container.appendChild(mounted.root);
        },
        destroy: () => {
          mounted?.destroy();
          mounted = null;
        },
      };

      // TODO(v2): replace with `defineSidebarTab({...})` from
      // '@comfyorg/extension-api'.
      const mgr = app.extensionManager;
      if (mgr && typeof mgr.registerSidebarTab === "function") {
        mgr.registerSidebarTab(tabSpec);
      } else {
        console.error(
          "[comfyui-mcp-panel] app.extensionManager.registerSidebarTab is unavailable; " +
            "update ComfyUI to a version that exposes the extension manager.",
        );
      }
    },
  });
}
