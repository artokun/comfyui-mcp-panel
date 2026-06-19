// =============================================================================
// ComfyUI Agent Panel — sidebar driven by an autonomous background agent.
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
// The panel orchestrator owns a DEDICATED bridge port (9180), separate from the
// legacy `comfyui-mcp --channels` bridge (9101) — so a stray --channels server
// in any Claude/Cursor session can never sit on the panel's port and produce a
// "connected but no agent" lie.
const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:9180";
const LEGACY_BRIDGE_URL = "ws://127.0.0.1:9101"; // old shared default — migrate off it

function loadBridgeUrl() {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY_BRIDGE);
    // Migrate anyone pinned to the old shared 9101 default onto the new port.
    if (!saved || saved === LEGACY_BRIDGE_URL) return DEFAULT_BRIDGE_URL;
    return saved;
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
// Set when the agent triggers a ComfyUI restart, so that after ComfyUI comes
// back the panel respawns the orchestrator, resumes the agent session, and
// nudges it to continue — making install→restart→continue autonomous. Survives
// a page reload (sessionStorage) in case the restart reloads the frontend.
const REBOOT_KEY = "comfyui-mcp.panel.rebootResume";
// Set while a soft reload (orchestrator respawn, no ComfyUI restart) is in
// flight. Value is the trigger origin ("agent" | "user") so that after the
// fresh orchestrator reconnects we resume the session and — only for an
// agent-triggered reload mid-task — nudge it to continue. Survives the bridge
// drop via sessionStorage.
const SOFT_RELOAD_KEY = "comfyui-mcp.panel.softReloadResume";
// Set while the agent is mid-turn (working), cleared when the turn finishes. If
// the connection drops while it's set — an UNEXPECTED bounce (another agent
// rebooting ComfyUI, a crash, an SDK self-heal) — the reconnect nudges the
// resumed session to continue where it left off. The REBOOT/SOFT_RELOAD cases
// (deliberate, agent-known) are handled first and clear this so we don't double-nudge.
const MID_TASK_KEY = "comfyui-mcp.panel.midTaskResume";
// Wall-clock (ms) of the last bridge drop — module-scoped so it survives panel
// remounts. A FAST reconnect (panel swap / WS blip; orchestrator alive) vs a
// SLOW one (real ComfyUI restart; orchestrator died + respawned) is how we tell
// a spurious bounce from a real one — only the slow case fires the resume nudge.
let lastBridgeDownAt = 0;
// One-shot flag set right before a frontend (page) reload WE trigger, so that
// after the reload we re-activate our own sidebar tab. ComfyUI restores the
// last active tab BEFORE our extension re-registers it, so it can't reopen ours
// on its own — we do it once registration is back.
const SIDEBAR_REOPEN_KEY = "comfyui-mcp.panel.reopenSidebar";
/** Our sidebar tab id — referenced by both the opener and the registration. */
const SIDEBAR_TAB_ID = "comfyui-mcp.agent";

/**
 * Best-effort: make our sidebar tab the active one. ComfyUI exposes this a few
 * different ways across versions, so try them in order and stop at the first
 * that takes. No-op if it's already active.
 */
function openSidebarTab() {
  const em = (typeof app !== "undefined" && app) ? app.extensionManager : null;
  if (!em) return false;
  const store = em.sidebarTab || em;
  const active = () => store.activeSidebarTabId ?? em.activeSidebarTabId;
  try {
    if (active() === SIDEBAR_TAB_ID) return true; // already open — nothing to do
    // Prefer an IDEMPOTENT set (never closes the tab); fall back to toggle only
    // after confirming our tab isn't the active one (so toggle can't close it).
    if (typeof em.setActiveSidebarTab === "function") em.setActiveSidebarTab(SIDEBAR_TAB_ID);
    else { try { store.activeSidebarTabId = SIDEBAR_TAB_ID; } catch { /* not writable */ } }
    if (active() === SIDEBAR_TAB_ID) return true;
    if (typeof store.toggleSidebarTab === "function") store.toggleSidebarTab(SIDEBAR_TAB_ID);
    else if (typeof em.toggleSidebarTab === "function") em.toggleSidebarTab(SIDEBAR_TAB_ID);
    else em.command?.execute?.(`Workspace.ToggleSidebarTab.${SIDEBAR_TAB_ID}`);
    return active() === SIDEBAR_TAB_ID;
  } catch (e) {
    console.warn("[comfyui-mcp-panel] couldn't open sidebar tab:", e);
    return false;
  }
}

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

// Sticky auto-connect: once the user has connected, the panel auto-reconnects
// (respawning the orchestrator if it died, e.g. after a ComfyUI reboot) on every
// open — until they explicitly Disconnect. localStorage so it survives a full
// frontend reload, not just a tab session.
const AUTOCONNECT_KEY = "comfyui-mcp.panel.autoConnect";
function lsGet(key) {
  try {
    return window.localStorage.getItem(key) || null;
  } catch {
    return null;
  }
}
function lsSet(key, val) {
  try {
    if (val == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, val);
  } catch {
    // localStorage unavailable — auto-connect degrades to manual Connect.
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

/** Programmatically save the active workflow — NO Save/Rename dialog. Uses the
 *  workflow STORE's saveWorkflow() (which calls workflow.save({force}); the
 *  dialog only comes from the Comfy.SaveWorkflow *command* path). If the
 *  workflow was never saved (or a `name` is given), it's renamed first so it
 *  lands as a real, named file. Best-effort + feature-detected. Returns the
 *  saved name, or null if it couldn't save. */
async function programmaticSave(name) {
  const svc = app?.extensionManager?.workflow;
  const wf = svc?.activeWorkflow;
  if (!wf) throw new Error("no active workflow to save");
  const wasUnsaved = wf.isTemporary === true || wf.isPersisted === false;
  // Rename FIRST when we want a specific/auto name, so it persists under that
  // name (renameWorkflow does the store bookkeeping; path needs the prefix).
  const desired = (name ? String(name) : wasUnsaved ? autoWorkflowName() : "")
    .replace(/\.json$/i, "")
    .trim();
  if (desired && typeof svc.renameWorkflow === "function") {
    const target = `workflows/${desired}.json`;
    if (wf.path !== target) {
      try {
        await svc.renameWorkflow(wf, target);
      } catch {
        /* keep going — we'll still save under the current name */
      }
    }
  }
  if (typeof svc.saveWorkflow === "function") await svc.saveWorkflow(wf);
  else if (typeof wf.save === "function") await wf.save();
  else throw new Error("workflow save API unavailable on this frontend");
  return desired || wf.filename || getWorkflowTitle();
}

/** If the open workflow was never saved to disk, save it (no dialog) so the
 *  agent works from a grounded file. Best-effort. Returns the saved name or null. */
async function groundUnsavedWorkflow() {
  try {
    const wf = app?.extensionManager?.workflow?.activeWorkflow;
    if (!wf || (wf.isPersisted !== false && wf.isTemporary !== true)) return null;
    return await programmaticSave();
  } catch {
    return null; // best-effort — never block the chat on a save hiccup
  }
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

// The currently-mounted panel root (set by buildPanel). Used by canvas "fit" to
// measure how much of the canvas the open sidebar panel overlays.
let activePanelRoot = null;

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
        // Bounding box of all nodes (prefer litegraph's boundingRect, which
        // includes titles; fall back to pos/size).
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const n of nodes) {
          const br = n.boundingRect;
          let x, y, w0, h0;
          if (Array.isArray(br) && br.length === 4 && (br[2] || br[3])) {
            [x, y, w0, h0] = br;
          } else {
            x = n.pos[0];
            y = n.pos[1] - 30; // title bar renders above pos
            w0 = n.size?.[0] ?? 200;
            h0 = (n.size?.[1] ?? 100) + 30;
          }
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x + w0);
          maxY = Math.max(maxY, y + h0);
        }
        const bounds = [minX, minY, maxX - minX, maxY - minY];
        // Panel-aware: the open sidebar panel overlays part of the canvas, so
        // widen the fit bounds on the panel's side — the graph then lands in the
        // VISIBLE area instead of behind the panel (fit otherwise frames the
        // FULL canvas, which sits behind the panel overlay).
        try {
          const cEl = canvas.canvas;
          const pr = activePanelRoot?.isConnected ? activePanelRoot.getBoundingClientRect() : null;
          const cr = cEl?.getBoundingClientRect?.();
          if (pr && cr && pr.width > 0 && cr.width > 0) {
            const panelOnLeft = (pr.left + pr.right) / 2 < (cr.left + cr.right) / 2;
            const inset = panelOnLeft ? Math.max(0, pr.right - cr.left) : Math.max(0, cr.right - pr.left);
            if (inset > 8 && inset < cr.width * 0.9) {
              const extra = bounds[2] * (cr.width / (cr.width - inset) - 1);
              bounds[2] += extra;
              if (panelOnLeft) bounds[0] -= extra; // pad the panel (left) side; right panel grows bounds to the right
            }
          }
        } catch {
          // measurement unavailable — fall back to a plain full-canvas fit
        }
        // SMOOTH animated zoom-to-fit when supported (matches the native
        // "Fit view" easing); fall back to an instant set otherwise.
        if (typeof canvas.animateToBounds === "function") {
          canvas.animateToBounds(bounds, { duration: 400 });
          return { canvas: { action, animated: true } };
        }
        const pad = 60;
        const el = canvas.canvas;
        const w = bounds[2] + pad * 2;
        const h = bounds[3] + pad * 2;
        const next = Math.min(el.width / w, el.height / h, 1.5);
        ds.scale = next;
        ds.offset[0] = -bounds[0] + pad + (el.width / next - w) / 2;
        ds.offset[1] = -bounds[1] + pad + (el.height / next - h) / 2;
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

  async workflow_save({ name } = {}) {
    // Fully programmatic — no Save/Rename dialog. Auto-names a never-saved
    // workflow; saves in place otherwise.
    const saved = await programmaticSave(name);
    return { saved: true, workflow: saved };
  },

  async workflow_save_as({ name }) {
    if (!name || typeof name !== "string") throw new Error("name (string) is required");
    const saved = await programmaticSave(name);
    return { saved: true, workflow: saved };
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

  // Rename a node's TITLE (the label on its header) — distinct from widget values.
  graph_set_title({ node_id, title }) {
    const { graph } = getGraphCtx();
    const node = resolveNode(graph, node_id);
    const previous = node.title;
    graph.beforeChange?.();
    try {
      node.title = String(title ?? "");
    } finally {
      graph.afterChange?.();
    }
    graph.setDirtyCanvas?.(true, true);
    return { node_id: node.id, previous, title: node.title };
  },

  // Navigate INTO a subgraph node so the canvas (and therefore every graph_*
  // editor) targets its inner graph — the way to read/edit nodes inside a
  // subgraph. Pair with graph_exit_subgraph to return to the root.
  graph_enter_subgraph({ node_id }) {
    const { graph, canvas } = getGraphCtx();
    const node = resolveNode(graph, node_id);
    const sub = node.subgraph;
    if (!sub) throw new Error(`Node ${node.id} (${node.type}) is not a subgraph`);
    if (typeof canvas.openSubgraph !== "function") {
      throw new Error("subgraph navigation unavailable on this frontend");
    }
    canvas.openSubgraph(sub, node);
    canvas.setDirty?.(true, true);
    return { entered: node.id, viewing: describeActiveGraph(getGraphCtx().graph) };
  },

  // Leave the current subgraph and return to the root graph.
  graph_exit_subgraph() {
    const { graph, canvas, rootGraph } = getGraphCtx();
    if (graph === rootGraph) return { viewing: { scope: "root" }, note: "already at root" };
    if (typeof canvas.setGraph !== "function") {
      throw new Error("subgraph navigation unavailable on this frontend");
    }
    canvas.setGraph(graph.rootGraph ?? rootGraph);
    canvas.setDirty?.(true, true);
    return { viewing: describeActiveGraph(getGraphCtx().graph) };
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

function createBridgeClient({ onStatus, onSay, onStream, onLog, onCommand, onAsk, onSecret, onReload, onTodo, onDownloads, onThinking, onAgentStatus, onSession, onModels, onAck, onTurn, getResume }) {
  let sock = null;
  let url = loadBridgeUrl();
  let closed = false;
  let attempt = 0;
  let reconnectTimer = null;
  // Truthful "connected": a WS open is NOT enough — we only flip to "connected"
  // once the orchestrator handshake (its `models` frame) arrives. A non-orchestrator
  // squatter on the port (e.g. a stray `comfyui-mcp --channels`) never sends it,
  // so the panel won't lie "connected" when there's no agent behind the socket.
  let handshakeTimer = null;
  let handshakeDone = false;
  const HANDSHAKE_MS = 20000;
  function clearHandshake() {
    if (handshakeTimer) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }
  }
  function markConnected() {
    handshakeDone = true;
    clearHandshake();
    // Remember the user wants the agent connected, so we auto-reconnect after a
    // ComfyUI reboot / panel reopen (until they explicitly Disconnect).
    lsSet(AUTOCONNECT_KEY, "1");
    onStatus("connected");
  }

  function connect() {
    if (closed) return;
    // Re-entrancy guard: never open a second socket while one is already
    // connecting/open (multiple callers — reconnect timer, post-restart resume,
    // Connect button — can race).
    if (sock && (sock.readyState === WebSocket.CONNECTING || sock.readyState === WebSocket.OPEN)) {
      return;
    }
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
      handshakeDone = false;
      // Stay "connecting" until the orchestrator handshake (models frame) lands.
      onStatus("connecting");
      onLog(`Connected to ${url} — waiting for the panel agent…`);
      sendHello();
      clearHandshake();
      handshakeTimer = setTimeout(() => {
        if (handshakeDone) return;
        onLog(
          `⚠ Bridge open on ${url} but no panel agent responded. Something else may be holding the port ` +
            `(e.g. a 'comfyui-mcp --channels' server from another Claude/Cursor session). Close it, or fully ` +
            `restart ComfyUI, then reconnect.`,
        );
      }, HANDSHAKE_MS);
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
          let result;
          if (msg.cmd === "ask_user") {
            // Not a graph executor — render an interactive question card in the
            // chat (UI scope) and block on the user's pick. The chosen string
            // becomes the tool result the agent receives.
            if (!onAsk) throw new Error("This panel build can't display questions.");
            result = await onAsk(msg);
          } else if (msg.cmd === "request_secret") {
            // Secure secret entry. The pasted value rides back to the
            // orchestrator (which writes it to config) and is the tool's reply;
            // it is never surfaced to the agent's context or recorded to history.
            if (!onSecret) throw new Error("This panel build can't collect secrets.");
            result = await onSecret(msg);
          } else if (msg.cmd === "soft_reload") {
            // Agent-triggered soft reload. Reply FIRST (below), then bounce —
            // an "orchestrator" scope kills this very session, so the resume
            // flow (SOFT_RELOAD_KEY) continues the conversation afterward.
            if (!onReload) throw new Error("This panel build can't soft-reload.");
            const scope = msg.scope === "frontend" ? "frontend" : "orchestrator";
            result = `soft reload (${scope}) scheduled`;
            setTimeout(() => onReload(scope), 60);
          } else if (msg.cmd === "set_todo") {
            // Render/update the agent's live TODO checklist in the footer tray.
            const items = Array.isArray(msg.items) ? msg.items : [];
            onTodo?.(items);
            result = { ok: true, count: items.length };
          } else {
            const executor = GRAPH_TOOL_EXECUTORS[msg.cmd];
            if (!executor) throw new Error(`Unknown command "${msg.cmd}"`);
            result = await executor(msg);
          }
          reply = { rid: msg.rid, ok: true, result };
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
        // ask_user / request_secret paint their OWN cards and their replies carry
        // user input (a choice, or a SECRET) — never echo them as an activity card
        // (and never record them). Other commands get the normal activity card.
        if (msg.cmd !== "ask_user" && msg.cmd !== "request_secret" && msg.cmd !== "set_todo") {
          onCommand?.(msg.cmd, msg, reply);
        }
        return;
      }
      if (msg && msg.type === "say" && typeof msg.text === "string") {
        // `id` reconciles this committed reply with its live streaming preview.
        onSay(msg.text, { id: msg.id, streamed: !!msg.streamed });
      }
      // Live streaming deltas: incremental thinking / reply text before the final
      // `say` commits. phase: "think" | "text" | "end".
      if (msg && msg.type === "stream" && typeof msg.id === "string") {
        onStream?.(msg);
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
      // Live model catalog from the orchestrator (SDK-probed). This is also the
      // orchestrator HANDSHAKE — receiving it proves a real panel agent is behind
      // the socket, so it's the moment we truthfully flip to "connected".
      if (msg && msg.type === "models" && Array.isArray(msg.models)) {
        markConnected();
        onModels?.(msg.models, typeof msg.current === "string" ? msg.current : undefined);
      }
      // Structured acks (ready / working / options / …). The "ready" ack is sent
      // after the orchestrator has processed hello (resume armed), so it's the
      // reliable signal to send a post-restart resume nudge.
      if (msg && msg.type === "ack") {
        onAck?.(msg);
      }
      // Turn lifecycle → "working" indicator (working stays up through the whole
      // turn incl. silent tool work; done clears it).
      if (msg && msg.type === "turn" && typeof msg.state === "string") {
        onTurn?.(msg.state);
      }
      // Live download progress for the status tray (sourced orchestrator-side
      // from the download tool's temp progress file and/or the Manager queue).
      if (msg && msg.type === "download_progress" && Array.isArray(msg.downloads)) {
        onDownloads?.(msg.downloads);
      }
      // Live extended-thinking token count → "thinking… (N)" indicator.
      if (msg && msg.type === "thinking" && typeof msg.tokens === "number") {
        onThinking?.(msg.tokens);
      }
      // "echo" frames are ignored — we render the user bubble locally on send.
    });

    sock.addEventListener("close", () => {
      sock = null;
      handshakeDone = false;
      clearHandshake();
      lastBridgeDownAt = Date.now(); // for the fast-vs-slow reconnect heuristic
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
    sendUserMessage(text, context, images) {
      if (!sock || sock.readyState !== WebSocket.OPEN) return false;
      try {
        sock.send(
          JSON.stringify({
            type: "user_message",
            text,
            ...(context ? { context } : {}),
            ...(images?.length ? { images } : {}),
          }),
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
.cmcp-spin i { animation: cmcp-spin 0.8s linear infinite; }
@keyframes cmcp-spin { to { transform: rotate(360deg); } }

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
  /* Real table layout (NOT display:block) so the header row stays aligned with
     the body; fit the panel width and let long cells wrap instead of scrolling. */
  display: table; width: 100%; table-layout: fixed;
  border-collapse: collapse; margin: 0.5rem 0; font-size: 0.6875rem;
}
.cmcp-bubble th, .cmcp-bubble td {
  border: 1px solid var(--p-content-border-color, #3f3f46);
  padding: 0.25rem 0.5rem; text-align: left; vertical-align: top;
  overflow-wrap: anywhere; word-break: break-word;
}
.cmcp-bubble th { background: var(--p-surface-800, #27272a); font-weight: 600; }
.cmcp-newmsg {
  position: absolute; left: 50%; transform: translateX(-50%); bottom: 0.6rem; z-index: 6;
  display: inline-flex; align-items: center; gap: 0.35rem;
  padding: 0.3rem 0.75rem; border-radius: 999px; border: none; cursor: pointer;
  background: var(--p-primary-color, #2563eb); color: var(--p-primary-contrast-color, #fff);
  font: inherit; font-size: 0.7rem; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45);
}
.cmcp-newmsg .pi { font-size: 0.7rem; }
/* The base rule sets display, which beats the UA [hidden] rule — so re-assert
   it or "newMsgBtn.hidden = true" won't actually hide the pill. */
.cmcp-newmsg[hidden] { display: none; }
.cmcp-tray {
  flex: none; margin: 0 0.5rem 0.25rem; padding: 0.4rem 0.55rem;
  background: var(--p-surface-800, #27272a); border: 1px solid var(--p-content-border-color, #3f3f46);
  border-radius: 8px; max-height: 9rem; overflow-y: auto; font-size: 0.7rem;
}
.cmcp-tray[hidden] { display: none; }
.cmcp-tray-head { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.55; margin-bottom: 0.3rem; }
.cmcp-todo-item { display: flex; align-items: flex-start; gap: 0.4rem; padding: 0.12rem 0; line-height: 1.3; }
.cmcp-todo-item .pi { font-size: 0.7rem; margin-top: 0.1rem; flex: none; }
.cmcp-todo-item.done { opacity: 0.55; }
.cmcp-todo-item.done span { text-decoration: line-through; }
.cmcp-todo-item.done .pi { color: var(--p-green-400, #4ade80); }
.cmcp-todo-item.active { font-weight: 600; }
.cmcp-todo-item.active .pi { color: var(--p-primary-color, #60a5fa); }
.cmcp-todo-item.pending .pi { opacity: 0.5; }
.cmcp-dl { margin-bottom: 0.4rem; }
.cmcp-dl-item { padding: 0.18rem 0; }
.cmcp-dl-top { display: flex; justify-content: space-between; gap: 0.5rem; align-items: baseline; }
.cmcp-dl-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cmcp-dl-meta { flex: none; opacity: 0.7; font-size: 0.62rem; }
.cmcp-dl-bar { height: 4px; border-radius: 999px; background: var(--p-surface-700, #3f3f46); overflow: hidden; margin-top: 0.2rem; }
.cmcp-dl-fill { height: 100%; background: var(--p-primary-color, #3a7bd5); transition: width 0.3s ease; }
.cmcp-dl-item.done .cmcp-dl-fill { background: var(--p-green-400, #4ade80); }
.cmcp-dl-item.error .cmcp-dl-fill { background: var(--p-red-400, #f87171); }
.cmcp-dl-bar.indet .cmcp-dl-fill { width: 30%; animation: cmcp-indet 1.1s ease-in-out infinite; }
@keyframes cmcp-indet { 0% { margin-left: -30%; } 100% { margin-left: 100%; } }
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
.cmcp-card-head { display: flex; align-items: center; gap: 0.375rem; font-weight: 600; min-width: 0; }
.cmcp-card-head .pi { font-size: 0.75rem; color: var(--p-primary-color, #60a5fa); flex: none; }
.cmcp-card-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cmcp-card.error .cmcp-card-head .pi { color: var(--p-red-400, #f87171); }
.cmcp-card-detail {
  margin-top: 0.25rem; color: var(--p-text-muted-color, #a1a1aa);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.6875rem;
  overflow-x: auto; white-space: pre-wrap; word-break: break-word;
  max-height: 7.5rem; overflow-y: auto;
}

.cmcp-dropzone {
  position: absolute; inset: 0; z-index: 60;
  /* hidden by default — shown only while dragging a file over the composer.
     NB: use display:none (not the [hidden] attr) because an author display rule
     would otherwise override the UA [hidden]{display:none}. */
  display: none; align-items: center; justify-content: center;
  border: 2px dashed var(--p-primary-color, #3b82f6);
  border-radius: 10px;
  background: color-mix(in srgb, var(--p-primary-color, #3b82f6) 16%, var(--p-surface-900, #18181b));
  color: var(--p-primary-color, #60a5fa); font-weight: 600; font-size: 0.85rem;
  pointer-events: none; animation: cmcp-in 0.12s ease-out;
}
.cmcp-dropzone.cmcp-show { display: flex; }
.cmcp-dropzone span { display: inline-flex; align-items: center; gap: 0.4rem; }
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

/* ---- live streaming: thinking accordion + reply preview ---- */
/* The "see thinking" disclosure above a streaming reply. Open + scrollable while
   the model reasons; collapses to a discreet one-line summary once text starts. */
.cmcp-think {
  margin: 0 0 0.5rem; border: 1px solid var(--p-content-border-color, #3f3f46);
  border-radius: var(--p-border-radius-md, 6px);
  background: var(--p-surface-900, #18181b);
}
.cmcp-think > summary {
  list-style: none; cursor: pointer; user-select: none;
  padding: 0.3125rem 0.5rem; font-size: 0.6875rem; font-weight: 600;
  color: var(--p-text-muted-color, #a1a1aa);
  display: flex; align-items: center; gap: 0.375rem;
}
.cmcp-think > summary::-webkit-details-marker { display: none; }
.cmcp-think > summary::before {
  content: "\\25b8"; font-size: 0.625rem; transition: transform 0.15s;
}
.cmcp-think[open] > summary::before { transform: rotate(90deg); }
.cmcp-think-body {
  max-height: 11rem; overflow-y: auto;
  padding: 0 0.5rem 0.4375rem 0.875rem;
  font-size: 0.6875rem; line-height: 1.45;
  color: var(--p-text-muted-color, #8a8a93);
  white-space: pre-wrap; word-break: break-word;
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
}
/* While open & streaming, a soft pulse on the summary so it reads as "live". */
.cmcp-think[open] > summary { color: var(--p-primary-color, #60a5fa); }
/* Blinking caret on the reply preview while it streams in. */
.cmcp-reply.streaming-cursor::after {
  content: "\\258b"; margin-left: 1px; color: var(--p-primary-color, #60a5fa);
  animation: cmcp-caret 1s step-end infinite;
}
@keyframes cmcp-caret { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }

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
/* Slash commands: keep the short /command always visible and let the (often
   long) hint truncate instead — otherwise a long hint collapsed the label. */
.cmcp-popover-item.cmcp-slash .lbl { flex: 0 0 auto; }
.cmcp-popover-item.cmcp-slash small { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
  // Expose this panel's root so canvas "fit" can measure how much of the canvas
  // the open panel occludes and frame the graph in the visible area.
  activePanelRoot = root;

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
  const reloadBtn = iconBtn("pi-sync", "Soft reload the agent — picks up new code, keeps ComfyUI and this conversation");
  reloadBtn.addEventListener("click", () => softReload("user", "orchestrator"));
  actions.append(reloadBtn, newChatBtn, historyBtn);

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
  body.style.position = "relative"; // anchor the "new messages" pill
  body.appendChild(log);

  // Discord-style sticky autoscroll: follow new content only while the user is
  // already at the bottom. If they've scrolled up to read, leave them there and
  // surface a "New messages" pill that smooth-scrolls back down.
  let stickToBottom = true;
  const BOTTOM_SLACK_PX = 48;
  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight <= BOTTOM_SLACK_PX;
  const newMsgBtn = document.createElement("button");
  newMsgBtn.type = "button";
  newMsgBtn.className = "cmcp-newmsg";
  newMsgBtn.hidden = true;
  newMsgBtn.innerHTML = '<i class="pi pi-arrow-down"></i> New messages';
  newMsgBtn.addEventListener("click", () => {
    stickToBottom = true;
    newMsgBtn.hidden = true;
    log.scrollTo({ top: log.scrollHeight, behavior: "smooth" });
  });
  // Track the user's scroll position; re-stick (and hide the pill) at the bottom.
  log.addEventListener("scroll", () => {
    stickToBottom = atBottom();
    if (stickToBottom) newMsgBtn.hidden = true;
  });
  body.appendChild(newMsgBtn);
  root.appendChild(body);

  // Footer status tray — docked above the composer. Hosts the agent's live TODO
  // checklist (download progress rows slot in here later). Hidden until non-empty.
  let todoItems = [];
  let downloadItems = [];
  const tray = document.createElement("div");
  tray.className = "cmcp-tray";
  tray.hidden = true;
  root.appendChild(tray);

  function fmtBytes(n) {
    if (!n || n < 1024) return `${n || 0} B`;
    const u = ["KB", "MB", "GB", "TB"];
    let i = -1;
    let v = n;
    do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
    return `${v.toFixed(1)} ${u[i]}`;
  }

  function renderTray() {
    tray.replaceChildren();
    const hasDl = downloadItems.length > 0;
    const hasTodo = todoItems.length > 0;
    tray.hidden = !hasDl && !hasTodo;
    if (tray.hidden) return;

    if (hasDl) {
      const dl = document.createElement("div");
      dl.className = "cmcp-dl";
      const head = document.createElement("div");
      head.className = "cmcp-tray-head";
      head.textContent = "Downloads";
      dl.appendChild(head);
      for (const d of downloadItems) {
        const total = d && Number(d.total) > 0 ? Number(d.total) : 0;
        const got = d && Number(d.downloaded) > 0 ? Number(d.downloaded) : 0;
        const pct = total ? Math.min(100, Math.round((100 * got) / total)) : null;
        const failed = d && (d.status === "error" || d.status === "failed");
        const done = d && d.status === "done";
        const row = document.createElement("div");
        row.className = "cmcp-dl-item" + (failed ? " error" : done ? " done" : "");
        const top = document.createElement("div");
        top.className = "cmcp-dl-top";
        const name = document.createElement("span");
        name.className = "cmcp-dl-name";
        name.textContent = (d && d.name) || "download";
        name.title = name.textContent;
        const meta = document.createElement("span");
        meta.className = "cmcp-dl-meta";
        const speed = d && Number(d.bytes_per_sec) > 0 ? `${fmtBytes(Number(d.bytes_per_sec))}/s` : "";
        meta.textContent = failed
          ? "failed"
          : done
            ? "done"
            : [pct != null ? `${pct}%` : "…", speed].filter(Boolean).join(" · ");
        top.append(name, meta);
        row.appendChild(top);
        const barWrap = document.createElement("div");
        barWrap.className = "cmcp-dl-bar" + (pct == null && !done && !failed ? " indet" : "");
        const fill = document.createElement("div");
        fill.className = "cmcp-dl-fill";
        fill.style.width = `${done ? 100 : (pct ?? (failed ? 100 : 30))}%`;
        barWrap.appendChild(fill);
        row.appendChild(barWrap);
        dl.appendChild(row);
      }
      tray.appendChild(dl);
    }

    if (hasTodo) {
      const list = document.createElement("div");
      list.className = "cmcp-todo";
      const doneN = todoItems.filter((it) => it && it.status === "done").length;
      const head = document.createElement("div");
      head.className = "cmcp-tray-head";
      head.textContent = `Plan · ${doneN}/${todoItems.length}`;
      list.appendChild(head);
      for (const it of todoItems) {
        const status = it && it.status === "active" ? "active" : it && it.status === "done" ? "done" : "pending";
        const row = document.createElement("div");
        row.className = "cmcp-todo-item " + status;
        const icon = document.createElement("i");
        icon.className =
          "pi " + (status === "done" ? "pi-check-circle" : status === "active" ? "pi-spin pi-spinner" : "pi-circle");
        const txt = document.createElement("span");
        txt.textContent = (it && it.text) || "";
        row.append(icon, txt);
        list.appendChild(row);
      }
      tray.appendChild(list);
    }
    scrollLog();
  }
  function renderTodo(items) {
    todoItems = Array.isArray(items) ? items : [];
    renderTray();
  }
  function renderDownloads(downloads) {
    downloadItems = (Array.isArray(downloads) ? downloads : []).filter(Boolean);
    renderTray();
  }

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
    if (!stickToBottom) {
      // User is reading further up — don't yank them down; offer the jump pill.
      newMsgBtn.hidden = false;
      return;
    }
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
    t.className = "cmcp-card-text";
    t.textContent = text;
    t.title = text; // full value on hover (the line is ellipsized)
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

  /**
   * Render an interactive question card and resolve with the user's pick.
   * `msg` = { question, header?, options:[{label, description?}], multi_select? }.
   * Single-select resolves on click; multi-select toggles and resolves on Submit.
   * An always-present "Other…" field lets the user answer freely. Returns the
   * chosen string (comma-joined for multi-select) — the agent's tool result.
   */
  function paintQuestion(msg) {
    clearEmpty();
    const opts = Array.isArray(msg.options) ? msg.options : [];
    const multi = !!msg.multi_select;
    const card = document.createElement("div");
    card.className = "cmcp-card cmcp-question";
    card.style.cssText = "border-left:3px solid var(--p-primary-color,#3a7bd5);";

    if (msg.header) {
      const chip = document.createElement("div");
      chip.className = "cmcp-card-head";
      chip.style.cssText = "text-transform:uppercase;font-size:0.6rem;letter-spacing:0.05em;opacity:0.7;";
      chip.textContent = msg.header;
      card.appendChild(chip);
    }
    const q = document.createElement("div");
    q.style.cssText = "font-weight:600;margin:0.15rem 0 0.5rem;";
    renderRichText(q, msg.question || "Pick one:");
    card.appendChild(q);

    const selected = new Set();
    let done = false;
    let resolveFn;
    const promise = new Promise((res) => { resolveFn = res; });

    const finish = (answer) => {
      if (done) return;
      done = true;
      // Collapse the interactive card into a STATIC result — remove every button
      // and input so it no longer looks clickable / awaiting an answer.
      card.replaceChildren();
      card.classList.remove("cmcp-question");
      card.style.cssText = "border-left:3px solid var(--p-primary-color,#3a7bd5);opacity:0.9;";
      if (msg.question) {
        const q = document.createElement("div");
        q.style.cssText = "font-size:0.72rem;opacity:0.65;";
        q.textContent = msg.question;
        card.appendChild(q);
      }
      const a = document.createElement("div");
      a.style.cssText = "font-weight:600;margin-top:0.15rem;color:var(--p-primary-color,#6ea8fe);";
      a.textContent = `✓ ${answer}`;
      card.appendChild(a);
      // Record as a plain card so a reload restores it as static text, not a widget.
      record({ role: "card", icon: "pi-check", text: msg.question || "Choice", detail: answer });
      scrollLog();
      resolveFn(answer);
    };

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;flex-direction:column;gap:0.3rem;";
    for (const opt of opts) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "cmcp-opt";
      b.style.cssText =
        "text-align:left;padding:0.4rem 0.55rem;border-radius:6px;border:1px solid var(--p-surface-500,#555);" +
        "background:var(--p-surface-800,#2a2a2a);color:inherit;cursor:pointer;font-size:0.8rem;";
      const lbl = document.createElement("div");
      lbl.style.fontWeight = "600";
      lbl.textContent = opt.label ?? String(opt);
      b.appendChild(lbl);
      if (opt.description) {
        const d = document.createElement("div");
        d.style.cssText = "font-size:0.7rem;opacity:0.7;margin-top:0.1rem;";
        d.textContent = opt.description;
        b.appendChild(d);
      }
      b.addEventListener("click", () => {
        if (done) return;
        if (multi) {
          const label = opt.label ?? String(opt);
          if (selected.has(label)) { selected.delete(label); b.style.borderColor = "var(--p-surface-500,#555)"; }
          else { selected.add(label); b.style.borderColor = "var(--p-primary-color,#3a7bd5)"; }
        } else {
          finish(opt.label ?? String(opt));
        }
      });
      btnRow.appendChild(b);
    }
    card.appendChild(btnRow);

    // Always-available free-text answer ("Other").
    const otherRow = document.createElement("div");
    otherRow.style.cssText = "display:flex;gap:0.3rem;margin-top:0.4rem;";
    const other = document.createElement("input");
    other.type = "text";
    other.placeholder = "Other… (type your own answer)";
    other.style.cssText =
      "flex:1;padding:0.35rem 0.5rem;border-radius:6px;border:1px solid var(--p-surface-500,#555);" +
      "background:var(--p-surface-900,#1e1e1e);color:inherit;font-size:0.8rem;";
    other.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && other.value.trim()) { e.preventDefault(); finish(other.value.trim()); }
    });
    otherRow.appendChild(other);

    const submit = document.createElement("button");
    submit.type = "button";
    submit.style.cssText =
      "padding:0.35rem 0.7rem;border-radius:6px;border:none;cursor:pointer;font-size:0.8rem;" +
      "background:var(--p-primary-color,#3a7bd5);color:#fff;";
    submit.textContent = multi ? "Submit" : "Send";
    submit.addEventListener("click", () => {
      if (done) return;
      if (other.value.trim()) finish(other.value.trim());
      else if (multi && selected.size) finish([...selected].join(", "));
    });
    otherRow.appendChild(submit);
    card.appendChild(otherRow);

    log.appendChild(card);
    scrollLog();
    return promise;
  }

  /**
   * Render a SECURE secret/token input and resolve with the pasted value.
   * `msg` = { label?, hint? }. The value is masked, never echoed back into the
   * chat, and NEVER recorded to history — only the agent-supplied label and a
   * redacted "received" note are kept. The resolved string travels straight back
   * over the bridge to the orchestrator (which writes it to config); it never
   * enters the agent's context.
   */
  function paintSecret(msg) {
    clearEmpty();
    const card = document.createElement("div");
    card.className = "cmcp-card cmcp-secret";
    card.style.cssText = "border-left:3px solid var(--p-yellow-400,#facc15);";

    const head = document.createElement("div");
    head.className = "cmcp-card-head";
    const lock = document.createElement("i");
    lock.className = "pi pi-lock";
    const t = document.createElement("span");
    t.style.fontWeight = "600";
    t.textContent = msg.label || "Paste your token";
    head.append(lock, t);
    card.appendChild(head);

    const hint = document.createElement("div");
    hint.style.cssText = "font-size:0.68rem;opacity:0.7;margin:0.2rem 0 0.4rem;";
    hint.textContent =
      msg.hint || "Sent straight to your config — never shown to the agent and never saved to chat history.";
    card.appendChild(hint);

    let done = false;
    let resolveFn;
    const promise = new Promise((res) => { resolveFn = res; });

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:0.3rem;";
    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = "Paste token…";
    input.style.cssText =
      "flex:1;padding:0.35rem 0.5rem;border-radius:6px;border:1px solid var(--p-surface-500,#555);" +
      "background:var(--p-surface-900,#1e1e1e);color:inherit;font-size:0.8rem;";

    // Show/record only a masked preview (first 4 … last 4) so the user can
    // confirm WHICH token without ever exposing the full value.
    const mask = (v) =>
      !v ? "" : v.length <= 8 ? "•".repeat(v.length) : `${v.slice(0, 4)}…${v.slice(-4)}`;
    const finish = (value) => {
      if (done) return;
      done = true;
      input.value = ""; // clear the field immediately
      card.replaceChildren();
      card.style.cssText = "border-left:3px solid var(--p-green-400,#4ade80);opacity:0.9;";
      const ok = document.createElement("div");
      ok.style.cssText = "font-size:0.75rem;color:var(--p-green-400,#4ade80);";
      const m = mask(value);
      ok.textContent = value ? `🔒 Token saved: ${m}` : "Skipped — no token entered.";
      card.appendChild(ok);
      // Record ONLY the masked preview — never the full value.
      record({ role: "card", icon: "pi-lock", text: msg.label || "Token", detail: value ? `saved ${m}` : "skipped" });
      scrollLog();
      resolveFn(value || "");
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(input.value.trim()); }
    });
    row.appendChild(input);

    const submit = document.createElement("button");
    submit.type = "button";
    submit.style.cssText =
      "padding:0.35rem 0.7rem;border-radius:6px;border:none;cursor:pointer;font-size:0.8rem;" +
      "background:var(--p-primary-color,#3a7bd5);color:#fff;";
    submit.textContent = "Save";
    submit.addEventListener("click", () => finish(input.value.trim()));
    row.appendChild(submit);

    const skip = document.createElement("button");
    skip.type = "button";
    skip.style.cssText =
      "padding:0.35rem 0.6rem;border-radius:6px;border:1px solid var(--p-surface-500,#555);" +
      "background:transparent;color:inherit;cursor:pointer;font-size:0.8rem;";
    skip.textContent = "Skip";
    skip.addEventListener("click", () => finish(""));
    row.appendChild(skip);

    card.appendChild(row);
    log.appendChild(card);
    scrollLog();
    setTimeout(() => input.focus(), 0);
    return promise;
  }

  function appendUser(text) {
    stickToBottom = true; // your own message → always jump to the latest
    newMsgBtn.hidden = true;
    paintUser(text);
    record({ role: "user", text });
  }

  function appendAgent(text) {
    paintAgent(text);
    record({ role: "agent", text });
  }

  // ---- live streaming (thinking + reply) ----
  // A streaming bubble is keyed by the SDK message id so deltas stay coherent and
  // the final committed `say` (same id) REPLACES the preview rather than adding a
  // duplicate. Thinking text streams into a "see thinking" accordion that's open
  // (and scrollable) while the model reasons, then collapses the instant reply
  // text begins. Reply text streams as plain text with a caret; on commit it's
  // re-rendered as full markdown.
  const streamBubbles = new Map(); // id -> { el, thinkWrap, thinkBody, thinkSummary, replyEl, thinkText, replyText }

  function ensureStreamBubble(id) {
    let s = streamBubbles.get(id);
    if (s) return s;
    clearEmpty();
    const el = document.createElement("div");
    el.className = "cmcp-bubble agent streaming";
    const replyEl = document.createElement("div");
    replyEl.className = "cmcp-reply";
    el.appendChild(replyEl);
    log.appendChild(el);
    s = { el, thinkWrap: null, thinkBody: null, thinkSummary: null, replyEl, thinkText: "", replyText: "" };
    streamBubbles.set(id, s);
    bumpThinking(); // keep the working indicator pinned below the new bubble
    return s;
  }

  function ensureThinkArea(s) {
    if (s.thinkWrap) return s;
    const det = document.createElement("details");
    det.className = "cmcp-think";
    det.open = true;
    const sum = document.createElement("summary");
    sum.textContent = "Thinking…";
    const body = document.createElement("div");
    body.className = "cmcp-think-body";
    det.append(sum, body);
    s.el.insertBefore(det, s.replyEl); // thinking sits above the reply
    s.thinkWrap = det;
    s.thinkBody = body;
    s.thinkSummary = sum;
    return s;
  }

  function collapseThinking(s, label) {
    if (s.thinkWrap) {
      s.thinkWrap.open = false;
      if (s.thinkSummary) s.thinkSummary.textContent = label;
    }
  }

  function onStreamDelta(msg) {
    const { phase, id } = msg;
    const delta = typeof msg.delta === "string" ? msg.delta : "";
    if (phase === "think") {
      const s = ensureStreamBubble(id);
      ensureThinkArea(s);
      s.thinkText += delta;
      s.thinkBody.textContent = s.thinkText;
      s.thinkBody.scrollTop = s.thinkBody.scrollHeight; // follow the newest reasoning
      scrollLog();
    } else if (phase === "text") {
      const s = ensureStreamBubble(id);
      collapseThinking(s, "See thinking"); // reply began → tuck the reasoning away
      s.replyText += delta;
      s.replyEl.textContent = s.replyText; // plain while streaming; markdown on commit
      s.replyEl.classList.add("streaming-cursor");
      scrollLog();
    } else if (phase === "end") {
      const s = streamBubbles.get(id);
      if (s) s.replyEl.classList.remove("streaming-cursor");
    }
  }

  /** Reconcile a committed `say` with its live preview: replace the streamed text
   *  with final markdown, collapse thinking, record to history. Returns false if
   *  there's no matching stream bubble (caller falls back to a normal bubble). */
  function commitStream(id, text) {
    const s = streamBubbles.get(id);
    if (!s) return false;
    s.replyEl.classList.remove("streaming-cursor");
    collapseThinking(s, "See thinking");
    renderRichText(s.replyEl, text);
    s.el.classList.remove("streaming");
    streamBubbles.delete(id);
    record({ role: "agent", text }); // thinking is ephemeral — only the reply persists
    scrollLog();
    return true;
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
    streamBubbles.clear(); // drop any in-flight streaming previews (DOM is gone)
    log.appendChild(empty);
  }

  function newChat() {
    thread = null;
    ssSet(CURRENT_THREAD_KEY, null);
    ssSet(SESSION_KEY, null);
    ssSet(CTX_KEY, null);
    if (typeof resetAttachments === "function") resetAttachments();
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

  // ---- "working" indicator ----
  // Driven by the turn lifecycle (turn:working / turn:done from the orchestrator,
  // plus the optimistic show on send). It stays up through the WHOLE turn —
  // including silent tool work where nothing posts to the chat — so it never
  // looks idle right before a big reply lands. Whimsical status words cycle so
  // it's clearly alive.
  const WORK_WORDS = [
    "Flibbertigibbeting",
    "Reticulating splines",
    "Percolating",
    "Noodling",
    "Conjuring nodes",
    "Wrangling tensors",
    "Untangling the graph",
    "Spelunking latent space",
    "Frobnicating",
    "Hammering pixels",
    "Consulting the oracle",
    "Herding samplers",
    "Marinating",
    "Tinkering",
    "Vibing",
  ];
  let thinkingEl = null;
  let thinkingLabel = null;
  let workWordTimer = null;
  let workWordIdx = 0;
  let thinkingSafety = null;
  let thinkingTokens = 0;
  // Backstop: if no activity (say/command/turn signal) for this long, auto-hide
  // — covers a missed turn:done (e.g. an older orchestrator, or an errored turn)
  // so the indicator never sticks forever.
  const THINKING_SAFETY_MS = 120000;

  function armSafety() {
    if (thinkingSafety) clearTimeout(thinkingSafety);
    thinkingSafety = setTimeout(hideThinking, THINKING_SAFETY_MS);
  }

  function fmtThinkTokens(n) {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
  }
  function cycleWord() {
    if (!thinkingLabel) return;
    const base =
      thinkingTokens > 0
        ? `Thinking… (${fmtThinkTokens(thinkingTokens)} tokens)`
        : `${WORK_WORDS[workWordIdx % WORK_WORDS.length]}…`;
    thinkingLabel.textContent = `${base} (Ctrl+C to stop)`;
    workWordIdx += 1;
  }
  // Live extended-thinking token meter (from the orchestrator's thinking frame).
  function setThinkingTokens(n) {
    thinkingTokens = Number(n) || 0;
    if (!thinkingEl) showThinking();
    cycleWord();
    armSafety();
  }

  function hideThinking() {
    if (workWordTimer) {
      clearInterval(workWordTimer);
      workWordTimer = null;
    }
    if (thinkingSafety) {
      clearTimeout(thinkingSafety);
      thinkingSafety = null;
    }
    if (thinkingEl) {
      thinkingEl.remove();
      thinkingEl = null;
      thinkingLabel = null;
    }
    thinkingTokens = 0; // reset so the next turn doesn't show a stale count
  }

  function showThinking() {
    if (!thinkingEl) {
      clearEmpty();
      thinkingEl = document.createElement("div");
      thinkingEl.className = "cmcp-thinking";
      const dots = document.createElement("span");
      dots.className = "cmcp-thinking-dots";
      for (let i = 0; i < 3; i += 1) dots.appendChild(document.createElement("span"));
      thinkingLabel = document.createElement("span");
      thinkingEl.append(dots, thinkingLabel);
      log.appendChild(thinkingEl);
    }
    workWordIdx = 0;
    cycleWord();
    if (!workWordTimer) workWordTimer = setInterval(cycleWord, 2600);
    armSafety();
    scrollLog();
  }

  /** Keep the indicator pinned below the newest message/activity card. */
  function bumpThinking() {
    if (!thinkingEl) return;
    log.appendChild(thinkingEl);
    armSafety();
    scrollLog();
  }

  // ---- auto-fit: after the agent makes structural edits, zoom/center the
  // canvas so the user can watch what's being built (it's usually zoomed in).
  // Debounced so a burst of adds/wires/subgraphs settles into ONE fit, and only
  // for agent-driven structural ops (never the user's own panning/widget tweaks).
  const AUTOFIT_CMDS = new Set([
    "graph_add_node",
    "graph_remove_node",
    "graph_connect",
    "graph_disconnect",
    "graph_create_subgraph",
    "graph_enter_subgraph",
    "graph_exit_subgraph",
  ]);
  let autoFitTimer = null;
  function scheduleAutoFit() {
    if (autoFitTimer) clearTimeout(autoFitTimer);
    autoFitTimer = setTimeout(() => {
      autoFitTimer = null;
      try {
        GRAPH_TOOL_EXECUTORS.graph_canvas({ action: "fit" });
      } catch {
        // empty graph / canvas unavailable — nothing to fit
      }
    }, 700);
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
      // (Post-restart resume is handled in onAck on the "ready" ack, which the
      // orchestrator sends only AFTER it has armed hello.resume — so the nudge
      // can't out-race the session resume.)
    },
    onSay(text, meta) {
      // If this reply was streamed, commit it into its live preview bubble (same
      // message id) instead of painting a duplicate. Otherwise paint normally.
      // Either way KEEP the working indicator — the turn isn't over until
      // turn:done (a turn often emits progress text, then works on silently).
      if (!(meta && meta.id && commitStream(meta.id, text))) appendAgent(text);
      bumpThinking();
    },
    // Live streaming deltas (thinking + reply text) before the committed say.
    onStream(msg) {
      onStreamDelta(msg);
    },
    // The agent called panel_ask — render a question card and resolve with the
    // user's pick. Keep the working indicator pinned below it while we wait.
    onAsk(msg) {
      const p = paintQuestion(msg);
      bumpThinking();
      return p;
    },
    // The agent called panel_set_todo — render/update the live plan tray.
    onTodo(items) {
      renderTodo(items);
    },
    // Orchestrator pushed live download progress → render rows in the tray.
    onDownloads(list) {
      renderDownloads(list);
    },
    // Live extended-thinking token count → update the working indicator.
    onThinking(tokens) {
      setThinkingTokens(tokens);
    },
    // The agent called panel_request_secret — collect a token securely.
    onSecret(msg) {
      const p = paintSecret(msg);
      bumpThinking();
      return p;
    },
    // The agent called panel_reload — perform the soft reload it asked for.
    onReload(scope) {
      softReload("agent", scope);
    },
    onTurn(state) {
      if (state === "working") {
        showThinking();
        ssSet(MID_TASK_KEY, "1"); // a turn is in flight — arm the resume nudge
      } else if (state === "done") {
        hideThinking();
        ssSet(MID_TASK_KEY, null); // turn finished cleanly — nothing to resume
      }
    },
    onLog(text) {
      appendSystem(text);
    },
    onCommand(cmd, msg, reply) {
      appendActivity(cmd, msg, reply);
      bumpThinking();
      // After structural edits, zoom/center the canvas so the user can watch it
      // come together (debounced — one fit per burst).
      if (reply.ok && AUTOFIT_CMDS.has(cmd)) scheduleAutoFit();
      // The agent restarted ComfyUI — arm the auto-resume so we reconnect and
      // nudge it to continue once ComfyUI is back (install→restart→continue).
      if (cmd === "comfy_reboot" && reply.ok) {
        ssSet(REBOOT_KEY, "1");
        appendSystem("Restarting ComfyUI to load new nodes — I'll reconnect and pick up automatically when it's back.");
      }
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
    onAck(ack) {
      // Post-restart auto-resume (#3): the "ready" ack is sent after the
      // orchestrator armed hello.resume, so resuming the agent is safe now.
      // Clear REBOOT_KEY only here (on actual send) so a drop mid-reconnect
      // retries instead of losing the resume.
      if (ack?.kind === "ready" && ssGet(REBOOT_KEY)) {
        ssSet(REBOOT_KEY, null);
        appendSystem("Reconnected — resuming where we left off.");
        showThinking();
        client.sendUserMessage(
          "✅ ComfyUI just restarted to load newly-installed custom nodes (now available). Continue what you were doing before the restart — if you were mid-build, pick it back up.",
        );
        return;
      }
      // Soft-reload resume: the fresh orchestrator is up. Resume silently for a
      // user-triggered reload; nudge to continue for an agent-triggered one
      // (it was mid-task and its tool call died with the old process).
      if (ack?.kind === "ready" && ssGet(SOFT_RELOAD_KEY)) {
        const origin = ssGet(SOFT_RELOAD_KEY);
        ssSet(SOFT_RELOAD_KEY, null);
        ssSet(MID_TASK_KEY, null); // deliberate reload — don't also fire the drop nudge
        appendSystem("Agent reloaded — session resumed.");
        if (origin === "agent") {
          showThinking();
          client.sendUserMessage(
            "✅ You were just soft-reloaded to pick up code changes (no ComfyUI restart) — your tools and system prompt are now the latest build. Continue exactly what you were doing before the reload.",
          );
        }
        return;
      }
      // Unexpected bounce while mid-task — a DIFFERENT agent restarting ComfyUI
      // (to load nodes), a crash, or an SDK self-heal. The session resumed with
      // full context but has no pending turn, so it would sit idle. Nudge it.
      if (ack?.kind === "ready" && ssGet(MID_TASK_KEY)) {
        ssSet(MID_TASK_KEY, null);
        // Only nudge for a REAL restart. A fast reconnect (a panel remount from a
        // sidebar swap, or a brief WS blip) means the orchestrator never died —
        // the agent's turn kept running — so a "you dropped" nudge is false AND
        // would inject a spurious turn into a live session. A real ComfyUI restart
        // takes many seconds to come back, so a long gap since the drop = real.
        if (Date.now() - lastBridgeDownAt < 6000) return;
        appendSystem("Reconnected — picking up where we left off.");
        showThinking();
        client.sendUserMessage(
          "✅ Your connection dropped mid-task (e.g. ComfyUI was restarted, possibly by another agent installing nodes). The session resumed with full context — continue exactly what you were doing before the drop; if you were mid-build or mid-edit, pick it right back up.",
        );
      }
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
  // Post-restart autonomy (#3): ComfyUI's api fires `reconnecting` when the
  // server goes down (e.g. a Manager reboot) and `reconnected` when it's back.
  // After a reboot we triggered, respawn the orchestrator (it died with ComfyUI)
  // so the bridge can reconnect; onStatus(connected) then resumes the agent.
  function onComfyReconnecting() {
    // Only flag a restart if our bridge actually went down — a benign ComfyUI WS
    // blip (asset view / image check) shouldn't print a false "restarting" alarm.
    if ((ssGet(REBOOT_KEY) || lsGet(AUTOCONNECT_KEY)) && !client.isConnected()) {
      appendSystem("ComfyUI is restarting…");
    }
  }
  function onComfyReconnected() {
    // After ComfyUI comes back (backend-only reboot — the page didn't reload),
    // the orchestrator died with it. Respawn + reconnect if the agent was in use:
    // either a restart WE triggered (REBOOT_KEY) or sticky auto-connect.
    if (!ssGet(REBOOT_KEY) && !lsGet(AUTOCONNECT_KEY)) return;
    // ComfyUI fires "reconnected" for BENIGN WS blips too — viewing assets,
    // checking an image's status, a tab refocus — and those do NOT kill the
    // orchestrator. If OUR bridge is still up, the agent is alive and well, so
    // do NOT bounce a live session (that was the spurious "you reconnected"). A
    // real ComfyUI restart drops the bridge (the orchestrator dies with it, and
    // the bridge's own retry can't respawn it) — only then do we respawn here.
    if (client.isConnected()) return;
    appendSystem("ComfyUI is back — reconnecting the agent…");
    connectAgent();
  }
  try {
    api.addEventListener("executed", onExecuted);
    api.addEventListener("execution_error", onExecError);
    api.addEventListener("reconnecting", onComfyReconnecting);
    api.addEventListener("reconnected", onComfyReconnected);
  } catch {
    // api unavailable — execution surfacing disabled
  }

  saveBtn.addEventListener("click", () => {
    client.setUrl(urlInput.value.trim());
    appendSystem(`Reconnecting to ${client.currentUrl()}…`);
  });

  // Connect: ask ComfyUI's server to start the background agent on demand, then
  // open the bridge. The orchestrator is only ever spawned by this click — or by
  // the post-restart auto-resume. In-flight guard so the multiple callers
  // (button, reconnected event, mount auto-resume) can't double-spawn.
  let connecting = false;
  async function connectAgent() {
    if (connecting) return;
    connecting = true;
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
    } finally {
      connecting = false;
    }
    // Connect (or keep reconnecting with backoff until the bridge binds).
    client.start();
  }
  connectBtn.addEventListener("click", connectAgent);

  // Soft reload: pick up new code WITHOUT restarting ComfyUI, keeping this
  // conversation. Two scopes:
  //   • "orchestrator" — respawn the background agent (new tools / prompt /
  //     services). Drops the bridge; the fresh orchestrator resumes the session
  //     (SESSION_KEY) and onAck continues it.
  //   • "frontend" — reload just this panel page (new panel JS); ComfyUI and the
  //     orchestrator stay up, and the reconnect resumes the session.
  // `origin` ("user" | "agent") only affects whether we nudge the agent to
  // continue after an orchestrator reload (agent-triggered = it was mid-task).
  let reloading = false;
  async function softReload(origin = "user", scope = "orchestrator") {
    if (reloading) return;
    if (scope === "frontend") {
      // Nothing to respawn — just re-fetch the panel with a cache-bust. The
      // session id persists in sessionStorage, so we reconnect + resume on load.
      // Arm the reopen flag so our sidebar tab re-activates after the reload
      // (ComfyUI won't, since our tab isn't registered yet when it restores).
      ssSet(SIDEBAR_REOPEN_KEY, "1");
      appendSystem("Reloading the panel UI (new frontend code)…");
      try {
        const u = new URL(window.location.href);
        u.searchParams.set("cmcpReload", String(Date.now()));
        window.location.replace(u.toString());
      } catch {
        window.location.reload();
      }
      return;
    }
    reloading = true;
    reloadBtn.classList.add("cmcp-spin");
    ssSet(SOFT_RELOAD_KEY, origin === "agent" ? "agent" : "user");
    appendSystem("Soft-reloading the agent (new code, no ComfyUI restart)…");
    try {
      client.stop(); // drop the bridge so the old orchestrator can release the port
      const res = await api.fetchApi("/comfyui_mcp_panel/reload", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!data?.ok) {
        ssSet(SOFT_RELOAD_KEY, null);
        appendSystem(data?.message || "Soft reload failed — try Disconnect then Connect.");
        return;
      }
    } catch (err) {
      ssSet(SOFT_RELOAD_KEY, null);
      appendSystem(`Couldn't reach ComfyUI to reload the agent: ${err?.message ?? err}`);
      return;
    } finally {
      reloading = false;
      reloadBtn.classList.remove("cmcp-spin");
    }
    // Reconnect with backoff until the fresh orchestrator binds; onAck resumes.
    client.start();
  }

  disconnectBtn.addEventListener("click", async () => {
    // Explicit Disconnect = opt out of sticky auto-reconnect.
    lsSet(AUTOCONNECT_KEY, null);
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
      cmd: "/reload",
      icon: "pi-sync",
      hint: "soft-reload the agent (new code, keeps ComfyUI + this chat)",
      run: () => softReload("user", "orchestrator"),
    },
    {
      cmd: "/reload-ui",
      icon: "pi-refresh",
      hint: "reload just the panel UI (new frontend code, keeps the session)",
      run: () => softReload("user", "frontend"),
    },
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
      el.className =
        "cmcp-popover-item" + (idx === 0 ? " sel" : "") + (item.kind === "slash" ? " cmcp-slash" : "");
      const i = document.createElement("i");
      i.className = `pi ${item.icon}`;
      const lbl = document.createElement("span");
      lbl.className = "lbl";
      lbl.textContent = item.label;
      lbl.title = item.label;
      el.append(i, lbl);
      if (item.small) {
        const s = document.createElement("small");
        s.textContent = item.small;
        s.title = item.small;
        el.appendChild(s);
      }
      // Full text on hover for the whole row, so anything truncated is readable.
      el.title = item.small ? `${item.label} — ${item.small}` : item.label;
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
  // The attach button now uses the same chip pipeline as drag/paste — a [Image #N]
  // chip + structured ref, delivered inline to the agent on send.
  fileInput.addEventListener("change", () => {
    for (const f of Array.from(fileInput.files || [])) handleImageFile(f);
    fileInput.value = "";
  });

  // ---- attachments: drag-drop / paste images + paste large text ----------
  // Claude-Code style: a dropped/pasted image uploads into ComfyUI input/ and
  // drops a [Image #N] chip in the composer; a big text paste collapses to a
  // [Pasted text #N] chip. On send, pasted text expands inline and images are
  // referenced (the agent can view_image them or wire a LoadImage node).
  const PASTE_TEXT_THRESHOLD = 800; // chars; longer pastes collapse to a chip
  let attachments = []; // { id, kind:"image"|"text", ... }
  let attachSeq = 0;
  function resetAttachments() {
    attachments = [];
    attachSeq = 0;
  }
  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  }
  function handleImageFile(file) {
    if (!file || !file.type?.startsWith("image/")) return;
    const id = ++attachSeq;
    const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
    const name = file.name || `pasted-${id}.${ext}`;
    const att = { id, kind: "image", name, mediaType: file.type, dataUrl: null, inputRef: null };
    attachments.push(att);
    insertAtCaret(`[Image #${id}] `);
    // Read for a thumbnail + upload to ComfyUI input/ (both async); submit awaits.
    att.ready = (async () => {
      try {
        att.dataUrl = await readAsDataURL(file);
      } catch {
        /* no preview */
      }
      try {
        const fd = new FormData();
        fd.append("image", file, name);
        const res = await api.fetchApi("/upload/image", { method: "POST", body: fd });
        if (res.status === 200) {
          const info = await res.json();
          att.inputRef = (info.subfolder ? `${info.subfolder}/` : "") + info.name;
          att.ref = { filename: info.name, subfolder: info.subfolder || undefined, type: info.type || "input" };
        }
      } catch {
        /* upload failed — the chip still references it by name as a fallback */
      }
    })();
  }
  function handlePastedText(text) {
    const id = ++attachSeq;
    attachments.push({ id, kind: "text", content: text });
    insertAtCaret(`[Pasted text #${id}] `);
  }

  // Resolve image references from an @node:<id> mention to ComfyUI /view refs:
  // a LoadImage-style input widget, and/or displayed output images (Save/Preview).
  const IMG_WIDGET_NAMES = /^(image|images|mask|video|file|filename|audio)$/i;
  function nodeImageRefs(node) {
    const out = [];
    for (const w of node?.widgets || []) {
      if (typeof w?.value === "string" && IMG_WIDGET_NAMES.test(w?.name || "")) {
        const v = w.value.replace(/\s*\[[^\]]+\]\s*$/, "").trim(); // strip " [input]"
        if (!/\.(png|jpe?g|gif|webp|bmp)$/i.test(v)) continue;
        const slash = v.lastIndexOf("/");
        out.push(
          slash >= 0
            ? { filename: v.slice(slash + 1), subfolder: v.slice(0, slash), type: "input" }
            : { filename: v, type: "input" },
        );
      }
    }
    for (const im of node?.imgs || []) {
      if (!im?.src) continue;
      try {
        const u = new URL(im.src, location.origin);
        const filename = u.searchParams.get("filename");
        if (filename) {
          out.push({
            filename,
            subfolder: u.searchParams.get("subfolder") || undefined,
            type: u.searchParams.get("type") || "output",
          });
        }
      } catch {
        /* non-view src — skip */
      }
    }
    return out;
  }

  // Gather all image refs to deliver inline with a message: attachment chips,
  // @input:<path> mentions, and @node:<id> mentions (Load/Save/Preview nodes).
  async function collectImageRefs(text, refImgs) {
    const refs = [];
    const seen = new Set();
    const add = (r) => {
      if (!r?.filename) return;
      const key = `${r.type || "input"}/${r.subfolder || ""}/${r.filename}`;
      if (seen.has(key)) return;
      seen.add(key);
      refs.push(r);
    };
    for (const a of refImgs) if (a.ref) add(a.ref);
    for (const m of text.matchAll(/@input:(.+?\.(?:png|jpe?g|gif|webp|bmp))\b/gi)) {
      const p = m[1].trim();
      const slash = p.lastIndexOf("/");
      add(slash >= 0 ? { filename: p.slice(slash + 1), subfolder: p.slice(0, slash), type: "input" } : { filename: p, type: "input" });
    }
    let graph = null;
    try {
      graph = getGraphCtx().graph;
    } catch {
      /* no graph */
    }
    if (graph?.getNodeById) {
      for (const m of text.matchAll(/@node:(\d+)/g)) {
        const node = graph.getNodeById(Number(m[1]));
        if (node) for (const r of nodeImageRefs(node)) add(r);
      }
    }
    return refs;
  }

  // Drop overlay — scoped to the COMPOSER (text area), shown only while dragging
  // a file over it. Toggled via a class (not the [hidden] attr — see CSS note).
  form.style.position = form.style.position || "relative";
  const dropzone = document.createElement("div");
  dropzone.className = "cmcp-dropzone";
  dropzone.innerHTML = '<span><i class="pi pi-image"></i> Drop image to attach</span>';
  form.appendChild(dropzone);
  let dragDepth = 0;
  const showDrop = (on) => dropzone.classList.toggle("cmcp-show", on);
  const dragHasFiles = (ev) => Array.from(ev.dataTransfer?.types || []).includes("Files");
  form.addEventListener("dragenter", (ev) => {
    if (!dragHasFiles(ev)) return;
    ev.preventDefault();
    dragDepth += 1;
    showDrop(true);
  });
  form.addEventListener("dragover", (ev) => {
    if (!dragHasFiles(ev)) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
  });
  form.addEventListener("dragleave", (ev) => {
    if (!dragHasFiles(ev)) return;
    dragDepth -= 1;
    if (dragDepth <= 0) {
      dragDepth = 0;
      showDrop(false);
    }
  });
  form.addEventListener("drop", (ev) => {
    if (!dragHasFiles(ev)) return;
    ev.preventDefault();
    dragDepth = 0;
    showDrop(false);
    for (const f of Array.from(ev.dataTransfer.files || [])) {
      if (f.type?.startsWith("image/")) handleImageFile(f);
    }
    input.focus();
  });
  input.addEventListener("paste", (ev) => {
    const dt = ev.clipboardData;
    if (!dt) return;
    const imgItem = Array.from(dt.items || []).find(
      (it) => it.kind === "file" && it.type?.startsWith("image/"),
    );
    if (imgItem) {
      const file = imgItem.getAsFile();
      if (file) {
        ev.preventDefault();
        handleImageFile(file);
        return;
      }
    }
    const text = dt.getData("text/plain");
    if (text && (text.length > PASTE_TEXT_THRESHOLD || (text.match(/\n/g) || []).length >= 12)) {
      ev.preventDefault();
      handlePastedText(text);
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

  // ---- composer history (press ↑ to recall your last message for editing) ----
  // Shell-style: ↑ from an empty composer (or with the caret at the very start)
  // walks back through messages you've sent and drops them back in the composer;
  // ↓ walks forward and finally restores the draft you were typing. Any keystroke
  // that edits the text exits history mode. Born from the muscle-memory urge to
  // press ↑ and fix a typo in the message you just fired off.
  const sentHistory = [];
  let histIdx = -1; // -1 = not navigating; otherwise an index into sentHistory
  let histDraft = ""; // the unsent draft stashed when navigation began

  function recordSent(text) {
    if (sentHistory[sentHistory.length - 1] !== text) sentHistory.push(text);
    if (sentHistory.length > 50) sentHistory.shift();
    histIdx = -1;
  }
  function setComposerValue(val) {
    input.value = val;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    const n = val.length;
    try {
      input.setSelectionRange(n, n);
    } catch {
      // detached/unsupported — value is set, caret position is cosmetic
    }
  }
  function recallPrev() {
    if (!sentHistory.length) return false;
    if (histIdx === -1) {
      histDraft = input.value;
      histIdx = sentHistory.length;
    }
    histIdx = Math.max(0, histIdx - 1);
    setComposerValue(sentHistory[histIdx]);
    return true;
  }
  function recallNext() {
    if (histIdx === -1) return false;
    histIdx += 1;
    if (histIdx >= sentHistory.length) {
      histIdx = -1;
      setComposerValue(histDraft); // back to the draft you were typing
    } else {
      setComposerValue(sentHistory[histIdx]);
    }
    return true;
  }

  // ---- submit ----
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    hideMenu();
    const text = input.value.trim();
    if (!text) return;
    recordSent(text); // remember it so ↑ can recall it later
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

    // Resolve attachment chips referenced in this message (the user may have
    // deleted some), then clear the registry for the next message.
    const refImgs = attachments.filter((a) => a.kind === "image" && text.includes(`[Image #${a.id}]`));
    const refTexts = attachments.filter((a) => a.kind === "text" && text.includes(`[Pasted text #${a.id}]`));
    resetAttachments();
    if (refImgs.length) await Promise.all(refImgs.map((a) => a.ready));
    for (const a of refImgs) if (a.dataUrl) paintImage(a.dataUrl, a.name);

    // Compose the text the AGENT receives: pasted text expands inline. Images
    // (chips + @input:/@node: mentions) are delivered as inline image blocks; a
    // short note lists chip paths as a fallback if a fetch fails.
    let sendText = text;
    for (const a of refTexts) sendText = sendText.split(`[Pasted text #${a.id}]`).join(a.content);
    const imageRefs = await collectImageRefs(text, refImgs);
    if (refImgs.length) {
      const lines = refImgs.map((a) => `#${a.id}${a.inputRef ? ` (input/${a.inputRef})` : ""}`).join(", ");
      sendText += `\n\n[Attached image(s) ${lines} — shown inline below.]`;
    }

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
    client.sendUserMessage(
      sendText,
      {
        workflow: getWorkflowTitle(),
        ...(viewing.scope === "subgraph" ? { subgraph: viewing.title } : {}),
      },
      imageRefs,
    );
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
    // ↑ recalls your previous sent message (when already navigating, or from the
    // very start of the composer so it never hijacks normal line-up movement);
    // ↓ walks forward / restores your draft. Esc bails out to the draft.
    if (ev.key === "ArrowUp" && (histIdx !== -1 || (input.selectionStart === 0 && input.selectionEnd === 0))) {
      if (recallPrev()) {
        ev.preventDefault();
        return;
      }
    }
    if (ev.key === "ArrowDown" && histIdx !== -1) {
      if (recallNext()) {
        ev.preventDefault();
        return;
      }
    }
    if (ev.key === "Escape" && histIdx !== -1) {
      ev.preventDefault();
      histIdx = -1;
      setComposerValue(histDraft);
      return;
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
    histIdx = -1; // a real edit exits message-history navigation
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
    // If a restart we triggered reloaded the page, finish the autonomous resume:
    // respawn the orchestrator and let onStatus(connected) nudge the agent.
    if (ssGet(REBOOT_KEY)) {
      connectAgent();
      return;
    }
    // Sticky auto-connect: the user connected before and didn't Disconnect, so
    // reconnect on open — respawning the orchestrator if it died (e.g. ComfyUI
    // was rebooted). This is what makes "open the panel after a reboot → it's
    // back" work without a manual Connect click.
    if (lsGet(AUTOCONNECT_KEY)) {
      connectAgent();
      return;
    }
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
        api.removeEventListener("reconnecting", onComfyReconnecting);
        api.removeEventListener("reconnected", onComfyReconnected);
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
        tooltip: "ComfyUI Agent Panel — your Claude session's window into this graph",
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

      // If WE just reloaded the page (frontend soft reload), re-open our tab so
      // the panel mounts and auto-resumes — ComfyUI's own tab-restore ran before
      // this registration, so it couldn't. Retry a few times since the sidebar
      // store may not be ready the instant setup() runs.
      if (ssGet(SIDEBAR_REOPEN_KEY)) {
        ssSet(SIDEBAR_REOPEN_KEY, null);
        let tries = 0;
        const reopen = () => {
          if (openSidebarTab() || ++tries >= 8) return;
          setTimeout(reopen, 150);
        };
        setTimeout(reopen, 120);
      }
    },
  });
}
