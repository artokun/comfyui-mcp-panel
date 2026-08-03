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

import {
  newScopedQueueMark,
  QUEUE_ITEM_TAG,
  queuePromptScopeArgs,
  promptContentHash,
  promptContentHashFromBody,
  collectVolatileInputs,
  verifyScopedPromptBody,
  scopeDroppedError,
  scopeUnverifiedError,
  scopeUnattributableError,
  createRunFetchInterceptor,
  createScopedRunGuard,
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
 * #556 build). `defer`: queuePrompt pushes the item and returns early (busy
 * processor); the TEST then drives the deferred post manually through
 * apiTarget.fetchApi, exactly like the in-flight processor would.
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
        shape === "shim"
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
  assert.match(guard.state.failed, /NOT reported as queued/);
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

test("#556 integration: happy path — marked scoped dispatch observed, prompt_id captured, fetchApi restored", async () => {
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
    assert.equal(apiTarget.fetchApi, prev, "guard restored after observation");
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
    const apiTarget = { fetchApi: makeServer() };
    const app = makeFrontend({ shape: "shimless", apiTarget });
    const result = await dispatchScopedRun({ app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14 });
    assert.equal(result.outcome, "dispatched");
    assert.equal(app.posted.length, 2, "both shapes attempted");
    assert.equal(app.posted[0].partial_execution_targets, undefined, "attempt 1 (array) dropped by this build");
    assert.equal(apiTarget.fetchApi.calls.length, 1, "only the correctly-shaped dispatch reached the server");
    assert.deepEqual(apiTarget.fetchApi.calls[0].options.body && JSON.parse(apiTarget.fetchApi.calls[0].options.body).partial_execution_targets, ["14"]);
  } finally {
    stop();
  }
});

test("#556 integration: a build honoring NEITHER shape ⇒ truthful refusal, ZERO dispatches", async () => {
  const stop = keepAlive();
  try {
    const apiTarget = { fetchApi: makeServer() };
    const app = makeFrontend({ shape: "positional", apiTarget });
    // positional honors the array… force neither by overriding queuePrompt to always drop targets
    app.queuePrompt = async (number, batch) => {
      const body = frontendBody({ output: OUR_OUTPUT, number, targets: null });
      app.posted.push(body);
      await apiTarget.fetchApi("/prompt", { method: "POST", body: JSON.stringify(body) });
      return true;
    };
    const result = await dispatchScopedRun({ app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14 });
    assert.equal(result.outcome, "refused");
    assert.match(result.error, /node 14/);
    assert.match(result.error, /Nothing was queued/);
    assert.equal(apiTarget.fetchApi.calls.length, 0, "no full-graph prompt ever left the tab");
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
    // Chaining: B restored the wrap that was current when IT installed — A's sentinel.
    assert.equal(apiTarget.fetchApi, sentinelA, "B's cleanup did not clobber A's sentinel");
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
    assert.equal(apiTarget.fetchApi, prev, "guard restored once the whole batch verified");
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
    assert.match(result.error, /NOT reported as queued/);
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

test("#556 r3 P0-3 integration: timeout CANCELS our tagged pending item (assert the removal) — guard restored, no sentinel", async () => {
  const stop = keepAlive();
  try {
    const apiTarget = { fetchApi: makeServer() };
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
    assert.equal(apiTarget.fetchApi, prev, "guard restored — no sentinel needed after a successful cancel");
    assert.equal(apiTarget.fetchApi.calls.length, 0, "nothing was ever dispatched");
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
