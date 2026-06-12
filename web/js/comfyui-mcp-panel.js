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

function createBridgeClient({ onStatus, onSay, onLog }) {
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
// Panel DOM. Returns { root, destroy } so the host can mount/unmount.
// ---------------------------------------------------------------------------
function buildPanel() {
  const root = document.createElement("div");
  root.className = "comfyui-mcp-panel";
  root.style.cssText = `
    display: flex; flex-direction: column; height: 100%;
    padding: 8px; gap: 8px; box-sizing: border-box;
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: var(--input-text, #ddd); background: var(--comfy-menu-bg, #222);
  `;

  // ---- Header: status pill --------------------------------------------------
  const header = document.createElement("div");
  header.style.cssText = "display: flex; align-items: center; gap: 8px;";
  const statusPill = document.createElement("span");
  statusPill.style.cssText = `
    padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600;
    background: #5a2828; color: #fff;
  `;
  statusPill.textContent = "disconnected";
  const headerTitle = document.createElement("span");
  headerTitle.textContent = "Claude ↔ graph bridge";
  headerTitle.style.cssText = "opacity: 0.7; font-size: 11px;";
  header.append(statusPill, headerTitle);
  root.appendChild(header);

  // ---- Settings strip --------------------------------------------------------
  const settingsBox = document.createElement("details");
  settingsBox.style.cssText = "border: 1px solid #444; border-radius: 4px; padding: 6px;";
  const settingsSummary = document.createElement("summary");
  settingsSummary.textContent = "Connection";
  settingsSummary.style.cssText = "cursor: pointer; user-select: none; font-weight: 600;";
  settingsBox.appendChild(settingsSummary);

  const urlRow = document.createElement("div");
  urlRow.style.cssText = "display: flex; flex-direction: column; gap: 2px; margin-top: 6px;";
  const urlLabel = document.createElement("label");
  urlLabel.textContent = "Bridge URL";
  urlLabel.style.cssText = "font-size: 11px; opacity: 0.7;";
  const urlInput = document.createElement("input");
  urlInput.type = "text";
  urlInput.value = loadBridgeUrl();
  urlInput.placeholder = DEFAULT_BRIDGE_URL;
  urlInput.style.cssText = `
    width: 100%; padding: 4px 6px; border: 1px solid #555; border-radius: 3px;
    background: var(--comfy-input-bg, #181818); color: inherit; box-sizing: border-box;
  `;
  urlRow.append(urlLabel, urlInput);

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = "Reconnect";
  saveBtn.style.cssText =
    "margin-top: 8px; padding: 4px 10px; cursor: pointer; align-self: flex-start;";

  const helpDiv = document.createElement("div");
  helpDiv.style.cssText =
    "margin-top: 8px; font-size: 11px; opacity: 0.75; line-height: 1.5;";
  const helpLabel = document.createElement("div");
  helpLabel.textContent =
    "This panel is a window into your own Claude Code session — no API keys. " +
    "Add comfyui-mcp to Claude Code with channels mode:";
  const helpCmd = document.createElement("code");
  helpCmd.textContent = 'claude mcp add comfyui -- npx -y comfyui-mcp --channels';
  helpCmd.style.cssText = `
    display: block; margin-top: 4px; padding: 4px 6px; border-radius: 3px;
    background: var(--comfy-input-bg, #181818); user-select: all; cursor: copy;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  `;
  helpCmd.title = "Click to copy";
  helpCmd.addEventListener("click", () => {
    navigator.clipboard?.writeText(helpCmd.textContent).then(
      () => appendSystem("Command copied."),
      () => {},
    );
  });
  helpDiv.append(helpLabel, helpCmd);

  settingsBox.append(urlRow, saveBtn, helpDiv);
  root.appendChild(settingsBox);

  // ---- Message log ------------------------------------------------------------
  const log = document.createElement("div");
  log.style.cssText = `
    flex: 1 1 auto; overflow-y: auto; padding: 6px;
    border: 1px solid #444; border-radius: 4px;
    display: flex; flex-direction: column; gap: 6px;
  `;
  root.appendChild(log);

  // ---- Input row ----------------------------------------------------------------
  const form = document.createElement("form");
  form.style.cssText = "display: flex; gap: 6px;";
  const input = document.createElement("textarea");
  input.placeholder = "Message Claude... (Enter to send, Shift+Enter for newline)";
  input.rows = 2;
  input.style.cssText = `
    flex: 1; padding: 6px; border: 1px solid #555; border-radius: 3px;
    background: var(--comfy-input-bg, #181818); color: inherit; resize: vertical;
    font: inherit;
  `;
  const sendBtn = document.createElement("button");
  sendBtn.type = "submit";
  sendBtn.textContent = "Send";
  sendBtn.style.cssText = "padding: 6px 12px; cursor: pointer;";
  form.append(input, sendBtn);
  root.appendChild(form);

  // ---- bubbles --------------------------------------------------------------------
  function makeBubble(role) {
    const bubble = document.createElement("div");
    bubble.style.cssText = `
      padding: 6px 8px; border-radius: 4px; max-width: 95%;
      white-space: pre-wrap; word-wrap: break-word;
    `;
    if (role === "user") {
      bubble.style.background = "#2a4d6e";
      bubble.style.alignSelf = "flex-end";
    } else if (role === "system") {
      bubble.style.background = "#3a3a3a";
      bubble.style.fontStyle = "italic";
      bubble.style.opacity = "0.8";
      bubble.style.alignSelf = "center";
      bubble.style.fontSize = "11px";
    } else {
      bubble.style.background = "#333";
      bubble.style.alignSelf = "flex-start";
    }
    log.appendChild(bubble);
    log.scrollTop = log.scrollHeight;
    return bubble;
  }

  function appendUser(text) {
    makeBubble("user").textContent = text;
  }
  function appendSystem(text) {
    makeBubble("system").textContent = text;
  }
  function appendAgent(text) {
    makeBubble("assistant").textContent = text;
  }

  // ---- bridge wiring -------------------------------------------------------------
  const client = createBridgeClient({
    onStatus(state) {
      statusPill.textContent = state;
      statusPill.style.background =
        state === "connected" ? "#2d5a2d" : state === "connecting" ? "#5a4a28" : "#5a2828";
      settingsBox.open = state !== "connected";
    },
    onSay(text) {
      appendAgent(text);
    },
    onLog(text) {
      appendSystem(text);
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
    } else {
      appendSystem(
        "Not connected — start the bridge (see Connection) and try again.",
      );
      settingsBox.open = true;
    }
  });

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      form.requestSubmit();
    }
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
