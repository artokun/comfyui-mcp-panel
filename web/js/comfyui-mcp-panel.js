// =============================================================================
// ComfyUI MCP Panel — sidebar driven by an autonomous background agent.
//
// Shipped as a UI-only custom node pack (served via WEB_DIRECTORY). The panel
// connects to the loopback WebSocket bridge owned by the comfyui-mcp panel
// orchestrator, started with:
//
//     npx -y comfyui-mcp --panel-orchestrator
//
// The AGENT is a background Claude Agent SDK session the orchestrator spawns
// per tab, running on the user's Claude SUBSCRIPTION — there are NO LLM API
// keys anywhere in this path, and the user's interactive Claude session stays
// free. The agent drives the graph through the bridge; the bridge forwards each
// rid-correlated command here, where a fixed allowlist of executors mutates the
// open LiteGraph graph. Messages the user types below travel the other way:
// panel → bridge → background agent.
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
import { api } from "/scripts/api.js";
import { marked } from "./vendor/marked.esm.js";
import DOMPurify from "./vendor/purify.es.js";

// Execution-error capture: listen from module load so graph_get_errors can
// report the most recent failure even if it predates the agent's question.
// execution_start clears state for the new run.
let lastExecutionError = null;
try {
  api.addEventListener("execution_error", (ev) => {
    lastExecutionError = { ...(ev.detail ?? {}), ts: new Date().toISOString() };
  });
  api.addEventListener("execution_start", () => {
    lastExecutionError = null;
  });
} catch {
  // api unavailable — graph_get_errors reports null.
}

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

// Per-tab agent session id + which thread this tab is showing. sessionStorage
// is tab-scoped and survives reload — exactly what "restore the last session on
// reload" needs, without two tabs clobbering each other.
const SESSION_KEY = "comfyui-mcp.panel.sessionId";
const CURRENT_THREAD_KEY = "comfyui-mcp.panel.currentThreadId";
function ssGet(key) {
  try {
    return window.sessionStorage.getItem(key) || null;
  } catch {
    return null;
  }
}
function ssSet(key, val) {
  try {
    if (val == null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, val);
  } catch {
    // sessionStorage unavailable — resume/restore degrade to off.
  }
}

// ---------------------------------------------------------------------------
// Model + effort picker. The orchestrator passes these to the Agent SDK
// (Options.model / Options.effort), so the panel can actually drive them now —
// model switches live, an effort change restarts the (resumed) session.
//
// The real catalog is NOT hardcoded: the orchestrator probes the SDK
// (query.supportedModels()) — the only model-enumeration that works on the
// subscription lane — and pushes a `models` frame with each model's
// `supportedEffortLevels`. The list below is only a fallback for when the
// probe hasn't answered yet (or failed).
// ---------------------------------------------------------------------------
const FALLBACK_MODELS = [
  { value: "opus", displayName: "Opus", description: "most capable", supportsEffort: true },
];
// Friendly copy for known effort ids; unknown ids fall back to a capitalized id.
const EFFORT_META = {
  low: { label: "Low", small: "quick" },
  medium: { label: "Medium", small: "default" },
  high: { label: "High", small: "thorough" },
  xhigh: { label: "Extra high", small: "deep" },
  max: { label: "Max", small: "exhaustive" },
};
const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** Normalize a ModelInfo list (or the fallback) to picker rows. `efforts`:
 *  an array of effort ids, or null when the model supports effort but didn't
 *  enumerate levels, or [] when it has no effort control. */
function normalizeModels(list) {
  return (Array.isArray(list) ? list : []).map((m) => {
    let efforts;
    if (Array.isArray(m.supportedEffortLevels)) efforts = m.supportedEffortLevels;
    else if (m.supportsEffort) efforts = null; // unknown → offer the standard set
    else efforts = []; // no effort control
    const desc = typeof m.description === "string" ? m.description : "";
    return {
      id: m.value,
      label: m.displayName || m.value,
      small: desc.length > 28 ? desc.slice(0, 27) + "…" : desc,
      efforts,
    };
  });
}
function effortMeta(id) {
  return EFFORT_META[id] ?? { label: id.charAt(0).toUpperCase() + id.slice(1), small: "" };
}

// Show the clean family aliases (Opus / Sonnet / Haiku): drop the synthetic
// "default", and drop pinned version ids (claude-*) that just duplicate an
// alias (e.g. claude-opus-4-8 vs the "opus" alias — same model). Falls back
// gracefully if that would empty the list.
function presentableModels(rows) {
  const aliases = rows.filter((r) => r.id !== "default" && !/^claude-/.test(r.id));
  if (aliases.length) return aliases;
  const noDefault = rows.filter((r) => r.id !== "default");
  return noDefault.length ? noDefault : rows;
}
// Pre-select Opus when the user hasn't chosen.
function pickDefaultModel(rows) {
  return (rows.find((r) => /opus/i.test(r.id)) ?? rows[0])?.id;
}
const PREFS_KEY = "comfyui-mcp.panel.prefs";
function loadPrefs() {
  try {
    const p = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? "{}");
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
}
function savePrefs(prefs) {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage unavailable — prefs are session-only.
  }
}
function modelLabel(catalog, id) {
  return catalog.find((m) => m.id === id)?.label ?? id ?? "Claude";
}

/** A readable auto name for grounding an unsaved workflow. */
function autoWorkflowName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `Untitled ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** If the open workflow was never saved to disk, save it (no dialog) so the
 *  agent works from a grounded file. Best-effort + feature-detected: if the
 *  workflow service shape differs, it no-ops rather than throwing. Returns the
 *  saved name, or null if nothing was saved. */
async function groundUnsavedWorkflow() {
  try {
    const svc = app?.extensionManager?.workflow;
    const wf = svc?.activeWorkflow;
    // isPersisted === false means "new workflow, never saved". Leave saved or
    // unknown-state workflows alone.
    if (!wf || wf.isPersisted !== false) return null;
    const name = autoWorkflowName();
    if (typeof svc.saveWorkflowAs === "function") {
      await svc.saveWorkflowAs(wf, { filename: name });
      return name;
    }
  } catch {
    // best-effort — never block the chat on a save hiccup
  }
  return null;
}

/** Call the BUILT-IN ComfyUI Manager v2 API (the same surface the "Extensions"
 *  UI uses via useComfyManagerService). Because the panel runs inside the
 *  frontend, api.fetchApi resolves the identical URL the UI hits — so this works
 *  against the bundled Desktop Manager without the MCP/cm-cli path. */
async function managerV2(route, { method = "GET", body } = {}) {
  const res = await api.fetchApi(`/v2/${route}`, {
    method,
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  if (!res || res.status === 404) {
    throw new Error("ComfyUI-Manager not reachable (is the built-in Manager enabled?)");
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.message) msg = j.message;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`Manager ${route}: ${msg}`);
  }
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

/** Build a ComfyUI /view URL for an output image descriptor. */
function imageViewUrl(img) {
  const qs = new URLSearchParams({
    filename: img.filename ?? "",
    subfolder: img.subfolder ?? "",
    type: img.type ?? "output",
  }).toString();
  const path = `/view?${qs}`;
  try {
    return typeof api?.apiURL === "function" ? api.apiURL(path) : path;
  } catch {
    return path;
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
  // app.canvas.graph is the graph the user is LOOKING at — the root graph or
  // an opened subgraph — so reads and edits target what's on screen.
  const graph = app?.canvas?.graph ?? app?.graph;
  const LG = window.LiteGraph ?? globalThis.LiteGraph;
  if (!app || !graph || !LG) {
    throw new Error("ComfyUI graph is not available (app.graph / LiteGraph missing)");
  }
  return { app, graph, rootGraph: app.graph, canvas: app.canvas, LG };
}

/** Where is the user looking right now — root graph or inside a subgraph? */
function describeActiveGraph(graph) {
  if (!app?.graph || graph === app.graph) return { scope: "root" };
  const owner = (app.graph._nodes ?? []).find((n) => n.subgraph === graph);
  return {
    scope: "subgraph",
    owner_node_id: owner?.id ?? null,
    title: owner?.title ?? graph?.name ?? "subgraph",
  };
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
  const summary = {
    id: node.id,
    type: node.type,
    title: node.title,
    widgets,
    inputs,
    outputs,
  };
  // Subgraphs summarize SHALLOWLY — boundary slots + widgets only, plus an
  // inner node count. Drill in with graph_get_subgraph when needed.
  if (node.subgraph) {
    summary.is_subgraph = true;
    summary.subgraph_node_count =
      node.subgraph._nodes?.length ?? node.subgraph.nodes?.length ?? 0;
  }
  return summary;
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
      viewing: describeActiveGraph(graph),
      node_count: graph._nodes?.length ?? 0,
      truncated: (graph._nodes?.length ?? 0) > MAX_STATE_NODES,
      nodes,
    };
  },

  graph_get_subgraph({ node_id }) {
    const { graph } = getGraphCtx();
    const node = resolveNode(graph, node_id);
    const sub = node.subgraph;
    if (!sub) throw new Error(`Node ${node.id} (${node.type}) is not a subgraph`);
    const inner = [...(sub._nodes ?? sub.nodes ?? [])];
    return {
      subgraph_of: { node_id: node.id, title: node.title },
      node_count: inner.length,
      truncated: inner.length > MAX_STATE_NODES,
      nodes: inner.slice(0, MAX_STATE_NODES).map(summarizeNode),
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

  graph_clear() {
    const { graph } = getGraphCtx();
    const nodes = [...(graph._nodes ?? [])];
    // Remove node-by-node inside ONE beforeChange/afterChange pair rather
    // than graph.clear(): the whole wipe becomes a single Ctrl+Z step.
    graph.beforeChange();
    try {
      for (const node of nodes) graph.remove(node);
    } finally {
      graph.afterChange();
    }
    graph.setDirtyCanvas(true, true);
    return { cleared: nodes.length };
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

  graph_move_node({ node_id, pos }) {
    const { graph } = getGraphCtx();
    const node = resolveNode(graph, node_id);
    if (!Array.isArray(pos) || pos.length !== 2) throw new Error("pos must be [x, y]");
    const previous = [node.pos[0], node.pos[1]];
    graph.beforeChange();
    try {
      node.pos = [Number(pos[0]), Number(pos[1])];
    } finally {
      graph.afterChange();
    }
    graph.setDirtyCanvas(true, true);
    return { moved: { node_id: node.id, from: previous, to: [node.pos[0], node.pos[1]] } };
  },

  graph_canvas({ action, node_id, dx, dy, scale }) {
    const { graph, canvas } = getGraphCtx();
    if (!canvas?.ds) throw new Error("Canvas is not available");
    const ds = canvas.ds;
    switch (action) {
      case "center_on_node": {
        const node = resolveNode(graph, node_id);
        if (typeof canvas.centerOnNode === "function") {
          canvas.centerOnNode(node);
        } else {
          ds.offset[0] =
            -node.pos[0] - (node.size?.[0] ?? 0) / 2 + canvas.canvas.width / ds.scale / 2;
          ds.offset[1] =
            -node.pos[1] - (node.size?.[1] ?? 0) / 2 + canvas.canvas.height / ds.scale / 2;
        }
        break;
      }
      case "fit": {
        const nodes = graph._nodes ?? [];
        if (!nodes.length) throw new Error("Graph is empty — nothing to fit");
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const n of nodes) {
          minX = Math.min(minX, n.pos[0]);
          minY = Math.min(minY, n.pos[1] - 30); // title bar renders above pos
          maxX = Math.max(maxX, n.pos[0] + (n.size?.[0] ?? 200));
          maxY = Math.max(maxY, n.pos[1] + (n.size?.[1] ?? 100));
        }
        const pad = 60;
        const el = canvas.canvas;
        const w = maxX - minX + pad * 2;
        const h = maxY - minY + pad * 2;
        const next = Math.min(el.width / w, el.height / h, 1.5);
        ds.scale = next;
        ds.offset[0] = -minX + pad + (el.width / next - w) / 2;
        ds.offset[1] = -minY + pad + (el.height / next - h) / 2;
        break;
      }
      case "pan":
        ds.offset[0] += Number(dx ?? 0);
        ds.offset[1] += Number(dy ?? 0);
        break;
      case "zoom": {
        const s = Number(scale);
        if (!(s > 0.05 && s <= 4)) throw new Error("scale must be in (0.05, 4]");
        ds.scale = s;
        break;
      }
      default:
        throw new Error(`Unknown canvas action "${action}"`);
    }
    canvas.setDirty(true, true);
    return {
      canvas: { action, scale: ds.scale, offset: [ds.offset[0], ds.offset[1]] },
    };
  },

  async graph_run({ batch_count }) {
    const { app } = getGraphCtx();
    if (typeof app.queuePrompt !== "function") {
      throw new Error("app.queuePrompt is unavailable on this frontend");
    }
    const batch = Number(batch_count ?? 1);
    await app.queuePrompt(0, batch);
    // queuePrompt swallows validation failures into lastNodeErrors.
    const nodeErrors =
      app.lastNodeErrors && Object.keys(app.lastNodeErrors).length ? app.lastNodeErrors : null;
    if (nodeErrors) return { queued: false, node_errors: nodeErrors };
    return { queued: true, batch_count: batch };
  },

  graph_get_errors() {
    const { app } = getGraphCtx();
    const nodeErrors =
      app.lastNodeErrors && Object.keys(app.lastNodeErrors).length ? app.lastNodeErrors : null;
    return {
      last_execution_error: lastExecutionError,
      node_errors: nodeErrors,
      ...(lastExecutionError || nodeErrors
        ? {}
        : { note: "no errors recorded since the last execution start" }),
    };
  },

  async workflow_save() {
    // Same path as Ctrl+S, including the save-as dialog for never-saved
    // workflows.
    const mgr = app?.extensionManager;
    if (!mgr?.command?.execute) {
      throw new Error("Save command unavailable on this frontend — use workflow_save_as with a name");
    }
    await mgr.command.execute("Comfy.SaveWorkflow");
    return { saved: true, workflow: getWorkflowTitle() };
  },

  async workflow_save_as({ name }) {
    if (!name || typeof name !== "string") throw new Error("name (string) is required");
    const { rootGraph } = getGraphCtx();
    const clean = name.replace(/\.json$/i, "");
    const data = rootGraph.serialize();
    const res = await api.fetchApi(
      `/userdata/${encodeURIComponent(`workflows/${clean}.json`)}?overwrite=true`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      },
    );
    if (res.status !== 200) throw new Error(`save failed: HTTP ${res.status}`);
    return { saved_as: `workflows/${clean}.json`, node_count: data.nodes?.length ?? 0 };
  },

  // --- Workflow tabs: new / list / open / switch / rename / close ----------
  // Uses ComfyUI's workflow service. "New workflow" opens a NEW TAB and never
  // touches the current graph (graph_clear is ONLY for clearing the open one).
  workflow_list() {
    const s = app?.extensionManager?.workflow;
    if (!s) throw new Error("workflow service unavailable on this frontend");
    const active = s.activeWorkflow;
    const brief = (w) => ({
      path: w.path,
      filename: w.filename,
      key: w.key,
      active: !!active && (w === active || w.key === active.key),
      modified: !!w.isModified,
      persisted: !!w.isPersisted,
    });
    return {
      active: active ? { path: active.path, filename: active.filename, key: active.key } : null,
      open: (s.openWorkflows ?? []).map(brief),
    };
  },

  async workflow_new() {
    const mgr = app?.extensionManager;
    if (!mgr?.command?.execute) throw new Error("command service unavailable");
    // Comfy.NewBlankWorkflow opens a fresh TAB — the current workflow is untouched.
    await mgr.command.execute("Comfy.NewBlankWorkflow");
    return { created: true, active: getWorkflowTitle() };
  },

  async workflow_open({ path }) {
    const s = app?.extensionManager?.workflow;
    if (!s?.openWorkflow) throw new Error("workflow service unavailable");
    const all = [...(s.openWorkflows ?? []), ...(s.workflows ?? [])];
    const target =
      (typeof s.getWorkflowByPath === "function" && path && s.getWorkflowByPath(path)) ||
      all.find(
        (w) =>
          w &&
          (w.path === path ||
            w.filename === path ||
            w.key === path ||
            (w.filename && w.filename.replace(/\.json$/i, "") === path)),
      );
    if (!target) throw new Error(`no workflow matching "${path}" — call workflow_list first`);
    await s.openWorkflow(target);
    return { opened: { path: target.path, filename: target.filename } };
  },

  async workflow_rename({ name, path }) {
    const s = app?.extensionManager?.workflow;
    if (!s?.renameWorkflow) throw new Error("rename unavailable on this frontend");
    if (!name) throw new Error("name is required");
    const all = [...(s.openWorkflows ?? []), ...(s.workflows ?? [])];
    const target = path
      ? all.find((w) => w && (w.path === path || w.filename === path || w.key === path))
      : s.activeWorkflow;
    if (!target) throw new Error("no target workflow");
    const clean = name.replace(/\.json$/i, "");
    const slash = target.path ? target.path.lastIndexOf("/") : -1;
    const dir = slash >= 0 ? target.path.slice(0, slash + 1) : "workflows/";
    await s.renameWorkflow(target, `${dir}${clean}.json`);
    return { renamed: { to: `${clean}.json` } };
  },

  async workflow_close({ path, force }) {
    const s = app?.extensionManager?.workflow;
    if (!s?.closeWorkflow) throw new Error("close unavailable on this frontend");
    const target = path
      ? (s.openWorkflows ?? []).find(
          (w) => w && (w.path === path || w.filename === path || w.key === path),
        )
      : s.activeWorkflow;
    if (!target) throw new Error("no target workflow");
    // Guard against data loss: don't silently close a workflow with unsaved
    // changes (closeWorkflow bypasses the UI's save prompt). Save first.
    if (target.isModified && !force) {
      throw new Error(
        `"${target.filename || target.path}" has unsaved changes — save it first (panel_save_workflow) before closing, or pass force:true to discard.`,
      );
    }
    await s.closeWorkflow(target);
    return { closed: { path: target.path } };
  },

  // --- Subgraphs: select nodes + group into a subgraph ---------------------
  graph_select_nodes({ node_ids }) {
    const { graph, canvas } = getGraphCtx();
    if (!canvas) throw new Error("canvas unavailable");
    const ns = (Array.isArray(node_ids) ? node_ids : [])
      .map((id) => graph.getNodeById(Number(id)))
      .filter(Boolean);
    if (!ns.length) throw new Error("no matching nodes to select");
    if (typeof canvas.selectItems === "function") canvas.selectItems(ns);
    else if (typeof canvas.selectNodes === "function") canvas.selectNodes(ns);
    else throw new Error("selection API unavailable");
    canvas.setDirty?.(true, true);
    return { selected: ns.map((n) => n.id) };
  },

  graph_create_subgraph({ node_ids }) {
    const { graph, canvas } = getGraphCtx();
    if (typeof graph.convertToSubgraph !== "function") {
      throw new Error("convertToSubgraph unavailable on this frontend");
    }
    const ns = (Array.isArray(node_ids) ? node_ids : [])
      .map((id) => graph.getNodeById(Number(id)))
      .filter(Boolean);
    if (!ns.length) throw new Error("provide node_ids to group into a subgraph");
    if (typeof canvas.selectItems === "function") canvas.selectItems(ns);
    else if (typeof canvas.selectNodes === "function") canvas.selectNodes(ns);
    graph.beforeChange?.();
    let res;
    try {
      res = graph.convertToSubgraph(canvas.selectedItems);
    } finally {
      graph.afterChange?.();
    }
    graph.setDirtyCanvas?.(true, true);
    return {
      subgraph: {
        node_id: res?.node?.id ?? null,
        name: res?.subgraph?.name ?? null,
        from_nodes: ns.map((n) => n.id),
      },
    };
  },

  // --- Custom-node management via the BUILT-IN ComfyUI Manager (/v2 API) ----
  async nodes_search({ query, limit }) {
    const data = await managerV2("customnode/getmappings?mode=cache");
    const q = String(query ?? "").toLowerCase();
    const out = [];
    const push = (id, title, desc) => {
      if (!id) return;
      const hay = `${id} ${title ?? ""} ${desc ?? ""}`.toLowerCase();
      if (!q || hay.includes(q)) {
        out.push({ id, title: title ?? id, description: String(desc ?? "").slice(0, 160) });
      }
    };
    if (Array.isArray(data)) {
      for (const p of data) push(p.id ?? p.reference ?? p.title, p.title, p.description);
    } else if (data && typeof data === "object") {
      // getmappings is keyed by repo/url → [ [classNames…], { title, description, … } ]
      for (const [key, val] of Object.entries(data)) {
        const meta = Array.isArray(val) ? val[1] : val;
        push(meta?.id ?? meta?.title ?? key, meta?.title, meta?.description);
      }
    }
    const max = Math.min(Number(limit) || 15, 40);
    return { count: out.length, results: out.slice(0, max) };
  },

  async nodes_list() {
    return { installed: await managerV2("customnode/installed") };
  },

  async nodes_install({ id, version, repository, channel, mode, selected_version }) {
    if (!id && !repository) {
      throw new Error("id (registry id or author/repo) or repository (git URL) is required");
    }
    const sel = selected_version || version || (repository ? "nightly" : "latest");
    const params = {
      id: id ?? repository,
      version: version || (sel === "nightly" ? "nightly" : "latest"),
      selected_version: sel,
      ...(repository ? { repository } : {}),
      mode: mode || "remote",
      channel: channel || "default",
    };
    const ui_id = crypto.randomUUID();
    const client_id = api.clientId ?? api.initialClientId ?? "comfyui-mcp-panel";
    await managerV2("manager/queue/task", {
      method: "POST",
      body: { kind: "install", params, ui_id, client_id },
    });
    await managerV2("manager/queue/start", { method: "POST" });
    return {
      queued: true,
      ui_id,
      id: params.id,
      note: "Install queued. Poll nodes_queue_status; a ComfyUI restart (comfy_reboot) is usually required to load new nodes.",
    };
  },

  async nodes_queue_status() {
    return { status: await managerV2("manager/queue/status") };
  },

  async comfy_reboot() {
    // Restart the ComfyUI server (to load newly installed nodes). ComfyUI and the
    // orchestrator go down briefly; the panel auto-reconnects + resumes after.
    await managerV2("manager/reboot", { method: "POST" });
    return { rebooting: true };
  },
};

// ---------------------------------------------------------------------------
// Bridge client: WS connection to the comfyui-mcp server with auto-reconnect.
// ---------------------------------------------------------------------------

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

function createBridgeClient({ onStatus, onSay, onLog, onCommand, onAgentStatus, onSession, onModels, getResume }) {
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

    sock.addEventListener("message", async (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      if (msg && typeof msg.rid === "string" && typeof msg.cmd === "string") {
        // Agent command — execute against the graph, reply with the rid.
        // Executors may be async (run, save) — await uniformly.
        let reply;
        try {
          const executor = GRAPH_TOOL_EXECUTORS[msg.cmd];
          if (!executor) throw new Error(`Unknown command "${msg.cmd}"`);
          reply = { rid: msg.rid, ok: true, result: await executor(msg) };
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
      // Optional agent-side status (context window fill, model name).
      if (msg && msg.type === "agent_status") {
        onAgentStatus?.(msg);
      }
      // Session lifecycle: the orchestrator reports the SDK session id (or null
      // on a reset) so the panel can persist it and resume across reloads.
      if (msg && msg.type === "session") {
        onSession?.(typeof msg.session_id === "string" ? msg.session_id : null);
      }
      // Live model catalog from the orchestrator (SDK-probed).
      if (msg && msg.type === "models" && Array.isArray(msg.models)) {
        onModels?.(msg.models, typeof msg.current === "string" ? msg.current : undefined);
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
      // Carry the last session id so the orchestrator resumes the agent's
      // memory after a panel reload (only honored before the tab's agent spawns).
      const resume = getResume?.();
      sock.send(
        JSON.stringify({
          type: "hello",
          tab_id: getTabId(),
          title: getWorkflowTitle(),
          ...(resume ? { resume } : {}),
        }),
      );
    } catch {
      // Reconnect path will retry.
    }
  }

  // When the workflow title changes (rename / open a different file / progress
  // ticks during a run / each graph edit toggling the modified "*"), send a
  // LIGHTWEIGHT title update — NOT a full hello. A full hello re-greets the user
  // ("agent ready"), so re-helloing on every title mutation during a build/run
  // produced a greeting storm. Deduped so identical titles don't spam.
  const titleEl = document.querySelector("title");
  let lastSentTitle = null;
  function sendTitle() {
    if (!sock || sock.readyState !== WebSocket.OPEN) return;
    const t = getWorkflowTitle();
    if (t === lastSentTitle) return;
    lastSentTitle = t;
    try {
      sock.send(JSON.stringify({ type: "title", tab_id: getTabId(), title: t }));
    } catch {
      // dropped — next mutation retries
    }
  }
  const titleObserver = titleEl ? new MutationObserver(() => sendTitle()) : null;
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
    sendUserMessage(text, context) {
      if (!sock || sock.readyState !== WebSocket.OPEN) return false;
      try {
        sock.send(
          JSON.stringify({ type: "user_message", text, ...(context ? { context } : {}) }),
        );
        return true;
      } catch {
        return false;
      }
    },
    /** Send an arbitrary control frame (set_options, new_session, …). */
    sendFrame(frame) {
      if (!sock || sock.readyState !== WebSocket.OPEN) return false;
      try {
        sock.send(JSON.stringify({ tab_id: getTabId(), ...frame }));
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
    isConnected() {
      return !!sock && sock.readyState === WebSocket.OPEN;
    },
    stop() {
      // Close the socket and stop reconnecting, but stay re-startable (unlike
      // destroy, which also tears down the title observer for good).
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
  display: flex; flex-direction: column; height: 100%; min-height: 0;
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

/* Middle section: bounded flex body whose only job is to host the scroll
   surface, so the header and composer stay pinned. */
.cmcp-body {
  flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column;
  overflow: hidden;
}
.cmcp-log {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0.75rem;
  display: flex; flex-direction: column; gap: 0.5rem;
}
.cmcp-empty {
  margin: auto; text-align: center; max-width: 230px;
  color: var(--p-text-muted-color, #a1a1aa);
}
.cmcp-empty .pi { font-size: 1.75rem; display: block; margin-bottom: 0.5rem; opacity: 0.5; }
.cmcp-empty-title { font-weight: 600; color: var(--p-text-color, #fff); margin-bottom: 0.25rem; }
.cmcp-examples { display: flex; flex-direction: column; gap: 0.375rem; margin-top: 0.875rem; text-align: left; }
.cmcp-example {
  display: flex; align-items: center; gap: 0.5rem; width: 100%; box-sizing: border-box;
  padding: 0.4375rem 0.625rem; cursor: pointer; font: inherit; font-size: 0.75rem;
  color: var(--p-text-color, #fff); text-align: left;
  background: var(--p-surface-800, #27272a);
  border: 1px solid var(--p-content-border-color, #3f3f46);
  border-radius: var(--p-border-radius-md, 6px);
  transition: border-color 0.15s, background 0.15s;
}
.cmcp-example:hover { border-color: var(--p-primary-color, #60a5fa); background: var(--p-surface-700, #3f3f46); }
.cmcp-example .pi { font-size: 0.8125rem; margin: 0; opacity: 1; color: var(--p-primary-color, #60a5fa); flex: none; }

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
/* Agent text flows freely — no card/bubble. Only user messages are boxed. */
.cmcp-bubble.agent {
  align-self: stretch; max-width: 100%;
  padding: 0; background: none; border: none; border-radius: 0;
}
.cmcp-bubble.agent code, .cmcp-bubble.user code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.75rem;
  background: var(--p-form-field-background, #09090b);
  padding: 0.0625rem 0.25rem; border-radius: var(--p-border-radius-sm, 4px);
}
/* GFM rendering (marked output) inside bubbles. */
.cmcp-bubble > :first-child { margin-top: 0; }
.cmcp-bubble > :last-child { margin-bottom: 0; }
.cmcp-bubble p { margin: 0 0 0.5rem; }
.cmcp-bubble ul, .cmcp-bubble ol { margin: 0 0 0.5rem; padding-left: 1.25rem; }
.cmcp-bubble li { margin: 0.125rem 0; }
.cmcp-bubble li > p { margin: 0; }
.cmcp-bubble h1, .cmcp-bubble h2, .cmcp-bubble h3,
.cmcp-bubble h4, .cmcp-bubble h5, .cmcp-bubble h6 {
  margin: 0.625rem 0 0.25rem; font-weight: 600; line-height: 1.3;
}
.cmcp-bubble h1 { font-size: 1.05rem; }
.cmcp-bubble h2 { font-size: 1rem; }
.cmcp-bubble h3 { font-size: 0.9375rem; }
.cmcp-bubble h4, .cmcp-bubble h5, .cmcp-bubble h6 { font-size: 0.875rem; }
.cmcp-bubble a { color: var(--p-primary-color, #60a5fa); text-decoration: underline; }
.cmcp-bubble blockquote {
  margin: 0.5rem 0; padding: 0.125rem 0 0.125rem 0.75rem;
  border-left: 3px solid var(--p-content-border-color, #3f3f46);
  color: var(--p-text-muted-color, #a1a1aa);
}
.cmcp-bubble hr { border: none; border-top: 1px solid var(--p-content-border-color, #3f3f46); margin: 0.75rem 0; }
.cmcp-bubble img { max-width: 100%; border-radius: var(--p-border-radius-md, 6px); }
.cmcp-bubble pre {
  margin: 0.375rem 0; padding: 0.5rem 0.625rem;
  background: var(--p-form-field-background, #09090b);
  border: 1px solid var(--p-content-border-color, #3f3f46);
  border-radius: var(--p-border-radius-md, 6px);
  overflow-x: auto; max-height: 20rem; overflow-y: auto;
  font-size: 0.6875rem; line-height: 1.5; tab-size: 2;
}
.cmcp-bubble.agent pre code, .cmcp-bubble.user pre code {
  background: none; padding: 0; border-radius: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre; color: var(--p-text-color, #fff);
}
.cmcp-bubble table {
  display: block; width: 100%; overflow-x: auto;
  border-collapse: collapse; margin: 0.5rem 0; font-size: 0.6875rem;
}
.cmcp-bubble th, .cmcp-bubble td {
  border: 1px solid var(--p-content-border-color, #3f3f46);
  padding: 0.25rem 0.5rem; text-align: left;
}
.cmcp-bubble th { background: var(--p-surface-800, #27272a); font-weight: 600; }
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

.cmcp-thinking {
  align-self: flex-start; display: flex; align-items: center; gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: var(--p-surface-800, #27272a);
  border: 1px solid var(--p-content-border-color, #3f3f46);
  border-radius: var(--p-border-radius-lg, 8px);
  color: var(--p-text-muted-color, #a1a1aa); font-size: 0.75rem;
  animation: cmcp-in 0.18s ease-out;
}
.cmcp-thinking-dots { display: inline-flex; gap: 3px; }
.cmcp-thinking-dots span {
  width: 5px; height: 5px; border-radius: 50%;
  background: var(--p-primary-color, #60a5fa);
  animation: cmcp-dotbounce 1.2s ease-in-out infinite;
}
.cmcp-thinking-dots span:nth-child(2) { animation-delay: 0.15s; }
.cmcp-thinking-dots span:nth-child(3) { animation-delay: 0.3s; }
@keyframes cmcp-dotbounce {
  0%, 60%, 100% { opacity: 0.25; transform: translateY(0); }
  30% { opacity: 1; transform: translateY(-3px); }
}

.cmcp-composer {
  position: relative; margin: 0.625rem 0.75rem 0.75rem; flex: none;
  display: flex; flex-direction: column;
  background: var(--p-form-field-background, #09090b);
  border: 1px solid var(--p-form-field-border-color, #52525b);
  border-radius: var(--p-border-radius-xl, 12px);
  transition: border-color 0.15s;
}
.cmcp-composer:focus-within { border-color: var(--p-focus-ring-color, #60a5fa); }
.cmcp-composer-input {
  width: 100%; box-sizing: border-box; resize: none; border: none; outline: none;
  background: transparent; color: var(--p-form-field-color, #fff);
  font: inherit; padding: 0.625rem 0.75rem 0.25rem;
  min-height: 2.25rem; max-height: 7.5rem;
}
.cmcp-composer-row { display: flex; align-items: center; gap: 0.25rem; padding: 0.25rem 0.5rem 0.5rem; }
.cmcp-spacer { flex: 1; }
.cmcp-iconbtn {
  width: 1.75rem; height: 1.75rem; flex: none;
  display: flex; align-items: center; justify-content: center;
  background: transparent; border: none; cursor: pointer;
  border-radius: var(--p-border-radius-sm, 4px);
  color: var(--p-text-muted-color, #a1a1aa);
  transition: background 0.15s, color 0.15s;
}
.cmcp-iconbtn:hover { background: var(--p-surface-700, #3f3f46); color: var(--p-text-color, #fff); }
.cmcp-iconbtn:disabled { opacity: 0.35; cursor: default; }
.cmcp-iconbtn.active { color: var(--p-red-400, #f87171); }
.cmcp-iconbtn .pi { font-size: 0.875rem; }
.cmcp-chip {
  display: flex; align-items: center; gap: 0.25rem;
  border: none; background: transparent; cursor: pointer;
  color: var(--p-text-muted-color, #a1a1aa); font: inherit; font-size: 0.6875rem;
  padding: 0.125rem 0.375rem; border-radius: var(--p-border-radius-sm, 4px);
}
.cmcp-chip:hover { background: var(--p-surface-700, #3f3f46); }
.cmcp-ctx { font-size: 0.625rem; color: var(--p-text-muted-color, #a1a1aa); min-width: 1.75rem; }
.cmcp-ring { flex: none; margin: 0 0.125rem; transform: rotate(-90deg); }
.cmcp-ring .bg { stroke: var(--p-surface-600, #52525b); }
.cmcp-ring .fg { stroke: var(--p-primary-color, #60a5fa); transition: stroke-dashoffset 0.3s; }
.cmcp-popover {
  position: absolute; bottom: calc(100% + 6px); left: 0; right: 0; z-index: 40;
  background: var(--p-surface-800, #27272a);
  border: 1px solid var(--p-content-border-color, #3f3f46);
  border-radius: var(--p-border-radius-lg, 8px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  max-height: 14rem; overflow-y: auto; padding: 0.25rem;
}
.cmcp-popover--down { bottom: auto; top: calc(100% + 4px); left: 0.5rem; right: 0.5rem; }
.cmcp-popover-item {
  display: flex; align-items: center; gap: 0.5rem; width: 100%; box-sizing: border-box;
  padding: 0.375rem 0.5rem; border: none; background: transparent; cursor: pointer;
  text-align: left; color: var(--p-text-color, #fff); font: inherit; font-size: 0.75rem;
  border-radius: var(--p-border-radius-sm, 4px);
}
.cmcp-popover-item.sel, .cmcp-popover-item:hover { background: var(--p-surface-700, #3f3f46); }
.cmcp-popover-item .pi { font-size: 0.75rem; color: var(--p-text-muted-color, #a1a1aa); flex: none; }
.cmcp-popover-item small { margin-left: auto; color: var(--p-text-muted-color, #a1a1aa); flex: none; padding-left: 0.5rem; }
.cmcp-popover-item .lbl { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cmcp-status-btn {
  display: inline-flex; align-items: center; gap: 0.3125rem;
  background: none; border: none; cursor: pointer; font: inherit; color: inherit;
  padding: 0.125rem 0.375rem; border-radius: var(--p-border-radius-sm, 4px);
}
.cmcp-status-btn:hover { background: var(--p-surface-800, #27272a); }
.cmcp-status-btn .pi { color: var(--p-text-muted-color, #a1a1aa); }
.cmcp-conn-pop { padding: 0.625rem; max-height: none; }

/* History rows: open button + trash, revealed on hover. */
.cmcp-hist-row { display: flex; align-items: stretch; gap: 0.125rem; }
.cmcp-hist-row .cmcp-hist-open { flex: 1 1 auto; min-width: 0; }
.cmcp-hist-del {
  flex: none; width: 1.75rem; border: none; background: transparent; cursor: pointer;
  color: var(--p-text-muted-color, #a1a1aa); border-radius: var(--p-border-radius-sm, 4px);
  opacity: 0; transition: opacity 0.12s, background 0.12s, color 0.12s;
}
.cmcp-hist-row:hover .cmcp-hist-del { opacity: 1; }
.cmcp-hist-del:hover { background: var(--p-surface-700, #3f3f46); color: var(--p-red-400, #f87171); }
.cmcp-hist-del .pi { font-size: 0.75rem; }

/* Model/effort picker popover (anchored above the composer). */
.cmcp-pop-section { padding: 0.25rem 0.5rem 0.125rem; font-size: 0.625rem; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.04em; color: var(--p-text-muted-color, #a1a1aa); }
.cmcp-pop-section:not(:first-child) { margin-top: 0.25rem; border-top: 1px solid var(--p-content-border-color, #3f3f46); padding-top: 0.375rem; }
.cmcp-popover-item .check { flex: none; width: 1rem; text-align: center; margin-left: 0.375rem; color: var(--p-primary-color, #60a5fa); visibility: hidden; }
.cmcp-popover-item .check.on { visibility: visible; }
.cmcp-chip .pi-angle-down { font-size: 0.5625rem; opacity: 0.7; }
.cmcp-chip .dim { opacity: 0.65; }
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
    case "graph_clear":
      return {
        icon: "pi-eraser",
        text: `Cleared canvas — removed ${r.cleared} node${r.cleared === 1 ? "" : "s"} (one Ctrl+Z restores all)`,
      };
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
    case "graph_get_subgraph":
      return {
        icon: "pi-sitemap",
        text: `Read subgraph “${r.subgraph_of?.title}” — ${r.node_count} node${r.node_count === 1 ? "" : "s"}`,
      };
    case "graph_move_node":
      return { icon: "pi-arrows-alt", text: `Moved node ${r.moved?.node_id} to [${r.moved?.to?.map(Math.round)}]` };
    case "graph_canvas":
      return { icon: "pi-window-maximize", text: `Canvas: ${r.canvas?.action?.replace(/_/g, " ")}` };
    case "graph_run":
      return r.queued
        ? { icon: "pi-play", text: `Queued workflow${r.batch_count > 1 ? ` ×${r.batch_count}` : ""}` }
        : {
            icon: "pi-exclamation-triangle",
            text: "Run blocked by node errors",
            detail: JSON.stringify(r.node_errors).slice(0, 300),
          };
    case "graph_get_errors":
      return {
        icon: "pi-info-circle",
        text: r.node_errors || r.last_execution_error ? "Read execution errors" : "Checked errors — none",
      };
    case "workflow_save":
      return { icon: "pi-save", text: `Saved “${r.workflow}”` };
    case "workflow_save_as":
      return { icon: "pi-save", text: `Saved as ${r.saved_as}` };
    default:
      return { icon: "pi-bolt", text: cmd, detail: JSON.stringify(r).slice(0, 300) };
  }
}

// GitHub-flavored markdown, single-newline line breaks.
marked.setOptions({ gfm: true, breaks: true });

/** Render agent markdown (full GFM) via marked, sanitized with DOMPurify so
 *  agent output can never inject script/handlers into the panel. */
function renderRichText(el, text) {
  el.innerHTML = DOMPurify.sanitize(marked.parse(String(text)));
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
  const status = document.createElement("button");
  status.type = "button";
  status.className = "cmcp-status cmcp-status-btn";
  status.title = "Connection";
  const dot = document.createElement("span");
  dot.className = "cmcp-dot";
  const statusText = document.createElement("span");
  statusText.textContent = "disconnected";
  const caret = document.createElement("i");
  caret.className = "pi pi-angle-down";
  caret.style.fontSize = "0.625rem";
  status.append(dot, statusText, caret);

  function iconBtn(icon, titleText) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cmcp-iconbtn";
    b.title = titleText;
    const i = document.createElement("i");
    i.className = `pi ${icon}`;
    b.appendChild(i);
    return b;
  }

  const actions = document.createElement("span");
  actions.style.cssText = "margin-left:auto;display:flex;gap:0.125rem;align-items:center;";
  const newChatBtn = iconBtn("pi-plus", "New chat");
  const historyBtn = iconBtn("pi-history", "Chat history");
  actions.append(newChatBtn, historyBtn);

  header.style.position = "relative";
  const histPop = document.createElement("div");
  histPop.className = "cmcp-popover cmcp-popover--down";
  histPop.hidden = true;
  header.append(title, actions, status, histPop);
  root.appendChild(header);

  // ---- Connection settings ----
  const settingsBox = document.createElement("div");
  settingsBox.className = "cmcp-popover cmcp-popover--down cmcp-conn-pop";
  settingsBox.hidden = true;
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

  // Primary action: starts the background agent on demand (via ComfyUI's own
  // server) and connects. Nothing is ever spawned without this click.
  const connectBtn = document.createElement("button");
  connectBtn.className = "cmcp-btn";
  connectBtn.type = "button";
  connectBtn.textContent = "Connect";
  connectBtn.style.cssText =
    "background:var(--p-primary-color,#2563eb);color:var(--p-primary-contrast-color,#fff);border-color:transparent;";

  const disconnectBtn = document.createElement("button");
  disconnectBtn.className = "cmcp-btn";
  disconnectBtn.type = "button";
  disconnectBtn.textContent = "Disconnect";
  disconnectBtn.hidden = true;

  const saveBtn = document.createElement("button");
  saveBtn.className = "cmcp-btn";
  saveBtn.type = "button";
  saveBtn.textContent = "Reconnect";
  saveBtn.title = "Re-open the bridge connection at the URL above";
  saveBtn.style.opacity = "0.8";

  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:0.375rem;align-items:center;flex-wrap:wrap;";
  btnRow.append(connectBtn, disconnectBtn, saveBtn);

  const helpDiv = document.createElement("div");
  helpDiv.className = "cmcp-help";
  helpDiv.textContent =
    "Click Connect to start an autonomous agent on your Claude subscription — no API keys. Sign in to Claude once (run `claude`) first. Prefer to run it yourself? Start the orchestrator, then Connect:";
  const helpCmd = document.createElement("code");
  helpCmd.className = "cmcp-cmd";
  helpCmd.textContent = "npx -y comfyui-mcp --panel-orchestrator";
  helpCmd.title = "Click to copy";
  helpCmd.addEventListener("click", () => {
    navigator.clipboard?.writeText(helpCmd.textContent).then(
      () => appendSystem("Command copied."),
      () => {},
    );
  });
  helpDiv.appendChild(helpCmd);

  settingsBody.append(urlLabel, urlInput, btnRow, helpDiv);
  settingsBox.appendChild(settingsBody);
  // Lives in the header as a dropdown anchored under the status pill.
  header.appendChild(settingsBox);
  status.addEventListener("click", (e) => {
    e.stopPropagation();
    histPop.hidden = true;
    settingsBox.hidden = !settingsBox.hidden;
  });

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
    "Build and edit the live graph, generate images & audio, run the workflow and read its errors, or find models on Civitai — every graph edit undoes with Ctrl+Z.";
  empty.append(emptyIcon, emptyTitle, emptyBody);

  // Example prompts surface the agent's newer capabilities and prefill the
  // composer on click. `input` is assigned later in this closure; the click
  // handlers run long after, so referencing it is safe.
  const EXAMPLES = [
    { icon: "pi-volume-up", text: "Generate a 30s lofi piano track" },
    { icon: "pi-sliders-h", text: "Build a Flux txt2img graph and run it" },
    { icon: "pi-exclamation-triangle", text: "Run the workflow and tell me if it errors" },
    { icon: "pi-search", text: "Find a good Flux LoRA on Civitai and add it" },
  ];
  const examplesBox = document.createElement("div");
  examplesBox.className = "cmcp-examples";
  for (const ex of EXAMPLES) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "cmcp-example";
    const i = document.createElement("i");
    i.className = `pi ${ex.icon}`;
    const t = document.createElement("span");
    t.textContent = ex.text;
    chip.append(i, t);
    chip.addEventListener("click", () => {
      input.value = ex.text;
      input.focus();
      input.dispatchEvent(new Event("input"));
    });
    examplesBox.appendChild(chip);
  }
  empty.appendChild(examplesBox);
  log.appendChild(empty);
  const body = document.createElement("div");
  body.className = "cmcp-body";
  body.appendChild(log);
  root.appendChild(body);

  function clearEmpty() {
    if (empty.parentElement) empty.remove();
  }

  // ---- Composer ----
  const form = document.createElement("form");
  form.className = "cmcp-composer";

  const menuPop = document.createElement("div");
  menuPop.className = "cmcp-popover";
  menuPop.hidden = true;

  const input = document.createElement("textarea");
  input.className = "cmcp-composer-input";
  input.placeholder = "Ask Claude… / for commands, @ for context";
  input.rows = 1;

  const row = document.createElement("div");
  row.className = "cmcp-composer-row";

  // Context-window ring. Claude Code does not expose its context usage to
  // MCP servers, so this stays empty until an `agent_status` frame reports
  // a context_pct — the plumbing is live, the data source is future work.
  const SVG_NS = "http://www.w3.org/2000/svg";
  const RING_R = 7;
  const RING_C = 2 * Math.PI * RING_R;
  const ring = document.createElementNS(SVG_NS, "svg");
  ring.setAttribute("class", "cmcp-ring");
  ring.setAttribute("width", "18");
  ring.setAttribute("height", "18");
  ring.setAttribute("viewBox", "0 0 18 18");
  for (const cls of ["bg", "fg"]) {
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("class", cls);
    c.setAttribute("cx", "9");
    c.setAttribute("cy", "9");
    c.setAttribute("r", String(RING_R));
    c.setAttribute("fill", "none");
    c.setAttribute("stroke-width", "2");
    if (cls === "bg") c.setAttribute("opacity", "0.35");
    if (cls === "fg") {
      c.setAttribute("stroke-dasharray", String(RING_C));
      c.setAttribute("stroke-dashoffset", String(RING_C));
      c.setAttribute("stroke-linecap", "round");
    }
    ring.appendChild(c);
  }
  const ringTitle = document.createElementNS(SVG_NS, "title");
  ringTitle.textContent = "Context window — fills as Claude reports usage";
  ring.appendChild(ringTitle);
  // Compact context-usage readout shown right after the ring.
  const ctxLabel = document.createElement("span");
  ctxLabel.className = "cmcp-ctx";
  ctxLabel.title = "Context window used";
  const CTX_KEY = "comfyui-mcp.panel.ctxPct";
  ctxLabel.textContent = "—"; // until the first usage report

  function setContextPct(p) {
    const clamped = Math.max(0, Math.min(1, p > 1 ? p / 100 : p));
    ring.querySelector(".fg").setAttribute("stroke-dashoffset", String(RING_C * (1 - clamped)));
    const pct = Math.round(clamped * 100);
    ringTitle.textContent = `Context window ~${pct}% used`;
    ctxLabel.textContent = clamped > 0 ? `${pct}%` : "—";
  }
  // Restore last % across reloads (orchestrator also re-pushes on connect).
  {
    const p0 = Number(ssGet(CTX_KEY));
    if (p0 > 0) setContextPct(p0);
  }

  // Model + effort picker. The orchestrator forwards these to the Agent SDK,
  // so the chip actually drives the background agent (model live, effort on a
  // resumed restart). The catalog arrives live via the `models` frame; until
  // then it's the small fallback. Selection persists in localStorage and is
  // re-sent on connect so a freshly-spawned agent adopts it.
  const prefs = loadPrefs();
  if (prefs.model === "default") prefs.model = undefined; // migrate old saved value
  let modelCatalog = presentableModels(normalizeModels(FALLBACK_MODELS));
  if (!prefs.model) prefs.model = pickDefaultModel(modelCatalog);

  /** The effort ids offered for the currently-selected model. */
  function effortsForModel(id) {
    const row = modelCatalog.find((m) => m.id === id);
    if (!row) return ALL_EFFORTS;
    if (row.efforts === null) return ALL_EFFORTS; // supports effort, levels unknown
    return row.efforts; // explicit list (possibly empty = no effort control)
  }

  const modelChip = document.createElement("button");
  modelChip.type = "button";
  modelChip.className = "cmcp-chip";
  modelChip.title = "Model & reasoning effort for the background agent";
  const modelChipLabel = document.createElement("span");
  const modelChipEffort = document.createElement("span");
  modelChipEffort.className = "dim";
  const modelChipCaret = document.createElement("i");
  modelChipCaret.className = "pi pi-angle-down";
  modelChip.append(modelChipLabel, modelChipEffort, modelChipCaret);

  function refreshModelChip() {
    modelChipLabel.textContent = modelLabel(modelCatalog, prefs.model);
    modelChipEffort.textContent = prefs.effort ? ` · ${prefs.effort}` : "";
  }
  refreshModelChip();

  const modelPop = document.createElement("div");
  modelPop.className = "cmcp-popover";
  modelPop.hidden = true;

  function buildModelPop() {
    modelPop.textContent = "";
    const section = (label) => {
      const h = document.createElement("div");
      h.className = "cmcp-pop-section";
      h.textContent = label;
      modelPop.appendChild(h);
    };
    const item = ({ label, small }, selected, onPick) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "cmcp-popover-item" + (selected ? " sel" : "");
      const lbl = document.createElement("span");
      lbl.className = "lbl";
      lbl.textContent = label;
      el.appendChild(lbl);
      if (small) {
        const s = document.createElement("small");
        s.textContent = small;
        el.appendChild(s);
      }
      // Always render the check (visibility toggled) so the column is reserved
      // and rows don't reflow when the selection changes.
      const c = document.createElement("i");
      c.className = "pi pi-check check" + (selected ? " on" : "");
      el.appendChild(c);
      el.addEventListener("mousedown", (mev) => {
        mev.preventDefault();
        onPick();
      });
      modelPop.appendChild(el);
    };

    section("Model");
    for (const m of modelCatalog) {
      item({ label: m.label, small: m.small }, m.id === prefs.model, () => {
        prefs.model = m.id;
        prefs.userSet = true;
        // Drop an effort the new model can't do.
        const avail = effortsForModel(m.id);
        if (prefs.effort && !avail.includes(prefs.effort)) prefs.effort = undefined;
        savePrefs(prefs);
        refreshModelChip();
        modelPop.hidden = true;
        client?.sendFrame?.({ type: "set_options", model: m.id, effort: prefs.effort ?? null });
        appendSystem(`Model → ${m.label}.`);
      });
    }

    const efforts = effortsForModel(prefs.model);
    if (efforts.length) {
      section("Effort");
      for (const id of efforts) {
        const meta = effortMeta(id);
        item(meta, id === prefs.effort, () => {
          prefs.effort = id;
          prefs.userSet = true;
          savePrefs(prefs);
          refreshModelChip();
          modelPop.hidden = true;
          client?.sendFrame?.({ type: "set_options", effort: id });
          appendSystem(`Effort → ${meta.label}. Continuing this chat at the new effort…`);
        });
      }
    }
  }

  /** Replace the catalog when the orchestrator reports the real model list. */
  function applyModelCatalog(list) {
    const next = presentableModels(normalizeModels(list));
    if (!next.length) return;
    modelCatalog = next;
    // Keep the user's saved pick if still valid; else pre-select Opus.
    if (!modelCatalog.some((m) => m.id === prefs.model)) {
      prefs.model = pickDefaultModel(modelCatalog);
    }
    if (prefs.effort && !effortsForModel(prefs.model).includes(prefs.effort)) {
      prefs.effort = undefined;
    }
    savePrefs(prefs);
    refreshModelChip();
    if (!modelPop.hidden) buildModelPop();
    // Now that the catalog is live, prefs.model is a REAL id — safe to push the
    // user's saved pick so a freshly-spawned agent adopts it. (Never sent before
    // this point; the fallback id may not be a usable model.)
    if (prefs.userSet) {
      client?.sendFrame?.({
        type: "set_options",
        model: prefs.model,
        effort: prefs.effort ?? null,
      });
    }
  }

  modelChip.addEventListener("click", (e) => {
    e.stopPropagation();
    if (modelPop.hidden) {
      buildModelPop();
      modelPop.hidden = false;
    } else {
      modelPop.hidden = true;
    }
  });

  const spacer = document.createElement("span");
  spacer.className = "cmcp-spacer";

  const attachBtn = iconBtn("pi-paperclip", "Attach an image (uploads to ComfyUI's input/ folder)");
  const micBtn = iconBtn("pi-microphone", "Dictate (browser speech recognition)");
  const sendBtn = iconBtn("pi-send", "Send (Enter)");
  sendBtn.type = "submit";

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.hidden = true;

  row.append(ring, ctxLabel, modelChip, spacer, attachBtn, micBtn, sendBtn);
  form.append(menuPop, modelPop, input, row, fileInput);
  root.appendChild(form);

  // ---- feed renderers + thread persistence ----
  // paint* draws DOM only; append* paints AND records into the current
  // thread (localStorage), so history can replay a conversation verbatim.
  const THREADS_KEY = "comfyui-mcp.panel.threads";
  const MAX_THREADS = 20;
  const MAX_THREAD_MSGS = 200;
  let threads = (() => {
    try {
      const t = JSON.parse(window.localStorage.getItem(THREADS_KEY) ?? "[]");
      return Array.isArray(t) ? t : [];
    } catch {
      return [];
    }
  })();
  let thread = null; // created lazily on first recorded message

  function persistThreads() {
    try {
      window.localStorage.setItem(THREADS_KEY, JSON.stringify(threads.slice(-MAX_THREADS)));
    } catch {
      // localStorage unavailable — history is session-only.
    }
  }

  function record(entry) {
    if (!thread) {
      thread = { id: crypto.randomUUID(), ts: Date.now(), msgs: [] };
      // Adopt any session id the orchestrator has already reported for this tab.
      const sid = ssGet(SESSION_KEY);
      if (sid) thread.sessionId = sid;
      threads.push(thread);
      if (threads.length > MAX_THREADS) threads = threads.slice(-MAX_THREADS);
      ssSet(CURRENT_THREAD_KEY, thread.id);
    }
    thread.msgs.push(entry);
    if (thread.msgs.length > MAX_THREAD_MSGS) {
      thread.msgs.splice(0, thread.msgs.length - MAX_THREAD_MSGS);
    }
    thread.ts = Date.now();
    persistThreads();
  }

  /** Bind the agent's current session id to the open thread (for reload/resume). */
  function bindSession(sessionId) {
    ssSet(SESSION_KEY, sessionId);
    if (thread) {
      thread.sessionId = sessionId || undefined;
      persistThreads();
    }
  }

  function scrollLog() {
    // Defer to after layout so tall content (code blocks, images) still lands
    // at the true bottom.
    requestAnimationFrame(() => {
      log.scrollTop = log.scrollHeight;
    });
  }

  function paintUser(text) {
    clearEmpty();
    const b = document.createElement("div");
    b.className = "cmcp-bubble user";
    b.textContent = text;
    log.appendChild(b);
    scrollLog();
  }

  function paintAgent(text) {
    clearEmpty();
    const b = document.createElement("div");
    b.className = "cmcp-bubble agent";
    renderRichText(b, text);
    log.appendChild(b);
    scrollLog();
  }

  function paintCard({ icon, text, detail, error }) {
    clearEmpty();
    const card = document.createElement("div");
    card.className = "cmcp-card" + (error ? " error" : "");
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

  function paintImage(url, name) {
    clearEmpty();
    const card = document.createElement("div");
    card.className = "cmcp-bubble agent cmcp-imgcard";
    const img = document.createElement("img");
    img.src = url;
    img.alt = name || "output";
    img.loading = "lazy";
    img.style.cssText = "max-width:100%;border-radius:6px;display:block;cursor:zoom-in;";
    img.addEventListener("click", () => window.open(url, "_blank"));
    card.appendChild(img);
    if (name) {
      const cap = document.createElement("div");
      cap.style.cssText = "font-size:0.625rem;color:var(--p-text-muted-color,#a1a1aa);margin-top:0.25rem;";
      cap.textContent = name;
      card.appendChild(cap);
    }
    log.appendChild(card);
    scrollLog();
  }

  function appendUser(text) {
    paintUser(text);
    record({ role: "user", text });
  }

  function appendAgent(text) {
    paintAgent(text);
    record({ role: "agent", text });
  }

  function appendSystem(text) {
    // System notices are transient — painted, never recorded.
    const b = document.createElement("div");
    b.className = "cmcp-sys";
    b.textContent = text;
    log.appendChild(b);
    scrollLog();
  }

  function appendActivity(cmd, msg, reply) {
    const { icon, text, detail } = describeCommand(cmd, msg, reply);
    const card = { icon, text, detail, error: !reply.ok };
    paintCard(card);
    record({ role: "card", ...card });
  }

  function resetFeed() {
    for (const el of [...log.children]) el.remove();
    log.appendChild(empty);
  }

  function newChat() {
    thread = null;
    ssSet(CURRENT_THREAD_KEY, null);
    ssSet(SESSION_KEY, null);
    ssSet(CTX_KEY, null);
    resetFeed();
    setContextPct(0);
    ctxLabel.textContent = "—";
    // Tell the orchestrator to forget this tab's session so the NEXT message
    // starts a genuinely fresh agent (no memory of the prior conversation).
    client?.sendFrame?.({ type: "new_session" });
  }

  function loadThread(t) {
    thread = t;
    ssSet(CURRENT_THREAD_KEY, t.id);
    resetFeed();
    for (const m of t.msgs) {
      if (m.role === "user") paintUser(m.text);
      else if (m.role === "agent") paintAgent(m.text);
      else if (m.role === "card") paintCard(m);
    }
    // Resume this conversation's agent session (or start fresh if it has none),
    // so typing continues THIS chat rather than whatever was last active.
    ssSet(SESSION_KEY, t.sessionId || null);
    if (t.sessionId) client?.sendFrame?.({ type: "resume_session", session_id: t.sessionId });
    else client?.sendFrame?.({ type: "new_session" });
  }

  function renderHistory() {
    histPop.textContent = "";
    const list = [...threads].reverse();
    if (!list.length) {
      const none = document.createElement("div");
      none.className = "cmcp-sys";
      none.style.padding = "0.375rem";
      none.textContent = "No past chats yet.";
      histPop.appendChild(none);
      return;
    }
    for (const t of list) {
      const row = document.createElement("div");
      row.className = "cmcp-hist-row";

      const item = document.createElement("button");
      item.type = "button";
      item.className = "cmcp-popover-item cmcp-hist-open";
      const i = document.createElement("i");
      i.className = "pi pi-comment";
      const lbl = document.createElement("span");
      lbl.className = "lbl";
      const firstUser = t.msgs.find((m) => m.role === "user");
      lbl.textContent = (firstUser?.text ?? "(no messages)").slice(0, 48);
      const when = document.createElement("small");
      when.textContent = new Date(t.ts).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
      item.append(i, lbl, when);
      item.addEventListener("click", () => {
        histPop.hidden = true;
        loadThread(t);
      });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "cmcp-hist-del";
      del.title = "Delete this chat";
      const di = document.createElement("i");
      di.className = "pi pi-trash";
      del.appendChild(di);
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        threads = threads.filter((x) => x.id !== t.id);
        persistThreads();
        // Deleting the open chat clears the feed and starts fresh.
        if (thread && thread.id === t.id) newChat();
        renderHistory();
      });

      row.append(item, del);
      histPop.appendChild(row);
    }
  }

  newChatBtn.addEventListener("click", () => {
    histPop.hidden = true;
    newChat();
  });
  historyBtn.addEventListener("click", () => {
    if (histPop.hidden) renderHistory();
    histPop.hidden = !histPop.hidden;
  });

  // ---- "Claude is working…" indicator ----
  // Honest framing: Claude Code does NOT stream its reasoning to MCP
  // servers, so real thinking tokens can't appear here. What the panel can
  // do is acknowledge the send instantly and stay visibly alive until the
  // agent's next say/graph-edit lands. Graph edits keep the indicator alive
  // (Claude is mid-task); a say bubble retires it (Claude replied). If
  // nothing arrives for a while, swap to a hint about how the loop works —
  // the agent reads panel messages by polling its inbox.
  const THINKING_HINT_MS = 45000;
  let thinkingEl = null;
  let thinkingTimer = null;

  function hideThinking() {
    if (thinkingTimer) {
      clearTimeout(thinkingTimer);
      thinkingTimer = null;
    }
    if (thinkingEl) {
      thinkingEl.remove();
      thinkingEl = null;
    }
  }

  function onThinkingTimeout() {
    hideThinking();
    appendSystem(
      "Claude hasn’t replied yet — check that comfyui-mcp is connected in your Claude session (/mcp) and that it was started with --channels. It may also just be mid-task.",
    );
  }

  function showThinking() {
    hideThinking();
    clearEmpty();
    thinkingEl = document.createElement("div");
    thinkingEl.className = "cmcp-thinking";
    const dots = document.createElement("span");
    dots.className = "cmcp-thinking-dots";
    for (let i = 0; i < 3; i += 1) dots.appendChild(document.createElement("span"));
    const label = document.createElement("span");
    label.textContent = "Claude is working… (Ctrl+C to stop)";
    thinkingEl.append(dots, label);
    log.appendChild(thinkingEl);
    scrollLog();
    thinkingTimer = setTimeout(onThinkingTimeout, THINKING_HINT_MS);
  }

  /** Keep the indicator below the newest activity card and reset its
   *  quiet-period timer — an incoming graph edit proves Claude is working. */
  function bumpThinking() {
    if (!thinkingEl) return;
    log.appendChild(thinkingEl);
    if (thinkingTimer) clearTimeout(thinkingTimer);
    thinkingTimer = setTimeout(onThinkingTimeout, THINKING_HINT_MS);
    scrollLog();
  }

  // ---- bridge wiring ----
  const client = createBridgeClient({
    onStatus(state) {
      statusText.textContent = state;
      dot.className = "cmcp-dot" + (state === "connected" ? " connected" : state === "connecting" ? " connecting" : "");
      settingsBox.hidden = state !== "disconnected";
      const connected = state === "connected";
      connectBtn.hidden = connected;
      disconnectBtn.hidden = !connected;
      connectBtn.disabled = state === "connecting";
      connectBtn.textContent = state === "connecting" ? "Connecting…" : "Connect";
      if (!connected) hideThinking();
      // NB: do NOT push set_options here. The saved model id is only known-valid
      // once the live catalog arrives, so the push happens in applyModelCatalog
      // — sending an unvalidated fallback id can wedge the agent on a model the
      // account can't use.
    },
    onSay(text) {
      hideThinking();
      appendAgent(text);
    },
    onLog(text) {
      appendSystem(text);
    },
    onCommand(cmd, msg, reply) {
      appendActivity(cmd, msg, reply);
      bumpThinking();
    },
    onAgentStatus(s) {
      // Percentage of the context window used (label + ring), persisted so a
      // reload isn't blank. % is what the user wants — not raw token counts.
      if (typeof s.context_pct === "number") {
        setContextPct(s.context_pct);
        ssSet(CTX_KEY, String(s.context_pct));
        if (typeof s.cost_usd === "number") {
          ringTitle.textContent = `Context ~${Math.round(s.context_pct * 100)}% used · $${s.cost_usd.toFixed(3)}`;
        }
      }
      // Keep the chip in sync if the agent reports a concrete model id we know.
      if (typeof s.model === "string" && modelCatalog.some((m) => m.id === s.model)) {
        prefs.model = s.model;
        refreshModelChip();
      }
    },
    onSession(sessionId) {
      bindSession(sessionId);
    },
    onModels(list) {
      applyModelCatalog(list);
    },
    getResume: () => ssGet(SESSION_KEY),
  });

  // ---- ComfyUI execution events → image cards + agent awareness (#7) ----
  // When a run finishes with output images, show them in the chat and notify
  // the agent so it knows its render landed (the orchestrator drops the event
  // if no session is attending). On error, notify the agent to diagnose.
  function onExecuted(ev) {
    const d = ev?.detail ?? {};
    const images = (d.output && d.output.images) || [];
    if (!images.length) return;
    for (const img of images) {
      if (img && img.filename) paintImage(imageViewUrl(img), img.filename);
    }
    client.sendFrame({
      type: "agent_event",
      kind: "executed",
      images,
      node_id: d.node ?? d.display_node ?? null,
    });
  }
  function onExecError(ev) {
    const d = ev?.detail ?? {};
    client.sendFrame({
      type: "agent_event",
      kind: "run_error",
      error: d.exception_message || d.exception_type || "execution error",
    });
  }
  try {
    api.addEventListener("executed", onExecuted);
    api.addEventListener("execution_error", onExecError);
  } catch {
    // api unavailable — execution surfacing disabled
  }

  saveBtn.addEventListener("click", () => {
    client.setUrl(urlInput.value.trim());
    appendSystem(`Reconnecting to ${client.currentUrl()}…`);
  });

  // Connect: ask ComfyUI's server to start the background agent on demand, then
  // open the bridge. The orchestrator is only ever spawned by this click.
  async function connectAgent() {
    connectBtn.disabled = true;
    connectBtn.textContent = "Starting…";
    try {
      const res = await api.fetchApi("/comfyui_mcp_panel/connect", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!data?.ok && data?.message) appendSystem(data.message);
    } catch (err) {
      // No /connect route (older/headless host) — fall through and try the
      // bridge directly in case the user started the orchestrator themselves.
      appendSystem(`Couldn't reach ComfyUI to start the agent: ${err?.message ?? err}`);
    }
    // Connect (or keep reconnecting with backoff until the bridge binds).
    client.start();
  }
  connectBtn.addEventListener("click", connectAgent);

  disconnectBtn.addEventListener("click", async () => {
    client.stop();
    connectBtn.hidden = false;
    disconnectBtn.hidden = true;
    connectBtn.disabled = false;
    connectBtn.textContent = "Connect";
    statusText.textContent = "disconnected";
    dot.className = "cmcp-dot";
    settingsBox.hidden = false;
    try {
      await api.fetchApi("/comfyui_mcp_panel/disconnect", { method: "POST" });
    } catch {
      // best-effort; a user-run orchestrator is intentionally left running
    }
    appendSystem("Disconnected. Click Connect to start again.");
  });

  // ---- slash commands (run locally, no agent round-trip) ----
  async function runLocalCommand(cmd, args) {
    try {
      const result = await GRAPH_TOOL_EXECUTORS[cmd](args);
      appendActivity(cmd, args, { ok: true, result });
    } catch (err) {
      appendActivity(cmd, args, { ok: false, error: err?.message ?? String(err) });
    }
  }

  const SLASH_COMMANDS = [
    { cmd: "/new", icon: "pi-plus", hint: "start a new chat", run: () => newChat() },
    {
      cmd: "/fit",
      icon: "pi-window-maximize",
      hint: "fit the canvas to the graph",
      run: () => runLocalCommand("graph_canvas", { action: "fit" }),
    },
    { cmd: "/run", icon: "pi-play", hint: "queue the open workflow", run: () => runLocalCommand("graph_run", {}) },
    {
      cmd: "/errors",
      icon: "pi-info-circle",
      hint: "show the last execution errors",
      run: () => runLocalCommand("graph_get_errors", {}),
    },
    {
      cmd: "/help",
      icon: "pi-question-circle",
      hint: "list commands",
      run: () => appendSystem(SLASH_COMMANDS.map((c) => `${c.cmd} — ${c.hint}`).join(" · ")),
    },
  ];

  // ---- completion menu (slash + @ mentions) ----
  let menuItems = [];
  let menuSel = 0;
  let menuToken = null; // { start, end } range in input.value being completed

  function hideMenu() {
    menuPop.hidden = true;
    menuItems = [];
    menuToken = null;
  }

  function showMenu(items) {
    menuItems = items;
    menuSel = 0;
    menuPop.textContent = "";
    if (!items.length) {
      hideMenu();
      return;
    }
    items.forEach((item, idx) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "cmcp-popover-item" + (idx === 0 ? " sel" : "");
      const i = document.createElement("i");
      i.className = `pi ${item.icon}`;
      const lbl = document.createElement("span");
      lbl.className = "lbl";
      lbl.textContent = item.label;
      el.append(i, lbl);
      if (item.small) {
        const s = document.createElement("small");
        s.textContent = item.small;
        el.appendChild(s);
      }
      // mousedown (not click) so the textarea never loses focus.
      el.addEventListener("mousedown", (mev) => {
        mev.preventDefault();
        pickMenuItem(item);
      });
      menuPop.appendChild(el);
    });
    menuPop.hidden = false;
  }

  function moveSel(delta) {
    if (!menuItems.length) return;
    menuSel = (menuSel + delta + menuItems.length) % menuItems.length;
    [...menuPop.children].forEach((el, i) => el.classList.toggle("sel", i === menuSel));
    menuPop.children[menuSel]?.scrollIntoView({ block: "nearest" });
  }

  function pickMenuItem(item) {
    if (item.kind === "slash") {
      hideMenu();
      input.value = "";
      input.style.height = "auto";
      appendUser(item.ref.cmd);
      item.ref.run();
      return;
    }
    const { start, end } = menuToken ?? { start: input.value.length, end: input.value.length };
    input.value = input.value.slice(0, start) + item.insert + input.value.slice(end);
    const pos = start + item.insert.length;
    input.selectionStart = pos;
    input.selectionEnd = pos;
    hideMenu();
    input.focus();
  }

  function buildAtItems(query) {
    const q = query.toLowerCase();
    const items = [];
    const wf = getWorkflowTitle();
    if (!q || "workflow".includes(q) || wf.toLowerCase().includes(q)) {
      items.push({
        icon: "pi-file",
        label: `workflow — ${wf}`,
        small: "context",
        insert: `@workflow:"${wf}" `,
      });
    }
    try {
      const { graph } = getGraphCtx();
      for (const n of graph._nodes ?? []) {
        const name = n.title ?? n.type;
        const label = `#${n.id} ${name}`;
        if (!q || label.toLowerCase().includes(q)) {
          items.push({
            icon: n.subgraph ? "pi-sitemap" : "pi-circle",
            label,
            small: n.subgraph ? "subgraph" : n.type,
            insert: `@node:${n.id}(${name}) `,
          });
        }
        if (items.length >= 9) break;
      }
    } catch {
      // graph unavailable — node items skipped
    }
    try {
      const LG = window.LiteGraph ?? globalThis.LiteGraph;
      if (q.length >= 2 && LG?.registered_node_types) {
        let added = 0;
        for (const t of Object.keys(LG.registered_node_types)) {
          if (t.toLowerCase().includes(q)) {
            items.push({ icon: "pi-box", label: t, small: "node type", insert: `@type:${t} ` });
            added += 1;
            if (added >= 5) break;
          }
        }
      }
    } catch {
      // LiteGraph unavailable — type items skipped
    }
    return items.slice(0, 12);
  }

  function refreshMenu() {
    const caret = input.selectionStart ?? input.value.length;
    const upto = input.value.slice(0, caret);
    // Slash menu only while the whole message IS the command being typed.
    if (/^\/[\w-]*$/.test(upto) && upto === input.value) {
      const q = upto.toLowerCase();
      menuToken = { start: 0, end: input.value.length };
      showMenu(
        SLASH_COMMANDS.filter((c) => c.cmd.startsWith(q)).map((c) => ({
          kind: "slash",
          icon: c.icon,
          label: c.cmd,
          small: c.hint,
          ref: c,
        })),
      );
      return;
    }
    const atM = upto.match(/(^|\s)@([\w./:-]*)$/);
    if (atM) {
      menuToken = { start: caret - atM[2].length - 1, end: caret };
      showMenu(buildAtItems(atM[2]));
      return;
    }
    hideMenu();
  }

  // ---- attach (upload into ComfyUI's input/ folder) ----
  function insertAtCaret(text) {
    const s = input.selectionStart ?? input.value.length;
    const e = input.selectionEnd ?? s;
    input.value = input.value.slice(0, s) + text + input.value.slice(e);
    const pos = s + text.length;
    input.selectionStart = pos;
    input.selectionEnd = pos;
    input.dispatchEvent(new Event("input"));
    input.focus();
  }

  attachBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    appendSystem(`Uploading ${file.name}…`);
    try {
      const fd = new FormData();
      fd.append("image", file);
      const res = await api.fetchApi("/upload/image", { method: "POST", body: fd });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const info = await res.json();
      const ref = (info.subfolder ? `${info.subfolder}/` : "") + info.name;
      insertAtCaret(`@input:${ref} `);
      appendSystem(`Attached — saved to ComfyUI input/${ref} (usable in LoadImage).`);
    } catch (err) {
      appendSystem(`Upload failed: ${err?.message ?? err}`);
    }
  });

  // ---- voice dictation (browser speech recognition; Chrome) ----
  const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  let recognition = null;
  if (!SR) {
    micBtn.disabled = true;
    micBtn.title = "Voice input is not supported in this browser";
  }
  micBtn.addEventListener("click", () => {
    if (!SR) return;
    if (recognition) {
      recognition.stop();
      return;
    }
    recognition = new SR();
    recognition.lang = navigator.language || "en-US";
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.addEventListener("result", (ev) => {
      const last = ev.results[ev.results.length - 1];
      if (last?.isFinal) insertAtCaret(`${last[0].transcript.trim()} `);
    });
    recognition.addEventListener("end", () => {
      micBtn.classList.remove("active");
      recognition = null;
    });
    recognition.addEventListener("error", (ev) => {
      if (ev.error !== "aborted") appendSystem(`Voice input error: ${ev.error}`);
    });
    micBtn.classList.add("active");
    recognition.start();
  });

  // ---- submit ----
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    hideMenu();
    const text = input.value.trim();
    if (!text) return;
    if (text.startsWith("/")) {
      const c = SLASH_COMMANDS.find((sc) => sc.cmd === text.split(/\s+/)[0]);
      if (c) {
        appendUser(text);
        input.value = "";
        input.style.height = "auto";
        c.run();
        return;
      }
    }
    if (!client.isConnected()) {
      appendSystem("Not connected — click Connect (in the Connection panel) and try again.");
      settingsBox.hidden = false;
      return;
    }
    const freshChat = !thread;
    appendUser(text);
    showThinking();
    input.value = "";
    input.style.height = "auto";
    // Ground a brand-new chat: if the open workflow was never saved, save it
    // first so the agent works from a real file (Ctrl+S / reload behave).
    if (freshChat) {
      const saved = await groundUnsavedWorkflow();
      if (saved) appendSystem(`Saved your workflow as “${saved}” — grounded base for the agent.`);
    }
    // Stamp where the user is — workflow + opened subgraph — so the agent
    // gets the context without asking.
    let viewing = { scope: "root" };
    try {
      viewing = describeActiveGraph(getGraphCtx().graph);
    } catch {
      // graph unavailable — send without subgraph context
    }
    client.sendUserMessage(text, {
      workflow: getWorkflowTitle(),
      ...(viewing.scope === "subgraph" ? { subgraph: viewing.title } : {}),
    });
  });

  input.addEventListener("keydown", (ev) => {
    if (!menuPop.hidden && menuItems.length) {
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        moveSel(1);
        return;
      }
      if (ev.key === "ArrowUp") {
        ev.preventDefault();
        moveSel(-1);
        return;
      }
      if (ev.key === "Enter" || ev.key === "Tab") {
        ev.preventDefault();
        pickMenuItem(menuItems[menuSel]);
        return;
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        hideMenu();
        return;
      }
    }
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      form.requestSubmit();
    }
  });
  // Ctrl+C / Cmd+C interrupts a running turn. Only when no text is selected
  // (so copy still works) and a turn is actually in flight. Scoped to the panel
  // via bubbling — it won't hijack Ctrl+C elsewhere in ComfyUI.
  root.addEventListener("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === "c" || ev.key === "C")) {
      const hasSelection = (window.getSelection?.()?.toString() ?? "").length > 0;
      if (!hasSelection && thinkingEl) {
        ev.preventDefault();
        if (client.sendFrame({ type: "interrupt" })) {
          hideThinking();
          appendSystem("Interrupted.");
        }
      }
    }
  });

  input.addEventListener("blur", () => setTimeout(hideMenu, 150));
  // Auto-grow the textarea up to its CSS max-height.
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    refreshMenu();
  });

  // Dismiss the header/picker dropdowns when clicking anywhere outside them
  // (not just on the trigger or an option). Uses mousedown so it settles before
  // an option's own click handler runs. The completion menu keeps its own
  // blur-based dismissal.
  function onDocPointerDown(ev) {
    const t = ev.target;
    if (!settingsBox.hidden && !settingsBox.contains(t) && !status.contains(t)) {
      settingsBox.hidden = true;
    }
    if (!histPop.hidden && !histPop.contains(t) && !historyBtn.contains(t)) {
      histPop.hidden = true;
    }
    if (!modelPop.hidden && !modelPop.contains(t) && !modelChip.contains(t)) {
      modelPop.hidden = true;
    }
  }
  document.addEventListener("mousedown", onDocPointerDown);

  // Reload restore: repaint the chat this tab was last showing. The agent's
  // memory continues automatically — either the orchestrator's agent for this
  // (stable) tab id is still alive, or hello's `resume` (the session id kept in
  // sessionStorage) rehydrates it from disk after an orchestrator restart.
  (function restoreLastThread() {
    try {
      const cur = ssGet(CURRENT_THREAD_KEY);
      const t = cur ? threads.find((x) => x.id === cur) : null;
      if (!t || !t.msgs?.length) return;
      thread = t;
      resetFeed();
      for (const m of t.msgs) {
        if (m.role === "user") paintUser(m.text);
        else if (m.role === "agent") paintAgent(m.text);
        else if (m.role === "card") paintCard(m);
      }
    } catch {
      // Corrupt/absent state — start clean.
    }
  })();

  // On load, only auto-connect if a bridge is already up (you started the
  // orchestrator yourself, or another tab did). Otherwise sit idle behind the
  // Connect button — we never start a process without an explicit click.
  (async () => {
    try {
      const res = await api.fetchApi("/comfyui_mcp_panel/status");
      const data = await res.json().catch(() => ({}));
      if (data?.running) client.start();
    } catch {
      // No status route — leave the Connect button for the user to drive.
    }
  })();

  return {
    root,
    destroy() {
      try {
        recognition?.stop();
      } catch {
        // recognition already stopped
      }
      document.removeEventListener("mousedown", onDocPointerDown);
      try {
        api.removeEventListener("executed", onExecuted);
        api.removeEventListener("execution_error", onExecError);
      } catch {
        // already detached
      }
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
          // Make the tab content a full-height flex column so the panel's header
          // and input pin to the edges and only the chat body scrolls (the
          // container otherwise sizes to content and the whole panel scrolls).
          container.style.height = "100%";
          container.style.minHeight = "0";
          container.style.display = "flex";
          container.style.flexDirection = "column";
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
