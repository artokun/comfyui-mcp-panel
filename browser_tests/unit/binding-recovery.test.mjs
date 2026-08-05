/**
 * Unit tests for the binding-wedged-no-recovery cluster (panel #606 / #607, on the
 * tree that absorbed #621):
 *
 *   #606 — a panel-created blank tab could wedge behind the binding guard after a
 *     reconnect: ComfyUI reuses app.graph across tabs and clear/configure does NOT
 *     reset graph.extra, so the new tab inherited the PREVIOUS workflow's root tag;
 *     with its ChangeTracker not yet PROVEN empty the both-empty heal could not fire,
 *     and nothing re-stamped the root. workflow_new now stamps the root at creation
 *     (only when the root is PROVEN content-free). workflow_open's side of the
 *     cluster is covered by open-rebind-proof.test.mjs (the #623 attempt-scoped
 *     open_proof marker, which superseded this file's earlier re-stamp tests when
 *     the two integrated).
 *
 *   #607 — a fence refusal ("workflow instance mismatch") meant the orchestrator's
 *     cached stamp was stale relative to the panel's LIVE identity, yet the advertised
 *     recovery never reached that cache: the panel re-hellos (the frame the
 *     orchestrator re-stamps from) when the refusal fires.
 *
 * The harnesses extract the SHIPPING code from the panel monolith and drive it with
 * injected doubles, so the tests are about the code that actually runs (delete the
 * stamp / the hook call and the matching test fails).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { graphRootProvenEmpty } from "../../web/js/lib/graph-binding.js";
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
