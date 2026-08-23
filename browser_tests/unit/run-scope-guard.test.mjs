/**
 * Unit tests for web/js/lib/run-scope-guard.js — run with `node --test`.
 *
 * Guards #556: a scoped panel_run (to_node_id, "run to node") must NEVER
 * silently fall through to a FULL-graph execution — and must never collateral-
 * damage unrelated queue traffic while preventing that. The integration tests
 * below drive dispatchScopedRun — the SAME orchestration graph_run runs —
 * through mock frontends, including the real guard-install/try/finally/restore
 * control flow (codex gate r3: the sentinel must ACTUALLY be installed after a
 * timeout, degraded mode must fail closed BEFORE dispatch, and run identity —
 * queue-position mark + queue-item tag — must separate our work from every
 * stranger's).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  newScopedQueueMark,
  QUEUE_ITEM_TAG,
  queuePromptScopeArgs,
  queuePromptScopeAttempts,
  repairScopeInBody,
  promptContentHash,
  promptContentHashFromBody,
  canonicalizePrompt,
  diffPromptCanons,
  collectVolatileInputs,
  verifyScopedPromptBody,
  scopeDroppedError,
  scopeUnverifiedError,
  scopeUnattributableError,
  scopeDispatchError,
  createRunFetchInterceptor,
  createScopedRunGuard,
  describeObserved,
  readScopeFromBody,
  cancelPendingScopedQueueItem,
  dispatchScopedRun,
} from "../../web/js/lib/run-scope-guard.js";
import { resolveRunToNodeTarget } from "../../web/js/lib/subgraph-scope.js";

// A Response double with the surface the guard + frontend rejection path use.
function jsonResponse(status, obj) {
  return {
    status,
    clone() {
      return { json: async () => JSON.parse(JSON.stringify(obj)) };
    },
    text: async () => JSON.stringify(obj),
  };
}

// The "server" — a recording fetchApi double standing in for the real one.
function makeServer(responder) {
  const calls = [];
  const fetchApi = async (route, options) => {
    calls.push({ route, options });
    return responder ? responder(route, options) : jsonResponse(200, { prompt_id: `srv-${calls.length}` });
  };
  fetchApi.calls = calls;
  return fetchApi;
}

const promptPost = (body) => [
  "/prompt",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  },
];

// The graphToPrompt output OUR scoped run queued.
const OUR_OUTPUT = {
  "3": { class_type: "KSampler", inputs: {} },
  "9": { class_type: "SaveImage", inputs: {} },
  "14": { class_type: "PreviewAny", inputs: {} },
};
const OUR_HASH = promptContentHash(OUR_OUTPUT);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Node 22's test runner exits the process early — cancelling every pending
// test with "Promise resolution is still pending but the event loop has
// already resolved" — when a test's pending promise depends SOLELY on UNREF'd
// timers (the guard's verify-timeout and sentinel linger are unref'd BY DESIGN
// so they never hold a real process's event loop; that production behavior
// must not change). A REF'd interval keeps the loop alive for the duration of
// an integration test; cleared in finally so it never leaks past the test.
function keepAlive() {
  const ka = setInterval(() => {}, 25);
  return () => clearInterval(ka);
}

// Two run marks for the tests (what newScopedQueueMark hands out per run).
const MARK_A = 2 ** 30 - 1 - 1;
const MARK_B = 2 ** 30 - 1 - 2;

// Bodies the way the frontend's api.queuePrompt builds them.
function frontendBody({ output = OUR_OUTPUT, number = MARK_A, targets = null }) {
  const body = { prompt: output, client_id: "x" };
  if (targets) body.partial_execution_targets = targets;
  if (number === -1) body.front = true;
  else if (number != 0) body.number = number;
  return body;
}

/**
 * A mock frontend. `shape`: "shim" (options object AND legacy array both
 * honored), "positional" (array only), "shimless" (options object only — the
 * #556 build), "dropping" (BOTH shapes ignored — the build the three #556
 * field recurrences describe, where the /prompt body arrived with no
 * partial_execution_targets whichever argument was passed).
 * `defer`: queuePrompt pushes the item and returns early (busy processor); the
 * TEST then drives the deferred post manually through apiTarget.fetchApi,
 * exactly like the in-flight processor would.
 */
function makeFrontend({ shape = "shim", defer = false, apiTarget, output = OUR_OUTPUT, failGraphToPrompt = false } = {}) {
  const app = {
    queueItems: [],
    posted: [],
    graphToPrompt: async () => {
      if (failGraphToPrompt) throw new Error("serialization exploded");
      return { output, workflow: {} };
    },
    queuePrompt: async (number, batch, arg) => {
      const queueNodeIds =
        shape === "dropping"
          ? undefined
          : // #752 — an api-layer build: it reads ONLY `partialExecutionTargets`,
            // the key `api.queuePrompt` actually turns into the request field, and
            // ignores a positional array and `queueNodeIds` alike.
            shape === "apiOptions"
            ? (Array.isArray(arg) ? undefined : arg?.partialExecutionTargets)
          : shape === "shim"
            ? Array.isArray(arg)
              ? arg
              : arg?.queueNodeIds
            : shape === "positional"
              ? Array.isArray(arg)
                ? arg
                : undefined
              : Array.isArray(arg)
                ? undefined
                : arg?.queueNodeIds;
      const item = { number, batchCount: batch, queueNodeIds };
      if (defer) {
        app.queueItems?.push(item); // hard-private builds hide the array from us
        app.deferredItem = item;
        return false; // busy — the processor posts it LATER
      }
      // Synchronous processing: post now, through whatever fetchApi is installed.
      const body = frontendBody({ output, number, targets: queueNodeIds?.length ? queueNodeIds : null });
      app.posted.push(body);
      await apiTarget.fetchApi("/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return true;
    },
    // Simulate the in-flight processor eventually posting a deferred item.
    postDeferred: async (item) => {
      const body = frontendBody({ output, number: item.number, targets: item.queueNodeIds?.length ? item.queueNodeIds : null });
      app.posted.push(body);
      return apiTarget.fetchApi("/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
  };
  return app;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("#556 queuePromptScopeArgs: no scope ⇒ [undefined]; scope ⇒ array first, then options object", () => {
  assert.deepEqual(queuePromptScopeArgs(undefined), [undefined]);
  assert.deepEqual(queuePromptScopeArgs([]), [undefined]);
  const [first, second] = queuePromptScopeArgs(["76:34"]);
  assert.deepEqual(first, ["76:34"]);
  assert.deepEqual(second, { queueNodeIds: ["76:34"] });
});

// ---------------------------------------------------------------------------
// #630 — HONOURING the scope, not merely refusing to violate it.
//
// Refusing a scoped run is the SAFE outcome for #556; running the requested
// subset is the CORRECT one. These cover the last-resort delivery route: when
// neither app.queuePrompt argument shape carries the scope, the panel writes
// partial_execution_targets into this run's own /prompt body and re-verifies
// it before it leaves.
// ---------------------------------------------------------------------------

test("#630 queuePromptScopeAttempts: both argument shapes are tried BEFORE the body repair, and repair is licensed only on the last attempt", () => {
  assert.deepEqual(queuePromptScopeAttempts(undefined), [{ arg: undefined, repair: false }]);
  assert.deepEqual(queuePromptScopeAttempts([]), [{ arg: undefined, repair: false }]);
  const attempts = queuePromptScopeAttempts(["76:34"]);
  assert.equal(attempts.length, 4);
  assert.deepEqual(attempts[0], { arg: ["76:34"], repair: false });
  assert.deepEqual(attempts[1], { arg: { queueNodeIds: ["76:34"] }, repair: false });
  // #752 — the api layer reads a DIFFERENT key than the store does. Verified in
  // a shipped 1.47.12 bundle: the store destructures `queueNodeIds` and calls
  // `api.queuePrompt(e, m, {partialExecutionTargets: n})`, and only that second
  // key becomes `partial_execution_targets` in the request. A build whose
  // app.queuePrompt forwards straight to the api layer ignores both shapes above.
  assert.deepEqual(attempts[2], { arg: { partialExecutionTargets: ["76:34"] }, repair: false });
  assert.deepEqual(attempts[3], { arg: ["76:34"], repair: true });
  assert.equal(
    attempts.filter((a) => a.repair).length,
    1,
    "a frontend that delivers the scope natively must always win — repair is the last resort only",
  );
});

test("#630 repairScopeInBody: writes EXACTLY the resolved targets, leaves the prompt (and therefore the content hash) untouched", () => {
  const body = JSON.stringify(frontendBody({ number: MARK_A, targets: null }));
  const repaired = repairScopeInBody(body, ["14"]);
  assert.notEqual(repaired, null);
  const parsed = JSON.parse(repaired);
  assert.deepEqual(parsed.partial_execution_targets, ["14"], "exactly the resolved scope, nothing widened");
  assert.deepEqual(parsed.prompt, OUR_OUTPUT, "the prompt is not rewritten");
  assert.equal(parsed.number, MARK_A, "the run identity mark survives the repair");
  assert.equal(
    promptContentHashFromBody(repaired),
    OUR_HASH,
    "repair must not invalidate this run's own content attribution",
  );
  // The repair verifies its own output: it is itself an operation that can
  // fail, and a repair that cannot be confirmed is not handed on.
  assert.equal(verifyScopedPromptBody(repaired, ["14"]).ok, true);
});

test("#630 repairScopeInBody: refuses what it cannot safely rewrite — unparseable, non-object, or no scope to write", () => {
  assert.equal(repairScopeInBody("not-json{", ["14"]), null, "an unreadable body is never repaired");
  assert.equal(repairScopeInBody(JSON.stringify([1, 2]), ["14"]), null, "an array body is not a prompt request");
  assert.equal(repairScopeInBody(JSON.stringify("scalar"), ["14"]), null);
  assert.equal(repairScopeInBody(undefined, ["14"]), null);
  assert.equal(
    repairScopeInBody(JSON.stringify(frontendBody({})), []),
    null,
    "no resolved scope ⇒ nothing to write; never an empty partial_execution_targets",
  );
  // The PRIMITIVE will rewrite whatever it is handed — it is the caller that
  // decides what may be repaired, and the guard now hands it ONLY a genuinely
  // absent key (asserted in the guard tests below). This documents the split of
  // responsibility; it is not a licence to overwrite a present value.
  const overwritten = repairScopeInBody(
    JSON.stringify(frontendBody({ number: MARK_A, targets: ["999"] })),
    ["14"],
  );
  assert.deepEqual(JSON.parse(overwritten).partial_execution_targets, ["14"]);
});

test("#556 r7 promptContentHash: full CONTENT covered (ids, class types, links, widget values), key-order-insensitive", () => {
  const a = promptContentHash({ "9": { class_type: "B", inputs: { steps: 20, model: ["3", 0] } }, "3": { class_type: "A", inputs: {} } });
  const b = promptContentHash({ "3": { class_type: "A", inputs: {} }, "9": { class_type: "B", inputs: { model: ["3", 0], steps: 20 } } });
  assert.equal(a, b, "same content, any key order ⇒ same hash");
  assert.notEqual(promptContentHash({ "9": { class_type: "B", inputs: { steps: 25, model: ["3", 0] } }, "3": { class_type: "A", inputs: {} } }), a,
    "a changed WIDGET VALUE changes the hash");
  assert.notEqual(promptContentHash({ "9": { class_type: "B", inputs: { steps: 20, model: ["4", 0] } }, "3": { class_type: "A", inputs: {} } }), a,
    "a changed LINK changes the hash");
  assert.notEqual(promptContentHash({ "3": { class_type: "A" } }), a, "a changed node set changes the hash");
  // The ONLY tolerance: inputs whose OWNING widget self-mutates at queue
  // time — PER-NODE pairs (r8), never a global input name.
  const withSeed = (seed, node = "3") => promptContentHash(
    { "3": { class_type: "KSampler", inputs: { seed, steps: 20 } }, "5": { class_type: "KSampler", inputs: { seed: 222, steps: 20 } } },
    new Set([`${node} seed`]),
  );
  assert.equal(withSeed(1), withSeed(999), "the hook node's rerolled seed is excluded");
  assert.notEqual(withSeed(1, "3"), withSeed(999, "5"),
    "excluding node 3's 'seed' does NOT hide an edit to node 5's same-named input");
  assert.equal(promptContentHashFromBody(JSON.stringify({ prompt: OUR_OUTPUT })), OUR_HASH);
  assert.equal(promptContentHashFromBody("not-json{"), null);
});

test("#556 r8 collectVolatileInputs: per-NODE pairs (execId + input name) across the root graph and nested subgraphs", () => {
  const root = {
    _nodes: [
      { id: 1, widgets: [{ name: "seed", beforeQueued() {} }, { name: "steps" }] },
      { id: 2, widgets: null, subgraph: { _nodes: [{ id: 3, widgets: [{ name: "noise_seed", beforeQueued() {} }] }] } },
    ],
  };
  const pairs = collectVolatileInputs(root);
  assert.deepEqual([...pairs].sort(), ["1 seed", "2:3 noise_seed"],
    "root node ⇒ String(id); nested node ⇒ colon-joined subgraph-instance path");
  assert.equal(collectVolatileInputs(null).size, 0);
});

test("#572 collectVolatileInputs: a linked value-control TARGET is excluded — the stock control_after_generate shape", () => {
  // The frontend hangs beforeQueued on the UNSERIALIZED control combo and the
  // hook mutates the LINKED, serialized seed (target.linkedWidgets = [control]).
  // Excluding only the carrier's name covered nothing: the seed re-roll between
  // our pre-dispatch hash and the deferred serialization false-refused every
  // scoped run as "graph CHANGED" (WidgetControlMode "before" / pre-#8774 builds).
  const control = { name: "control_after_generate", value: "randomize", beforeQueued() {}, afterQueued() {} };
  const seed = { name: "seed", value: 42, linkedWidgets: [control] };
  const root = { _nodes: [{ id: 3, widgets: [seed, control, { name: "steps", value: 20 }] }] };
  const pairs = collectVolatileInputs(root);
  assert.ok(pairs.has("3 seed"), "the serialized re-roll target is volatile");
  assert.ok(pairs.has("3 control_after_generate"), "the hook carrier's own name stays excluded");
  assert.ok(!pairs.has("3 steps"), "unrelated inputs stay covered for drift detection");
});

test("#572 collectVolatileInputs: a FIXED carrier never mutates, so NOTHING is excluded — a mid-window edit to its target refuses as drift", () => {
  // A "fixed" value-control no-ops at queue time: its linked target's input is
  // NOT volatile, and neither is the carrier's own. Excluding either would mask
  // a genuine mid-window user edit (codex r2 — the fixed-ness check must GATE
  // the exclusion, not follow it).
  const control = { name: "control_after_generate", value: "fixed", beforeQueued() {}, afterQueued() {} };
  const seed = { name: "seed", value: 42, linkedWidgets: [control] };
  const graph = { _nodes: [{ id: 3, widgets: [seed, control, { name: "steps", value: 20 }] }] };
  const pairs = collectVolatileInputs(graph);
  assert.ok(!pairs.has("3 seed"), "fixed ⇒ the target input stays drift-covered");
  assert.ok(!pairs.has("3 control_after_generate"), "fixed ⇒ the carrier's own input stays drift-covered too");
  // Hash level: a user edit to the fixed target's serialized input during the
  // deferred window MUST mismatch — exactly like any other genuine edit.
  const volatileInputs = collectVolatileInputs(graph);
  const atHash = promptContentHash(
    { "3": { class_type: "KSampler", inputs: { seed: 42, steps: 20 } }, "9": { class_type: "SaveImage", inputs: {} } },
    volatileInputs,
  );
  const edited = promptContentHashFromBody(
    JSON.stringify({ prompt: { "3": { class_type: "KSampler", inputs: { seed: 777, steps: 20 } }, "9": { class_type: "SaveImage", inputs: {} } } }),
    volatileInputs,
  );
  assert.notEqual(edited, atHash, "a mid-window edit to a FIXED control's target refuses as drift");
});

test("#572 collectVolatileInputs: the linked-target exclusion reaches nested subgraphs with the colon-path execId", () => {
  const control = { name: "control_after_generate", value: "increment", beforeQueued() {} };
  const noiseSeed = { name: "noise_seed", value: 7, linkedWidgets: [control] };
  const root = {
    _nodes: [
      { id: 10, widgets: [], subgraph: { _nodes: [{ id: 15, widgets: [noiseSeed, control] }] } },
    ],
  };
  const pairs = collectVolatileInputs(root);
  assert.ok(pairs.has("10:15 noise_seed"), "nested target pairs line up with the flattened prompt keys");
});

// ---------------------------------------------------------------------------
// #1124 — the SECOND volatility mechanism: an extension that rewrites the
// outgoing prompt in its own api.queuePrompt patch, with no widget hook at all.
//
// The widget shape below is the repo's measured `Seed (rgthree)` instance
// (scoped-batch-seed.test.mjs): rgthree SPLICES OUT control_after_generate and
// leaves `seed` plus three buttons. Note what is absent — there is no
// `beforeQueued` anywhere on it, which is exactly why the hook scan found
// nothing and every scoped run on such a graph was refused as "graph CHANGED".
// ---------------------------------------------------------------------------

const rgthreeSeedNode = (id, seedValue, extra = {}) => ({
  id,
  type: "Seed (rgthree)",
  mode: 0,
  widgets: [
    { name: "seed", value: seedValue },
    { name: "🎲 Randomize Each Time", value: "" },
    { name: "🎲 New Fixed Random", value: "" },
    { name: "USE_LAST_SEED", value: "okay" },
  ],
  ...extra,
});

test("#1124 collectVolatileInputs: an ARMED rgthree Seed node is volatile despite carrying NO beforeQueued hook", () => {
  const root = {
    _nodes: [
      rgthreeSeedNode(47, -1),
      { id: 3, widgets: [{ name: "steps", value: 20 }] },
    ],
  };
  // Proof the OLD signal could not have found it: nothing on this node is a hook.
  for (const w of root._nodes[0].widgets) {
    assert.equal(typeof w.beforeQueued, "undefined", `${w.name} carries no beforeQueued`);
  }
  assert.deepEqual([...collectVolatileInputs(root)].sort(), ["47 seed"]);
});

test("#1124 collectVolatileInputs: a FIXED rgthree Seed excludes nothing — the graph stays fully drift-covered", () => {
  const root = { _nodes: [rgthreeSeedNode(47, 12345)] };
  assert.equal(collectVolatileInputs(root).size, 0);
});

test("#1124 collectVolatileInputs: the rgthree exclusion reaches nested subgraphs with the colon-path execId", () => {
  const root = {
    _nodes: [{ id: 10, widgets: [], subgraph: { _nodes: [rgthreeSeedNode(15, -1)] } }],
  };
  assert.ok(collectVolatileInputs(root).has("10:15 seed"), "nested pairs line up with the flattened prompt keys");
});

test("#1124 promptContentHash: rgthree's substitution is not drift, but an edit to ANY other input of the SAME node still is", () => {
  // The narrowness check. Only the one input rgthree rewrites is dropped; the
  // node's other inputs, and every other node, keep full coverage.
  const graph = { _nodes: [rgthreeSeedNode(47, -1)] };
  const volatileInputs = collectVolatileInputs(graph);
  const stamped = { "47": { class_type: "Seed (rgthree)", inputs: { seed: -1, extra: 7 } } };
  const atHash = promptContentHash(stamped, volatileInputs);
  const body = (inputs) => JSON.stringify({ prompt: { "47": { class_type: "Seed (rgthree)", inputs } } });
  // rgthree's own measured draw, substituted at queue time ⇒ still OUR dispatch.
  assert.equal(
    promptContentHashFromBody(body({ seed: 1028465986822020, extra: 7 }), volatileInputs),
    atHash,
    "the queue-time substitution is the exclusion's purpose",
  );
  // A sibling input on the SAME node ⇒ real drift, still refused.
  assert.notEqual(
    promptContentHashFromBody(body({ seed: 1028465986822020, extra: 8 }), volatileInputs),
    atHash,
    "a sibling input of the seed node is NOT covered by the exclusion",
  );
});

// ---------------------------------------------------------------------------
// #1273 — the THIRD volatility mechanism: cg-use-everywhere converts its
// broadcasts to REAL links inside its own queuePrompt patch, so the stamp's
// graphToPrompt and the dispatch's serialization of an UNTOUCHED graph differ
// on exactly the pack's extra.ue_links record. The pair computation itself
// (including the subgraph routing behind the field report's "103:48 anything"
// tokens) is pinned in use-everywhere-links.test.mjs; these tests pin the
// integration: collectVolatileInputs carries the pairs, and the two-channel
// hash comparison of an untouched UE graph now MATCHES.
// ---------------------------------------------------------------------------

const ueGraph = () => ({
  _nodes: [
    { id: 4, inputs: [], outputs: [{ name: "CLIP", links: [] }] },
    { id: 22, inputs: [{ name: "clip", link: null }, { name: "text", link: null }] },
  ],
  extra: {
    ue_links: [{ downstream: 22, downstream_slot: 0, upstream: 4, upstream_slot: 0, controller: 48, type: "CLIP" }],
  },
});

test("#1273 collectVolatileInputs: a UE broadcast target is volatile, its sibling input is not", () => {
  const pairs = collectVolatileInputs(ueGraph());
  assert.ok(pairs.has("22 clip"), "the input the injection will materialise");
  assert.ok(!pairs.has("22 text"), "everything else keeps full drift coverage");
  assert.equal(collectVolatileInputs({ _nodes: [], extra: {} }).size, 0,
    "a graph without a ue_links record is untouched");
});

test("#1273 promptContentHash: an untouched UE graph stamps EQUAL to its dispatched body — and a real edit still refuses", () => {
  // The pre-dispatch serialization has NO UE link; the post body carries the
  // injected one. Before #1273 this pair of hashes always mismatched and every
  // run-to-node on a UE graph was refused as "the graph CHANGED".
  const volatileInputs = collectVolatileInputs(ueGraph());
  const stamped = { "22": { class_type: "CLIPTextEncode", inputs: { text: "a cat" } }, "4": { class_type: "CheckpointLoaderSimple", inputs: {} } };
  const atHash = promptContentHash(stamped, volatileInputs);
  const dispatched = (inputs) =>
    JSON.stringify({ prompt: { "22": { class_type: "CLIPTextEncode", inputs }, "4": { class_type: "CheckpointLoaderSimple", inputs: {} } } });
  assert.equal(
    promptContentHashFromBody(dispatched({ clip: ["4", 0], text: "a cat" }), volatileInputs),
    atHash,
    "UE's queue-time injection is the exclusion's purpose — the scoped run is no longer refused",
  );
  assert.notEqual(
    promptContentHashFromBody(dispatched({ clip: ["4", 0], text: "a dog" }), volatileInputs),
    atHash,
    "a mid-window edit to any OTHER input of the same node is still drift",
  );
  assert.equal(
    promptContentHashFromBody(dispatched({ clip: ["5", 0], text: "a cat" }), volatileInputs),
    atHash,
    "a mid-window rewiring OF the excluded input itself is indistinguishable from the " +
      "injection and is TOLERATED — the documented residual, disclosed via volatileInputs",
  );
});

// ---------------------------------------------------------------------------
// #2099 — VHS_VideoCombine resolves Comfy save-file date templates in
// filename_prefix as the prompt is queued. That queue-time clock substitution is
// not graph drift, but only the exact VHS filename_prefix date-template input is
// volatile; ordinary prefixes and every other input stay covered.
// ---------------------------------------------------------------------------

const vhsNode = (id, filenamePrefix, extra = {}) => ({
  id,
  type: "VHS_VideoCombine",
  widgets: [
    { name: "frame_rate", value: 24 },
    { name: "filename_prefix", value: filenamePrefix },
    { name: "format", value: "video/h264-mp4" },
  ],
  ...extra,
});

test("#2099 collectVolatileInputs: only VHS_VideoCombine filename_prefix with a recognized date template is volatile", () => {
  const root = {
    _nodes: [
      vhsNode(223, "video/%date:yyyyMMdd_hhmmss%"),
      vhsNode(224, "video/fixed_prefix"),
      vhsNode(225, "video/%not_a_date_template%"),
      vhsNode(226, "video/%date:folder%"),
      vhsNode(227, "video/%date:yyyy-MM-ddThh:mm:ss%"),
      { id: 9, type: "SaveImage", widgets: [{ name: "filename_prefix", value: "%date:yyyyMMdd_hhmmss%" }] },
      { id: 10, widgets: [], subgraph: { _nodes: [vhsNode(15, "nested/%date:yyyy-MM-dd%")] } },
    ],
  };
  const pairs = collectVolatileInputs(root);
  assert.deepEqual(
    [...pairs].sort(),
    ["10:15 filename_prefix", "223 filename_prefix", "227 filename_prefix"],
    "exact VHS node + exact input + recognized date template; nested execIds are preserved",
  );
});

test("#2099 promptContentHash: VHS date-template substitution is stable, ordinary prefixes and sibling edits are still drift", () => {
  const graph = { _nodes: [vhsNode(223, "video/%date:yyyyMMdd_hhmmss%")] };
  const volatileInputs = collectVolatileInputs(graph);
  const stamped = {
    "223": {
      class_type: "VHS_VideoCombine",
      inputs: { images: ["1000", 0], filename_prefix: "video/%date:yyyyMMdd_hhmmss%", frame_rate: 24 },
    },
    "14": { class_type: "PreviewAny", inputs: {} },
  };
  const atHash = promptContentHash(stamped, volatileInputs);
  const body = (inputs) => JSON.stringify({
    prompt: {
      "223": { class_type: "VHS_VideoCombine", inputs },
      "14": { class_type: "PreviewAny", inputs: {} },
    },
  });
  assert.equal(
    promptContentHashFromBody(
      body({ images: ["1000", 0], filename_prefix: "video/20260823_142233", frame_rate: 24 }),
      volatileInputs,
    ),
    atHash,
    "the queue-time clock substitution is the exclusion's purpose",
  );
  assert.notEqual(
    promptContentHashFromBody(
      body({ images: ["1000", 0], filename_prefix: "video/20260823_142233", frame_rate: 30 }),
      volatileInputs,
    ),
    atHash,
    "a sibling input on the same VHS node is still drift-covered",
  );

  const ordinaryVolatileInputs = collectVolatileInputs({ _nodes: [vhsNode(223, "video/fixed_prefix")] });
  const ordinaryStamped = {
    "223": {
      class_type: "VHS_VideoCombine",
      inputs: { images: ["1000", 0], filename_prefix: "video/fixed_prefix", frame_rate: 24 },
    },
  };
  assert.equal(ordinaryVolatileInputs.size, 0, "an ordinary VHS prefix excludes nothing");
  assert.notEqual(
    promptContentHashFromBody(
      JSON.stringify({
        prompt: {
          "223": {
            class_type: "VHS_VideoCombine",
            inputs: { images: ["1000", 0], filename_prefix: "video/changed_prefix", frame_rate: 24 },
          },
        },
      }),
      ordinaryVolatileInputs,
    ),
    promptContentHash(ordinaryStamped, ordinaryVolatileInputs),
    "ordinary filename_prefix edits remain drift-covered",
  );
});

// ---------------------------------------------------------------------------
// #1331 — the FOURTH volatility mechanism: after reconnect, leftover values of
// link-driven converted widgets (MiniMax H3 clip/vae/model/length, …) settle
// between the pre-dispatch stamp and the POST body. The #1050 single retry
// still races because serializeValue keeps flipping those leftovers. The
// value that EXECUTES is the incoming link; the leftover is non-semantic.
// A PURE SOCKET (connected input, no matching widget / no convert-to-input
// marker) stays hashed — a KSampler.model rewire is still drift.
// ---------------------------------------------------------------------------

const minimaxH3Node = (id, { leftover = true } = {}) => ({
  id,
  type: "MiniMaxH3ReferenceToVideo",
  widgets: [
    { name: "clip", value: leftover ? "clip_l.safetensors" : ["4", 0] },
    { name: "vae", value: leftover ? "ae.safetensors" : ["5", 0] },
    { name: "length", value: leftover ? 81 : ["9", 0] },
    { name: "prompt", value: "a cat" },
  ],
  inputs: [
    { name: "clip", link: 11, widget: { name: "clip" } },
    { name: "vae", link: 12, widget: { name: "vae" } },
    { name: "length", link: 13, widget: { name: "length" } },
    { name: "prompt", link: null },
  ],
});

const hooklessControl = (value = "randomize") => ({
  name: "control_after_generate",
  value,
  options: {
    serialize: false,
    canvasOnly: true,
    values: ["fixed", "increment", "decrement", "randomize"],
  },
});

test("#1331 collectVolatileInputs: a link-driven converted widget is volatile, its unlinked sibling is not", () => {
  const graph = {
    _nodes: [
      minimaxH3Node(1000),
      { id: 3, widgets: [{ name: "steps", value: 20 }], inputs: [{ name: "model", link: 1 }] },
    ],
  };
  const pairs = collectVolatileInputs(graph);
  assert.ok(pairs.has("1000 clip"), "converted clip leftover is the race");
  assert.ok(pairs.has("1000 vae"), "converted vae leftover is the race");
  assert.ok(pairs.has("1000 length"), "converted length leftover is the race");
  assert.ok(!pairs.has("1000 prompt"), "an UNLINKED sibling widget stays drift-covered");
  assert.ok(!pairs.has("3 model"), "a PURE SOCKET (no matching widget, no convert marker) stays hashed");
  assert.ok(!pairs.has("3 steps"), "an unlinked widget on another node stays covered");
});

test("#1331 collectVolatileInputs: a same-name widget + linked input (no input.widget marker) is still the leftover", () => {
  // Older frontends omit input.widget and just keep the widget next to a
  // same-named connected input. That is still a converted leftover.
  const graph = {
    _nodes: [{
      id: 110,
      widgets: [{ name: "clip", value: "clip_l.safetensors" }, { name: "text", value: "hi" }],
      inputs: [{ name: "clip", link: 7 }, { name: "text", link: null }],
    }],
  };
  const pairs = collectVolatileInputs(graph);
  assert.ok(pairs.has("110 clip"));
  assert.ok(!pairs.has("110 text"));
});

test("#1331 collectVolatileInputs: the convert-to-input marker counts even when the widget was hidden", () => {
  // After convert, some builds drop the widget from node.widgets but leave
  // input.widget.name. graphToPrompt can still emit a leftover under that name
  // while the frontend settles — exclude the name, not the socket's siblings.
  const graph = {
    _nodes: [{
      id: 1100,
      widgets: [{ name: "prompt", value: "a cat" }],
      inputs: [
        { name: "clip", link: 1, widget: { name: "clip" } },
        { name: "model", link: 2 },
      ],
    }],
  };
  const pairs = collectVolatileInputs(graph);
  assert.ok(pairs.has("1100 clip"), "hidden converted widget is still the leftover");
  assert.ok(!pairs.has("1100 model"), "a pure socket on the same node stays hashed");
  assert.ok(!pairs.has("1100 prompt"), "an unlinked live widget stays covered");
});

test("#1331 collectVolatileInputs: the link-driven exclusion reaches nested subgraphs with the colon-path execId", () => {
  const root = {
    _nodes: [{ id: 10, widgets: [], subgraph: { _nodes: [minimaxH3Node(15)] } }],
  };
  const pairs = collectVolatileInputs(root);
  assert.ok(pairs.has("10:15 clip"), "nested leftover pairs line up with the flattened prompt keys");
  assert.ok(!pairs.has("10:15 prompt"));
});

test("#1331 collectVolatileInputs: an unlinked converted-shaped widget is NOT volatile — a mid-window edit is still drift", () => {
  const graph = {
    _nodes: [{
      id: 1000,
      widgets: [{ name: "clip", value: "clip_l.safetensors" }],
      inputs: [{ name: "clip", link: null, widget: { name: "clip" } }],
    }],
  };
  assert.equal(collectVolatileInputs(graph).size, 0, "no live link ⇒ the widget value is still what executes");
});

test("#1331 promptContentHash: leftover widget values stamp EQUAL to the dispatched link form — and a real edit still refuses", () => {
  const volatileInputs = collectVolatileInputs({ _nodes: [minimaxH3Node(1000)] });
  const stamped = {
    "4": { class_type: "CLIPLoader", inputs: { clip_name: "clip_l.safetensors" } },
    "1000": {
      class_type: "MiniMaxH3ReferenceToVideo",
      inputs: { clip: "clip_l.safetensors", vae: "ae.safetensors", length: 81, prompt: "a cat" },
    },
    "223": { class_type: "VHS_VideoCombine", inputs: { images: ["1000", 0] } },
  };
  const atHash = promptContentHash(stamped, volatileInputs);
  const dispatched = (inputs) =>
    JSON.stringify({
      prompt: {
        "4": { class_type: "CLIPLoader", inputs: { clip_name: "clip_l.safetensors" } },
        "1000": { class_type: "MiniMaxH3ReferenceToVideo", inputs },
        "223": { class_type: "VHS_VideoCombine", inputs: { images: ["1000", 0] } },
      },
    });
  assert.equal(
    promptContentHashFromBody(
      dispatched({ clip: ["4", 0], vae: ["5", 0], length: ["9", 0], prompt: "a cat" }),
      volatileInputs,
    ),
    atHash,
    "the leftover→link flip is the exclusion's purpose — the scoped run is no longer refused",
  );
  assert.notEqual(
    promptContentHashFromBody(
      dispatched({ clip: ["4", 0], vae: ["5", 0], length: ["9", 0], prompt: "a dog" }),
      volatileInputs,
    ),
    atHash,
    "a mid-window edit to any OTHER input of the same node is still drift",
  );
  assert.equal(
    promptContentHashFromBody(
      dispatched({ clip: ["88", 0], vae: ["5", 0], length: ["9", 0], prompt: "a cat" }),
      volatileInputs,
    ),
    atHash,
    "a mid-window rewiring OF the excluded leftover itself is the documented residual",
  );
});

test("#1331 collectVolatileInputs: hookless control_after_generate (reconnect) excludes the governed seed, not a sibling", () => {
  // After reconnect the combo is present by OPTION SHAPE before beforeQueued
  // is re-hung. The #572 hook scan finds nothing; the leftover seed still
  // randomizes between stamp and dispatch.
  const control = hooklessControl("randomize");
  const seed = { name: "noise_seed", value: 111, linkedWidgets: [control] };
  const graph = { _nodes: [{ id: 16, widgets: [seed, control, { name: "steps", value: 20 }] }] };
  for (const w of graph._nodes[0].widgets) {
    assert.equal(typeof w.beforeQueued, "undefined", `${w.name} carries no beforeQueued`);
  }
  const pairs = collectVolatileInputs(graph);
  assert.ok(pairs.has("16 noise_seed"), "the governed seed is volatile without a hook");
  assert.ok(pairs.has("16 control_after_generate"), "the carrier's own name is excluded too");
  assert.ok(!pairs.has("16 steps"), "a sibling stays drift-covered");
});

test("#1331 collectVolatileInputs: a FIXED hookless control excludes nothing", () => {
  const control = hooklessControl("fixed");
  const seed = { name: "noise_seed", value: 111, linkedWidgets: [control] };
  const graph = { _nodes: [{ id: 16, widgets: [seed, control] }] };
  assert.equal(collectVolatileInputs(graph).size, 0);
});

test("#1331 promptContentHash: hookless randomize seed churn is not drift — a sibling edit still is", () => {
  const control = hooklessControl("randomize");
  const seed = { name: "noise_seed", value: 111, linkedWidgets: [control] };
  const volatileInputs = collectVolatileInputs({
    _nodes: [{ id: 16, widgets: [seed, control, { name: "steps", value: 20 }] }],
  });
  const atHash = promptContentHash(
    { "16": { class_type: "RandomNoise", inputs: { noise_seed: 111, steps: 20 } } },
    volatileInputs,
  );
  const body = (inputs) => JSON.stringify({ prompt: { "16": { class_type: "RandomNoise", inputs } } });
  assert.equal(
    promptContentHashFromBody(body({ noise_seed: 999983, steps: 20 }), volatileInputs),
    atHash,
    "reconnect seed churn without a re-hung hook is the exclusion's purpose",
  );
  assert.notEqual(
    promptContentHashFromBody(body({ noise_seed: 999983, steps: 25 }), volatileInputs),
    atHash,
    "a genuine mid-window edit to a non-excluded input of the same node refuses",
  );
});


test("#572 promptContentHash: the narrowed exclusion tolerates ONLY the hook's own input — a seed edit is the documented residual, an edit to any OTHER input of the same node refuses", () => {
  const control = { name: "control_after_generate", value: "randomize", beforeQueued() {} };
  const seed = { name: "seed", value: 111, linkedWidgets: [control] };
  const graph = { _nodes: [{ id: 3, widgets: [seed, control, { name: "steps", value: 20 }] }] };
  const volatileInputs = collectVolatileInputs(graph);
  // Only the hook-mutated input itself is excluded — never a sibling.
  assert.deepEqual([...volatileInputs].sort(), ["3 control_after_generate", "3 seed"]);
  // Pre-dispatch fingerprint (seed value as serialized at hash time)…
  const atHash = promptContentHash(
    { "3": { class_type: "KSampler", inputs: { seed: 111, steps: 20 } }, "9": { class_type: "SaveImage", inputs: {} } },
    volatileInputs,
  );
  const postBody = (inputs) =>
    JSON.stringify({ prompt: { "3": { class_type: "KSampler", inputs }, "9": { class_type: "SaveImage", inputs: {} } } });
  // The hook's OWN reroll between serialization and dispatch is not drift…
  assert.equal(
    promptContentHashFromBody(postBody({ seed: 999983, steps: 20 }), volatileInputs),
    atHash,
    "the queue-time reroll is the exclusion's purpose",
  );
  // …and a USER edit to that same excluded input is indistinguishable from it:
  // TOLERATED — the documented accepted residual (surfaced via the run result's
  // drift_coverage note; no hash can separate "user set 777" from "hook rerolled").
  assert.equal(
    promptContentHashFromBody(postBody({ seed: 777, steps: 20 }), volatileInputs),
    atHash,
    "accepted residual: a user edit to the hook-mutated input rides the exclusion",
  );
  // A user edit to ANY OTHER input of the SAME node is still caught as drift.
  assert.notEqual(
    promptContentHashFromBody(postBody({ seed: 999983, steps: 25 }), volatileInputs),
    atHash,
    "a genuine mid-window edit to a non-excluded input of the same node refuses",
  );
});

test("#630 scopeDroppedError: the no-scope refusal states the OBSERVATION and no longer asserts a cause it cannot see", () => {
  // The pre-#630 message asserted "this frontend build ignored the run-to-node
  // argument" for every no-usable-scope state. That is a bucket narrated as a
  // cause, and three #556 field reports pasted that asserted cause into the
  // tracker, which is why the real cause is still unknown.
  //
  // #752 — THE REPLACEMENT WAS ALSO AN UNEARNED CLAIM, and this comment used to
  // state it as fact: that ComfyUI_frontend 1.42 through 1.50 all accept BOTH
  // third-argument shapes. Only 1.47.12 was ever measured. Three field reports on
  // 1.45.21 — inside that range — hit this path, so the range was wrong, and
  // saying so in the shipped message told each reporter their own evidence could
  // not be happening. Whatever this note says next, it may not assert behaviour
  // of a build nobody here has run.
  const msg = scopeDroppedError({
    toNodeId: 4995,
    verdict: { ok: false, reason: "scope_missing", expected: ["4995"], got: null, bodyKeys: ["client_id", "extra_data", "number", "prompt"] },
  });
  assert.match(msg, /node 4995/);
  assert.match(msg, /no partial_execution_targets key at all/, "says what was seen");
  assert.doesNotMatch(
    msg,
    /this frontend build ignored the run-to-node argument/,
    "the discredited single-cause assertion must be gone, not merely reworded around",
  );
  // Evidence survives to the report instead of being thrown away.
  assert.match(msg, /body keys: client_id, extra_data, number, prompt/);
  // Refusal, not a silent fallback.
  assert.match(msg, /Nothing was queued/);
  assert.match(msg, /refusing to fall through to a full-graph execution/);
  // A remedy that works from where the caller is standing — and the full-graph
  // cost is stated, never taken silently on their behalf.
  assert.match(msg, /panel_run without to_node_id/);
  assert.match(msg, /WHOLE graph/);
});

test("#630 scopeDroppedError: the four distinct no-usable-scope states read differently — a timed-out/unreadable observation is not a definite 'the key was absent'", () => {
  const of = (reason, extra = {}) =>
    scopeDroppedError({ toNodeId: 7, verdict: { ok: false, reason, expected: ["7"], got: null, ...extra } });
  const absent = of("scope_missing");
  const empty = of("scope_empty");
  const notList = of("scope_not_a_list", { raw: { queueNodeIds: ["7"] } });
  const unreadable = of("body_unreadable");
  assert.match(absent, /no partial_execution_targets key at all/);
  assert.match(empty, /EMPTY partial_execution_targets list/);
  assert.match(notList, /was not a list/);
  assert.match(notList, /queueNodeIds/, "the actual value is evidence for the next report");
  assert.match(unreadable, /could not be parsed/);
  const all = [absent, empty, notList, unreadable];
  assert.equal(new Set(all).size, 4, "four observations, four messages — never one verdict standing in for all of them");
  // None of them may claim the key was absent when that is not what happened.
  assert.doesNotMatch(empty, /no partial_execution_targets key at all/);
  assert.doesNotMatch(notList, /no partial_execution_targets key at all/);
  assert.doesNotMatch(unreadable, /no partial_execution_targets key at all/);
});

test("#630 guard: each distinct no-usable-scope state is reported as ITSELF, not folded into scope_missing", async () => {
  const stop = keepAlive();
  try {
    const run = async (targetsValue) => {
      const orig = makeServer();
      const guard = createScopedRunGuard({
        origFetchApi: orig,
        execIds: ["14"],
        contentHash: OUR_HASH,
        batch: 1,
        toNodeId: 14,
        queueMark: MARK_A,
      });
      const body = { prompt: OUR_OUTPUT, client_id: "x", number: MARK_A };
      if (targetsValue !== undefined) body.partial_execution_targets = targetsValue;
      await guard(...promptPost(body));
      return guard.state.droppedReason;
    };
    assert.equal(await run(undefined), "scope_missing");
    assert.equal(await run([]), "scope_empty");
    assert.equal(await run({ queueNodeIds: ["14"] }), "scope_not_a_list");
    assert.equal(await run("14"), "scope_not_a_list");
  } finally {
    stop();
  }
});

test("#572 scopeDroppedError: graph_changed guidance names the retry safety and the queue-time hook cause", () => {
  const msg = scopeDroppedError({ toNodeId: 116, verdict: { ok: false, reason: "graph_changed" } });
  assert.match(msg, /node 116/);
  assert.match(msg, /Retrying is safe \(nothing was queued\)/);
  assert.match(msg, /queue-time widget hook/);
  assert.match(msg, /Nothing was queued/);
});

test("#556 verifyScopedPromptBody: exact scope passes; missing/empty/wrong/extra/unparseable all refuse", () => {
  assert.deepEqual(verifyScopedPromptBody(JSON.stringify({ partial_execution_targets: ["10:15:359"] }), ["10:15:359"]), { ok: true });
  assert.equal(verifyScopedPromptBody(JSON.stringify({ prompt: {} }), ["14"]).reason, "scope_missing");
  assert.equal(verifyScopedPromptBody(JSON.stringify({ partial_execution_targets: ["14", "9"] }), ["14"]).reason, "scope_mismatch");
  assert.equal(verifyScopedPromptBody("garbage{", ["14"]).ok, false);
  assert.deepEqual(verifyScopedPromptBody("garbage", null), { ok: true });
});

test("#556 error messages: dropped names the node + nothing queued; unverified distinguishes cancelled vs sentinel; unattributable fails closed", () => {
  const dropped = scopeDroppedError({ toNodeId: 14, verdict: { ok: false, reason: "scope_missing", expected: ["14"], got: null } });
  assert.match(dropped, /node 14/);
  assert.match(dropped, /Nothing was queued/);
  const cancelled = scopeUnverifiedError({ toNodeId: 14, timeoutMs: 5000, cancelled: true });
  assert.match(cancelled, /REMOVED/);
  assert.match(cancelled, /nothing was queued/i);
  const sentinel = scopeUnverifiedError({ toNodeId: 14, timeoutMs: 5000, cancelled: false });
  assert.match(sentinel, /sentinel/);
  assert.match(sentinel, /CONFIRMED queued/i);
  const unattributable = scopeUnattributableError({ toNodeId: 14 });
  assert.match(unattributable, /cannot be dispatched safely/);
  assert.match(unattributable, /Nothing was queued/);
});

// ---------------------------------------------------------------------------
// createRunFetchInterceptor — the UNSCOPED path (historical #358/#370 capture)
// ---------------------------------------------------------------------------

test("#556 unscoped interceptor: captures top-level rejection and prompt_id, leaves the request untouched", async () => {
  const spy = makeServer(async () => jsonResponse(400, { error: { type: "missing_node_type" } }));
  let rejection = null;
  const intercepted = createRunFetchInterceptor({ origFetchApi: spy, onRejection: (r) => (rejection = r) });
  const [route, options] = promptPost({ prompt: {} });
  const res = await intercepted(route, options);
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].options, options);
  assert.equal(res.status, 400);
  assert.deepEqual(rejection, { error: { type: "missing_node_type" }, node_errors: null });

  const ids = [];
  const intercepted2 = createRunFetchInterceptor({ origFetchApi: makeServer(async () => jsonResponse(200, { prompt_id: 0 })), onPromptId: (p) => ids.push(p) });
  await intercepted2(...promptPost({ prompt: {} }));
  assert.deepEqual(ids, ["0"], "falsy-but-valid id 0 captured, string-normalized");
});

// ---------------------------------------------------------------------------
// createScopedRunGuard — mark-based attribution (unit level)
// ---------------------------------------------------------------------------

test("#556 guard: OUR marked post with signature+exact targets ⇒ observed, dispatched verbatim, prompt_id captured", async () => {
  const spy = makeServer();
  const ids = [];
  const guard = createScopedRunGuard({ origFetchApi: spy, execIds: ["14"], contentHash: OUR_HASH, batch: 1, toNodeId: 14, queueMark: MARK_A, onPromptId: (p) => ids.push(p) });
  const [route, options] = promptPost(frontendBody({ targets: ["14"] }));
  const res = await guard(route, options);
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].options, options);
  assert.equal(res.status, 200);
  assert.equal(guard.state.observed, 1);
  assert.deepEqual(ids, ["srv-1"]);
});

test("#556 r6: an attributed post whose fetch THROWS is a dispatch FAILURE — never counted as verified, never captured", async () => {
  const spy = makeServer(async () => { throw new Error("connection reset"); });
  let captured = null;
  const guard = createScopedRunGuard({ origFetchApi: spy, execIds: ["14"], contentHash: OUR_HASH, batch: 1, toNodeId: 14, queueMark: MARK_A, onPromptId: (p) => (captured = p) });
  await assert.rejects(guard(...promptPost(frontendBody({ targets: ["14"] }))), /connection reset/);
  assert.equal(guard.state.observed, 0, "a thrown fetch never satisfies the batch verdict");
  assert.match(guard.state.failed, /connection reset/);
  // #630 r7 P0-4 — the message is now a DISCLOSURE, not a denial: the request
  // had already left, so whether ComfyUI accepted it is not observable.
  assert.match(guard.state.failed, /NOT confirmed queued/);
  assert.match(guard.state.failed, /CANNOT be determined from here/);
  assert.equal(captured, null, "no prompt_id claimed");
});

test("#556 r6: an attributed post with a MALFORMED response (200 without prompt_id, or non-200 without a rejection body) is a dispatch FAILURE", async () => {
  for (const bad of [jsonResponse(200, {}), jsonResponse(500, {}), jsonResponse(200, { prompt_id: null })]) {
    const spy = makeServer(async () => bad);
    let captured = null;
    const guard = createScopedRunGuard({ origFetchApi: spy, execIds: ["14"], contentHash: OUR_HASH, batch: 1, toNodeId: 14, queueMark: MARK_A, onPromptId: (p) => (captured = p) });
    const res = await guard(...promptPost(frontendBody({ targets: ["14"] })));
    assert.equal(res, bad, "the real response passes back to the frontend");
    assert.equal(guard.state.observed, 0, `HTTP ${bad.status} malformed ⇒ not verified`);
    assert.match(guard.state.failed, /malformed/);
    assert.equal(captured, null);
  }
});

test("#1690: a scoped batch with a blank receipt and a valid receipt is uncertain, not queued:true", async () => {
  const stop = keepAlive();
  try {
    const responses = [jsonResponse(200, { prompt_id: "   " }), jsonResponse(200, { prompt_id: "p2" })];
    let responseIndex = 0;
    const server = makeServer(() => responses[responseIndex++]);
    const apiTarget = { fetchApi: server };
    const app = makeFrontend({ shape: "shim", apiTarget });
    app.queuePrompt = async (number, batch) => {
      for (let i = 0; i < batch; i++) {
        const body = frontendBody({ number, targets: ["14"] });
        app.posted.push(body);
        await apiTarget.fetchApi("/prompt", { method: "POST", body: JSON.stringify(body) });
      }
      return true;
    };
    const ids = [];
    const result = await dispatchScopedRun({
      app,
      apiTarget,
      execIds: ["14"],
      batch: 2,
      toNodeId: 14,
      onPromptId: (p) => ids.push(p),
    });
    assert.equal(server.calls.length, 2);
    assert.deepEqual(ids, ["p2"], "the usable receipt remains ledger-eligible");
    assert.equal(result.verified, 1);
    assert.equal(result.indeterminate, 1, "the blank receipt consumes an uncertain batch slot");
    assert.notEqual(result.outcome, "dispatched", "one blank receipt prevents a full-batch claim");
  } finally {
    stop();
  }
});

test("#556 r6: a GENUINE server rejection still flows through the established #358 rejection channel (not a dispatch failure)", async () => {
  const rejectionBody = { error: { type: "prompt_outputs_failed_validation", message: "bad input" } };
  const spy = makeServer(async () => jsonResponse(400, rejectionBody));
  let rejection = null;
  const guard = createScopedRunGuard({ origFetchApi: spy, execIds: ["14"], contentHash: OUR_HASH, batch: 1, toNodeId: 14, queueMark: MARK_A, onRejection: (r) => (rejection = r) });
  await guard(...promptPost(frontendBody({ targets: ["14"] })));
  assert.equal(guard.state.rejected, 1);
  assert.equal(guard.state.failed, null, "a server rejection is NOT a dispatch failure");
  assert.equal(guard.state.observed, 0);
  assert.deepEqual(rejection, { error: rejectionBody.error, node_errors: null });
});

test("#556 guard: OUR marked post with MISSING or WRONG/EXTRA targets ⇒ refused with zero dispatch", async () => {
  for (const bad of [null, ["9"], ["14", "9"]]) {
    const spy = makeServer();
    let dropped = null;
    const guard = createScopedRunGuard({ origFetchApi: spy, execIds: ["14"], contentHash: OUR_HASH, batch: 1, toNodeId: 14, queueMark: MARK_A, onScopeDropped: (m) => (dropped = m) });
    const res = await guard(...promptPost(frontendBody({ targets: bad })));
    assert.equal(spy.calls.length, 0, `targets ${JSON.stringify(bad)} must never leave the tab`);
    assert.equal(res.status, 400);
    assert.match(dropped, /node 14/);
    assert.equal(guard.state.observed, 0);
  }
});

test("#556 r3 P0-3: an UNMARKED post is FOREIGN even with our node set AND our targets — never refused, never captured, never observed", async () => {
  const spy = makeServer();
  let captured = null, dropped = null;
  const guard = createScopedRunGuard({
    origFetchApi: spy, execIds: ["14"], contentHash: OUR_HASH, batch: 1, toNodeId: 14, queueMark: MARK_A,
    onPromptId: (p) => (captured = p), onScopeDropped: (m) => (dropped = m),
  });
  // A foreign scoped run to the same node (number=0 ⇒ no body.number ⇒ unmarked).
  const foreignScoped = await guard(...promptPost(frontendBody({ number: 0, targets: ["14"] })));
  assert.equal(foreignScoped.status, 200);
  assert.equal(spy.calls.length, 1);
  assert.equal(guard.state.observed, 0, "foreign same-targets post never satisfies observation");
  assert.equal(captured, null);
  // A user's full run of the SAME graph — never refused as our corrupted dispatch.
  const userFull = await guard(...promptPost(frontendBody({ number: 0, targets: null })));
  assert.equal(userFull.status, 200);
  assert.equal(spy.calls.length, 2);
  assert.equal(dropped, null);
  assert.equal(guard.state.dropped, null);
});

test("#556 guard: a marked post whose graph CHANGED under the deferred item (signature mismatch) is corrupted ⇒ refused", async () => {
  const spy = makeServer();
  const guard = createScopedRunGuard({ origFetchApi: spy, execIds: ["14"], contentHash: OUR_HASH, batch: 1, toNodeId: 14, queueMark: MARK_A });
  const changedOutput = { "3": { class_type: "KSampler" }, "20": { class_type: "SaveImage" } };
  const res = await guard(...promptPost(frontendBody({ output: changedOutput, targets: ["14"] })));
  assert.equal(res.status, 400, "scope is unverifiable against the changed graph — refuse");
  assert.equal(spy.calls.length, 0);
});

// ---------------------------------------------------------------------------
// cancelPendingScopedQueueItem — ownership-tagged removal
// ---------------------------------------------------------------------------

test("#556 r3/r4: cancellation removes ONLY the ownership-tagged item with THIS run's mark — tag without the mark, and foreign items, stay", () => {
  const runTag = Symbol("t");
  const ourArray = ["14"];
  Object.defineProperty(ourArray, QUEUE_ITEM_TAG, { value: runTag, enumerable: false });
  const ourOptionsItem = { number: MARK_A, batchCount: 1, queueNodeIds: { queueNodeIds: ourArray } };
  const ourDirectItem = { number: MARK_A, batchCount: 1, queueNodeIds: ourArray };
  // Same tag but a DIFFERENT run's mark — never ours (paranoia; can't happen
  // in practice since tag and mark are minted together).
  const wrongMarkItem = { number: MARK_B, batchCount: 1, queueNodeIds: ourArray };
  const foreignSameScope = { number: 0, batchCount: 1, queueNodeIds: ["14"] };
  const userFullRun = { number: 0, batchCount: 1, queueNodeIds: undefined };
  const app = { queueItems: [userFullRun, wrongMarkItem, foreignSameScope, ourDirectItem, ourOptionsItem] };
  const res = cancelPendingScopedQueueItem(app, { runTag, queueMark: MARK_A });
  assert.equal(res.accessible, true);
  assert.equal(res.removed, 2, "our item removed in either stored shape");
  assert.deepEqual(app.queueItems, [userFullRun, wrongMarkItem, foreignSameScope], "mark-mismatched and foreign items stay");
});

test("#556 r3 P0-3: hard-private queueItems builds ⇒ inaccessible (caller keeps the sentinel)", () => {
  assert.deepEqual(cancelPendingScopedQueueItem({}, { runTag: Symbol("t"), queueMark: MARK_A }), { accessible: false, removed: 0 });
});

test("#556 r4 P0-2: newScopedQueueMark is unique per run, nonzero, a safe integer near 2^30 (sorts to the queue end)", () => {
  const a = newScopedQueueMark();
  const b = newScopedQueueMark();
  assert.notEqual(a, b, "two runs never share a mark — a sentinel can't claim a later run's traffic");
  for (const m of [a, b]) {
    assert.ok(Number.isSafeInteger(m));
    assert.ok(m > 0);
    assert.ok(m <= 2 ** 30 - 1 && m > 2 ** 29, "large enough to always append at the priority-queue end");
  }
});

// ---------------------------------------------------------------------------
// dispatchScopedRun — the REAL orchestration graph_run runs (integration)
// ---------------------------------------------------------------------------

test("#556 integration: happy path — marked scoped dispatch observed, prompt_id captured, sentinel RETAINED (#630 r4)", async () => {
  const stop = keepAlive();
  try {
    const apiTarget = { fetchApi: makeServer() };
    const prev = apiTarget.fetchApi;
    const app = makeFrontend({ shape: "shim", apiTarget });
    const ids = [];
    const result = await dispatchScopedRun({
      app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14,
      onPromptId: (p) => ids.push(p),
    });
    assert.equal(result.outcome, "dispatched");
    assert.deepEqual(ids, ["srv-1"]);
    // #630 r4 — DELIBERATE CHANGE. This used to assert restoration. Restoring
    // on success uninstalled the quota fence, so a LATE same-mark post (a
    // deferred duplicate emitted after queuePrompt returned) bypassed the guard
    // and, on a scope-dropping build, left the tab UNSCOPED — a full-graph run
    // arriving after a scoped success was already reported.
    assert.notEqual(apiTarget.fetchApi, prev, "the sentinel is retained so a late post of THIS run is still fenced");
    assert.equal(app.posted.length, 1, "first arg shape worked — no retry");
    assert.equal(app.posted[0].number, result.queueMark, "our posts carry THIS run's queue mark");
    assert.deepEqual(app.posted[0].partial_execution_targets, ["14"]);
  } finally {
    stop();
  }
});

test("#572 integration: the scoped-run result SURFACES the drift-uncovered inputs (hook-mutated inputs are not drift-covered)", async () => {
  const stop = keepAlive();
  try {
    const apiTarget = { fetchApi: makeServer() };
    const app = makeFrontend({ shape: "shim", apiTarget });
    // The live graph carries a seed whose linked control re-rolls it at queue time:
    // that input (and the unserialized carrier) is excluded from the drift hash, so
    // the run must REPORT the coverage gap rather than claim full-graph drift proof.
    const control = { name: "control_after_generate", value: "randomize", beforeQueued() {} };
    const seed = { name: "seed", value: 111, linkedWidgets: [control] };
    app.graph = { _nodes: [{ id: 3, widgets: [seed, control, { name: "steps", value: 20 }] }] };
    const result = await dispatchScopedRun({ app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14 });
    assert.equal(result.outcome, "dispatched");
    assert.deepEqual(
      [...(result.volatileInputs ?? [])].sort(),
      ["3 control_after_generate", "3 seed"],
      "the run reports exactly which inputs were NOT drift-covered for this run",
    );
  } finally {
    stop();
  }
});

test("#572 integration: a graph with NO queue-time hooks reports full drift coverage (no uncovered inputs)", async () => {
  const stop = keepAlive();
  try {
    const apiTarget = { fetchApi: makeServer() };
    const app = makeFrontend({ shape: "shim", apiTarget });
    app.graph = { _nodes: [{ id: 3, widgets: [{ name: "seed", value: 111 }, { name: "steps", value: 20 }] }] };
    const result = await dispatchScopedRun({ app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14 });
    assert.equal(result.outcome, "dispatched");
    assert.deepEqual(result.volatileInputs ?? [], [], "nothing excluded ⇒ the whole prompt was drift-covered");
  } finally {
    stop();
  }
});

test("#556 integration: a shim-less options build drops the legacy array — attempt 1 refused with ZERO dispatch, attempt 2 delivers", async () => {
  const stop = keepAlive();
  try {
    // Hold the SERVER double directly: since #630 r4 a successful run retains
    // its sentinel, so apiTarget.fetchApi is the guard afterwards, not this.
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const app = makeFrontend({ shape: "shimless", apiTarget });
    const result = await dispatchScopedRun({ app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14 });
    assert.equal(result.outcome, "dispatched");
    assert.equal(app.posted.length, 2, "both shapes attempted");
    assert.equal(app.posted[0].partial_execution_targets, undefined, "attempt 1 (array) dropped by this build");
    assert.equal(server.calls.length, 1, "only the correctly-shaped dispatch reached the server");
    assert.deepEqual(JSON.parse(server.calls[0].options.body).partial_execution_targets, ["14"]);
  } finally {
    stop();
  }
});

test("#630 integration: a build honoring NEITHER shape is now HONOURED, not refused — and the request that reaches ComfyUI names ONLY node 14's branch", async () => {
  // Supersedes the pre-#630 expectation ("truthful refusal, zero dispatches").
  // Refusing was safe but was not what the caller asked for; the requested
  // subset is now actually executed. The assertion that matters is not "the
  // run completed" — it is WHICH nodes ComfyUI was told to execute.
  const stop = keepAlive();
  try {
    // Hold the SERVER double directly (see #630 r4: success retains the sentinel).
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const app = makeFrontend({ shape: "dropping", apiTarget });
    const result = await dispatchScopedRun({ app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14 });
    assert.equal(result.outcome, "dispatched");
    assert.equal(result.scopeAppliedBy, "request_body_repair", "the caller can tell HOW the scope was delivered");
    assert.equal(result.repaired, 1);
    // Both native shapes were tried first and both dropped the scope…
    assert.equal(
      app.posted.length,
      4,
      "array shape, queueNodeIds shape, partialExecutionTargets shape, then the repair attempt",
    );
    assert.equal(app.posted[0].partial_execution_targets, undefined);
    assert.equal(app.posted[1].partial_execution_targets, undefined);
    assert.equal(app.posted[2].partial_execution_targets, undefined);
    // …and exactly ONE request reached ComfyUI, carrying exactly node 14.
    assert.equal(server.calls.length, 1, "the two unrepaired attempts were blocked, not forwarded");
    const sent = JSON.parse(server.calls[0].options.body);
    assert.deepEqual(
      sent.partial_execution_targets,
      ["14"],
      "ONLY the requested branch is an execution root — SaveImage (9) is never named",
    );
    assert.ok(!sent.partial_execution_targets.includes("9"), "the unrelated SaveImage branch is not a root (#556)");
    assert.deepEqual(sent.prompt, OUR_OUTPUT, "the prompt itself is untouched by the repair");
    assert.equal(sent.number, result.queueMark, "the repaired body keeps this run's identity mark");
  } finally {
    stop();
  }
});

test("#630 gate r1: batch=2 through the REPAIR path — EVERY post is repaired and EVERY body that reaches ComfyUI names only node 14", async () => {
  // Repair must survive the batch accounting, not just the single-post case:
  // a batch is N separate /prompt posts, and a scope that reached only the
  // first would leave the rest running the full graph.
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const app = makeFrontend({ shape: "dropping", apiTarget });
    app.queuePrompt = async (number, batch) => {
      for (let i = 0; i < batch; i++) {
        const body = frontendBody({ output: OUR_OUTPUT, number, targets: null }); // scope dropped every time
        app.posted.push(body);
        await apiTarget.fetchApi("/prompt", { method: "POST", body: JSON.stringify(body) });
      }
      return true;
    };
    const ids = [];
    const result = await dispatchScopedRun({
      app, apiTarget, execIds: ["14"], batch: 2, toNodeId: 14,
      onPromptId: (p) => ids.push(p),
    });
    assert.equal(result.outcome, "dispatched");
    assert.equal(result.verified, 2, "the WHOLE batch verified — never dispatched on a partial");
    assert.equal(result.repaired, 2, "both posts needed the repair, both got it");
    assert.equal(result.scopeAppliedBy, "request_body_repair");
    assert.deepEqual(ids, ["srv-1", "srv-2"], "every repaired prompt_id still reaches the recovery ledger");
    // The assertion that matters: what ComfyUI was told to execute, per post.
    assert.equal(server.calls.length, 2);
    for (const call of server.calls) {
      assert.deepEqual(
        JSON.parse(call.options.body).partial_execution_targets,
        ["14"],
        "every post in the batch is scoped — not just the first",
      );
    }
  } finally {
    stop();
  }
});

test("#630 gate r1: a batch where a LATER post drifts is still a truthful partial — repair never rescues a changed graph into a full-batch claim", async () => {
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const app = makeFrontend({ shape: "dropping", apiTarget });
    app.queuePrompt = async (number, batch) => {
      for (let i = 0; i < batch; i++) {
        // Post 2 of EACH attempt serializes a DRIFTED graph (a widget value
        // changed under the deferred item). Per-attempt, not cumulative: the
        // earlier argument-shape attempts must present the same situation.
        const output = i === 0 ? OUR_OUTPUT : { ...OUR_OUTPUT, "3": { class_type: "KSampler", inputs: { steps: 99 } } };
        const body = frontendBody({ output, number, targets: null });
        app.posted.push(body);
        const res = await apiTarget.fetchApi("/prompt", { method: "POST", body: JSON.stringify(body) });
        if (res.status !== 200) break; // the frontend's batch loop breaks on a refusal
      }
      return true;
    };
    const result = await dispatchScopedRun({ app, apiTarget, execIds: ["14"], batch: 2, toNodeId: 14 });
    assert.equal(result.outcome, "refused", "never 'dispatched' on a partial batch");
    assert.equal(result.verified, 1, "the truthful count of what IS queued");
    assert.match(result.error, /1 of 2/);
    assert.match(result.error, /graph changed/i, "the drift is named, not repaired away");
    assert.equal(server.calls.length, 1, "only the undrifted post reached ComfyUI");
    assert.deepEqual(JSON.parse(server.calls[0].options.body).partial_execution_targets, ["14"]);
  } finally {
    stop();
  }
});

test("#630 gate r1: graph_run's repair disclosure separates what was OBSERVED from what was not — it never asserts the frontend's internal hook mode", () => {
  // The panel sees the outgoing request body, not the frontend's queue loop.
  // Two different frontend behaviours produce the identical observation: the
  // positional argument accepted (hooks ran partial) with the field dropped
  // later, or the argument ignored outright (hooks ran full). Naming the
  // second as fact would be asserting a cause from a bucket — the exact defect
  // this change exists to remove — so the note must state the uncertainty.
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "../../web/js/comfyui-mcp-panel.js"), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf('accept.scope_applied_by = "request_body_repair"');
  assert.ok(start > 0, "graph_run discloses a body-repaired scope rather than reporting it as a native scoped run");
  // Rebuild the message the caller actually receives: the source spells it as
  // adjacent template chunks joined with `+`, so strip the concatenation
  // scaffolding and assert against the prose itself, not its line breaks.
  //
  // #752 — two things the first version of this got wrong, both of which made it
  // assert against text that is not in the message. It sliced a magic 1800
  // characters, so growing the note silently pushed the last assertion off the
  // end; and it did not strip `//` comments, so a comment ABOUT the message read
  // as part of it. Now it slices to the end of the statement and drops comment
  // lines, which is what "the message the caller receives" actually means.
  const end = source.indexOf("\n    }", start);
  assert.ok(end > start, "the scope_note assignment must be a bounded block");
  const note = source
    .slice(start, end)
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n")
    .replace(/`\s*\+\s*\n\s*`/g, "")
    .replace(/\s+/g, " ");
  assert.match(note, /OBSERVED: the request ComfyUI received names ONLY node \$\{to_node_id\} as an execution root/,
    "what the panel actually saw is labelled as such, and it is which nodes execute");
  assert.match(note, /NOT OBSERVED: whether the frontend also treated this as a partial execution internally/,
    "and what it could not see is labelled too");
  // The discredited definite claim must be gone, not softened around.
  assert.doesNotMatch(
    note,
    /the frontend ran its queue-time widget hooks as if this were a full run/,
    "the unobserved hook mode must never be stated as fact",
  );
  assert.match(note, /If it did not, its queue-time widget hooks ran/,
    "the hook consequence is conditional on the unobserved branch");
  assert.match(note, /does not change which nodes execute/, "and its blast radius is bounded honestly");
  // #996 — the note used to end by sending reporters off to file with nothing to
  // compare against. There is now one MEASURED fact to give them: on 1.48.7 the
  // positional shape DOES put partial_execution_targets into the request, captured
  // from the outgoing body, so the capability exists upstream and upgrading may be
  // the shortest fix.
  assert.match(
    note,
    /On ComfyUI_frontend 1\.48\.7 the positional argument shape DOES carry the scope/,
    "the measured build is named, together with what was measured about it",
  );
  assert.match(note, /measured by capturing the outgoing body/, "and how it was established");
  // The ask survives — one datum is not a diagnosis — but WHAT it asks for changed
  // (#996). Two reports arrived with the build and the ComfyUI_frontend version this
  // used to request, and neither identified the cause: the version is not what
  // differs. It now asks for the queue-chain line, which names the two links that
  // can silently drop the scope.
  // This assertion reads the note's SOURCE, so it can only see the delegation —
  // the wording now lives in web/js/lib/queue-prompt-chain.js and is asserted
  // behaviourally in queue-prompt-chain.test.mjs, against the same patched-chain
  // shape measured on a live 1.48.7 (app.queuePrompt wrapped by a custom node,
  // api.queuePrompt wrapped by rgthree). That is a stronger check than a grep for
  // a sentence, which is why the sentence moved.
  assert.match(note, /describeQueuePromptChainForReport\(/, "the ask survives, via the shared builder");
  // …and it reads the globals through the GUARDED accessor. Inlining `window.app`
  // here would put a throwing getter outside every guard in the library — a
  // mutation doing exactly that survived every behavioural test, because the call
  // site is only reachable in a browser.
  assert.match(note, /queuePromptChainDeps\(\)/, "the globals are read through the guarded accessor");
  assert.doesNotMatch(
    note,
    /including your ComfyUI_frontend version/,
    "it no longer asks for the datum that failed to identify the cause twice",
  );
  // The workaround must name the version that was actually measured. "upgrading may
  // help" does not say to WHAT, and no 1.48.6→1.48.7 end-to-end result was taken
  // (codex).
  assert.match(note, /trying ComfyUI_frontend 1\.48\.7 may be the quickest workaround/i,
    "the workaround names the measured build, not upgrading in general");
  // And the datum is bounded to what capturing a request body can show.
  assert.match(note, /establishes that the request is built correctly there, not that a whole run behaves differently/,
    "serialization is not end-to-end behaviour, and the note says so");
  // #752's lesson, which this change sits one edit away from repeating: a version
  // RANGE is a claim about builds nobody here has measured. One build must not
  // become one. The first version of this guard missed "all 1.48.x builds" and
  // "1.48.6 through 1.48.9" (codex), so it matches the SHAPES a range takes.
  assert.doesNotMatch(
    note,
    /affects versions|all builds (before|after)|all 1\.\d+\.x|\d+\.\d+\.\d+\s*(-|–|through|to)\s*\d+\.\d+\.\d+|1\.4\d\s*-\s*1\.\d+/i,
    "one measured build must never be inflated into a range",
  );
});

test("#630 gate r2: an explicit partial_execution_targets:null is a PRESENT key, never reported as 'no key at all'", async () => {
  // The body keys printed as evidence would show the key present. Saying the
  // key was absent would contradict the panel's own evidence — the observed-
  // state-collapsed-into-a-definite-negative defect this split exists to stop.
  const stop = keepAlive();
  try {
    const orig = makeServer();
    const guard = createScopedRunGuard({
      origFetchApi: orig,
      execIds: ["14"],
      contentHash: OUR_HASH,
      batch: 1,
      toNodeId: 14,
      queueMark: MARK_A,
    });
    await guard(...promptPost({ prompt: OUR_OUTPUT, client_id: "x", number: MARK_A, partial_execution_targets: null }));
    assert.equal(guard.state.droppedReason, "scope_not_a_list", "a present-but-unusable value is not an absent key");
    assert.doesNotMatch(guard.state.dropped, /no partial_execution_targets key at all/);
    assert.match(guard.state.dropped, /was not a list \(null\)/);
    // …while a genuinely absent key still reads as absent.
    const g2 = createScopedRunGuard({
      origFetchApi: makeServer(), execIds: ["14"], contentHash: OUR_HASH, batch: 1, toNodeId: 14, queueMark: MARK_A,
    });
    await g2(...promptPost({ prompt: OUR_OUTPUT, client_id: "x", number: MARK_A }));
    assert.equal(g2.state.droppedReason, "scope_missing");
    assert.match(g2.state.dropped, /no partial_execution_targets key at all/);
  } finally {
    stop();
  }
});

test("#630 gate r3: an EXTRA post beyond the requested batch is FENCED, not dispatched — the branch never runs more times than asked", async () => {
  // The old batch bound was observational: it stopped the orchestration
  // waiting, but never stopped a post leaving. A duplicate/stale same-identity
  // post therefore executed the requested branch AGAIN — real GPU/API cost —
  // while graph_run still reported batch_count as what was asked for. The
  // repair would have widened this: a duplicate whose scope was dropped used
  // to be refused, and would now have been repaired into a dispatch.
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const app = makeFrontend({ shape: "dropping", apiTarget });
    app.queuePrompt = async (number, batch) => {
      // The defect mode: batch+1 posts for a batch of `batch`.
      for (let i = 0; i < batch + 1; i++) {
        const body = frontendBody({ output: OUR_OUTPUT, number, targets: null });
        app.posted.push(body);
        await apiTarget.fetchApi("/prompt", { method: "POST", body: JSON.stringify(body) });
      }
      return true;
    };
    const result = await dispatchScopedRun({ app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14 });
    assert.equal(result.outcome, "dispatched", "the prompt that WAS asked for is queued — not a failure");
    assert.equal(result.verified, 1);
    assert.equal(
      server.calls.length,
      1,
      "EXACTLY the requested number of prompts reached ComfyUI — the extra was fenced, not forwarded",
    );
    assert.deepEqual(JSON.parse(server.calls[0].options.body).partial_execution_targets, ["14"]);
    // Disclosed, never silent: the caller learns their frontend produced an extra.
    assert.equal(result.overrunBlocked, 1);
    assert.match(result.overrunNote, /EXTRA \/prompt post/);
    assert.match(result.overrunNote, /refused rather than dispatched/);
    assert.match(result.overrunNote, /requested prompts are queued and unaffected/,
      "a disclosure about work that succeeded — never a failure that invites a retry");
  } finally {
    stop();
  }
});

test("#630 gate r4: a LATE extra post, arriving AFTER the run reported success, still cannot run the full graph", async () => {
  // The deferred race the r3 fence alone did not cover. Completing the batch
  // used to restore fetchApi, uninstalling the quota fence — so a duplicate the
  // frontend's processor emits after queuePrompt returned bypassed the guard
  // entirely and, on a scope-dropping build, went out UNSCOPED. A full-graph
  // execution arriving after we already reported a scoped success is the worst
  // shape of #556: nothing in the reply hints at it.
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const prev = apiTarget.fetchApi;
    const app = makeFrontend({ shape: "dropping", apiTarget });
    let lateNumber = null;
    app.queuePrompt = async (number, batch) => {
      lateNumber = number;
      for (let i = 0; i < batch; i++) {
        const body = frontendBody({ output: OUR_OUTPUT, number, targets: null });
        app.posted.push(body);
        await apiTarget.fetchApi("/prompt", { method: "POST", body: JSON.stringify(body) });
      }
      return true;
    };
    const result = await dispatchScopedRun({ app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14 });
    assert.equal(result.outcome, "dispatched");
    assert.equal(server.calls.length, 1);
    assert.deepEqual(JSON.parse(server.calls[0].options.body).partial_execution_targets, ["14"]);
    // The guard must NOT have been uninstalled by success.
    assert.notEqual(apiTarget.fetchApi, prev, "a completed scoped run keeps its sentinel for the page session");
    // NOW the late duplicate, exactly as a stalled processor would emit it.
    const late = frontendBody({ output: OUR_OUTPUT, number: lateNumber, targets: null });
    const res = await apiTarget.fetchApi("/prompt", { method: "POST", body: JSON.stringify(late) });
    assert.equal(res.status, 400, "the late duplicate is refused");
    assert.equal(server.calls.length, 1, "and it NEVER reached ComfyUI — no unscoped full-graph post, ever");
    // A stranger's traffic still passes through the lingering sentinel.
    const foreign = frontendBody({ output: OUR_OUTPUT, number: 0, targets: null });
    await apiTarget.fetchApi("/prompt", { method: "POST", body: JSON.stringify(foreign) });
    assert.equal(server.calls.length, 2, "the sentinel only ever constrains its own run");
    assert.equal(
      JSON.parse(server.calls[1].options.body).partial_execution_targets,
      undefined,
      "and it does not narrow a stranger's full run either",
    );
  } finally {
    stop();
  }
});

test("#630 gate r9 P1: a request STILL IN FLIGHT at timeout is not reported as 'nothing queued'", async () => {
  // A busy frontend can fire-and-forget a correctly-scoped POST and return. If
  // the server has not answered by the time the wait expires, that request HAS
  // left the panel and may still be accepted — reporting the run as
  // queued:false then is a definite negative about something unobserved, and
  // the caller acting on it re-renders a branch that is already running.
  const stop = keepAlive();
  try {
    let releaseResponse;
    const held = new Promise((r) => { releaseResponse = r; });
    const server = makeServer(async () => {
      await held;
      return jsonResponse(200, { prompt_id: "srv-late" });
    });
    const apiTarget = { fetchApi: server };
    const app = makeFrontend({ shape: "shim", apiTarget });
    // Fire-and-forget: post WITHOUT awaiting, then return — the request is in
    // flight when dispatchScopedRun starts waiting.
    app.queuePrompt = async (number) => {
      const body = frontendBody({ output: OUR_OUTPUT, number, targets: ["14"] });
      app.posted.push(body);
      void apiTarget.fetchApi("/prompt", { method: "POST", body: JSON.stringify(body) });
      return true;
    };
    const result = await dispatchScopedRun({
      app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14, verifyTimeoutMs: 25,
    });
    assert.equal(result.outcome, "unverified");
    assert.equal(result.verified, 0, "it was genuinely not confirmed");
    assert.equal(result.inFlight, 1, "but one correctly-scoped request had already left the panel");
    assert.match(result.error, /ALREADY LEFT the panel/);
    assert.match(result.error, /NOT a report that nothing was queued/);
    assert.match(result.error, /Check the ComfyUI queue before retrying/);
    // And it really can be accepted afterwards — which is why the claim matters.
    releaseResponse();
    await sleep(5);
    assert.equal(server.calls.length, 1, "the scoped request did leave, exactly once");
    assert.deepEqual(JSON.parse(server.calls[0].options.body).partial_execution_targets, ["14"]);
  } finally {
    stop();
  }
});

test("#630 gate r9 P1: graph_run counts in-flight requests as unresolved, so `queued` is omitted rather than asserted false", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "../../web/js/comfyui-mcp-panel.js"), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf('if (runScopeResult && runScopeResult.outcome !== "dispatched")');
  const block = source.slice(start, start + 6000).replace(/`\s*\+\s*\n\s*`/g, "").replace(/\s+/g, " ");
  assert.match(
    block,
    /const unresolved = \(runScopeResult\.indeterminate \?\? 0\) \+ \(runScopeResult\.inFlight \?\? 0\);/,
    "an in-flight request has the same epistemic status as an indeterminate one",
  );
  assert.match(block, /if \(unresolved > 0\)/, "and it gates the queued-unknown shape");
});

test("#630 gate r8 P0: a RETRYING run never displaces a concurrent run's sentinel — B's late post is still fenced", async () => {
  // A installs GA1 and waits on a deferred first attempt. B starts, captures
  // GA1 as its chain, succeeds, and retains GB. A's deferred post arrives
  // scopeless, GA1 refuses it, and A retries. A's finally used to restore A's
  // ENTRY-TIME fetchApi (raw), CLOBBERING GB — and A's next guard also
  // delegated to A's entry-time raw fetch, bypassing B. A late B post then
  // passed through as foreign and reached raw fetch scopeless: full graph.
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    // A: shim-less (drops the positional array) and DEFERRED, so attempt 1's
    // post is driven manually below — the interleaving the old overlap test
    // never produced, because it only started B after A had already returned.
    const appA = makeFrontend({ shape: "shimless", defer: true, apiTarget });
    const runA = dispatchScopedRun({
      app: appA, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14, verifyTimeoutMs: 1500,
    });
    await sleep(15); // A has installed GA1 and is waiting on its deferred post
    const attempt1Item = appA.deferredItem;
    // B runs to completion WHILE A is mid-flight, and retains GB as current.
    const appB = makeFrontend({ shape: "shim", apiTarget });
    const resultB = await dispatchScopedRun({
      app: appB, apiTarget, execIds: ["15"], batch: 1, toNodeId: 15,
    });
    assert.equal(resultB.outcome, "dispatched");
    const callsAfterB = server.calls.length;
    // A's deferred attempt-1 post lands SCOPELESS (shim-less dropped the array)
    // and is refused — which is what makes A RETRY the next shape. That retry
    // is the moment the old code restored A's entry-time fetchApi over GB.
    await appA.postDeferred(attempt1Item);
    await runA;
    // THE REGRESSION: B's late scopeless post must still be fenced. If A's
    // retry clobbered GB, or A's next guard delegated to A's entry-time raw
    // fetch instead of the current chain, this reaches the server unscoped.
    const lateB = frontendBody({ output: OUR_OUTPUT, number: resultB.queueMark, targets: null });
    await apiTarget.fetchApi("/prompt", { method: "POST", body: JSON.stringify(lateB) });
    assert.equal(
      server.calls.length,
      callsAfterB,
      "B's late scopeless post never reached ComfyUI — A's retry did not displace or bypass B's fence",
    );
  } finally {
    stop();
  }
});

test("#630 gate r8 P0: a superseded attempt RETIRES rather than unhooking — it never double-handles its successor's post", async () => {
  // Standing down by writing fetchApi back to an older value is what displaced
  // other runs. Retiring keeps the chain intact; the retired guard must then be
  // fully transparent, or it would refuse its own successor's repaired body.
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const raw = apiTarget.fetchApi;
    const app = makeFrontend({ shape: "dropping", apiTarget });
    const result = await dispatchScopedRun({ app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14 });
    // The repair attempt is attempt 3; attempts 1 and 2 were superseded. If a
    // retired guard still acted on the mark, the repaired body would have been
    // refused on its way down the chain instead of reaching the server.
    assert.equal(result.outcome, "dispatched");
    assert.equal(result.scopeAppliedBy, "request_body_repair");
    assert.equal(server.calls.length, 1);
    assert.deepEqual(JSON.parse(server.calls[0].options.body).partial_execution_targets, ["14"]);
    // The chain was never unwound back to raw.
    assert.notEqual(apiTarget.fetchApi, raw, "the terminal sentinel is current, and raw fetch was never restored");
  } finally {
    stop();
  }
});

test("#630 gate r8 P1: an INDETERMINATE dispatch omits `queued` — neither true nor false is honest", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "../../web/js/comfyui-mcp-panel.js"), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf('if (runScopeResult && runScopeResult.outcome !== "dispatched")');
  assert.ok(start > 0);
  const block = source.slice(start, start + 6000).replace(/`\s*\+\s*\n\s*`/g, "").replace(/\s+/g, " ");
  // The indeterminate branch must NOT assert queued:false…
  const indetStart = block.indexOf("if (unresolved > 0)");
  assert.ok(indetStart > 0, "the indeterminate case is handled separately");
  // Bound the slice to THIS branch's return, or it runs on into the
  // nothing-dispatched `queued: false` below and the assertion means nothing.
  const indetBlock = block.slice(indetStart, block.indexOf("}; }", indetStart) + 4);
  assert.ok(indetBlock.length > 100 && indetBlock.length < 1400, "the branch was isolated, not the whole tail");
  assert.doesNotMatch(indetBlock, /queued: false/,
    "a definite negative about a request whose fate we say we cannot determine");
  assert.match(indetBlock, /queued_unknown: true/);
  assert.match(indetBlock, /deliberately omits "queued"/, "and the omission is explained, not silent");
  assert.match(indetBlock, /a blind retry can render the branch twice/);
  // …while a run where nothing left the panel still gets the definite answer.
  assert.match(block, /return \{ queued: false, error: runScopeResult\.error \};/,
    "nothing dispatched ⇒ queued:false is observable and still stated plainly");
});

test("#630 gate r7 P0-1: only a genuinely ABSENT key is repaired — a PRESENT value we cannot interpret is refused, never overwritten", async () => {
  // Absence is ours to fill. `[]`, `null`, `"14"` and especially
  // `{ queueNodeIds: [...] }` are PRESENT values in a shape we did not expect —
  // the last looks like another layer's scope convention. Rewriting one would
  // be executing our intent over a request that said something different, which
  // is the same violation as overwriting a mismatch.
  const stop = keepAlive();
  try {
    const cases = [
      { targets: [], label: "empty list" },
      { targets: null, label: "explicit null" },
      { targets: "14", label: "bare string" },
      { targets: { queueNodeIds: ["9"] }, label: "another layer's convention" },
    ];
    for (const { targets, label } of cases) {
      const server = makeServer();
      const guard = createScopedRunGuard({
        origFetchApi: server, execIds: ["14"], contentHash: OUR_HASH, batch: 1, toNodeId: 14, queueMark: MARK_A,
        repairScope: true,
      });
      const body = { prompt: OUR_OUTPUT, client_id: "x", number: MARK_A, partial_execution_targets: targets };
      const res = await guard(...promptPost(body));
      assert.equal(res.status, 400, `${label}: refused, not repaired`);
      assert.equal(guard.state.repaired, 0, `${label}: never rewritten`);
      assert.equal(server.calls.length, 0, `${label}: nothing left the tab`);
      // …and the refusal names what it actually saw, so the next report is diagnosable.
      assert.match(guard.state.dropped, /was not a list|EMPTY partial_execution_targets/, `${label}: observation named`);
    }
    // The one case that IS repaired: the key genuinely absent.
    const server = makeServer();
    const guard = createScopedRunGuard({
      origFetchApi: server, execIds: ["14"], contentHash: OUR_HASH, batch: 1, toNodeId: 14, queueMark: MARK_A,
      repairScope: true,
    });
    await guard(...promptPost({ prompt: OUR_OUTPUT, client_id: "x", number: MARK_A }));
    assert.equal(guard.state.repaired, 1, "an absent key is ours to fill");
    assert.deepEqual(JSON.parse(server.calls[0].options.body).partial_execution_targets, ["14"]);
  } finally {
    stop();
  }
});

test("#630 gate r7 P0-2: app.queuePrompt THROWING mid-run leaves the fence UP — a deferred duplicate cannot post scopeless", async () => {
  // The `finally` always runs; the terminal-path decision may never. A throw
  // from queuePrompt after it had already emitted a scoped post used to unwind
  // through the finally with keepGuardInstalled still false, restoring raw
  // fetchApi — and a deferred same-mark duplicate then ran the full graph.
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const prev = apiTarget.fetchApi;
    const app = makeFrontend({ shape: "dropping", apiTarget });
    let runMark = null;
    app.queuePrompt = async (number) => {
      runMark = number; // the run's real mark — a module counter, not a fixed value
      const body = frontendBody({ output: OUR_OUTPUT, number, targets: null });
      app.posted.push(body);
      await apiTarget.fetchApi("/prompt", { method: "POST", body: JSON.stringify(body) });
      throw new Error("frontend blew up after posting");
    };
    await assert.rejects(
      () => dispatchScopedRun({ app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14 }),
      /frontend blew up/,
    );
    assert.notEqual(apiTarget.fetchApi, prev, "the fence is NOT torn down by an exception unwinding the finally");
    // The deferred duplicate that used to escape.
    const late = frontendBody({ output: OUR_OUTPUT, number: runMark, targets: null });
    const before = server.calls.length;
    await apiTarget.fetchApi("/prompt", { method: "POST", body: JSON.stringify(late) });
    assert.equal(server.calls.length, before, "a late scopeless duplicate never reached ComfyUI");
  } finally {
    stop();
  }
});

test("#630 gate r7 P0-3: a SUCCESSFUL cancel still keeps the sentinel — removing what we could see proves nothing about what we could not", async () => {
  // `removed > 0` proves only that tagged entries still in app.queueItems were
  // spliced. A copy the frontend already took, popped, or scheduled is
  // invisible to that check, and restoring raw fetchApi lets it post scopeless.
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const prev = apiTarget.fetchApi;
    // "shim" so the TAGGED targets array is what the queue item holds — that is
    // what makes the cancel succeed, which is the precondition under test.
    const app = makeFrontend({ shape: "shim", defer: true, apiTarget });
    const result = await dispatchScopedRun({
      app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14, verifyTimeoutMs: 40,
    });
    assert.equal(result.outcome, "unverified");
    assert.match(result.error, /located and REMOVED/, "the cancel did succeed — that part is unchanged");
    assert.notEqual(apiTarget.fetchApi, prev, "and the sentinel STAYS, because the cancel is not proof about unseen copies");
    // A retained same-mark copy posting later is still fenced.
    const late = frontendBody({ output: OUR_OUTPUT, number: result.queueMark, targets: null });
    await apiTarget.fetchApi("/prompt", { method: "POST", body: JSON.stringify(late) });
    assert.equal(server.calls.length, 0, "no scopeless full-graph post ever left the tab");
  } finally {
    stop();
  }
});

test("#630 gate r7 P0-4: the dispatch-failure message DISCLOSES an unknown outcome instead of denying arrival", () => {
  // It used to end "this prompt did not reach ComfyUI" — a definite negative
  // the panel cannot observe, contradicting the module's own INDETERMINATE
  // handling, and one that makes the caller resubmit a render that may already
  // be running.
  const msg = scopeDispatchError({
    toNodeId: 14,
    detail: "the /prompt request itself threw (connection reset)",
    verified: 0,
    batch: 1,
  });
  assert.doesNotMatch(msg, /this prompt did not reach ComfyUI/,
    "the unobservable denial must be gone, not reworded around");
  assert.match(msg, /CANNOT be determined from here/, "the uncertainty is named as uncertainty");
  assert.match(msg, /may be queued or running right now/);
  assert.match(msg, /Check the ComfyUI queue before resubmitting/, "with an action that works from where the caller is");
  assert.match(msg, /a retry may render the branch twice/, "and the cost of getting it wrong");
  // What IS observable is still asserted plainly.
  assert.match(msg, /no full-graph dispatch occurred/);
  assert.match(msg, /NOT confirmed queued/);
});

test("#630 gate r5 P0: a TERMINAL PARTIAL batch keeps its sentinel — a late post cannot escape after a half-succeeded run", async () => {
  // Success and dispatch-failure kept the sentinel; the terminal partial did
  // not. One post repaired and queued, a later one refused for drift, then
  // fetchApi restored — and a late same-mark scopeless post bypassed both the
  // quota fence and the repair to reach ComfyUI as a full graph.
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const prev = apiTarget.fetchApi;
    const app = makeFrontend({ shape: "dropping", apiTarget });
    let lateNumber = null;
    app.queuePrompt = async (number, batch) => {
      lateNumber = number;
      for (let i = 0; i < batch; i++) {
        const output = i === 0 ? OUR_OUTPUT : { ...OUR_OUTPUT, "3": { class_type: "KSampler", inputs: { steps: 99 } } };
        const body = frontendBody({ output, number, targets: null });
        app.posted.push(body);
        const res = await apiTarget.fetchApi("/prompt", { method: "POST", body: JSON.stringify(body) });
        if (res.status !== 200) break;
      }
      return true;
    };
    const result = await dispatchScopedRun({ app, apiTarget, execIds: ["14"], batch: 2, toNodeId: 14 });
    assert.equal(result.outcome, "refused", "a partial batch is never claimed as dispatched");
    assert.equal(result.verified, 1);
    assert.notEqual(apiTarget.fetchApi, prev, "the sentinel is retained on the PARTIAL path too");
    // The late post that used to escape.
    const late = frontendBody({ output: OUR_OUTPUT, number: lateNumber, targets: null });
    const res = await apiTarget.fetchApi("/prompt", { method: "POST", body: JSON.stringify(late) });
    assert.equal(res.status, 400);
    assert.equal(server.calls.length, 1, "no unscoped full-graph post ever left the tab");
  } finally {
    stop();
  }
});

test("#630 gate r5 P0: an ALL-REFUSED run keeps its sentinel too — the last attempt's return is terminal, not a handover", async () => {
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const prev = apiTarget.fetchApi;
    const app = makeFrontend({ shape: "shim", apiTarget });
    let lateNumber = null;
    app.queuePrompt = async (number) => {
      lateNumber = number;
      const body = frontendBody({ output: OUR_OUTPUT, number, targets: ["9"] }); // mismatch: never repaired
      app.posted.push(body);
      await apiTarget.fetchApi("/prompt", { method: "POST", body: JSON.stringify(body) });
      return true;
    };
    const result = await dispatchScopedRun({ app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14 });
    assert.equal(result.outcome, "refused");
    assert.equal(server.calls.length, 0, "nothing was queued");
    assert.notEqual(apiTarget.fetchApi, prev, "and the sentinel remains for a late post of this run");
    const late = frontendBody({ output: OUR_OUTPUT, number: lateNumber, targets: null });
    const res = await apiTarget.fetchApi("/prompt", { method: "POST", body: JSON.stringify(late) });
    assert.equal(res.status, 400);
    assert.equal(server.calls.length, 0, "STILL nothing — a late scopeless post is refused, not run as a full graph");
  } finally {
    stop();
  }
});

test("#630 gate r5 P1: graph_run discloses a PARTIAL batch's queued work instead of reporting a bare failure", () => {
  // A partial batch is not a run that failed; it is one that partly succeeded.
  // A bare queued:false reports failure for prompts that are executing right
  // now, and the obvious reaction — re-run the batch — queues them a second
  // time. Refuse-vs-disclose: refuse only what did not happen.
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "../../web/js/comfyui-mcp-panel.js"), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("if (runScopeResult && runScopeResult.outcome !== \"dispatched\")");
  assert.ok(start > 0);
  const block = source.slice(start, start + 4600).replace(/`\s*\+\s*\n\s*`/g, "").replace(/\s+/g, " ");
  assert.match(block, /if \(runScopeResult\.verified > 0 && unresolved === 0\)/, "only a fully verified partial is reported queued");
  assert.match(block, /partially_queued: true/);
  assert.match(block, /queued_prompt_ids: queuedPromptIds\.slice\(\)/, "the caller can TRACK what is already running");
  assert.match(block, /Re-run only the remaining/, "and is told not to re-run the whole batch");
  assert.match(block, /would queue the already-running prompt\(s\) again/, "with the reason stated");
});

test("#630 gate r4: two CONCURRENT same-mark posts — the quota is a reservation, so the branch still runs exactly once", async () => {
  // The sequential fence was racy: counting only COMPLETED requests let two
  // in-flight posts both read observed=0, both clear the quota, and both be
  // forwarded — rendering the requested branch twice, at real GPU/API cost,
  // while the result reported no overrun at all. The slot must be reserved
  // BEFORE the await, not counted after it.
  const stop = keepAlive();
  try {
    let release;
    const gate = new Promise((r) => { release = r; });
    let n = 0;
    const server = makeServer(async () => {
      // Hold the FIRST request open so the second arrives while it is in flight.
      if (n++ === 0) await gate;
      return jsonResponse(200, { prompt_id: `srv-${n}` });
    });
    const guard = createScopedRunGuard({
      origFetchApi: server, execIds: ["14"], contentHash: OUR_HASH, batch: 1, toNodeId: 14, queueMark: MARK_A,
      repairScope: true,
    });
    const post = () => guard(...promptPost(frontendBody({ number: MARK_A, targets: null })));
    const first = post();
    const second = await post(); // arrives while `first` is still awaiting the server
    assert.equal(second.status, 400, "the concurrent duplicate is fenced by the RESERVED slot");
    assert.equal(guard.state.overrun, 1, "and it is counted as an overrun, not silently allowed");
    release();
    await first;
    assert.equal(guard.state.observed, 1);
    assert.equal(server.calls.length, 1, "EXACTLY one request reached ComfyUI — the branch runs once");
    assert.deepEqual(JSON.parse(server.calls[0].options.body).partial_execution_targets, ["14"]);
  } finally {
    stop();
  }
});

test("#630 gate r4: a MALFORMED response keeps its slot — 'could not tell whether it queued' is not 'it did not queue'", async () => {
  // The post reached ComfyUI and MAY have queued. Releasing the slot on that
  // uncertainty would let a retry render the branch a second time. A throw is
  // different — it never left — and that slot IS released (covered above).
  const stop = keepAlive();
  try {
    const server = makeServer(() => jsonResponse(200, { no_prompt_id: true }));
    const guard = createScopedRunGuard({
      origFetchApi: server, execIds: ["14"], contentHash: OUR_HASH, batch: 1, toNodeId: 14, queueMark: MARK_A,
      repairScope: true,
    });
    const post = () => guard(...promptPost(frontendBody({ number: MARK_A, targets: null })));
    await post();
    assert.ok(guard.state.failed, "a malformed response is a dispatch failure, never a success");
    assert.equal(guard.state.observed, 0, "and never counted as verified");
    // The slot stays consumed, so a retry cannot double-render the branch.
    const retry = await post();
    assert.equal(retry.status, 400);
    assert.equal(guard.state.overrun, 1);
    assert.equal(server.calls.length, 1, "the branch was never dispatched a second time on an unknown outcome");
  } finally {
    stop();
  }
});

test("#630 gate r6: a THROWN fetch is INDETERMINATE, not proof of non-arrival — its slot stays consumed", async () => {
  // This test previously asserted the opposite: that a throw means the request
  // never reached ComfyUI, so its quota slot was released and a retry could
  // dispatch. That premise is wrong and is this cluster's defect class exactly.
  // A fetch can throw AFTER ComfyUI received and queued the prompt — a reset
  // while reading the response is indistinguishable from one before the request
  // left. Releasing the slot on that basis re-dispatches a branch that may
  // already be rendering.
  const stop = keepAlive();
  try {
    const server = makeServer(() => {
      throw new Error("connection reset");
    });
    const guard = createScopedRunGuard({
      origFetchApi: server, execIds: ["14"], contentHash: OUR_HASH, batch: 1, toNodeId: 14, queueMark: MARK_A,
      repairScope: true,
    });
    const post = () => guard(...promptPost(frontendBody({ number: MARK_A, targets: null })));
    await assert.rejects(post, /connection reset/, "the frontend still sees the failure it would have seen");
    assert.ok(guard.state.failed, "recorded as a dispatch FAILURE, never a success");
    assert.equal(guard.state.observed, 0, "and never counted as verified");
    assert.equal(guard.state.indeterminate, 1, "its outcome is recorded as UNKNOWN, which is what it is");
    // The slot is spent: a second post cannot double-render a branch that may
    // already be queued.
    const again = await post();
    assert.equal(again.status, 400);
    assert.equal(guard.state.overrun, 1);
    assert.equal(server.calls.length, 1, "exactly one request ever left the panel");
  } finally {
    stop();
  }
});

test("#630 gate r6: graph_run never states a remainder it cannot count, and never claims 'nothing queued' after an indeterminate dispatch", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "../../web/js/comfyui-mcp-panel.js"), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf('if (runScopeResult && runScopeResult.outcome !== "dispatched")');
  assert.ok(start > 0);
  const block = source.slice(start, start + 5600).replace(/`\s*\+\s*\n\s*`/g, "").replace(/\s+/g, " ");
  // A partial no longer asserts "not queued" for prompts that are executing.
  assert.match(block, /queued: true, complete: false, partially_queued: true/,
    "a partial batch is queued-but-incomplete, never a flat failure");
  assert.match(block, /incomplete_reason: runScopeResult\.error/,
    "and its reason does not masquerade as an error about work that did happen");
  // The remainder is only named when it is actually knowable.
  assert.match(block, /const unresolved = \(runScopeResult\.indeterminate \?\? 0\) \+ \(runScopeResult\.inFlight \?\? 0\);/);
  // …and that count must actually SELECT the uncertain result. Asserting only
  // that both strings exist would pass a version that still reports queued:true.
  assert.match(block, /if \(runScopeResult\.verified > 0 && unresolved === 0\)/,
    "unresolved receipts veto the partial queued:true result");
  assert.match(block, /if \(unresolved > 0\)/,
    "the unresolved count selects the queued_unknown result");
  assert.match(block, /queued_count: runScopeResult\.verified/,
    "known prompt ids remain disclosed as partial evidence");
  assert.match(block, /the remaining count cannot be stated from here without risking a duplicate render/);
  assert.match(block, /Check the ComfyUI queue before re-running anything/);
  // Zero verified + an indeterminate dispatch is still not "nothing ran".
  // #630 r8 — this used to be `outcome_unknown` beside a `queued: false`. The
  // flag is now `queued_unknown` and `queued` is omitted entirely, because no
  // boolean is an honest answer for a request whose fate we cannot determine.
  assert.match(block, /queued_unknown: true/);
  assert.match(block, /rather than assuming nothing ran/);
});

test("#630 gate r2 P1: describeObserved NEVER throws — the refusal path's own formatting cannot be what fails", () => {
  // JSON.stringify is not a safe formatter for a value off the wire: circular
  // structures and BigInt throw outright, and a deeply nested value throws
  // RangeError from a shallow stack. This function sits on the refusal path,
  // between deciding to refuse and recording it, so a throw here escaped the
  // guard mid-decision. A guard that can throw is not a guard. The contract is
  // total: any input, no throw, bounded output.
  const circular = { a: 1 };
  circular.self = circular;
  let deep = { end: true };
  for (let i = 0; i < 60000; i++) deep = { a: deep };
  const cases = [
    circular,
    { big: 1n },
    1n,
    deep,
    undefined,
    Symbol("s"),
    () => {},
    { toJSON() { throw new Error("hostile toJSON"); } },
    null,
    42,
    "plain",
    ["a", "b"],
  ];
  for (const value of cases) {
    let out;
    assert.doesNotThrow(() => {
      out = describeObserved(value);
    }, `describeObserved must not throw for ${String(value?.constructor?.name ?? typeof value)}`);
    assert.equal(typeof out, "string", "and it always yields a string the message can interpolate");
    assert.ok(out.length <= 220, "bounded — this lands in an error a human reads");
  }
  // It still says something useful for ordinary values.
  assert.equal(describeObserved(["14"]), '["14"]');
  assert.match(describeObserved(circular), /unserializable/);
});

test("#630 gate r2 P1: a refusal is ALWAYS recorded, so a description failure can never leave the next post unguarded", async () => {
  const stop = keepAlive();
  try {
    const orig = makeServer();
    const guard = createScopedRunGuard({
      origFetchApi: orig, execIds: ["14"], contentHash: OUR_HASH, batch: 1, toNodeId: 14, queueMark: MARK_A,
    });
    // A body whose partial_execution_targets is valid JSON but pathological to
    // re-render. Whatever happens while describing it, the post must be refused
    // and the refusal recorded.
    let deep = "null";
    for (let i = 0; i < 5000; i++) deep = `{"a":${deep}}`;
    const nested = `{"prompt":${JSON.stringify(OUR_OUTPUT)},"client_id":"x","number":${MARK_A},"partial_execution_targets":${deep}}`;
    let threw = null;
    let first;
    try {
      first = await guard("/prompt", { method: "POST", body: nested });
    } catch (err) {
      threw = err;
    }
    assert.equal(threw, null, "the guard must not throw out of the refusal path");
    assert.equal(first.status, 400, "the corrupted post is refused");
    assert.equal(orig.calls.length, 0, "and nothing left the tab");
    assert.ok(guard.state.dropped, "a refusal is always recorded, even when the value cannot be rendered");
  } finally {
    stop();
  }
});

test("#630 gate r2 P1: describeObserved never throws — and beyond the batch budget our corrupted post is refused, not forwarded", async () => {
  const stop = keepAlive();
  try {
    const orig = makeServer();
    const guard = createScopedRunGuard({
      origFetchApi: orig, execIds: ["14"], contentHash: OUR_HASH, batch: 1, toNodeId: 14, queueMark: MARK_A,
    });
    // Three attributed scopeless posts against a batch budget of 1.
    for (let i = 0; i < 3; i++) {
      const res = await guard(...promptPost({ prompt: OUR_OUTPUT, client_id: "x", number: MARK_A }));
      assert.equal(res.status, 400, `post ${i + 1} refused`);
    }
    assert.equal(orig.calls.length, 0, "not one of them was ever forwarded unscoped");
    assert.equal(guard.state.refused, 1, "the RECORDING stays bounded — only the forwarding was the bug");
  } finally {
    stop();
  }
});

test("#630 gate r2 P2: readScopeFromBody classifies every body shape as ITSELF — a successful parse is never reported as a failed one", () => {
  const state = (b) => readScopeFromBody(typeof b === "string" ? b : JSON.stringify(b)).state;
  // A genuine parse failure.
  assert.equal(state("not-json{"), "body_unreadable");
  assert.equal(state(undefined), "body_unreadable");
  // Parsed fine, but not a prompt request object. Reporting these as
  // "could not be parsed" would be a definite negative about an operation that
  // SUCCEEDED — the collapse this whole split exists to remove.
  assert.equal(state("null"), "body_not_an_object");
  assert.equal(state("42"), "body_not_an_object");
  assert.equal(state('"a string"'), "body_not_an_object");
  assert.equal(state([1, 2, 3]), "body_not_an_object");
  // A real request object, per scope shape.
  assert.equal(state({ prompt: {} }), "absent");
  assert.equal(state({ prompt: {}, partial_execution_targets: null }), "not_a_list");
  assert.equal(state({ prompt: {}, partial_execution_targets: "14" }), "not_a_list");
  assert.equal(state({ prompt: {}, partial_execution_targets: { queueNodeIds: ["14"] } }), "not_a_list");
  assert.equal(state({ prompt: {}, partial_execution_targets: [] }), "empty");
  assert.equal(state({ prompt: {}, partial_execution_targets: ["14"] }), "present");
  // Body keys are evidence, and only exist where there is an object to read.
  assert.deepEqual(readScopeFromBody(JSON.stringify({ b: 1, a: 2 })).bodyKeys, ["a", "b"]);
  assert.equal(readScopeFromBody(JSON.stringify([1, 2])).bodyKeys, null, "array indices are not body keys");
  assert.equal(readScopeFromBody("not-json{").bodyKeys, null);
});

test("#630 gate r2 P2: an unparseable or non-object body is FOREIGN by identity — it can carry no mark, so it is passed through, never refused", async () => {
  // Why the two body-shape states cannot reach the refusal path: run identity
  // is tested first, and it is read from a top-level `number`. This pins the
  // reasoning rather than leaving it as an unstated assumption.
  const stop = keepAlive();
  try {
    for (const body of ["not-json{", JSON.stringify([1, 2, 3]), JSON.stringify(42), "null"]) {
      const orig = makeServer();
      const guard = createScopedRunGuard({
        origFetchApi: orig, execIds: ["14"], contentHash: OUR_HASH, batch: 1, toNodeId: 14, queueMark: MARK_A,
        repairScope: true,
      });
      await guard("/prompt", { method: "POST", body });
      assert.equal(orig.calls.length, 1, `passed through untouched: ${body.slice(0, 12)}`);
      assert.equal(orig.calls[0].options.body, body, "and byte-identical — never rewritten by the repair");
      assert.equal(guard.state.refused, 0);
      assert.equal(guard.state.repaired, 0);
      assert.equal(guard.state.observed, 0, "never counted as our own dispatch either");
    }
  } finally {
    stop();
  }
});

test("#630 gate r2 P2: a body that PARSED but is not a request object is not reported as unparseable", async () => {
  // JSON.parse succeeded. Saying "could not be parsed" would be a definite
  // negative about an operation that worked — the collapse this split removes.
  const stop = keepAlive();
  try {
    const scalar = scopeDroppedError({ toNodeId: 7, verdict: { ok: false, reason: "body_not_an_object", expected: ["7"], got: null, raw: 42 } });
    assert.match(scalar, /body parsed, but it was not a request object \(42\)/);
    assert.doesNotMatch(scalar, /could not be parsed/, "a successful parse is never reported as a failed one");
    const unreadable = scopeDroppedError({ toNodeId: 7, verdict: { ok: false, reason: "body_unreadable", expected: ["7"], got: null } });
    assert.match(unreadable, /could not be parsed/, "and a genuine parse failure still says so");
    assert.notEqual(scalar, unreadable);
    // End to end through the guard: an array body parses, and is classified as
    // a shape problem, not a parse problem and not an absent key.
    const orig = makeServer();
    const guard = createScopedRunGuard({
      origFetchApi: orig, execIds: ["14"], contentHash: OUR_HASH, batch: 1, toNodeId: 14, queueMark: MARK_A,
    });
    // Marked via a top-level `number`… an array cannot carry one, so it is
    // foreign by identity and must simply pass through untouched.
    await guard("/prompt", { method: "POST", body: JSON.stringify([1, 2, 3]) });
    assert.equal(orig.calls.length, 1, "an unattributable body is foreign traffic, passed through");
    assert.equal(guard.state.refused, 0);
  } finally {
    stop();
  }
});

test("#630 integration: repair NEVER overwrites a scope MISMATCH — a body carrying targets we did not ask for is still refused, zero dispatches", async () => {
  // The repair widens nothing. When our own attributed post carries DIFFERENT
  // targets, the panel does not understand why and must not paper over it by
  // writing its own — that would be executing something other than what the
  // body says while claiming to have fixed it.
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const app = makeFrontend({ shape: "shim", apiTarget });
    app.queuePrompt = async (number) => {
      const body = frontendBody({ output: OUR_OUTPUT, number, targets: ["9"] }); // WRONG branch
      app.posted.push(body);
      await apiTarget.fetchApi("/prompt", { method: "POST", body: JSON.stringify(body) });
      return true;
    };
    const result = await dispatchScopedRun({ app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14 });
    assert.equal(result.outcome, "refused");
    assert.match(result.error, /instead of \["14"\]/, "the observed mismatch is named, not overwritten");
    assert.equal(server.calls.length, 0, "nothing reached ComfyUI — not the wrong scope, not a repaired one");
  } finally {
    stop();
  }
});

test("#630 integration: repair is scoped to OUR OWN post — a stranger's scopeless /prompt is passed through untouched, never rewritten", async () => {
  // The repair rides on the same run-identity gate as every other guard
  // action. A foreign full run of the same graph must leave the tab exactly as
  // the user queued it: unscoped, unmodified.
  const stop = keepAlive();
  try {
    const apiTarget = { fetchApi: makeServer() };
    const orig = apiTarget.fetchApi;
    const guard = createScopedRunGuard({
      origFetchApi: orig,
      execIds: ["14"],
      contentHash: OUR_HASH,
      batch: 1,
      toNodeId: 14,
      queueMark: MARK_A,
      repairScope: true,
    });
    // Someone else's full run: same graph, same node set, NO mark of ours.
    const foreign = frontendBody({ number: 0, targets: null });
    await guard(...promptPost(foreign));
    assert.equal(orig.calls.length, 1);
    const forwarded = JSON.parse(orig.calls[0].options.body);
    assert.equal(
      forwarded.partial_execution_targets,
      undefined,
      "a stranger's full run is never silently narrowed to our scope",
    );
    assert.equal(guard.state.repaired, 0);
    assert.equal(guard.state.refused, 0, "and it is never refused either");
  } finally {
    stop();
  }
});

test("#630 integration: an UNPARSEABLE own-post body is refused, not 'repaired' — a repair that cannot be verified is not a repair", async () => {
  const stop = keepAlive();
  try {
    const apiTarget = { fetchApi: makeServer() };
    const orig = apiTarget.fetchApi;
    const guard = createScopedRunGuard({
      origFetchApi: orig,
      execIds: ["14"],
      contentHash: OUR_HASH,
      batch: 1,
      toNodeId: 14,
      queueMark: MARK_A,
      repairScope: true,
    });
    // Our mark is readable but the content hash cannot be computed ⇒ not
    // attributable as our unmodified prompt ⇒ never repaired.
    const drifted = frontendBody({ output: { "3": { class_type: "KSampler", inputs: { steps: 99 } } }, number: MARK_A, targets: null });
    await guard(...promptPost(drifted));
    assert.equal(guard.state.repaired, 0, "content drift is never repaired into a dispatch");
    assert.equal(orig.calls.length, 0, "nothing left the tab");
    assert.equal(guard.state.droppedReason, "graph_changed");
  } finally {
    stop();
  }
});

test("#556 r4 P0-1 integration: THE SENTINEL INSTALLS AND NEVER EXPIRES — still installed past the old linger bound, still refusing the late scope-dropped post with zero dispatch", async () => {
  const stop = keepAlive();
  try {
    const apiTarget = { fetchApi: makeServer() };
    const prev = apiTarget.fetchApi;
    // Busy SHIM-LESS frontend (drops the legacy array ⇒ the deferred item has no
    // scope), and queueItems NOT accessible (hard-private build) ⇒ cancel impossible.
    const app = makeFrontend({ shape: "shimless", defer: true, apiTarget });
    delete app.queueItems;
    const result = await dispatchScopedRun({
      app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14,
      verifyTimeoutMs: 50,
    });
    assert.equal(result.outcome, "unverified");
    assert.match(result.error, /sentinel/);
    assert.match(result.error, /page session/);
    assert.notEqual(apiTarget.fetchApi, prev, "the sentinel guard is STILL installed after the run returned");
    // Well past where the r3 linger timer would have restored fetchApi (120ms).
    await sleep(200);
    assert.notEqual(apiTarget.fetchApi, prev, "NO expiry — an expiring sentinel re-opens the hole: the uncancellable item can post whenever the stalled processor resumes");
    // The deferred item finally posts — through the sentinel — scope dropped.
    const res = await app.postDeferred(app.deferredItem);
    assert.equal(res.status, 400, "the sentinel STILL refuses the late scope-dropped dispatch");
    assert.equal(prev.calls.length, 0, "no full-graph dispatch escapes — ever");
    assert.notEqual(apiTarget.fetchApi, prev, "installed for the rest of the page session");
  } finally {
    stop();
  }
});

test("#556 r4 P0-2 integration: two overlapping scoped runs — B's traffic passes A's sentinel untouched, B is observed by its own guard, A's sentinel still only constrains A's items, guards chain without clobbering", async () => {
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const prev = apiTarget.fetchApi;
    // RUN A: busy shim-less frontend, deferred, uncancellable ⇒ sentinel.
    const appA = makeFrontend({ shape: "shimless", defer: true, apiTarget });
    delete appA.queueItems;
    const resultA = await dispatchScopedRun({
      app: appA, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14,
      verifyTimeoutMs: 50,
    });
    assert.equal(resultA.outcome, "unverified");
    const sentinelA = apiTarget.fetchApi;
    assert.notEqual(sentinelA, prev, "run A left its sentinel installed");

    // RUN B: a normal retry to a DIFFERENT node through the SAME apiTarget.
    // B's posts carry B's OWN unique mark — foreign to A's sentinel.
    const appB = makeFrontend({ shape: "shim", apiTarget });
    const idsB = [];
    const resultB = await dispatchScopedRun({
      app: appB, apiTarget, execIds: ["15"], batch: 1, toNodeId: 15,
      onPromptId: (p) => idsB.push(p),
    });
    assert.equal(resultB.outcome, "dispatched", "B runs normally behind A's sentinel");
    assert.notEqual(resultB.queueMark, resultA.queueMark, "each run has its own mark");
    assert.deepEqual(idsB, ["srv-1"], "B's prompt_id captured by B's guard, never by A's sentinel");
    assert.equal(server.calls.length, 1, "B's scoped dispatch reached the server THROUGH A's sentinel, untouched");
    assert.deepEqual(JSON.parse(server.calls[0].options.body).partial_execution_targets, ["15"]);
    // Chaining (#630 r4): B SUCCEEDED, so B now keeps its own sentinel too and
    // it is the current wrap. What must hold is not "A's sentinel is current"
    // but that the chain is intact — A's sentinel is still reachable THROUGH
    // B's, and neither run's guard clobbered the other's.
    assert.notEqual(apiTarget.fetchApi, sentinelA, "B retains its own sentinel on success");
    assert.notEqual(apiTarget.fetchApi, prev, "and the chain never unwinds back to the raw fetchApi");
    // A's late scope-dropped post is STILL refused by A's sentinel.
    const resA = await appA.postDeferred(appA.deferredItem);
    assert.equal(resA.status, 400, "A's sentinel still constrains exactly A's items");
    assert.equal(server.calls.length, 1, "A's corrupted dispatch never escapes");
  } finally {
    stop();
  }
});

test("#556 r7 integration: a deferred item serialized from a DRIFTED graph (same topology + targets, changed widget value or link) is REFUSED — zero dispatch, error names the drift, no shape retry", async () => {
  const stop = keepAlive();
  try {
    for (const drift of [
      { "3": { class_type: "KSampler", inputs: { steps: 25 } } }, // widget value changed
      { "9": { class_type: "SaveImage", inputs: { images: ["4", 0] } } }, // link rewired
    ]) {
      const server = makeServer();
      const apiTarget = { fetchApi: server };
      const driftedOutput = { ...OUR_OUTPUT, ...drift };
      const app = makeFrontend({ shape: "shim", defer: true, apiTarget });
      // The deferred item posts with the SAME targets but the DRIFTED content
      // (same node ids/types — a topology-only fingerprint would accept it).
      app.postDeferred = async (item) => {
        const body = frontendBody({ output: driftedOutput, number: item.number, targets: ["14"] });
        app.posted.push(body);
        return apiTarget.fetchApi("/prompt", { method: "POST", body: JSON.stringify(body) });
      };
      const promise = dispatchScopedRun({
        app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14,
        verifyTimeoutMs: 500,
      });
      await sleep(20);
      const res = await app.postDeferred(app.deferredItem);
      const result = await promise;
      assert.equal(res.status, 400, `drift ${JSON.stringify(drift)} is refused`);
      assert.equal(result.outcome, "refused");
      assert.match(result.error, /graph CHANGED/i, "the error names the drift");
      assert.match(result.error, /Nothing was queued/);
      assert.equal(server.calls.length, 0, "the drifted prompt never left the tab");
      assert.equal(app.posted.length, 1, "no shape retry — content drift is not an argument-shape problem");
    }
  } finally {
    stop();
  }
});

test("#556 r7 integration: a deferred post differing ONLY in a self-mutating (beforeQueued) input is still OUR dispatch — observed and delivered", async () => {
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const outputAtQueue = {
      "3": { class_type: "KSampler", inputs: { seed: 111, steps: 20 } },
      "14": { class_type: "PreviewAny", inputs: {} },
    };
    // The live graph has a beforeQueued seed widget — its value is excluded
    // from the content hash, so a rerolled seed can't refuse our own dispatch.
    // app.graph is the panel's live root (production shape, r8).
    const app = makeFrontend({ shape: "shim", defer: true, apiTarget, output: outputAtQueue });
    app.graph = { _nodes: [{ id: 3, widgets: [{ name: "seed", beforeQueued() {} }, { name: "steps" }] }] };
    const ids = [];
    const promise = dispatchScopedRun({
      app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14,
      verifyTimeoutMs: 500,
      onPromptId: (p) => ids.push(p),
    });
    await sleep(20);
    // The deferred serialization rerolled the seed (beforeQueued) — nothing else changed.
    app.postDeferred = async (item) => {
      const body = frontendBody({
        output: { ...outputAtQueue, "3": { class_type: "KSampler", inputs: { seed: 999999, steps: 20 } } },
        number: item.number,
        targets: ["14"],
      });
      app.posted.push(body);
      return apiTarget.fetchApi("/prompt", { method: "POST", body: JSON.stringify(body) });
    };
    await app.postDeferred(app.deferredItem);
    const result = await promise;
    assert.equal(result.outcome, "dispatched", "a rerolled seed does not refuse our own dispatch");
    assert.deepEqual(ids, ["srv-1"]);
    assert.equal(server.calls.length, 1);
  } finally {
    stop();
  }
});

test("#556 r8 integration: an edit to a NON-hook node's same-named input is STILL detected as drift (per-node exclusions) — while the hook node's reroll is tolerated", async () => {
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const outputAtQueue = {
      "3": { class_type: "KSampler", inputs: { seed: 111, steps: 20 } }, // hook node
      "5": { class_type: "KSampler", inputs: { seed: 222, steps: 20 } }, // NON-hook node, same input name
      "14": { class_type: "PreviewAny", inputs: {} },
    };
    const app = makeFrontend({ shape: "shim", defer: true, apiTarget, output: outputAtQueue });
    // app.graph is the panel's live root (production shape): only node 3 has the hook.
    app.graph = {
      _nodes: [
        { id: 3, widgets: [{ name: "seed", beforeQueued() {} }, { name: "steps" }] },
        { id: 5, widgets: [{ name: "seed" }, { name: "steps" }] },
      ],
    };
    const promise = dispatchScopedRun({
      app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14,
      verifyTimeoutMs: 500,
    });
    await sleep(20);
    // The deferred post: node 3's seed rerolled (legitimate beforeQueued) AND
    // node 5's seed edited (a real user edit — must NOT hide behind node 3's
    // exclusion).
    app.postDeferred = async (item) => {
      const body = frontendBody({
        output: {
          ...outputAtQueue,
          "3": { class_type: "KSampler", inputs: { seed: 999999, steps: 20 } },
          "5": { class_type: "KSampler", inputs: { seed: 777, steps: 20 } },
        },
        number: item.number,
        targets: ["14"],
      });
      app.posted.push(body);
      return apiTarget.fetchApi("/prompt", { method: "POST", body: JSON.stringify(body) });
    };
    const res = await app.postDeferred(app.deferredItem);
    const result = await promise;
    assert.equal(res.status, 400, "the edit to the NON-hook node's seed is drift — refused");
    assert.equal(result.outcome, "refused");
    assert.match(result.error, /graph CHANGED/i);
    assert.equal(server.calls.length, 0, "the edited workflow never left the tab");
  } finally {
    stop();
  }
});

// ---------------------------------------------------------------------------
// #1124 integration — the reporter's exact sequence, driven through the REAL
// dispatchScopedRun.
//
// A `Seed (rgthree)` node (id 47) armed with the -1 sentinel feeds two KSampler
// seed inputs; the run is scoped to a downstream SaveImage (122). rgthree's
// `comfy-api-queue-prompt-before` handler fires INSIDE api.queuePrompt — after
// our pre-dispatch stamp, before the fetch — and overwrites the node's own seed
// input in the outgoing prompt. The widget itself stays at -1 (measured, see
// scoped-batch-seed.js), which is why the panel's single retry drew a DIFFERENT
// number and failed identically: the refusal was permanent, not racy.
// ---------------------------------------------------------------------------

/** The reporter's graph as graphToPrompt serializes it. */
const RGTHREE_STAMP = {
  "47": { class_type: "Seed (rgthree)", inputs: { seed: -1 } },
  "3": { class_type: "KSampler", inputs: { seed: ["47", 0], steps: 20 } },
  "5": { class_type: "KSampler", inputs: { seed: ["47", 0], steps: 25 } },
  "122": { class_type: "SaveImage", inputs: { images: ["3", 0] } },
};

/** rgthree's own measured draws (recorded in scoped-batch-seed.js). */
const RGTHREE_DRAWS = [1028465986822020, 98533269447704, 557498712106716];

/**
 * A frontend whose api.queuePrompt substitutes like rgthree's patch does.
 * `alsoEdit` mutates the outgoing prompt further, standing in for a REAL user
 * edit landing in the same window — the case that must still be refused.
 */
function makeRgthreeFrontend({ apiTarget, seedWidgetValue = -1, alsoEdit = null, nodeType = "Seed (rgthree)" }) {
  let draw = 0;
  const stamp = () => {
    const out = structuredClone(RGTHREE_STAMP);
    out["47"].inputs.seed = seedWidgetValue;
    out["47"].class_type = nodeType;
    return out;
  };
  const app = {
    queueItems: [],
    posted: [],
    // The panel's live root (production shape, r8) — no beforeQueued anywhere.
    graph: {
      _nodes: [
        { ...rgthreeSeedNode(47, seedWidgetValue), type: nodeType },
        { id: 3, widgets: [{ name: "steps", value: 20 }] },
      ],
    },
    graphToPrompt: async () => ({ output: stamp(), workflow: {} }),
    queuePrompt: async (number, batch, arg) => {
      const targets = Array.isArray(arg) ? arg : arg?.queueNodeIds;
      const output = stamp();
      // rgthree: `outputInputs[this.seedWidget.name || "seed"] = seedToUse;`
      // — only when the widget holds a sentinel, which is what arms the node.
      if ([-1, -2, -3].includes(seedWidgetValue)) {
        output["47"].inputs.seed = RGTHREE_DRAWS[draw++ % RGTHREE_DRAWS.length];
      }
      if (alsoEdit) alsoEdit(output);
      const body = frontendBody({ output, number, targets: targets?.length ? targets : null });
      app.posted.push(body);
      await apiTarget.fetchApi(...promptPost(body));
      return true;
    },
  };
  return app;
}

test("#1124 integration: an ARMED rgthree Seed substituting its own seed at queue time is OUR dispatch — the scoped run reaches ComfyUI instead of being permanently refused", async () => {
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const app = makeRgthreeFrontend({ apiTarget });
    const ids = [];
    const result = await dispatchScopedRun({
      app, apiTarget, execIds: ["122"], batch: 1, toNodeId: 122,
      verifyTimeoutMs: 500,
      onPromptId: (p) => ids.push(p),
    });
    assert.equal(result.outcome, "dispatched", "the reported refusal is gone");
    assert.equal(result.verified, 1);
    assert.deepEqual(ids, ["srv-1"]);
    assert.equal(server.calls.length, 1, "the scoped prompt actually reached ComfyUI");
    // The scope is still delivered — this fix must not cost the guarantee #556 exists for.
    assert.deepEqual(JSON.parse(server.calls[0].options.body).partial_execution_targets, ["122"]);
    // The gap is DISCLOSED, never silent: graph_run turns this into drift_coverage.
    assert.deepEqual(result.volatileInputs, ["47 seed"]);
  } finally {
    stop();
  }
});

test("#1124 integration: a FIXED rgthree Seed keeps full drift coverage — a body whose seed differs is STILL refused", async () => {
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    // Not armed ⇒ rgthree substitutes nothing ⇒ nothing is excluded. Something
    // ELSE changed that seed, and that is exactly the drift #556 must catch.
    const app = makeRgthreeFrontend({
      apiTarget,
      seedWidgetValue: 12345,
      alsoEdit: (output) => { output["47"].inputs.seed = 999; },
    });
    const result = await dispatchScopedRun({
      app, apiTarget, execIds: ["122"], batch: 1, toNodeId: 122, verifyTimeoutMs: 500,
    });
    assert.equal(result.outcome, "refused", "a fixed seed node is NOT drift-blind");
    assert.match(result.error, /graph CHANGED/i);
    assert.match(result.error, /47 seed/, "and the refusal still names what differed");
    assert.equal(server.calls.length, 0, "the drifted prompt never left the tab");
    assert.deepEqual(result.volatileInputs, [], "a fixed node excludes nothing");
  } finally {
    stop();
  }
});

test("#1124 integration: a LOOK-ALIKE node type does NOT buy a drift exemption — its seed edit is still refused", async () => {
  const stop = keepAlive();
  try {
    // codex r1 P2, at the level that matters: the exclusion is keyed on the exact
    // registered type, so a foreign node whose type merely contains "rgthree" and
    // "seed" keeps FULL drift coverage. If this ever passes as "dispatched", the
    // guard has been silently disarmed for every graph containing such a node.
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const app = makeRgthreeFrontend({
      apiTarget,
      nodeType: "Seed Generator (rgthree-style)",
      // Armed sentinel + a changed seed in the body: the exact shape the real
      // rgthree node gets forgiven for. This node must NOT be forgiven.
      alsoEdit: (output) => { output["47"].inputs.seed = 4242; },
    });
    const result = await dispatchScopedRun({
      app, apiTarget, execIds: ["122"], batch: 1, toNodeId: 122, verifyTimeoutMs: 500,
    });
    assert.equal(result.outcome, "refused", "a look-alike type is NOT exempt from drift detection");
    assert.match(result.error, /graph CHANGED/i);
    assert.match(result.error, /47 seed/);
    assert.equal(server.calls.length, 0, "the drifted prompt never left the tab");
    assert.deepEqual(result.volatileInputs, [], "and nothing was excluded for it");
  } finally {
    stop();
  }
});

test("#1124 integration: the exclusion is ONE input — an armed rgthree Seed does NOT let a real edit elsewhere ride along", async () => {
  const stop = keepAlive();
  try {
    // The guard-relaxation check, and the reason this fix is not a widening of
    // #556 into uselessness: rgthree substitutes AND the user rewires/edits
    // something in the same window. The run must still be refused.
    for (const [label, edit] of [
      ["a widget value elsewhere", (o) => { o["3"].inputs.steps = 25; }],
      ["a link rewired", (o) => { o["122"].inputs.images = ["5", 0]; }],
      ["a node added", (o) => { o["77"] = { class_type: "SaveImage", inputs: {} }; }],
    ]) {
      const server = makeServer();
      const apiTarget = { fetchApi: server };
      const app = makeRgthreeFrontend({ apiTarget, alsoEdit: edit });
      const result = await dispatchScopedRun({
        app, apiTarget, execIds: ["122"], batch: 1, toNodeId: 122, verifyTimeoutMs: 500,
      });
      assert.equal(result.outcome, "refused", `${label} is still drift`);
      assert.match(result.error, /graph CHANGED/i, label);
      assert.equal(server.calls.length, 0, `${label}: the edited workflow never left the tab`);
      // The seed itself must NOT appear in the drift list — it was excluded — so
      // the refusal names the REAL change instead of the red herring the reporter
      // was handed.
      assert.doesNotMatch(result.error, /47 seed/, `${label}: the substituted seed is no longer blamed`);
    }
  } finally {
    stop();
  }
});

// ---------------------------------------------------------------------------
// #2099 integration — VHS_VideoCombine's filename_prefix date-template
// substitution is driven through dispatchScopedRun, while another changed input
// in the same queued body still trips the graph-drift refusal.
// ---------------------------------------------------------------------------

const VHS_STAMP = {
  "1000": { class_type: "VAEDecode", inputs: { samples: ["4", 0] } },
  "223": {
    class_type: "VHS_VideoCombine",
    inputs: { images: ["1000", 0], filename_prefix: "video/%date:yyyyMMdd_hhmmss%", frame_rate: 24 },
  },
};

function makeVhsDateFrontend({ apiTarget, alsoEdit = null } = {}) {
  const app = {
    queueItems: [],
    posted: [],
    graph: { _nodes: [vhsNode(223, "video/%date:yyyyMMdd_hhmmss%")] },
    graphToPrompt: async () => ({ output: structuredClone(VHS_STAMP), workflow: {} }),
    queuePrompt: async (number, batch, arg) => {
      const targets = Array.isArray(arg) ? arg : arg?.queueNodeIds;
      const output = structuredClone(VHS_STAMP);
      output["223"].inputs.filename_prefix = "video/20260823_142233";
      if (alsoEdit) alsoEdit(output);
      const body = frontendBody({ output, number, targets: targets?.length ? targets : null });
      app.posted.push(body);
      await apiTarget.fetchApi(...promptPost(body));
      return true;
    },
  };
  return app;
}

test("#2099 integration: VHS_VideoCombine date-template filename_prefix substitution is OUR dispatch", async () => {
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const app = makeVhsDateFrontend({ apiTarget });
    const result = await dispatchScopedRun({
      app, apiTarget, execIds: ["223"], batch: 1, toNodeId: 223, verifyTimeoutMs: 500,
    });
    assert.equal(result.outcome, "dispatched", "the date substitution is not treated as graph drift");
    assert.equal(server.calls.length, 1, "the scoped prompt reached ComfyUI");
    assert.deepEqual(JSON.parse(server.calls[0].options.body).partial_execution_targets, ["223"]);
    assert.deepEqual(result.volatileInputs, ["223 filename_prefix"], "the coverage gap is disclosed");
  } finally {
    stop();
  }
});

test("#2099 integration: VHS date-template exclusion does NOT let real edits elsewhere ride along", async () => {
  const stop = keepAlive();
  try {
    for (const [label, edit, token] of [
      ["a sibling VHS input", (output) => { output["223"].inputs.frame_rate = 30; }, /223 frame_rate/],
      ["an upstream node input", (output) => { output["1000"].inputs.samples = ["5", 0]; }, /1000 samples/],
    ]) {
      const server = makeServer();
      const apiTarget = { fetchApi: server };
      const app = makeVhsDateFrontend({ apiTarget, alsoEdit: edit });
      const result = await dispatchScopedRun({
        app, apiTarget, execIds: ["223"], batch: 1, toNodeId: 223, verifyTimeoutMs: 500,
      });
      assert.equal(result.outcome, "refused", `${label} edit is still drift`);
      assert.match(result.error, /graph CHANGED/i);
      assert.match(result.error, token);
      assert.doesNotMatch(result.error, /223 filename_prefix/, "the volatile date template is not blamed");
      assert.equal(server.calls.length, 0, `${label}: the edited workflow never left the tab`);
    }
  } finally {
    stop();
  }
});

// ---------------------------------------------------------------------------
// #1331 integration — the reporter's sequence, driven through dispatchScopedRun
// (the SAME orchestration graph_run / panel_run runs).
//
// After reconnect a MiniMax H3 node still has leftover clip/vae/length widget
// values; the live inputs are already linked. The stamp serializes the leftovers;
// the deferred POST serializes the incoming links (or later leftovers). Before
// #1331 that pair always mismatched and the #1050 retry failed identically.
// ---------------------------------------------------------------------------

const MINIMAX_STAMP = {
  "4": { class_type: "CLIPLoader", inputs: { clip_name: "clip_l.safetensors" } },
  "5": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
  "1000": {
    class_type: "MiniMaxH3ReferenceToVideo",
    inputs: { clip: "clip_l.safetensors", vae: "ae.safetensors", length: 81, prompt: "a cat" },
  },
  "223": { class_type: "VHS_VideoCombine", inputs: { images: ["1000", 0] } },
};

function makeMinimaxReconnectFrontend({ apiTarget, alsoEdit = null } = {}) {
  const app = {
    queueItems: [],
    posted: [],
    graph: { _nodes: [minimaxH3Node(1000), { id: 223, widgets: [] }] },
    graphToPrompt: async () => ({ output: structuredClone(MINIMAX_STAMP), workflow: {} }),
    queuePrompt: async (number, batch, arg) => {
      const targets = Array.isArray(arg) ? arg : arg?.queueNodeIds;
      const output = structuredClone(MINIMAX_STAMP);
      // The reconnect race: dispatch serializes the incoming links, not the leftovers.
      output["1000"].inputs.clip = ["4", 0];
      output["1000"].inputs.vae = ["5", 0];
      output["1000"].inputs.length = ["9", 0];
      if (alsoEdit) alsoEdit(output);
      const body = frontendBody({ output, number, targets: targets?.length ? targets : null });
      app.posted.push(body);
      await apiTarget.fetchApi(...promptPost(body));
      return true;
    },
  };
  return app;
}

test("#1331 integration: leftover link-driven clip/vae/length after reconnect is OUR dispatch — the scoped run reaches ComfyUI instead of racing the stamp", async () => {
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const app = makeMinimaxReconnectFrontend({ apiTarget });
    const ids = [];
    const result = await dispatchScopedRun({
      app, apiTarget, execIds: ["223"], batch: 1, toNodeId: 223,
      verifyTimeoutMs: 500,
      onPromptId: (p) => ids.push(p),
    });
    assert.equal(result.outcome, "dispatched", "the #556 graph-stamp refusal is gone");
    assert.equal(result.verified, 1);
    assert.deepEqual(ids, ["srv-1"]);
    assert.equal(server.calls.length, 1, "the scoped prompt actually reached ComfyUI");
    assert.deepEqual(JSON.parse(server.calls[0].options.body).partial_execution_targets, ["223"]);
    assert.deepEqual(
      result.volatileInputs,
      ["1000 clip", "1000 length", "1000 vae"],
      "the gap is DISCLOSED, never silent: graph_run turns this into drift_coverage",
    );
  } finally {
    stop();
  }
});

test("#1331 integration: the leftover exclusion does NOT let a real edit ride along", async () => {
  const stop = keepAlive();
  try {
    for (const [label, edit] of [
      ["an unlinked sibling widget", (o) => { o["1000"].inputs.prompt = "a dog"; }],
      ["a pure-socket rewire elsewhere", (o) => { o["223"].inputs.images = ["5", 0]; }],
      ["a node added", (o) => { o["77"] = { class_type: "SaveImage", inputs: {} }; }],
    ]) {
      const server = makeServer();
      const apiTarget = { fetchApi: server };
      const app = makeMinimaxReconnectFrontend({ apiTarget, alsoEdit: edit });
      const result = await dispatchScopedRun({
        app, apiTarget, execIds: ["223"], batch: 1, toNodeId: 223, verifyTimeoutMs: 500,
      });
      assert.equal(result.outcome, "refused", `${label} is still drift`);
      assert.match(result.error, /graph CHANGED/i, label);
      assert.equal(server.calls.length, 0, `${label}: the edited workflow never left the tab`);
      assert.doesNotMatch(result.error, /1000 clip/, `${label}: the leftover is no longer blamed`);
    }
  } finally {
    stop();
  }
});

test("#1331 integration: hookless RandomNoise seed churn after reconnect is OUR dispatch, a sibling edit is not", async () => {
  const stop = keepAlive();
  try {
    const control = hooklessControl("randomize");
    const seed = { name: "noise_seed", value: 111, linkedWidgets: [control] };
    const stamp = {
      "16": { class_type: "RandomNoise", inputs: { noise_seed: 111, steps: 20 } },
      "223": { class_type: "VHS_VideoCombine", inputs: { images: ["16", 0] } },
    };
    {
      const server = makeServer();
      const apiTarget = { fetchApi: server };
      const app = {
        graph: { _nodes: [{ id: 16, widgets: [seed, control, { name: "steps", value: 20 }] }] },
        graphToPrompt: async () => ({ output: structuredClone(stamp), workflow: {} }),
        queuePrompt: async (number, _batch, arg) => {
          const targets = Array.isArray(arg) ? arg : arg?.queueNodeIds;
          const output = structuredClone(stamp);
          output["16"].inputs.noise_seed = 999983;
          await apiTarget.fetchApi(...promptPost(frontendBody({
            output, number, targets: targets?.length ? targets : null,
          })));
          return true;
        },
      };
      const result = await dispatchScopedRun({
        app, apiTarget, execIds: ["223"], batch: 1, toNodeId: 223, verifyTimeoutMs: 500,
      });
      assert.equal(result.outcome, "dispatched", "hookless seed churn is not a user edit");
      assert.equal(server.calls.length, 1, "the scoped prompt reached ComfyUI");
      assert.ok(result.volatileInputs.includes("16 noise_seed"));
    }
    {
      const server = makeServer();
      const apiTarget = { fetchApi: server };
      const app = {
        graph: { _nodes: [{ id: 16, widgets: [seed, control, { name: "steps", value: 20 }] }] },
        graphToPrompt: async () => ({ output: structuredClone(stamp), workflow: {} }),
        queuePrompt: async (number, _batch, arg) => {
          const targets = Array.isArray(arg) ? arg : arg?.queueNodeIds;
          const output = structuredClone(stamp);
          output["16"].inputs.noise_seed = 999983;
          output["16"].inputs.steps = 25;
          await apiTarget.fetchApi(...promptPost(frontendBody({
            output, number, targets: targets?.length ? targets : null,
          })));
          return true;
        },
      };
      const result = await dispatchScopedRun({
        app, apiTarget, execIds: ["223"], batch: 1, toNodeId: 223, verifyTimeoutMs: 500,
      });
      assert.equal(result.outcome, "refused", "a sibling edit is still drift");
      assert.match(result.error, /16 steps/);
      assert.equal(server.calls.length, 0);
    }
  } finally {
    stop();
  }
});

test("#556 r5 integration: batch=2 with the first post verified and the second scope-dropped ⇒ REFUSED with truthful counts, NO escape, never 'dispatched'", async () => {
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const app = makeFrontend({ shape: "shim", apiTarget });
    // The frontend's batch loop: post 1 keeps its scope, post 2 loses it, and
    // the loop breaks on the refusal (so nothing further posts).
    app.queuePrompt = async (number, batch, arg) => {
      for (let i = 0; i < batch; i++) {
        const targets = i === 0 ? ["14"] : null;
        const body = frontendBody({ output: OUR_OUTPUT, number, targets });
        app.posted.push(body);
        const res = await apiTarget.fetchApi("/prompt", { method: "POST", body: JSON.stringify(body) });
        if (res.status !== 200) return true;
      }
      return true;
    };
    const ids = [];
    const result = await dispatchScopedRun({
      app, apiTarget, execIds: ["14"], batch: 2, toNodeId: 14,
      onPromptId: (p) => ids.push(p),
    });
    assert.notEqual(result.outcome, "dispatched", "never dispatched on a partially-verified batch");
    assert.equal(result.outcome, "refused");
    assert.equal(result.verified, 1);
    assert.match(result.error, /1 of 2/);
    assert.match(result.error, /did NOT execute/);
    assert.equal(server.calls.length, 1, "only the verified scoped post left the tab — the scope-dropped one was refused");
    assert.deepEqual(ids, ["srv-1"], "the verified prompt_id was captured (ledger-eligible)");
  } finally {
    stop();
  }
});

test("#556 r5 integration: batch=2 FULLY verified ⇒ dispatched (guard held until BOTH posts verify)", async () => {
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const prev = apiTarget.fetchApi;
    const app = makeFrontend({ shape: "shim", apiTarget });
    app.queuePrompt = async (number, batch, arg) => {
      for (let i = 0; i < batch; i++) {
        const body = frontendBody({ output: OUR_OUTPUT, number, targets: ["14"] });
        app.posted.push(body);
        await apiTarget.fetchApi("/prompt", { method: "POST", body: JSON.stringify(body) });
      }
      return true;
    };
    const ids = [];
    const result = await dispatchScopedRun({
      app, apiTarget, execIds: ["14"], batch: 2, toNodeId: 14,
      onPromptId: (p) => ids.push(p),
    });
    assert.equal(result.outcome, "dispatched");
    assert.equal(result.verified, 2);
    assert.deepEqual(ids, ["srv-1", "srv-2"], "every batch prompt_id captured");
    assert.equal(server.calls.length, 2);
    // #630 r4 — see the happy-path note: success retains the sentinel so a late
    // duplicate of this run cannot post the full graph after we reported done.
    assert.notEqual(apiTarget.fetchApi, prev, "sentinel retained once the whole batch verified");
  } finally {
    stop();
  }
});

test("#556 r5 integration: batch=2 where the second post NEVER arrives ⇒ unverified naming the verified count, sentinel guards the rest", async () => {
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const app = makeFrontend({ shape: "shim", apiTarget });
    // Posts only the FIRST of the batch, then the processor stalls silently.
    app.queuePrompt = async (number, batch, arg) => {
      const body = frontendBody({ output: OUR_OUTPUT, number, targets: ["14"] });
      app.posted.push(body);
      await apiTarget.fetchApi("/prompt", { method: "POST", body: JSON.stringify(body) });
      return true;
    };
    const ids = [];
    const result = await dispatchScopedRun({
      app, apiTarget, execIds: ["14"], batch: 2, toNodeId: 14,
      verifyTimeoutMs: 60,
      onPromptId: (p) => ids.push(p),
    });
    assert.equal(result.outcome, "unverified");
    assert.equal(result.verified, 1);
    assert.match(result.error, /1 of 2/, "the error names how many of the batch were verified");
    assert.match(result.error, /sentinel/);
    // The stalled second post finally arrives, scope-dropped ⇒ sentinel refuses it.
    const res = await apiTarget.fetchApi("/prompt", {
      method: "POST",
      body: JSON.stringify(frontendBody({ output: OUR_OUTPUT, number: result.queueMark, targets: null })),
    });
    assert.equal(res.status, 400, "the sentinel refuses the late scope-dropped batch post");
    assert.equal(server.calls.length, 1, "only the one verified scoped post ever left the tab");
  } finally {
    stop();
  }
});

test("#556 r6 integration: batch=1 whose /prompt fetch THROWS ⇒ 'failed' outcome (never dispatched/queued:true), sentinel guards the incomplete batch", async () => {
  const stop = keepAlive();
  try {
    const server = makeServer(async () => { throw new Error("connection reset"); });
    const apiTarget = { fetchApi: server };
    const prev = apiTarget.fetchApi;
    const app = makeFrontend({ shape: "shim", apiTarget });
    // The frontend catches generic submission failures and returns normally.
    app.queuePrompt = async (number, batch, arg) => {
      const body = frontendBody({ output: OUR_OUTPUT, number, targets: ["14"] });
      app.posted.push(body);
      try {
        await apiTarget.fetchApi("/prompt", { method: "POST", body: JSON.stringify(body) });
      } catch { /* frontend swallows generic submission failures */ }
      return true;
    };
    const ids = [];
    const result = await dispatchScopedRun({
      app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14,
      onPromptId: (p) => ids.push(p),
    });
    assert.equal(result.outcome, "failed");
    assert.notEqual(result.outcome, "dispatched");
    assert.equal(result.verified, 0);
    assert.match(result.error, /connection reset/);
    assert.match(result.error, /NOT confirmed queued/);
    assert.match(result.error, /CANNOT be determined from here/, "#630 r7 P0-4: never a definite non-arrival claim");
    assert.deepEqual(ids, [], "no prompt_id claimed");
    assert.notEqual(apiTarget.fetchApi, prev, "batch unaccounted ⇒ sentinel stays (the frontend may keep looping)");
    // A late CORRUPTED post of this run is still refused by the sentinel.
    const res = await apiTarget.fetchApi("/prompt", {
      method: "POST",
      body: JSON.stringify(frontendBody({ output: OUR_OUTPUT, number: result.queueMark, targets: null })),
    });
    assert.equal(res.status, 400);
    assert.equal(server.calls.length, 1, "nothing ever dispatched successfully");
  } finally {
    stop();
  }
});

test("#556 r6 integration: batch=2 where post 1's fetch throws and post 2 verifies (frontend continues its loop) ⇒ still 'failed', post 2 captured for the ledger but the run is not claimed", async () => {
  const stop = keepAlive();
  try {
    let call = 0;
    const server = makeServer(async () => {
      call++;
      if (call === 1) throw new Error("connection reset");
      return jsonResponse(200, { prompt_id: "srv-2" });
    });
    const apiTarget = { fetchApi: server };
    const prev = apiTarget.fetchApi;
    const app = makeFrontend({ shape: "shim", apiTarget });
    app.queuePrompt = async (number, batch, arg) => {
      for (let i = 0; i < batch; i++) {
        const body = frontendBody({ output: OUR_OUTPUT, number, targets: ["14"] });
        app.posted.push(body);
        try {
          await apiTarget.fetchApi("/prompt", { method: "POST", body: JSON.stringify(body) });
        } catch { /* generic failure: the frontend CONTINUES its batch loop */ }
      }
      return true;
    };
    const ids = [];
    const result = await dispatchScopedRun({
      app, apiTarget, execIds: ["14"], batch: 2, toNodeId: 14,
      onPromptId: (p) => ids.push(p),
    });
    assert.equal(result.outcome, "failed", "the first post's failure terminates the run truthfully");
    assert.match(result.error, /connection reset/);
    assert.match(result.error, /0 of 2/);
    assert.notEqual(result.outcome, "dispatched");
    assert.deepEqual(ids, ["srv-2"], "post 2's prompt_id is ledger-captured (it IS queued) but the run is not reported as queued");
    assert.equal(server.calls.length, 2);
    assert.notEqual(apiTarget.fetchApi, prev, "batch not fully accounted ⇒ sentinel stays");
  } finally {
    stop();
  }
});

test("#556 r3 P0-3 integration: timeout CANCELS our tagged pending item (assert the removal) — and the sentinel STAYS (#630 r7)", async () => {
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const prev = apiTarget.fetchApi;
    const app = makeFrontend({ shape: "shim", defer: true, apiTarget });
    // A foreign identical-scope item also pending — must survive.
    app.queueItems.push({ number: 0, batchCount: 1, queueNodeIds: ["14"] });
    const result = await dispatchScopedRun({
      app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14,
      verifyTimeoutMs: 50,
    });
    assert.equal(result.outcome, "unverified");
    assert.match(result.error, /REMOVED/);
    assert.equal(app.queueItems.length, 1, "ONLY our tagged item was removed");
    assert.deepEqual(app.queueItems[0].queueNodeIds, ["14"]);
    // #630 r7 P0-3 — DELIBERATE CHANGE. This asserted "guard restored — no
    // sentinel needed after a successful cancel". A successful cancel proves
    // only that tagged entries STILL IN app.queueItems were spliced; it says
    // nothing about a copy the frontend already took, popped, or scheduled.
    // Positive evidence about what we could see is not evidence about what we
    // could not, and restoring on it let an unseen same-mark copy post
    // scopeless later.
    assert.notEqual(apiTarget.fetchApi, prev, "the sentinel stays — the cancel is not proof about unseen copies");
    assert.equal(server.calls.length, 0, "nothing was ever dispatched");
  } finally {
    stop();
  }
});

test("#556 r3 P0-2 integration: degraded mode FAILS CLOSED — graphToPrompt failure refuses BEFORE queuePrompt (never 'dispatch and hope')", async () => {
  const stop = keepAlive();
  try {
    const apiTarget = { fetchApi: makeServer() };
    const app = makeFrontend({ shape: "shim", apiTarget, failGraphToPrompt: true });
    let queuePromptCalled = false;
    const origQP = app.queuePrompt;
    app.queuePrompt = async (...a) => { queuePromptCalled = true; return origQP(...a); };
    const result = await dispatchScopedRun({ app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14 });
    assert.equal(result.outcome, "unverifiable");
    assert.match(result.error, /cannot be dispatched safely/);
    assert.equal(queuePromptCalled, false, "queuePrompt is never called without a signature");
    assert.equal(apiTarget.fetchApi.calls.length, 0, "nothing dispatched — the failure is closed, not open");
  } finally {
    stop();
  }
});

test("#556 r3 P0-3 integration: foreign traffic during our window is untouched — same-graph user full run + identical-scope foreign scoped run; only OUR marked post is observed and captured", async () => {
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const app = makeFrontend({ shape: "shim", defer: true, apiTarget });
    const ids = [];
    const promise = dispatchScopedRun({
      app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14,
      verifyTimeoutMs: 500,
      onPromptId: (p) => ids.push(p),
    });
    await sleep(20); // guard is installed, waiting for observation
    // A user queues a full run of the SAME graph (UI: number=0 ⇒ unmarked).
    const userRes = await apiTarget.fetchApi("/prompt", { method: "POST", body: JSON.stringify(frontendBody({ number: 0, targets: null })) });
    assert.equal(userRes.status, 200, "the user's run is dispatched normally");
    // A foreign scoped run with the SAME targets (also unmarked).
    const foreignRes = await apiTarget.fetchApi("/prompt", { method: "POST", body: JSON.stringify(frontendBody({ number: 0, targets: ["14"] })) });
    assert.equal(foreignRes.status, 200);
    assert.equal(server.calls.length, 2, "both foreign posts dispatched untouched");
    // Now OUR deferred item posts (marked, scoped) — observed.
    await app.postDeferred(app.deferredItem);
    const result = await promise;
    assert.equal(result.outcome, "dispatched");
    assert.deepEqual(ids, ["srv-3"], "only OUR prompt_id was captured (srv-1/2 were the foreign posts)");
    assert.equal(server.calls.length, 3);
  } finally {
    stop();
  }
});

// ---------------------------------------------------------------------------
// The RESOLUTION half of the refusal: a stale/unknown to_node_id never reaches
// dispatch at all (graph_run returns queued:false before queuePrompt).
// ---------------------------------------------------------------------------

const outputNode = (id) => ({
  id,
  type: "PreviewImage",
  constructor: { nodeData: { output_node: true } },
});

test("#556: a to_node_id that went STALE (graph changed after the id was captured) resolves not_found ⇒ refused before any dispatch", () => {
  const staleRoot = { _nodes: [outputNode(14)], getNodeById(id) { return this._nodes.find((n) => Number(n.id) === Number(id)) ?? null; } };
  assert.equal(resolveRunToNodeTarget(staleRoot, null, 14).ok, true);
  const liveRoot = { _nodes: [outputNode(15)], getNodeById(id) { return this._nodes.find((n) => Number(n.id) === Number(id)) ?? null; } };
  assert.deepEqual(resolveRunToNodeTarget(liveRoot, null, 14), { ok: false, code: "not_found", node: null });
});

test("#556: a NON-output target is refused (not_output) — it can never be an execution root", () => {
  const ksampler = { id: 3, type: "KSampler", constructor: { nodeData: { output_node: false } } };
  const root = { _nodes: [ksampler], getNodeById(id) { return this._nodes.find((n) => Number(n.id) === Number(id)) ?? null; } };
  const res = resolveRunToNodeTarget(root, null, 3);
  assert.equal(res.ok, false);
  assert.equal(res.code, "not_output");
});

// ---------------------------------------------------------------------------
// #659 — JSON-invisible widget values (undefined / function / symbol) must not
// false-positive the #556 drift guard, and a graph_changed refusal must say
// WHAT differed instead of asserting a cause.
// ---------------------------------------------------------------------------

test("#659 promptContentHash: an input whose value JSON cannot transmit is absent on BOTH channels — in-memory output and wire body hash identically", () => {
  // graphToPrompt assigns inputs[name] = widget.value unconditionally for
  // serialized widgets, so an async-populated combo that never got a value
  // (the issue's OllamaConnectivityV2 "model": ((), {}) — empty options, no
  // default) or a multi-spec COMFY_AUTOGROW_V3 shim widget lands in the
  // in-memory output as a key with an undefined value. JSON.stringify DROPS
  // that key from the POST body, so the parsed body never has it — and the
  // two hashes of the SAME untouched graph used to differ deterministically.
  const inMemory = {
    "3": { class_type: "KSampler", inputs: { steps: 20, model: undefined } },
    "9": { class_type: "SaveImage", inputs: {} },
  };
  const wireBody = (inputs3) =>
    JSON.stringify({ prompt: { "3": { class_type: "KSampler", inputs: inputs3 }, "9": { class_type: "SaveImage", inputs: {} } } });
  assert.equal(
    promptContentHash(inMemory),
    promptContentHashFromBody(wireBody({ steps: 20 })),
    "undefined-valued key in memory, key absent on the wire ⇒ SAME hash",
  );
  // Functions/symbols are dropped from the wire body exactly like undefined.
  const withFn = {
    "3": { class_type: "KSampler", inputs: { steps: 20, cb: () => {} } },
    "9": { class_type: "SaveImage", inputs: {} },
  };
  assert.equal(promptContentHash(withFn), promptContentHashFromBody(wireBody({ steps: 20 })),
    "a function-valued input is equally invisible to the wire");
  // null IS wire-representable — kept on both channels, so it hashes fine…
  const withNull = {
    "3": { class_type: "KSampler", inputs: { steps: 20, model: null } },
    "9": { class_type: "SaveImage", inputs: {} },
  };
  assert.equal(promptContentHash(withNull), promptContentHashFromBody(wireBody({ steps: 20, model: null })),
    "an explicit null survives the wire and stays covered");
  // …and undefined → null is a change the wire CARRIES: it must mismatch.
  assert.notEqual(
    promptContentHash(inMemory),
    promptContentHashFromBody(wireBody({ steps: 20, model: null })),
    "a key that APPEARS on the wire (undefined → null/value) is genuine drift, still detected",
  );
  // value → absent is equally a wire-carried change: still detected.
  assert.notEqual(
    promptContentHash(withNull),
    promptContentHashFromBody(wireBody({ steps: 20 })),
    "a key that VANISHES from the wire (value → undefined) is genuine drift, still detected",
  );
});

test("#659 guard: OUR marked post whose body lacks only a JSON-invisible input is OBSERVED, not refused as graph_changed", async () => {
  const spy = makeServer();
  const outputAtQueue = {
    "3": { class_type: "KSampler", inputs: { steps: 20, model: undefined } },
    "14": { class_type: "PreviewAny", inputs: {} },
  };
  const guard = createScopedRunGuard({
    origFetchApi: spy,
    execIds: ["14"],
    contentHash: promptContentHash(outputAtQueue),
    contentCanon: canonicalizePrompt(outputAtQueue),
    batch: 1,
    toNodeId: 14,
    queueMark: MARK_A,
  });
  // The frontend's body: JSON.stringify dropped the undefined-valued key.
  const wireOutput = JSON.parse(JSON.stringify(outputAtQueue));
  const res = await guard(...promptPost(frontendBody({ output: wireOutput, targets: ["14"] })));
  assert.equal(res.status, 200, "the same graph through the wire is OUR dispatch");
  assert.equal(guard.state.observed, 1);
  assert.equal(spy.calls.length, 1, "dispatched, not refused");
});

test("#659 guard: normalization is NOT tolerance — the previously-undefined input materializing in the body is genuine drift ⇒ refused, and the refusal NAMES the input", async () => {
  const spy = makeServer();
  const outputAtQueue = {
    "3": { class_type: "KSampler", inputs: { steps: 20, model: undefined } },
    "14": { class_type: "PreviewAny", inputs: {} },
  };
  const guard = createScopedRunGuard({
    origFetchApi: spy,
    execIds: ["14"],
    contentHash: promptContentHash(outputAtQueue),
    contentCanon: canonicalizePrompt(outputAtQueue),
    batch: 1,
    toNodeId: 14,
    queueMark: MARK_A,
  });
  const drifted = {
    "3": { class_type: "KSampler", inputs: { steps: 20, model: "llama3" } },
    "14": { class_type: "PreviewAny", inputs: {} },
  };
  const res = await guard(...promptPost(frontendBody({ output: drifted, targets: ["14"] })));
  assert.equal(res.status, 400, "a mid-window edit into the same input still refuses");
  assert.equal(spy.calls.length, 0, "the drifted prompt never left the tab");
  assert.equal(guard.state.droppedReason, "graph_changed");
  assert.match(guard.state.dropped, /3 model/, "the refusal names the differing execId inputName pair");
  assert.match(guard.state.dropped, /Nothing was queued/);
});

test("#659 promptContentHash: the JSON-survival probe covers toJSON() returning undefined, and unstringifyable values stay drift-covered (fail closed)", () => {
  const wireBody = (inputs3) =>
    JSON.stringify({ prompt: { "3": { class_type: "KSampler", inputs: inputs3 }, "9": { class_type: "SaveImage", inputs: {} } } });
  // codex gate r1: an object whose toJSON() yields undefined is dropped from
  // the wire body exactly like a bare undefined — a type-based filter would
  // have kept it and hashed it as [name, null], false-refusing again.
  const withToJsonUndefined = {
    "3": { class_type: "KSampler", inputs: { steps: 20, odd: { toJSON: () => undefined } } },
    "9": { class_type: "SaveImage", inputs: {} },
  };
  assert.equal(
    promptContentHash(withToJsonUndefined),
    promptContentHashFromBody(wireBody({ steps: 20 })),
    "a toJSON()-drops-it value is invisible on both channels",
  );
  // A value that THROWS on stringify (BigInt) can never be compared against
  // the wire — fail toward detecting drift: the hash itself refuses to
  // compute, and dispatchScopedRun's catch turns that into the upfront
  // fail-closed refusal (unchanged from before #659).
  assert.throws(
    () => promptContentHash({ "3": { class_type: "X", inputs: { n: 1n } } }),
    TypeError,
    "an unstringifyable value stays covered — the hash fails closed rather than dropping it",
  );
});

test("#659 scopeDroppedError: a malformed drift list can never throw out of the refusal's description (codex gate r1)", () => {
  // verdict.drift is module-internal today, but scopeDroppedError is exported
  // and runs on the refusal path: odd caller-supplied tokens degrade to the
  // no-diff guidance, they never escape as a throw.
  let msg;
  assert.doesNotThrow(() => {
    msg = scopeDroppedError({ toNodeId: 5, verdict: { ok: false, reason: "graph_changed", drift: [Symbol("x"), 42, null] } });
  });
  assert.match(msg, /queue-time widget hook/, "non-string tokens degrade to the no-diff guidance");
  assert.match(msg, /Nothing was queued/);
  // An over-long token is bounded before it reaches a caller-readable error.
  const long = scopeDroppedError({ toNodeId: 5, verdict: { ok: false, reason: "graph_changed", drift: [`3 ${"x".repeat(500)}`] } });
  assert.ok(long.length < 1200, "the drift list is length-bounded");
  assert.match(long, /3 x+/);
});

test("#659 promptContentHash: the probe uses the REAL input name and its parsed wire value — a key-sensitive toJSON cannot split the channels (codex gate r2)", () => {
  // toJSON(key) receives the property name: probing under a fixed key would
  // misjudge a key-sensitive toJSON (drop decision and value both), and
  // double-invoking a stateful toJSON could flip between probe and canon.
  // The probe therefore uses the real input name and the canon stores the
  // probe's PARSED value, so toJSON fires exactly once with the wire's key.
  const keySensitive = { toJSON: (key) => (key === "model" ? "llama3" : undefined) };
  const inMemory = { "3": { class_type: "X", inputs: { model: keySensitive } }, "9": { class_type: "Y", inputs: {} } };
  const wireBody = JSON.stringify({ prompt: { "3": { class_type: "X", inputs: { model: keySensitive } }, "9": { class_type: "Y", inputs: {} } } });
  assert.equal(
    promptContentHash(inMemory),
    promptContentHashFromBody(wireBody),
    'toJSON("model") on both channels ⇒ the same value, the same hash',
  );
  let calls = 0;
  const counting = { toJSON: () => (++calls, 1) };
  promptContentHash({ "3": { class_type: "X", inputs: { a: counting } } });
  assert.equal(calls, 1, "toJSON fires exactly once per input per canonicalization");
});

test("#659 promptContentHash: an own toJSON FUNCTION on the inputs object fails CLOSED, never a false graph_changed (codex gate r3)", () => {
  // inputs: { steps: 20, toJSON: () => undefined } — the hook protocol makes
  // the WIRE carry whatever toJSON returns instead of the keys, so no
  // per-input canonicalization can predict the body's shape. The hash must
  // refuse to compute (dispatchScopedRun's catch ⇒ the upfront unverifiable
  // refusal) rather than false-refuse a drift that never happened.
  const colliding = { "3": { class_type: "X", inputs: { steps: 20, toJSON: () => undefined } } };
  assert.throws(() => promptContentHash(colliding), TypeError, "unpredictable wire form ⇒ fail closed");
  // A NON-function toJSON-named input does not trip the hook protocol and
  // stays fully drift-covered.
  const harmless = { "3": { class_type: "X", inputs: { steps: 20, toJSON: false } } };
  assert.equal(
    promptContentHash(harmless),
    promptContentHashFromBody(JSON.stringify({ prompt: { "3": { class_type: "X", inputs: { steps: 20, toJSON: false } } } })),
    "a data-valued toJSON key serializes normally on both channels",
  );
});

test("#659 integration: a graph with a toJSON-function inputs collision is refused UPFRONT (unverifiable), queuePrompt never called", async () => {
  // Pins the end-to-end OUTCOME contract (upfront fail-closed, nothing
  // queued). The deliberate-throw MECHANISM is pinned by the hash-level test
  // above: without the canonicalizePrompt guard the probe's own toJSON
  // hijack still throws by accident, reaching the same outcome by another
  // path — the hash test is the one that fails there.
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const output = {
      "3": { class_type: "KSampler", inputs: { steps: 20, toJSON: () => undefined } },
      "14": { class_type: "PreviewAny", inputs: {} },
    };
    const app = makeFrontend({ shape: "shim", apiTarget, output });
    let queuePromptCalled = false;
    const origQP = app.queuePrompt;
    app.queuePrompt = async (...a) => { queuePromptCalled = true; return origQP(...a); };
    const result = await dispatchScopedRun({ app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14 });
    assert.equal(result.outcome, "unverifiable", "fails closed BEFORE dispatch — never a false drift refusal");
    assert.match(result.error, /cannot be dispatched safely/);
    assert.equal(queuePromptCalled, false);
    assert.equal(server.calls.length, 0, "nothing left the tab");
  } finally {
    stop();
  }
});

test("#659 diffPromptCanons: names input-level changes, node add/remove, and class_type changes — and never throws on odd input", () => {
  const a = canonicalizePrompt({
    "3": { class_type: "KSampler", inputs: { steps: 20, model: ["4", 0] } },
    "9": { class_type: "SaveImage", inputs: {} },
  });
  const b = canonicalizePrompt({
    "3": { class_type: "KSampler", inputs: { steps: 25 } },
    "10": { class_type: "PreviewAny", inputs: {} },
  });
  const tokens = diffPromptCanons(a, b);
  assert.ok(tokens.includes("3 steps"), "a changed value names the pair");
  assert.ok(tokens.includes("3 model"), "an input present on only one side names the pair");
  assert.ok(tokens.includes("9 (node only in queued prompt)"), "a removed node is named");
  assert.ok(tokens.includes("10 (node only in dispatch body)"), "an added node is named");
  const c = canonicalizePrompt({ "3": { class_type: "OTHER", inputs: {} } });
  assert.ok(diffPromptCanons(a, c).includes("3 (class_type changed)"), "a replaced node is named");
  assert.deepEqual(diffPromptCanons(a, a), [], "identical canons have no drift");
  assert.equal(diffPromptCanons(null, b), null, "an unusable canon degrades to null");
  assert.equal(diffPromptCanons("junk", b), null);
  assert.equal(diffPromptCanons(a, undefined), null);
});

test("#659 scopeDroppedError: a graph_changed refusal with drift tokens leads with the differing pairs; without them the hook guidance remains", () => {
  const withDrift = scopeDroppedError({
    toNodeId: 143,
    verdict: { ok: false, reason: "graph_changed", drift: ["42 model", "7 (node only in dispatch body)"] },
  });
  assert.match(withDrift, /node 143/);
  assert.match(withDrift, /42 model/);
  assert.match(withDrift, /7 \(node only in dispatch body\)/);
  assert.match(withDrift, /Retrying is safe/);
  assert.match(withDrift, /Nothing was queued/);
  const bare = scopeDroppedError({ toNodeId: 116, verdict: { ok: false, reason: "graph_changed", drift: null } });
  assert.match(bare, /queue-time widget hook/, "no diff available ⇒ the candidate-cause guidance stays");
  assert.match(bare, /Retrying is safe \(nothing was queued\)/);
});

test("#659 integration: a graph whose serialized widget value is undefined (the issue's OllamaConnectivityV2 shape) no longer false-refuses — the scoped run DISPATCHES", async () => {
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    // Reproduced live against ComfyUI_frontend 1.47.12 (#659): graphToPrompt's
    // in-memory output carries `model: undefined` for the empty-options combo;
    // the POST body drops the key — the old hash pair differed 5/5 with zero
    // edits and every scoped run was refused as "graph CHANGED".
    const output = {
      "3": { class_type: "KSampler", inputs: { steps: 20 } },
      "7": { class_type: "OllamaConnectivityV2", inputs: { url: "http://127.0.0.1:11434", model: undefined } },
      "14": { class_type: "PreviewAny", inputs: {} },
    };
    const app = makeFrontend({ shape: "shim", apiTarget, output });
    const result = await dispatchScopedRun({
      app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14,
      verifyTimeoutMs: 500,
    });
    assert.equal(result.outcome, "dispatched", "no user edit ⇒ no drift ⇒ the scoped run goes out");
    assert.equal(server.calls.length, 1);
    const posted = JSON.parse(server.calls[0].options.body);
    assert.deepEqual(posted.partial_execution_targets, ["14"]);
    assert.ok(!("model" in posted.prompt["7"].inputs), "the wire body never carried the JSON-invisible key");
  } finally {
    stop();
  }
});

test("#659 integration: a graph_changed refusal through dispatchScopedRun NAMES what differed — value edits, rewired links, added/removed nodes", async () => {
  const stop = keepAlive();
  try {
    for (const { drift, token } of [
      { drift: { "3": { class_type: "KSampler", inputs: { steps: 25 } } }, token: /3 steps/ },
      { drift: { "9": { class_type: "SaveImage", inputs: { images: ["4", 0] } } }, token: /9 images/ },
      { drift: { "20": { class_type: "SaveImage", inputs: {} } }, token: /20 \(node only in dispatch body\)/ },
    ]) {
      const server = makeServer();
      const apiTarget = { fetchApi: server };
      const driftedOutput = { ...OUR_OUTPUT, ...drift };
      const app = makeFrontend({ shape: "shim", defer: true, apiTarget });
      app.postDeferred = async (item) => {
        const body = frontendBody({ output: driftedOutput, number: item.number, targets: ["14"] });
        app.posted.push(body);
        return apiTarget.fetchApi("/prompt", { method: "POST", body: JSON.stringify(body) });
      };
      const promise = dispatchScopedRun({
        app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14,
        verifyTimeoutMs: 500,
      });
      await sleep(20);
      const res = await app.postDeferred(app.deferredItem);
      const result = await promise;
      assert.equal(res.status, 400);
      assert.equal(result.outcome, "refused");
      assert.match(result.error, /graph CHANGED/i);
      assert.match(result.error, token, `the refusal names the drift: ${token}`);
      assert.equal(server.calls.length, 0, "the drifted prompt never left the tab");
    }
    // A node REMOVED mid-window is named from the other side.
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const { "9": _dropped, ...shrunkOutput } = OUR_OUTPUT;
    const app = makeFrontend({ shape: "shim", defer: true, apiTarget });
    app.postDeferred = async (item) => {
      const body = frontendBody({ output: shrunkOutput, number: item.number, targets: ["14"] });
      app.posted.push(body);
      return apiTarget.fetchApi("/prompt", { method: "POST", body: JSON.stringify(body) });
    };
    const promise = dispatchScopedRun({
      app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14,
      verifyTimeoutMs: 500,
    });
    await sleep(20);
    await app.postDeferred(app.deferredItem);
    const result = await promise;
    assert.equal(result.outcome, "refused");
    assert.match(result.error, /9 \(node only in queued prompt\)/, "a removed node is named");
    assert.equal(server.calls.length, 0);
  } finally {
    stop();
  }
});

test("#752 the repair keeps WHAT THE BODY CONTAINED, not just that it repaired", async () => {
  // Three field reports stalled because the note said the scope "did not reach
  // the request" without saying what did reach it. The guard already computed the
  // body keys and threw them away — yet a frontend that DROPPED the field and one
  // that RENAMED it produce the same sentence otherwise, and that is precisely
  // the distinction the next report has to carry.
  const stop = keepAlive();
  try {
    const server = makeServer();
    const guard = createScopedRunGuard({
      origFetchApi: server, execIds: ["14"], contentHash: OUR_HASH, batch: 1, toNodeId: 14,
      queueMark: MARK_A, repairScope: true,
    });
    await guard(...promptPost({ prompt: OUR_OUTPUT, client_id: "x", number: MARK_A }));
    assert.equal(guard.state.repaired, 1, "an absent key is ours to fill");
    assert.ok(Array.isArray(guard.state.repairedFromKeys), "and the keys survive the repair");
    assert.deepEqual(
      guard.state.repairedFromKeys,
      ["client_id", "number", "prompt"],
      "exactly what the frontend sent, sorted",
    );
    assert.ok(
      !guard.state.repairedFromKeys.includes("partial_execution_targets"),
      "the key that was MISSING must never appear in the list of what was present",
    );
  } finally {
    stop();
  }
});

test("#752 the recorded keys are the FIRST repair's, not a growing list", async () => {
  // A batch repairs once per post. Appending would read as several different
  // causes in the report when it is one frontend behaving one way.
  const stop = keepAlive();
  try {
    const server = makeServer();
    const guard = createScopedRunGuard({
      origFetchApi: server, execIds: ["14"], contentHash: OUR_HASH, batch: 2, toNodeId: 14,
      queueMark: MARK_A, repairScope: true,
    });
    await guard(...promptPost({ prompt: OUR_OUTPUT, client_id: "x", number: MARK_A }));
    await guard(...promptPost({ prompt: OUR_OUTPUT, client_id: "x", number: MARK_A, extra_data: {} }));
    assert.equal(guard.state.repaired, 2);
    assert.deepEqual(guard.state.repairedFromKeys, ["client_id", "number", "prompt"], "first only");
  } finally {
    stop();
  }
});

test("#752 an unrepaired run reports no keys, rather than an empty list", async () => {
  // "" and [] would both render as 'the body carried these keys: ' in the note.
  // null is the honest value for 'no repair happened, so nothing was observed'.
  const stop = keepAlive();
  try {
    const server = makeServer();
    const guard = createScopedRunGuard({
      origFetchApi: server, execIds: ["14"], contentHash: OUR_HASH, batch: 1, toNodeId: 14,
      queueMark: MARK_A, repairScope: true,
    });
    await guard(
      ...promptPost({ prompt: OUR_OUTPUT, client_id: "x", number: MARK_A, partial_execution_targets: ["14"] }),
    );
    assert.equal(guard.state.repaired, 0, "the frontend delivered it; nothing to repair");
    assert.equal(guard.state.repairedFromKeys, null);
  } finally {
    stop();
  }
});

test("#752 NO shipped message asserts a ComfyUI_frontend version range", () => {
  // The messages claimed this path was "not reproducible against ComfyUI_frontend
  // 1.42–1.50". Three field reports on 1.45.21 sit INSIDE that range and hit it.
  // Only 1.47.12 was ever measured here, so the range was never earned — and
  // shipping it told each reporter their own evidence could not be happening.
  //
  // Scanned across ALL shipped panel JS rather than asserted on one string: the
  // claim lived in TWO places (the graph_run note and the guard's own refusal),
  // and fixing only the one quoted in the issue would have left the other
  // shipping the same false statement.
  const here = dirname(fileURLToPath(import.meta.url));
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".js")) {
        readFileSync(p, "utf8")
          .split("\n")
          .forEach((line, i) => {
            // A comment ABOUT the removed claim is the record of why; only
            // shipped prose is the problem.
            if (/^\s*(\/\/|\*)/.test(line)) return;
            if (/1\.\d\d\s*[-–]\s*1\.\d\d/.test(line)) offenders.push(`${name}:${i + 1}  ${line.trim()}`);
          });
      }
    }
  };
  walk(join(here, "../../web/js"));
  assert.deepEqual(offenders, [], `these ship a frontend version range:\n${offenders.join("\n")}`);
});

test("#752 WIRING: the graph_run note actually PRINTS the observed body keys", () => {
  // Recording them on the guard and never rendering them would leave the note
  // exactly as unhelpful as it was, with a passing test suite. The value has to
  // reach the sentence a reporter reads.
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "../../web/js/comfyui-mcp-panel.js"), "utf8");
  const start = source.indexOf('accept.scope_applied_by = "request_body_repair"');
  assert.ok(start > 0);
  const end = source.indexOf("\n    }", start);
  const raw = source.slice(start, end);
  assert.match(raw, /runScopeResult\?\.repairedFromKeys/, "the note reads the recorded keys");
  assert.match(raw, /repairedFromKeys\.join\(", "\)/, "and renders them into the prose");
  // Same normalisation as the #630 reconstruction above: the prose is spelled as
  // adjacent template chunks, so a phrase that reads as one sentence is not one
  // string in the source.
  const prose = raw
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n")
    .replace(/`\s*\+\s*\n\s*`/g, "")
    .replace(/\s+/g, " ");
  assert.match(
    prose,
    /carried these keys and no partial_execution_targets/,
    "labelled as what was present INSTEAD of the scope, not as a bare key dump",
  );
});

test("#752 a build that reads ONLY partialExecutionTargets is served NATIVELY, not by body repair", async () => {
  // Two field reports (frontend 1.45.21) queued correctly but via
  // `scope_applied_by: "request_body_repair"` — the fallback carrying the whole
  // feature. Read out of a shipped 1.47.12 bundle, the reason is that the
  // frontend uses two different option keys at two layers:
  //
  //   store: {queueNodeIds} -> api.queuePrompt(e, m, {partialExecutionTargets: n})
  //   api:   ...n?.partialExecutionTargets && {partial_execution_targets: ...}
  //
  // so a build whose app.queuePrompt forwards straight to the api layer ignored
  // both shapes the panel sent.
  const stop = keepAlive()
  try {
  const server = makeServer()
  const apiTarget = { fetchApi: server }
  const app = makeFrontend({ shape: "apiOptions", apiTarget })
  const result = await dispatchScopedRun({ app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14 })

  assert.equal(result.outcome, "dispatched")
  assert.equal(result.scopeAppliedBy, "frontend", "the scope reached the body through app.queuePrompt, not the repair")
  assert.ok(!result.repaired, "the body-repair fallback must not be needed for this build")
  // Shapes 1 and 2 are dropped by this build; the third one lands.
  assert.equal(app.posted.length, 3, "array, queueNodeIds, then the partialExecutionTargets shape")
  assert.equal(app.posted[0].partial_execution_targets, undefined)
  assert.equal(app.posted[1].partial_execution_targets, undefined)
  assert.deepEqual(app.posted[2].partial_execution_targets, ["14"])
  // Exactly one request reaches ComfyUI, carrying exactly node 14's branch.
  assert.equal(server.calls.length, 1, "the two dropped attempts were blocked, not forwarded")
  assert.deepEqual(JSON.parse(server.calls[0].options.body).partial_execution_targets, ["14"])
  } finally {
    stop()
  }
})

// ---------------------------------------------------------------------------
// comfyui-mcp#1871 — a run-to-node refused over a node on ANOTHER branch.
//
// ComfyUI's validate_prompt checks that every node in the POSTED prompt resolves
// to an installed class before it narrows execution to partial_execution_targets
// (0.33.2 execution.py: the two early returns come three lines above the
// `x in partial_execution_list` test). So the reporter's Topaz nodes 56/57 — not
// upstream of the node 43 they asked for, and never going to execute — refused the
// whole run.
//
// These drive the REAL orchestration: dispatchScopedRun through a mock frontend and
// a server double that answers exactly as ComfyUI 0.33.2 does.
// ---------------------------------------------------------------------------

// One checkpoint, two independent output branches. 43 is the branch asked for.
const TWO_BRANCH_OUTPUT = {
  "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd.safetensors" } },
  "3": { class_type: "KSampler", inputs: { model: ["1", 0], seed: 42 } },
  "40": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["1", 2] } },
  "43": { class_type: "SaveImage", inputs: { images: ["40", 0] } },
  "56": { class_type: "TopazUpscale", inputs: { image: ["40", 0] } },
  "57": { class_type: "SaveImage", inputs: { images: ["56", 0] } },
};

// ComfyUI's own rejection shape for a class it cannot resolve (execution.py 0.33.2).
const missingNodeRejection = (nodeId, classType) => ({
  error: {
    type: "missing_node_type",
    message: `Node '${classType}' not found. The custom node may not be installed.`,
    details: `Node ID '#${nodeId}'`,
    extra_info: { node_id: String(nodeId), class_type: classType, node_title: classType },
  },
  node_errors: {},
});

test("#1871 integration: ComfyUI refuses over an out-of-scope node ⇒ ONE pruned re-post queues the requested branch", async () => {
  const stop = keepAlive();
  try {
    let n = 0;
    const server = makeServer(async () => {
      n++;
      // First post: the whole prompt, refused over node 56 — exactly the report.
      if (n === 1) return jsonResponse(400, missingNodeRejection(56, "TopazUpscale"));
      return jsonResponse(200, { prompt_id: "srv-pruned" });
    });
    const apiTarget = { fetchApi: server };
    const app = makeFrontend({ shape: "shim", apiTarget, output: TWO_BRANCH_OUTPUT });
    const ids = [];
    const rejections = [];
    const result = await dispatchScopedRun({
      app, apiTarget, execIds: ["43"], batch: 1, toNodeId: 43,
      onPromptId: (p) => ids.push(p),
      onRejection: (r) => rejections.push(r),
    });

    assert.equal(result.outcome, "dispatched");
    assert.equal(result.verified, 1);
    assert.deepEqual(ids, ["srv-pruned"]);
    // The refusal that queued nothing must NOT be reported as this run's outcome —
    // graph_run turns a captured rejection into a failure, and the run succeeded.
    assert.deepEqual(rejections, [], "the superseded refusal is not surfaced as the run's verdict");

    assert.equal(server.calls.length, 2, "exactly one extra post — never a loop");
    const first = JSON.parse(server.calls[0].options.body);
    const second = JSON.parse(server.calls[1].options.body);
    assert.deepEqual(Object.keys(first.prompt).sort(), ["1", "3", "40", "43", "56", "57"]);
    assert.deepEqual(
      Object.keys(second.prompt).sort(),
      ["1", "3", "40", "43"],
      "the second post carries the backward closure of node 43 and nothing else",
    );
    assert.deepEqual(second.partial_execution_targets, ["43"], "the scope still travels");
    assert.equal(second.number, result.queueMark, "the pruned post still carries THIS run's identity");

    // DISCLOSED, not silent: the caller is told their ComfyUI refused the first post.
    assert.deepEqual(result.prunedRetry.removed.sort(), ["56", "57"]);
    assert.equal(result.prunedRetry.namedNode, "56");
  } finally {
    stop();
  }
});

test("#1871 integration: a missing node INSIDE the requested branch is reported, not retried", async () => {
  const stop = keepAlive();
  try {
    const server = makeServer(async () => jsonResponse(400, missingNodeRejection(40, "VAEDecode")));
    const apiTarget = { fetchApi: server };
    const app = makeFrontend({ shape: "shim", apiTarget, output: TWO_BRANCH_OUTPUT });
    const rejections = [];
    const result = await dispatchScopedRun({
      app, apiTarget, execIds: ["43"], batch: 1, toNodeId: 43,
      onRejection: (r) => rejections.push(r),
    });
    assert.equal(server.calls.length, 1, "pruning cannot fix it, so nothing is re-posted");
    assert.equal(result.prunedRetry, null);
    assert.equal(rejections.length, 1);
    assert.equal(rejections[0].error.extra_info.node_id, "40", "the caller gets the answer that matters");
  } finally {
    stop();
  }
});

test("#1871 integration: a run ComfyUI ACCEPTS is untouched — one post, no prune, even with a prunable other branch", async () => {
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const app = makeFrontend({ shape: "shim", apiTarget, output: TWO_BRANCH_OUTPUT });
    const result = await dispatchScopedRun({ app, apiTarget, execIds: ["43"], batch: 1, toNodeId: 43 });
    assert.equal(result.outcome, "dispatched");
    assert.equal(server.calls.length, 1, "the happy path never pays a second round trip");
    assert.equal(result.prunedRetry, null);
    // The prompt ComfyUI received is the one the frontend built — the other branch is
    // still in it, so its cached outputs are not evicted by this run (execution.py
    // set_prompt(prompt.keys()) + clean_unused).
    assert.deepEqual(Object.keys(JSON.parse(server.calls[0].options.body).prompt).sort(), [
      "1", "3", "40", "43", "56", "57",
    ]);
  } finally {
    stop();
  }
});

test("#1871 integration: when the pruned post is ALSO refused, the SECOND rejection is the one reported", async () => {
  const stop = keepAlive();
  try {
    let n = 0;
    const server = makeServer(async () => {
      n++;
      if (n === 1) return jsonResponse(400, missingNodeRejection(56, "TopazUpscale"));
      return jsonResponse(400, missingNodeRejection(3, "KSampler"));
    });
    const apiTarget = { fetchApi: server };
    const app = makeFrontend({ shape: "shim", apiTarget, output: TWO_BRANCH_OUTPUT });
    const rejections = [];
    const result = await dispatchScopedRun({
      app, apiTarget, execIds: ["43"], batch: 1, toNodeId: 43,
      onRejection: (r) => rejections.push(r),
    });
    assert.equal(server.calls.length, 2);
    assert.equal(result.verified, 0);
    assert.equal(rejections.length, 1, "one verdict, not two");
    assert.equal(
      rejections[0].error.extra_info.node_id,
      "3",
      "the reported blocker is the one inside the requested branch",
    );
    assert.equal(result.prunedRetry.namedNode, "56", "the superseded refusal is still disclosed");
  } finally {
    stop();
  }
});

test("#1871 integration: an UNSCOPED run is never pruned — the caller asked for the whole graph", async () => {
  const stop = keepAlive();
  try {
    let n = 0;
    const server = makeServer(async () => {
      n++;
      return jsonResponse(400, missingNodeRejection(56, "TopazUpscale"));
    });
    const apiTarget = { fetchApi: server };
    const app = makeFrontend({ shape: "shim", apiTarget, output: TWO_BRANCH_OUTPUT });
    // The unscoped path uses the historical capture wrap, which has no scope and no
    // prune: a full run that names a missing node is a real failure of what was asked.
    const rejections = [];
    apiTarget.fetchApi = createRunFetchInterceptor({
      origFetchApi: server,
      onRejection: (r) => rejections.push(r),
    });
    await app.queuePrompt(0, 1, undefined);
    assert.equal(server.calls.length, 1);
    assert.equal(rejections.length, 1);
    assert.equal(n, 1);
  } finally {
    stop();
  }
});

test("#1871 WIRING: graph_run actually RENDERS the pruned-retry disclosure into the run result", () => {
  // The guard can record the retry perfectly and the caller still never hear about
  // it — a one-line assignment in the reply builder is exactly the kind of install
  // a lib-level test cannot see. So this asserts on the call site itself.
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "../../web/js/comfyui-mcp-panel.js"), "utf8");
  assert.match(
    source,
    /import \{ prunedRetryNote \} from "\.\/lib\/partial-run-prune\.js";/,
    "the panel imports the note builder",
  );
  const start = source.indexOf("runScopeResult?.prunedRetry");
  assert.ok(start > 0, "the reply builder reads the recorded retry");
  const raw = source.slice(start, source.indexOf("\n    }", start));
  assert.match(raw, /accept\.excluded_nodes_omitted/, "the omitted node ids reach the result");
  assert.match(raw, /accept\.excluded_nodes_note = prunedRetryNote\(/, "and the sentence is built from them");
  assert.match(raw, /toNodeId: to_node_id/, "the note names the node the caller asked for");
  assert.match(raw, /namedNode: pr\.namedNode/, "and the node ComfyUI refused");
  // codex gate r2, P1 — the note says the pruned prompt is the one ComfyUI ACCEPTED.
  // A retry that was itself refused must never reach it, and that must be true of
  // this line rather than of three early returns further up.
  assert.match(
    source.slice(start - 200, start + 120),
    /runScopeResult\.verified > 0/,
    "the acceptance claim is gated on a post ComfyUI actually accepted",
  );
});

// ---------------------------------------------------------------------------
// #1504 — node_errors on an ACCEPTED (200) reply
// ---------------------------------------------------------------------------
//
// ComfyUI validates each output independently. When some fail but at least one
// survives, server.py queues the prompt and answers **200** with `prompt_id` AND
// the `node_errors` for the outputs it dropped. Those errors are not a refusal,
// and the capture layer is the only place that can still tell the difference:
// the frontend records a 200 reply node_errors onto app.lastNodeErrors exactly
// like a rejection, so by the time graph_run reads that field the distinction is
// gone. These pin that the 200 body is read for BOTH facts, on BOTH dispatch
// paths, and that a rejection is still never manufactured from a 200.

const PARTIAL_NODE_ERRORS = {
  36: {
    class_type: "VAEDecode",
    dependent_outputs: [],
    errors: [{ type: "required_input_missing", message: "Required input is missing", details: "samples" }],
  },
};

test("#1504 unscoped interceptor: a 200 with node_errors yields prompt_id + ACCEPTED drops, never a rejection", async () => {
  const spy = makeServer(async () =>
    jsonResponse(200, { prompt_id: "p-partial", number: 1, node_errors: PARTIAL_NODE_ERRORS }),
  );
  let rejection = null;
  const ids = [];
  const dropped = [];
  const intercepted = createRunFetchInterceptor({
    origFetchApi: spy,
    onRejection: (r) => (rejection = r),
    onPromptId: (p) => ids.push(p),
    onAcceptedNodeErrors: (ne) => dropped.push(ne),
  });
  await intercepted(...promptPost({ prompt: {} }));
  assert.equal(rejection, null, "a 200 is an acceptance — the rejection channel must stay empty");
  assert.deepEqual(ids, ["p-partial"], "the minted id is the receipt that this prompt IS queued");
  assert.deepEqual(dropped, [PARTIAL_NODE_ERRORS], "the dropped outputs come from the 200 body");
});

test("#1504 unscoped interceptor: a clean 200 reports NO drops", async () => {
  // Empty / absent / non-object node_errors must never fire the partial disclosure.
  for (const node_errors of [undefined, null, {}, [], "no"]) {
    const dropped = [];
    const intercepted = createRunFetchInterceptor({
      origFetchApi: makeServer(async () => jsonResponse(200, { prompt_id: "p1", node_errors })),
      onAcceptedNodeErrors: (ne) => dropped.push(ne),
    });
    await intercepted(...promptPost({ prompt: {} }));
    assert.deepEqual(dropped, [], `node_errors=${JSON.stringify(node_errors)} is not a drop`);
  }
});

test("#1504 interceptor: a 400 rejection body is NOT reported as accepted drops", async () => {
  // The #358 channel is unchanged: a refusal mints nothing, so nothing may reach
  // the accepted-drops channel or the caller would be told a refused prompt is running.
  const dropped = [];
  let rejection = null;
  const intercepted = createRunFetchInterceptor({
    origFetchApi: makeServer(async () => jsonResponse(400, { error: null, node_errors: PARTIAL_NODE_ERRORS })),
    onRejection: (r) => (rejection = r),
    onAcceptedNodeErrors: (ne) => dropped.push(ne),
  });
  await intercepted(...promptPost({ prompt: {} }));
  assert.deepEqual(dropped, [], "a non-200 never produces accepted drops");
  assert.deepEqual(rejection.node_errors, PARTIAL_NODE_ERRORS, "it stays a rejection");
});

test("#1504 integration: a SCOPED run reports the outputs ComfyUI dropped from the prompt it queued", async () => {
  const stop = keepAlive();
  try {
    const apiTarget = {
      fetchApi: makeServer(async () =>
        jsonResponse(200, { prompt_id: "p-scoped", number: 1, node_errors: PARTIAL_NODE_ERRORS }),
      ),
    };
    const app = makeFrontend({ shape: "shim", apiTarget });
    const ids = [];
    const dropped = [];
    const result = await dispatchScopedRun({
      app,
      apiTarget,
      execIds: ["14"],
      batch: 1,
      toNodeId: 14,
      onPromptId: (p) => ids.push(p),
      onAcceptedNodeErrors: (ne) => dropped.push(ne),
    });
    assert.equal(result.outcome, "dispatched", "a partial-validation 200 is still a real dispatch");
    assert.equal(result.verified, 1, "it counts as VERIFIED: ComfyUI accepted and is running it");
    assert.deepEqual(ids, ["p-scoped"]);
    assert.deepEqual(dropped, [PARTIAL_NODE_ERRORS]);
  } finally {
    stop();
  }
});
