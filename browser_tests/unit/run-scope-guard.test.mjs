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
  SCOPED_QUEUE_MARK,
  QUEUE_ITEM_TAG,
  queuePromptScopeArgs,
  promptSignature,
  promptSignatureFromBody,
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
const OUR_SIGNATURE = promptSignature(OUR_OUTPUT);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bodies the way the frontend's api.queuePrompt builds them.
function frontendBody({ output = OUR_OUTPUT, number = SCOPED_QUEUE_MARK, targets = null }) {
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

test("#556 promptSignature: node-id|class_type set, widget values excluded, order-insensitive", () => {
  const a = promptSignature({ "9": { class_type: "B", inputs: { seed: 1 } }, "3": { class_type: "A" } });
  const b = promptSignature({ "3": { class_type: "A" }, "9": { class_type: "B", inputs: { seed: 999 } } });
  assert.equal(a, b);
  assert.notEqual(promptSignature({ "3": { class_type: "A" } }), a);
  assert.equal(promptSignatureFromBody(JSON.stringify({ prompt: OUR_OUTPUT })), OUR_SIGNATURE);
  assert.equal(promptSignatureFromBody("not-json{"), null);
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
  const sentinel = scopeUnverifiedError({ toNodeId: 14, timeoutMs: 5000, cancelled: false, lingerMs: 600000 });
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
  const guard = createScopedRunGuard({ origFetchApi: spy, execIds: ["14"], signature: OUR_SIGNATURE, batch: 1, toNodeId: 14, onPromptId: (p) => ids.push(p) });
  const [route, options] = promptPost(frontendBody({ targets: ["14"] }));
  const res = await guard(route, options);
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].options, options);
  assert.equal(res.status, 200);
  assert.equal(guard.state.observed, 1);
  assert.deepEqual(ids, ["srv-1"]);
});

test("#556 guard: OUR marked post with MISSING or WRONG/EXTRA targets ⇒ refused with zero dispatch", async () => {
  for (const bad of [null, ["9"], ["14", "9"]]) {
    const spy = makeServer();
    let dropped = null;
    const guard = createScopedRunGuard({ origFetchApi: spy, execIds: ["14"], signature: OUR_SIGNATURE, batch: 1, toNodeId: 14, onScopeDropped: (m) => (dropped = m) });
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
    origFetchApi: spy, execIds: ["14"], signature: OUR_SIGNATURE, batch: 1, toNodeId: 14,
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
  const guard = createScopedRunGuard({ origFetchApi: spy, execIds: ["14"], signature: OUR_SIGNATURE, batch: 1, toNodeId: 14 });
  const changedOutput = { "3": { class_type: "KSampler" }, "20": { class_type: "SaveImage" } };
  const res = await guard(...promptPost(frontendBody({ output: changedOutput, targets: ["14"] })));
  assert.equal(res.status, 400, "scope is unverifiable against the changed graph — refuse");
  assert.equal(spy.calls.length, 0);
});

// ---------------------------------------------------------------------------
// cancelPendingScopedQueueItem — ownership-tagged removal
// ---------------------------------------------------------------------------

test("#556 r3 P0-3: cancellation removes ONLY the ownership-tagged item — an identical-scope foreign item stays", () => {
  const runTag = Symbol("t");
  const ourArray = ["14"];
  Object.defineProperty(ourArray, QUEUE_ITEM_TAG, { value: runTag, enumerable: false });
  const ourOptionsItem = { number: 1, batchCount: 1, queueNodeIds: { queueNodeIds: ourArray } };
  const ourDirectItem = { number: 1, batchCount: 1, queueNodeIds: ourArray };
  const foreignSameScope = { number: 0, batchCount: 1, queueNodeIds: ["14"] };
  const userFullRun = { number: 0, batchCount: 1, queueNodeIds: undefined };
  const app = { queueItems: [userFullRun, foreignSameScope, ourDirectItem, ourOptionsItem] };
  const res = cancelPendingScopedQueueItem(app, runTag);
  assert.equal(res.accessible, true);
  assert.equal(res.removed, 2, "our item removed in either stored shape");
  assert.deepEqual(app.queueItems, [userFullRun, foreignSameScope], "identical-scope foreign item and user run stay");
});

test("#556 r3 P0-3: hard-private queueItems builds ⇒ inaccessible (caller keeps the sentinel)", () => {
  assert.deepEqual(cancelPendingScopedQueueItem({}, Symbol("t")), { accessible: false, removed: 0 });
});

// ---------------------------------------------------------------------------
// dispatchScopedRun — the REAL orchestration graph_run runs (integration)
// ---------------------------------------------------------------------------

test("#556 integration: happy path — marked scoped dispatch observed, prompt_id captured, fetchApi restored", async () => {
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
  assert.equal(app.posted[0].number, SCOPED_QUEUE_MARK, "our posts carry the queue mark");
  assert.deepEqual(app.posted[0].partial_execution_targets, ["14"]);
});

test("#556 integration: a shim-less options build drops the legacy array — attempt 1 refused with ZERO dispatch, attempt 2 delivers", async () => {
  const apiTarget = { fetchApi: makeServer() };
  const app = makeFrontend({ shape: "shimless", apiTarget });
  const result = await dispatchScopedRun({ app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14 });
  assert.equal(result.outcome, "dispatched");
  assert.equal(app.posted.length, 2, "both shapes attempted");
  assert.equal(app.posted[0].partial_execution_targets, undefined, "attempt 1 (array) dropped by this build");
  assert.equal(apiTarget.fetchApi.calls.length, 1, "only the correctly-shaped dispatch reached the server");
  assert.deepEqual(apiTarget.fetchApi.calls[0].options.body && JSON.parse(apiTarget.fetchApi.calls[0].options.body).partial_execution_targets, ["14"]);
});

test("#556 integration: a build honoring NEITHER shape ⇒ truthful refusal, ZERO dispatches", async () => {
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
});

test("#556 r3 P0-1 integration: THE SENTINEL ACTUALLY INSTALLS — after a give-up timeout, api.fetchApi is STILL the guard and refuses the late scope-dropped post with zero dispatch", async () => {
  const apiTarget = { fetchApi: makeServer() };
  const prev = apiTarget.fetchApi;
  // Busy SHIM-LESS frontend (drops the legacy array ⇒ the deferred item has no
  // scope), and queueItems NOT accessible (hard-private build) ⇒ cancel impossible.
  const app = makeFrontend({ shape: "shimless", defer: true, apiTarget });
  delete app.queueItems;
  const result = await dispatchScopedRun({
    app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14,
    verifyTimeoutMs: 50, lingerMs: 120,
  });
  assert.equal(result.outcome, "unverified");
  assert.match(result.error, /sentinel/);
  assert.notEqual(apiTarget.fetchApi, prev, "the sentinel guard is STILL installed after the run returned");
  // The deferred item finally posts — through the sentinel — scope dropped.
  const res = await app.postDeferred(app.deferredItem);
  assert.equal(res.status, 400, "the sentinel refuses the late scope-dropped dispatch");
  assert.equal(prev.calls.length, 0, "no full-graph dispatch escapes — even after the timeout");
  // …and the sentinel self-removes at the long bound.
  await sleep(160);
  assert.equal(apiTarget.fetchApi, prev, "sentinel self-removes at the linger bound");
});

test("#556 r3 P0-3 integration: timeout CANCELS our tagged pending item (assert the removal) — guard restored, no sentinel", async () => {
  const apiTarget = { fetchApi: makeServer() };
  const prev = apiTarget.fetchApi;
  const app = makeFrontend({ shape: "shim", defer: true, apiTarget });
  // A foreign identical-scope item also pending — must survive.
  app.queueItems.push({ number: 0, batchCount: 1, queueNodeIds: ["14"] });
  const result = await dispatchScopedRun({
    app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14,
    verifyTimeoutMs: 50, lingerMs: 1000,
  });
  assert.equal(result.outcome, "unverified");
  assert.match(result.error, /REMOVED/);
  assert.equal(app.queueItems.length, 1, "ONLY our tagged item was removed");
  assert.deepEqual(app.queueItems[0].queueNodeIds, ["14"]);
  assert.equal(apiTarget.fetchApi, prev, "guard restored — no sentinel needed after a successful cancel");
  assert.equal(apiTarget.fetchApi.calls.length, 0, "nothing was ever dispatched");
});

test("#556 r3 P0-2 integration: degraded mode FAILS CLOSED — graphToPrompt failure refuses BEFORE queuePrompt (never 'dispatch and hope')", async () => {
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
});

test("#556 r3 P0-3 integration: foreign traffic during our window is untouched — same-graph user full run + identical-scope foreign scoped run; only OUR marked post is observed and captured", async () => {
  const server = makeServer();
  const apiTarget = { fetchApi: server };
  const app = makeFrontend({ shape: "shim", defer: true, apiTarget });
  const ids = [];
  const promise = dispatchScopedRun({
    app, apiTarget, execIds: ["14"], batch: 1, toNodeId: 14,
    verifyTimeoutMs: 500, lingerMs: 1000,
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
