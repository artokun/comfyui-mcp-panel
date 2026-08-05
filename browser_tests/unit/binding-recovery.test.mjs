/**
 * Unit tests for the binding-wedged-no-recovery cluster (panel #606 / #607, on the
 * tree that absorbed #621):
 *
 *   #606 — a panel-created blank tab could wedge behind the binding guard after a
 *     reconnect: ComfyUI reuses app.graph across tabs and clear/configure does NOT
 *     reset graph.extra, so the new tab inherited the PREVIOUS workflow's root tag;
 *     with its ChangeTracker not yet PROVEN empty the both-empty heal could not fire,
 *     and nothing re-stamped the root. workflow_new now stamps the root at creation
 *     (only when the root is PROVEN content-free), and workflow_open's repaint proof
 *     re-stamps the tag directly once the content is proven (the tag riding
 *     loadGraphData/configure is a serializer DIALECT, not workflow content).
 *
 *   #607 — a fence refusal ("workflow instance mismatch") meant the orchestrator's
 *     cached stamp was stale relative to the panel's LIVE identity, yet the advertised
 *     recovery never reached that cache: the panel re-hellos (the frame the
 *     orchestrator re-stamps from) when the refusal fires.
 *
 * The harnesses extract the SHIPPING code from the panel monolith and drive it with
 * injected doubles, so the tests are about the code that actually runs (delete the
 * stamp / the re-stamp / the hook call and the matching test fails).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  graphRootProvenEmpty,
  graphRootWorkflowUuidMatches,
  graphRootMatchesState,
} from "../../web/js/lib/graph-binding.js";
import { commandTargetsActiveWorkflow } from "../../web/js/lib/workflow-chat-identity.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");
const SRC = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");

/** Balanced extraction starting at a marker's first "{", ignoring nothing fancy
 *  (the extracted regions contain no template braces outside code). `openAt` skips
 *  ahead when the marker itself contains braces (e.g. a `({ rid } = {})` param). */
function balancedFrom(src, marker, openAt = null) {
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `missing marker: ${marker}`);
  const open = openAt ?? src.indexOf("{", start + marker.length);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i + 2);
      if (i < 0) break;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2);
      if (i < 0) break;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      for (i += 1; i < src.length; i += 1) {
        if (src[i] === "\\") {
          i += 1;
          continue;
        }
        if (src[i] === quote) break;
      }
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated block: ${marker}`);
}

// ---------------------------------------------------------------------------
// #606 fix 1 — workflow_new stamps the root tag at creation (proven-empty gate)
// ---------------------------------------------------------------------------

function buildWorkflowNew({
  rootGraph,
  activeWorkflow,
  stableUuid = "uuid-new-tab",
  onStamp = () => {},
} = {}) {
  // The extracted method source, converted from object-method to standalone form.
  // The body brace is located via ") {" because the signature itself carries
  // braces ("{ rid } = {}").
  const sigStart = SRC.indexOf("async workflow_new({");
  assert.notEqual(sigStart, -1, "workflow_new not found");
  const bodyBrace = SRC.indexOf(") {", sigStart) + 1;
  const methodSource = balancedFrom(SRC, "async workflow_new({", bodyBrace).replace(
    /^async workflow_new\(/,
    "async function workflow_new(",
  );
  const factory = new Function(
    "app",
    "activeWorkflowRef",
    "workflowTabId",
    "workflowStableUuid",
    "noteOpenAttempt",
    "coerceMessageText",
    "getWorkflowTitle",
    "graphRootProvenEmpty",
    "stampGraphRootWorkflowUuid",
    "backendReconnectEpoch",
    "activeWorkflowResyncEpoch",
    `${methodSource}\nreturn workflow_new;`,
  );
  return factory(
    { graph: rootGraph, extensionManager: { command: { execute: async () => {} } } },
    () => activeWorkflow,
    () => "tmp:new-tab",
    () => stableUuid,
    () => ({ seq: 1 }),
    (e) => String(e),
    () => "Unsaved Workflow",
    graphRootProvenEmpty,
    onStamp,
    1,
    0,
  );
}

const EMPTY_SERIALIZE = () => ({ nodes: [], links: [], extra: { ds: { offset: [0, 0], scale: 1 } } });

test("#606 workflow_new stamps the fresh tab's identity onto a proven-empty root", async () => {
  const rootGraph = { _nodes: [], extra: {}, serialize: EMPTY_SERIALIZE };
  const wf = { isPersisted: false, isModified: false, changeTracker: { activeState: { nodes: [] } } };
  const stamps = [];
  const workflow_new = buildWorkflowNew({
    rootGraph,
    activeWorkflow: wf,
    onStamp: (root, uuid, owner) => stamps.push([root, uuid, owner]),
  });
  const out = await workflow_new({ rid: "r1" });
  assert.equal(out.created, true);
  assert.equal(out.routing_key, "tmp:new-tab");
  assert.equal(stamps.length, 1, "the creation stamp must fire exactly once");
  assert.equal(stamps[0][0], rootGraph, "stamps the LIVE root");
  assert.equal(stamps[0][1], "uuid-new-tab", "stamps the NEW tab's identity");
  assert.equal(stamps[0][2], wf, "records the new workflow as the tag owner");
});

test("#606 workflow_new does NOT stamp a root that still holds content (fail closed)", async () => {
  const rootGraph = {
    _nodes: [{ id: 1, type: "KSampler" }],
    extra: { comfyui_mcp: { workflow_uuid: "uuid-OLD-tab" } },
    serialize: () => ({ nodes: [{ id: 1, type: "KSampler" }] }),
  };
  const wf = { isPersisted: false, isModified: false, changeTracker: { activeState: { nodes: [] } } };
  const stamps = [];
  const workflow_new = buildWorkflowNew({
    rootGraph,
    activeWorkflow: wf,
    onStamp: (...args) => stamps.push(args),
  });
  const out = await workflow_new({ rid: "r1" });
  assert.equal(out.created, true, "creation itself still succeeds");
  assert.equal(stamps.length, 0, "no re-tagging a root with foreign content");
});

test("#606 workflow_new does NOT stamp an unserializable root, and a throwing stamp never breaks creation", async () => {
  const wf = { isPersisted: false, isModified: false, changeTracker: { activeState: { nodes: [] } } };
  // Unserializable root: proven-empty fails closed → no stamp.
  const noSerializer = { _nodes: [], extra: {} };
  const stamps = [];
  const workflow_new = buildWorkflowNew({
    rootGraph: noSerializer,
    activeWorkflow: wf,
    onStamp: (...args) => stamps.push(args),
  });
  assert.equal((await workflow_new({ rid: "r1" })).created, true);
  assert.equal(stamps.length, 0);
  // A stamp that throws: creation still reports success (the guard simply keeps its say).
  const rootGraph = { _nodes: [], extra: {}, serialize: EMPTY_SERIALIZE };
  const workflow_new_throwing = buildWorkflowNew({
    rootGraph,
    activeWorkflow: wf,
    onStamp: () => {
      throw new Error("root refuses the tag");
    },
  });
  assert.equal((await workflow_new_throwing({ rid: "r2" })).created, true);
});

// ---------------------------------------------------------------------------
// #606/#560 fix 2 — workflow_open's repaint proof: content first, then the tag.
// A tag that did not ride loadGraphData/configure is re-stamped directly ONLY
// under BOTH positive proofs: the load observably TRANSITIONED the root into the
// loaded state (it did not match before), and no foreign tag is present.
// ---------------------------------------------------------------------------

/**
 * Drive the SHIPPING repaint-proof block (from the pre-load transition capture
 * through the proof chain, verbatim from the monolith) with a fake `app` whose
 * loadGraphData either applies the state to the live root or leaves a stale root
 * mounted. `preState` is what the root serializes to BEFORE the load; `postState`
 * what it serializes to after (when the load applies); `postTag` the identity tag
 * the root carries afterwards (absent / foreign / the target's own).
 */
function buildOpenProofBlock({ preState, postState, postTag, loadApplies = true, active, target, targetUuid, repaintState, onStamp }) {
  const marker = "const rootMatchedBeforeLoad = (() => {";
  const start = SRC.indexOf(marker);
  assert.notEqual(start, -1, "pre-load transition capture not found");
  const endMarker = "\n          }\n        } catch (err) {";
  const end = SRC.indexOf(endMarker, start);
  assert.notEqual(end, -1, "repaint proof block end not found");
  const block = SRC.slice(start, end);
  const rootGraph = {
    _nodes: [],
    extra: {},
    serialize: () => preState,
  };
  const app = {
    graph: rootGraph,
    loadGraphData: async () => {
      if (!loadApplies) return; // stale root stays mounted (old/partial frontend)
      rootGraph.serialize = () => postState;
      rootGraph.extra = postTag ? { comfyui_mcp: { workflow_uuid: postTag } } : {};
    },
  };
  const factory = new Function(
    "app",
    "getGraphCtx",
    "activeWorkflowRef",
    "graphRootMatchesState",
    "graphRootWorkflowUuidMatches",
    "stampGraphRootWorkflowUuid",
    "WORKFLOW_META_NAMESPACE",
    "WORKFLOW_UUID_FIELD",
    "target",
    "targetUuid",
    "repaintState",
    `let rebindFailed = null;\nreturn (async () => {\n${block}\nreturn { rebindFailed, rootGraph };\n})();`,
  );
  return factory(
    app,
    () => ({ rootGraph: app.graph }),
    () => active,
    graphRootMatchesState,
    graphRootWorkflowUuidMatches,
    onStamp,
    "comfyui_mcp",
    "workflow_uuid",
    target,
    targetUuid,
    repaintState,
  );
}

const TARGET_UUID = "22222222-2222-4222-8222-222222222222";
// The state workflow_open loads (tag stamped into extra, as the monolith does).
const REPAINT_STATE = {
  nodes: [{ id: 1, type: "KSampler" }],
  extra: { comfyui_mcp: { workflow_uuid: TARGET_UUID } },
};
// What the root serializes to after a faithful load: the repaint CONTENT (the
// shape comparison excludes the tag, so this carries just the nodes).
const LOADED_STATE = { nodes: [{ id: 1, type: "KSampler" }] };
// A genuinely different prior canvas (the drifted-binding case).
const STALE_STATE = { nodes: [{ id: 7, type: "VAELoader" }, { id: 8, type: "KSampler" }] };

test("#606 workflow_open: load transitioned the root, tag did not ride, none present → direct re-stamp heals", async () => {
  // The dialect this fixes: loadGraphData installed the exact repaint content
  // (a PROVEN transition — the root held a different canvas before), but this
  // frontend left the root's extra without the tag. Before the fix this was an
  // unrecoverable "could not prove that the active canvas was rebound" — the
  // dead-end remedy of #606.
  const target = { path: "workflows/a.json" };
  const stamps = [];
  const { rebindFailed, rootGraph } = await buildOpenProofBlock({
    preState: STALE_STATE,
    postState: LOADED_STATE,
    postTag: null,
    active: target,
    target,
    targetUuid: TARGET_UUID,
    repaintState: REPAINT_STATE,
    onStamp: (root, uuid, owner) => {
      stamps.push([root, uuid, owner]);
      root.extra = { comfyui_mcp: { workflow_uuid: uuid } };
    },
  });
  assert.equal(rebindFailed, null, "the rebind must succeed on a proven transition");
  assert.equal(stamps.length, 1, "exactly one direct re-stamp");
  assert.equal(stamps[0][1], TARGET_UUID);
  assert.equal(stamps[0][2], target);
  assert.equal(rootGraph.extra.comfyui_mcp.workflow_uuid, TARGET_UUID);
});

test("#606 workflow_open: tag already present after a faithful repaint → no extra stamp", async () => {
  const target = { path: "workflows/a.json" };
  const stamps = [];
  const { rebindFailed } = await buildOpenProofBlock({
    preState: STALE_STATE,
    postState: LOADED_STATE,
    postTag: TARGET_UUID,
    active: target,
    target,
    targetUuid: TARGET_UUID,
    repaintState: REPAINT_STATE,
    onStamp: (...args) => stamps.push(args),
  });
  assert.equal(rebindFailed, null);
  assert.equal(stamps.length, 0, "a tag that rode through needs no repair");
});

test("#606 workflow_open: a content mismatch NEVER reaches the re-stamp (the #349 fence stands)", async () => {
  // The root holds a DIFFERENT graph than the state we loaded — the wrong-canvas
  // case. The stamp must not fire: re-tagging a foreign canvas is exactly what
  // the binding guard exists to prevent.
  const target = { path: "workflows/a.json" };
  const stamps = [];
  const { rebindFailed, rootGraph } = await buildOpenProofBlock({
    preState: STALE_STATE,
    postState: STALE_STATE, // the load left the different-content root mounted
    postTag: "uuid-foreign",
    active: target,
    target,
    targetUuid: TARGET_UUID,
    repaintState: REPAINT_STATE,
    onStamp: (...args) => stamps.push(args),
  });
  assert.ok(rebindFailed instanceof Error, "content mismatch still refuses");
  assert.match(rebindFailed.message, /could not prove that the active canvas was rebound/);
  assert.equal(stamps.length, 0, "no re-stamp on unproven content");
  assert.equal(rootGraph.extra.comfyui_mcp.workflow_uuid, "uuid-foreign", "the foreign tag is untouched");
});

test("#606 workflow_open: another tab winning the active slot refuses WITHOUT a stamp", async () => {
  const target = { path: "workflows/a.json" };
  const usurper = { path: "workflows/b.json" };
  const stamps = [];
  const { rebindFailed } = await buildOpenProofBlock({
    preState: STALE_STATE,
    postState: LOADED_STATE,
    postTag: null,
    active: usurper, // a switch interleaved with the open's awaits (#716)
    target,
    targetUuid: TARGET_UUID,
    repaintState: REPAINT_STATE,
    onStamp: (...args) => stamps.push(args),
  });
  assert.ok(rebindFailed instanceof Error);
  assert.equal(stamps.length, 0);
});

test("#606 workflow_open: a root that will not hold the tag fails with the honest reason", async () => {
  const target = { path: "workflows/a.json" };
  const { rebindFailed } = await buildOpenProofBlock({
    preState: STALE_STATE,
    postState: LOADED_STATE,
    postTag: null,
    active: target,
    target,
    targetUuid: TARGET_UUID,
    repaintState: REPAINT_STATE,
    // Real-stamp semantics against a refusing root: the write throws in the
    // browser's strict mode; model it as a throw here.
    onStamp: () => {
      throw new TypeError("Cannot add property, object is not extensible");
    },
  });
  assert.ok(rebindFailed instanceof Error);
  assert.match(rebindFailed.message, /would not take the workflow's identity tag/);
});

test("#606 workflow_open: a PRESENT foreign tag is NEVER re-stamped, even on a proven transition (codex P0)", async () => {
  // The load applied, but the root carries a DIFFERENT workflow's tag. Claims
  // cannot distinguish an open identical-content copy whose registration is
  // missing from a closed tab's residue, and the binding guard's own doctrine
  // refuses unclaimed tags — so any present foreign tag fails closed.
  const target = { path: "workflows/a.json" };
  const stamps = [];
  const { rebindFailed, rootGraph } = await buildOpenProofBlock({
    preState: STALE_STATE,
    postState: LOADED_STATE,
    postTag: "uuid-copy",
    active: target,
    target,
    targetUuid: TARGET_UUID,
    repaintState: REPAINT_STATE,
    onStamp: (...args) => stamps.push(args),
  });
  assert.ok(rebindFailed instanceof Error, "a present foreign tag must fail closed");
  assert.match(rebindFailed.message, /carries a different workflow's identity tag/);
  assert.match(rebindFailed.message, /Reload the panel/);
  assert.equal(stamps.length, 0, "no re-stamp over a foreign tag");
  assert.equal(rootGraph.extra.comfyui_mcp.workflow_uuid, "uuid-copy", "the foreign tag survives");
});

test("#606 workflow_open: tag absent but NO transition (identical copy still mounted) fails closed (codex P0)", async () => {
  // The root already matched the target's content BEFORE the load and the load
  // left it untouched: no observable transition, so "our load applied" cannot be
  // told apart from "a stale root holding an identical copy's canvas". Even with
  // no tag present, the re-stamp must not fire.
  const target = { path: "workflows/a.json" };
  const stamps = [];
  const { rebindFailed } = await buildOpenProofBlock({
    preState: LOADED_STATE, // already identical BEFORE the load
    postState: LOADED_STATE,
    postTag: null,
    loadApplies: false, // old/partial frontend: the load resolved but did nothing
    active: target,
    target,
    targetUuid: TARGET_UUID,
    repaintState: REPAINT_STATE,
    onStamp: (...args) => stamps.push(args),
  });
  assert.ok(rebindFailed instanceof Error, "no transition ⇒ no proof the rebind happened");
  assert.match(rebindFailed.message, /already held content identical/);
  assert.match(rebindFailed.message, /Reload the panel/);
  assert.equal(stamps.length, 0, "no re-stamp without a proven transition");
});

// ---------------------------------------------------------------------------
// #607 fix 3 — a fence refusal re-advertises the panel's live identity (re-hello)
// ---------------------------------------------------------------------------

function buildMismatchFence() {
  // The module-level hook + note + the assert function, verbatim from the monolith.
  const sliceStart = SRC.indexOf("let workflowInstanceMismatchRehello = null;");
  assert.notEqual(sliceStart, -1, "hook declaration not found");
  const fnSource = balancedFrom(SRC, "function assertActiveWorkflowCommandTarget(");
  const fnStart = SRC.indexOf("function assertActiveWorkflowCommandTarget(");
  const slice = SRC.slice(sliceStart, fnStart + fnSource.length);
  const factory = new Function(
    "commandTargetsActiveWorkflow",
    "workflowStableUuid",
    "WORKFLOW_UUID_FIELD",
    `${slice}\nreturn {\n` +
      `  assert: assertActiveWorkflowCommandTarget,\n` +
      `  setHook: (fn) => { workflowInstanceMismatchRehello = fn; },\n` +
      `};`,
  );
  return factory(commandTargetsActiveWorkflow, () => "uuid-ACTIVE", "workflow_uuid");
}

test("#607 a refused stamp fires the re-hello hook exactly once, then throws", () => {
  const fence = buildMismatchFence();
  let hellos = 0;
  fence.setHook(() => {
    hellos += 1;
  });
  assert.throws(
    () =>
      fence.assert({
        cmd: "graph_add_node",
        workflow_uuid: "uuid-STALE",
      }),
    /workflow instance mismatch/,
  );
  assert.equal(hellos, 1, "the refusal re-advertises the panel's current identity");
});

test("#607 a matching stamp does NOT fire the hook and does not throw", () => {
  const fence = buildMismatchFence();
  let hellos = 0;
  fence.setHook(() => {
    hellos += 1;
  });
  fence.assert({ cmd: "graph_add_node", workflow_uuid: "uuid-ACTIVE" });
  assert.equal(hellos, 0);
});

test("#607 a throwing hook never masks or replaces the refusal", () => {
  const fence = buildMismatchFence();
  fence.setHook(() => {
    throw new Error("socket exploded");
  });
  assert.throws(
    () => fence.assert({ cmd: "graph_add_node", workflow_uuid: "uuid-STALE" }),
    /workflow instance mismatch/,
    "the refusal itself must stand",
  );
});

test("#607 the dispatch-time fence also re-advertises before refusing", () => {
  // Structural: the command-handler fence (separate from the assert helper used at
  // mutation boundaries) must fire the same hook before its throw.
  const marker = "const executor = GRAPH_TOOL_EXECUTORS[msg.cmd];";
  const start = SRC.indexOf(marker);
  assert.notEqual(start, -1);
  const end = SRC.indexOf("workflow instance mismatch:", start);
  assert.notEqual(end, -1);
  const fenceRegion = SRC.slice(start, end);
  const noteAt = fenceRegion.indexOf("noteWorkflowInstanceMismatch();");
  assert.notEqual(noteAt, -1, "the dispatch fence must re-advertise on refusal");
  const throwAt = fenceRegion.indexOf("throw new Error(", noteAt);
  assert.ok(throwAt > noteAt, "the re-advertise fires BEFORE the refusal throw");
});

test("#607 the client registers a THROTTLED re-hello as the hook", () => {
  // A full hello re-greets the user ("agent ready"), so a retry loop against a
  // genuinely-switched canvas must not storm greetings — the registration is
  // time-throttled.
  const marker = "workflowInstanceMismatchRehello = () => {";
  const start = SRC.indexOf(marker);
  assert.notEqual(start, -1, "the bridge client must register the re-hello hook");
  const region = SRC.slice(start, start + 400);
  assert.match(region, /lastMismatchRehelloAt/);
  assert.match(region, /sendHello\(\)/);
});
