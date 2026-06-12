// =============================================================================
// ComfyUI MCP Panel — sidebar agent chat + live graph edits.
//
// Shipped as a UI-only custom node pack (this file is served by ComfyUI via
// the pack's WEB_DIRECTORY). Registers a sidebar tab hosting a chat UI that
// talks to the agent backend in the `comfyui-mcp` npm package
// (run with COMFYUI_MCP_AGENT_POC=1).
//
// Wire format: the backend's `POST /api/chat` returns an AI SDK v6 UI Message
// Stream (Server-Sent Events). We parse `text-start`/`text-delta`/`text-end`
// to append streaming text, and `tool-input-available` /
// `tool-output-available` to render a tool card.
//
// LIVE GRAPH EDITS: tools whose name starts with `graph_` are CLIENT-SIDE —
// the backend declares them without an executor, the stream pauses after
// `tool-input-available`, and this panel executes them against the open
// LiteGraph graph (`window.app.graph`), then re-POSTs the conversation with
// the tool result appended so the agent can continue. All mutations are
// wrapped in beforeChange/afterChange so ComfyUI's native Ctrl+Z undoes them.
// The tool surface is a fixed allowlist — no arbitrary JS evaluation.
//
// Settings (panel UI; persisted via window.localStorage under
// `comfyui-mcp.agent-panel.*`):
//   - `backendUrl`  — URL the panel POSTs to (e.g. `http://127.0.0.1:8765`
//                     or a cloudflared trycloudflare.com URL).
//   - `token`       — bearer token printed on the server's stdout.
// Both are required before the first message can be sent.
//
// SECURITY NOTE: localStorage is per-origin readable by any script on the
// ComfyUI page. The bearer token grants spend on the user's provider keys —
// don't share workflow JSON containing it, and rotate it (restart the POC) if
// you suspect leakage.
//
// V1→V2 MIGRATION: this file uses `window.app.registerExtension(...)` (v1),
// `app.extensionManager.registerSidebarTab(...)`, and direct `app.graph` /
// `LiteGraph` access for the graph tools. When the v2 npm package
// `@comfyorg/extension-api` ships, the equivalents are `defineExtension()`,
// `defineSidebarTab()`, and `NodeHandle`/`WidgetHandle`. Every v1-specific
// call below is marked `// TODO(v2):`.
// =============================================================================

// ---------------------------------------------------------------------------
// AI SDK UI Message Stream parser. Kept byte-equivalent to the TS module at
// `src/experimental/ui-message-stream-parser.ts` (which has vitest coverage).
// We can't import that TS module here because this file is loaded directly
// by ComfyUI's browser with no bundler.
// ---------------------------------------------------------------------------
function parseUiMessageStream(buffer) {
  const chunks = [];
  let done = false;
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const remainder = parts.pop() ?? "";

  for (const frame of parts) {
    const dataLines = [];
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      let payload = line.slice(5);
      if (payload.startsWith(" ")) payload = payload.slice(1);
      dataLines.push(payload);
    }
    if (dataLines.length === 0) continue;
    const payload = dataLines.join("\n");
    if (payload === "[DONE]") {
      done = true;
      continue;
    }
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
        chunks.push(parsed);
      }
    } catch {
      // ignore malformed frames
    }
  }
  return { chunks, remainder, done };
}

// ---------------------------------------------------------------------------
// localStorage-backed settings (small, sync, plenty for the POC).
// ---------------------------------------------------------------------------
const STORAGE_KEY_BACKEND = "comfyui-mcp.agent-panel.backendUrl";
const STORAGE_KEY_TOKEN = "comfyui-mcp.agent-panel.token";

function loadSettings() {
  try {
    return {
      backendUrl: window.localStorage.getItem(STORAGE_KEY_BACKEND) ?? "",
      token: window.localStorage.getItem(STORAGE_KEY_TOKEN) ?? "",
    };
  } catch {
    return { backendUrl: "", token: "" };
  }
}

function saveSettings(s) {
  try {
    window.localStorage.setItem(STORAGE_KEY_BACKEND, s.backendUrl ?? "");
    window.localStorage.setItem(STORAGE_KEY_TOKEN, s.token ?? "");
  } catch {
    // localStorage may be unavailable in private/locked-down browsers; the
    // panel just becomes session-scoped in that case.
  }
}

// ---------------------------------------------------------------------------
// Tiny id helper for UIMessage ids. The AI SDK accepts any unique string.
// ---------------------------------------------------------------------------
function uid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Graph-edit executor — the client side of the agent's `graph_*` tools.
//
// Fixed allowlist of mutations against the open LiteGraph graph. Every entry
// returns a JSON-serializable result object; failures return { error } so the
// agent can self-correct instead of the stream dying. All mutations are
// sandwiched in beforeChange/afterChange for native undo integration.
//
// TODO(v2): replace direct app.graph / LiteGraph access with NodeHandle /
// WidgetHandle from @comfyorg/extension-api once it ships.
// ---------------------------------------------------------------------------

const MAX_STATE_NODES = 100;

function getGraphCtx() {
  const app = window.app ?? globalThis.app;
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

/** Place a new node: explicit [x, y], else cascade right-and-down from the
 *  last node in the graph so repeated adds don't stack at the origin. */
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

/** Execute one client-side graph tool. Never throws — errors come back as
 *  { error } so the agent loop forwards them as tool results and the model
 *  can correct itself. */
function executeGraphTool(toolName, input) {
  const executor = GRAPH_TOOL_EXECUTORS[toolName];
  if (!executor) {
    return { error: `Unknown client-side tool "${toolName}"` };
  }
  try {
    return executor(input ?? {});
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) };
  }
}

function isClientGraphTool(toolName) {
  return typeof toolName === "string" && toolName.startsWith("graph_");
}

// ---------------------------------------------------------------------------
// Build the panel DOM. Returns { root, destroy } so the host can mount/unmount.
// ---------------------------------------------------------------------------
function buildPanel() {
  const root = document.createElement("div");
  root.className = "comfyui-mcp-agent-panel";
  root.style.cssText = `
    display: flex; flex-direction: column; height: 100%;
    padding: 8px; gap: 8px; box-sizing: border-box;
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: var(--input-text, #ddd); background: var(--comfy-menu-bg, #222);
  `;

  // ---- Settings strip ------------------------------------------------------
  const settingsBox = document.createElement("details");
  settingsBox.style.cssText = "border: 1px solid #444; border-radius: 4px; padding: 6px;";
  const settingsSummary = document.createElement("summary");
  settingsSummary.textContent = "Connection";
  settingsSummary.style.cssText = "cursor: pointer; user-select: none; font-weight: 600;";
  settingsBox.appendChild(settingsSummary);

  const settings = loadSettings();
  settingsBox.open = !settings.backendUrl || !settings.token;

  const makeRow = (labelText, type, value, placeholder) => {
    const row = document.createElement("div");
    row.style.cssText = "display: flex; flex-direction: column; gap: 2px; margin-top: 6px;";
    const label = document.createElement("label");
    label.textContent = labelText;
    label.style.cssText = "font-size: 11px; opacity: 0.7;";
    const input = document.createElement("input");
    input.type = type;
    input.value = value;
    input.placeholder = placeholder;
    input.style.cssText = `
      width: 100%; padding: 4px 6px; border: 1px solid #555; border-radius: 3px;
      background: var(--comfy-input-bg, #181818); color: inherit; box-sizing: border-box;
    `;
    row.append(label, input);
    return { row, input };
  };

  const { row: urlRow, input: urlInput } = makeRow(
    "Backend URL",
    "url",
    settings.backendUrl,
    "https://<random>.trycloudflare.com",
  );
  const { row: tokenRow, input: tokenInput } = makeRow(
    "Bearer token",
    "password",
    settings.token,
    "from server stdout: 'session token: ...'",
  );

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = "Save";
  saveBtn.style.cssText =
    "margin-top: 8px; padding: 4px 10px; cursor: pointer; align-self: flex-start;";
  saveBtn.addEventListener("click", () => {
    saveSettings({
      backendUrl: urlInput.value.trim(),
      token: tokenInput.value.trim(),
    });
    appendSystem("Connection saved.");
    settingsBox.open = false;
  });

  // First-run helper: the backend is a separate process (it holds the LLM
  // API keys); give the user the exact command to launch it.
  const helpDiv = document.createElement("div");
  helpDiv.style.cssText =
    "margin-top: 8px; font-size: 11px; opacity: 0.75; line-height: 1.5;";
  const helpLabel = document.createElement("div");
  helpLabel.textContent = "No backend yet? Run this in a terminal, then paste the URL + token it prints:";
  const helpCmd = document.createElement("code");
  helpCmd.textContent =
    "COMFYUI_MCP_AGENT_POC=1 ANTHROPIC_API_KEY=sk-... npx -y comfyui-mcp";
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

  settingsBox.append(urlRow, tokenRow, saveBtn, helpDiv);
  root.appendChild(settingsBox);

  // ---- Message log ---------------------------------------------------------
  const log = document.createElement("div");
  log.style.cssText = `
    flex: 1 1 auto; overflow-y: auto; padding: 6px;
    border: 1px solid #444; border-radius: 4px;
    display: flex; flex-direction: column; gap: 6px;
  `;
  root.appendChild(log);

  // ---- Input row -----------------------------------------------------------
  const form = document.createElement("form");
  form.style.cssText = "display: flex; gap: 6px;";
  const input = document.createElement("textarea");
  input.placeholder = "Ask the agent... (Enter to send, Shift+Enter for newline)";
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

  // ---- DOM helpers ---------------------------------------------------------
  const messages = []; // UIMessage[] for /api/chat history.

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
    const bubble = makeBubble("user");
    bubble.textContent = text;
  }

  function appendSystem(text) {
    const bubble = makeBubble("system");
    bubble.textContent = text;
  }

  function appendAssistantStub() {
    const bubble = makeBubble("assistant");
    bubble.dataset.role = "assistant";
    return bubble;
  }

  function appendToolCard({ toolCallId, toolName, input: toolInput, output }) {
    const card = document.createElement("div");
    card.style.cssText = `
      align-self: flex-start; padding: 6px 8px; border-radius: 4px;
      background: #2c2c2c; border-left: 3px solid #6aa84f;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
      max-width: 95%; white-space: pre-wrap; word-wrap: break-word;
    `;
    const head = document.createElement("div");
    head.style.cssText = "font-weight: 600; margin-bottom: 4px;";
    head.textContent = `tool ${toolName ?? "?"} (${toolCallId.slice(0, 8)}…)`;
    card.appendChild(head);
    if (toolInput !== undefined) {
      const inDiv = document.createElement("div");
      inDiv.textContent = `input: ${safeStringify(toolInput)}`;
      card.appendChild(inDiv);
    }
    if (output !== undefined) {
      const outDiv = document.createElement("div");
      outDiv.style.opacity = "0.85";
      outDiv.textContent = `output: ${safeStringify(output)}`;
      card.appendChild(outDiv);
    }
    log.appendChild(card);
    log.scrollTop = log.scrollHeight;
    return card;
  }

  function safeStringify(v) {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }

  // ---- Send pipeline -------------------------------------------------------
  let inFlight = null; // AbortController for the current request.

  /** Read the live connection settings, preferring the form inputs over storage
   *  so that a user who types into Connection and hits Send (without clicking
   *  Save first) gets the expected behavior — and we silently persist the
   *  values they implicitly approved by sending. */
  function readConnection() {
    const liveUrl = urlInput.value.trim();
    const liveToken = tokenInput.value.trim();
    const stored = loadSettings();
    const backendUrl = liveUrl || stored.backendUrl;
    const token = liveToken || stored.token;
    if (
      backendUrl &&
      token &&
      (backendUrl !== stored.backendUrl || token !== stored.token)
    ) {
      saveSettings({ backendUrl, token });
    }
    return { backendUrl, token };
  }

  /** Normalize a user-pasted backend URL into a `/api/chat` endpoint.
   *  Accepts forms like:
   *    https://abc.trycloudflare.com
   *    https://abc.trycloudflare.com/
   *    https://abc.trycloudflare.com/api
   *    https://abc.trycloudflare.com/api/chat
   *  and returns the canonical `<origin>/api/chat`. */
  function toChatUrl(raw) {
    // Strip whitespace + trailing slashes.
    let s = raw.trim().replace(/\/+$/, "");
    // Strip a trailing `/api/chat` or `/api` segment if the user copied either.
    s = s.replace(/\/api\/chat$/i, "").replace(/\/api$/i, "");
    return s + "/api/chat";
  }

  /** Cap on backend round-trips per user message. Each round is one
   *  POST /api/chat; client-side graph tools force a continuation round.
   *  Generous enough for "build me a txt2img graph" (≈1 state read + ~8
   *  mutations batched across a few rounds), small enough to stop a loop. */
  const MAX_ROUNDS = 8;

  /** One POST /api/chat round: stream, render, collect tool calls.
   *  Returns { ok, assistantText, toolParts, pendingClientCalls } where
   *  pendingClientCalls are graph_* invocations the backend paused on. */
  async function streamRound(assistantBubble) {
    let assistantText = "";
    // Track open tool calls so we can fill in their output when it arrives,
    // AND so the assistant message we persist to history includes the
    // dynamic-tool parts the model actually emitted (otherwise multi-turn
    // tool conversations lose the tool context).
    const toolCards = new Map(); // toolCallId -> card element
    const toolParts = new Map(); // toolCallId -> dynamic-tool UIMessagePart
    const pendingClientCalls = []; // { toolCallId, toolName, input }

    const processChunk = (chunk) => {
      switch (chunk.type) {
        case "text-start":
          break;
        case "text-delta":
          if (typeof chunk.delta === "string") {
            assistantText += chunk.delta;
            assistantBubble.textContent = assistantText;
            log.scrollTop = log.scrollHeight;
          }
          break;
        case "text-end":
          break;
        case "tool-input-available": {
          const id = String(chunk.toolCallId ?? uid());
          const toolName = String(chunk.toolName ?? "");
          const card = appendToolCard({
            toolCallId: id,
            toolName,
            input: chunk.input,
          });
          toolCards.set(id, card);
          toolParts.set(id, {
            type: "dynamic-tool",
            toolName,
            toolCallId: id,
            state: "input-available",
            input: chunk.input,
          });
          // Client-side tool: the backend has no executor for graph_* —
          // the stream will end after this chunk and it's on us to run it.
          if (isClientGraphTool(toolName)) {
            pendingClientCalls.push({ toolCallId: id, toolName, input: chunk.input });
          }
          break;
        }
        case "tool-output-available": {
          const id = String(chunk.toolCallId ?? uid());
          let card = toolCards.get(id);
          if (!card) {
            card = appendToolCard({ toolCallId: id, toolName: "(tool)" });
            toolCards.set(id, card);
          }
          const outDiv = document.createElement("div");
          outDiv.style.opacity = "0.85";
          outDiv.textContent = `output: ${safeStringify(chunk.output)}`;
          card.appendChild(outDiv);
          log.scrollTop = log.scrollHeight;
          const prior = toolParts.get(id) ?? {
            type: "dynamic-tool",
            toolName: "(tool)",
            toolCallId: id,
          };
          toolParts.set(id, {
            ...prior,
            state: "output-available",
            output: chunk.output,
          });
          break;
        }
        case "tool-output-error": {
          const id = String(chunk.toolCallId ?? uid());
          const card = toolCards.get(id);
          const errDiv = document.createElement("div");
          errDiv.style.color = "#f08";
          errDiv.textContent = `error: ${chunk.errorText ?? "tool failed"}`;
          (card ?? appendToolCard({ toolCallId: id, toolName: "(tool)" })).appendChild(
            errDiv,
          );
          const prior = toolParts.get(id) ?? {
            type: "dynamic-tool",
            toolName: "(tool)",
            toolCallId: id,
          };
          toolParts.set(id, {
            ...prior,
            state: "output-error",
            errorText: String(chunk.errorText ?? "tool failed"),
          });
          break;
        }
        case "error":
          assistantBubble.textContent = String(chunk.errorText ?? "stream error");
          assistantBubble.style.background = "#5a2828";
          break;
        case "finish":
          break;
        default:
          break;
      }
    };

    const { backendUrl, token } = readConnection();
    const res = await fetch(toChatUrl(backendUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ messages }),
      signal: inFlight.signal,
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => "");
      assistantBubble.textContent = `Error ${res.status}: ${errText || res.statusText}`;
      assistantBubble.style.background = "#5a2828";
      return { ok: false, assistantText: "", toolParts, pendingClientCalls: [] };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let streamDone = false;

    while (!streamDone) {
      const { value, done } = await reader.read();
      if (done) {
        // Flush any pending multi-byte UTF-8 bytes the decoder is buffering.
        buffer += decoder.decode();
        const tail = parseUiMessageStream(buffer);
        buffer = tail.remainder;
        if (tail.done) streamDone = true;
        for (const chunk of tail.chunks) processChunk(chunk);
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const result = parseUiMessageStream(buffer);
      buffer = result.remainder;
      if (result.done) streamDone = true;

      for (const chunk of result.chunks) processChunk(chunk);
    }

    return { ok: true, assistantText, toolParts, pendingClientCalls };
  }

  async function sendMessage(text) {
    const { backendUrl, token } = readConnection();
    if (!backendUrl || !token) {
      appendSystem("Set the backend URL and bearer token in the Connection section first.");
      settingsBox.open = true;
      return;
    }

    messages.push({ id: uid(), role: "user", parts: [{ type: "text", text }] });
    appendUser(text);

    sendBtn.disabled = true;
    input.disabled = true;
    inFlight = new AbortController();

    try {
      // Agent loop: stream a round; if the model called client-side graph
      // tools, execute them against the open graph, append the results to
      // history, and POST again so the model can continue. Server-side
      // tools resolve inside a single round (their output rides the same
      // stream) and never force a continuation.
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const assistantBubble = appendAssistantStub();
        const result = await streamRound(assistantBubble);
        if (!result.ok) return;

        // Drop the empty bubble when the model emitted no text this round
        // (pure tool-call rounds otherwise leave blank gray boxes behind).
        if (!result.assistantText) assistantBubble.remove();

        // Execute any client-side graph tools the backend paused on.
        for (const call of result.pendingClientCalls) {
          const output = executeGraphTool(call.toolName, call.input);
          const prior = result.toolParts.get(call.toolCallId);
          const failed = output && typeof output === "object" && "error" in output;
          result.toolParts.set(call.toolCallId, {
            ...(prior ?? {
              type: "dynamic-tool",
              toolName: call.toolName,
              toolCallId: call.toolCallId,
              input: call.input,
            }),
            state: failed ? "output-error" : "output-available",
            ...(failed
              ? { errorText: String(output.error) }
              : { output }),
          });
          // Surface the result as its own card beneath the input card.
          appendToolCard({
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output,
          });
        }

        // Persist the assistant message (tool parts first, then text).
        const parts = [];
        for (const part of result.toolParts.values()) parts.push(part);
        if (result.assistantText) parts.push({ type: "text", text: result.assistantText });
        if (parts.length > 0) {
          messages.push({ id: uid(), role: "assistant", parts });
        }

        // No client tools pending → the turn is complete.
        if (result.pendingClientCalls.length === 0) return;

        if (round === MAX_ROUNDS - 1) {
          appendSystem(
            `Stopped after ${MAX_ROUNDS} agent rounds — send another message to continue.`,
          );
        }
      }
    } catch (err) {
      if (err && err.name === "AbortError") {
        appendSystem("[aborted]");
      } else {
        const msg = err && err.message ? err.message : String(err);
        const bubble = appendAssistantStub();
        bubble.textContent = `Request failed: ${msg}`;
        bubble.style.background = "#5a2828";
      }
    } finally {
      inFlight = null;
      sendBtn.disabled = false;
      input.disabled = false;
      input.focus();
    }
  }

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text || inFlight) return;
    input.value = "";
    void sendMessage(text);
  });

  input.addEventListener("keydown", (ev) => {
    // Enter sends; Shift+Enter inserts a newline.
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      form.requestSubmit();
    }
  });

  return {
    root,
    destroy() {
      try {
        inFlight?.abort();
      } catch {}
      root.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// v1 registration. We reach for `window.app` lazily — at module-eval time
// `app` may not yet be on `window`, but `registerExtension` itself queues.
// ---------------------------------------------------------------------------
const app = window.app ?? globalThis.app;
if (!app || typeof app.registerExtension !== "function") {
  console.error(
    "[comfyui-mcp] window.app.registerExtension is unavailable. " +
      "This extension targets the v1 ComfyUI frontend API.",
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
        tooltip: "comfyui-mcp Agent",
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

      // TODO(v2): replace with `defineSidebarTab({ id, title, type: 'custom',
      // icon, render, destroy })` imported from '@comfyorg/extension-api'.
      const mgr = app.extensionManager;
      if (mgr && typeof mgr.registerSidebarTab === "function") {
        mgr.registerSidebarTab(tabSpec);
      } else {
        console.error(
          "[comfyui-mcp] app.extensionManager.registerSidebarTab is unavailable; " +
            "the agent panel cannot mount. Update ComfyUI to a version that exposes the extension manager.",
        );
      }
    },
  });
}
