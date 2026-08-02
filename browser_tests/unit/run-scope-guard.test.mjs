/**
 * Unit tests for web/js/lib/run-scope-guard.js — run with `node --test`.
 *
 * Guards #556: a scoped panel_run (to_node_id, "run to node") must NEVER
 * silently fall through to a FULL-graph execution — and (codex gate) must do so
 * without breaking the tab around it:
 *
 *  P0 — a busy app.queuePrompt returns early and posts the item LATER; a guard
 *       restored at queuePrompt's return never sees that deferred dispatch. The
 *       scoped guard stays installed until our dispatch is OBSERVED or a
 *       bounded timeout, and a run whose dispatch never surfaces reports a
 *       truthful "unverified — nothing confirmed queued", never queued:true.
 *
 *  P1 — while installed, the guard sees EVERY POST /prompt in the tab. It only
 *       refuses a targetless body matching THIS run's prompt signature (and
 *       only within the batch count); unrelated full runs and other scoped runs
 *       pass through untouched and are never captured as ours.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  queuePromptScopeArgs,
  promptSignature,
  promptSignatureFromBody,
  verifyScopedPromptBody,
  scopeDroppedError,
  scopeUnverifiedError,
  createRunFetchInterceptor,
  createScopedRunGuard,
  cancelPendingScopedQueueItem,
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

// A recording origFetchApi double; every call is logged so tests can prove a
// dispatch did/didn't happen.
function makeFetchSpy(responder) {
  const calls = [];
  const fetchApi = async (route, options) => {
    calls.push({ route, options });
    return responder(route, options);
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

// The graphToPrompt output OUR scoped run queued (two branches: a KSampler
// trunk, a SaveImage branch, and the PreviewAny we scope to).
const OUR_OUTPUT = {
  "3": { class_type: "KSampler", inputs: {} },
  "9": { class_type: "SaveImage", inputs: {} },
  "14": { class_type: "PreviewAny", inputs: {} },
};
const OUR_SIGNATURE = promptSignature(OUR_OUTPUT);
const OUR_FULL_BODY = { prompt: OUR_OUTPUT, client_id: "x" };
const OUR_SCOPED_BODY = { prompt: OUR_OUTPUT, client_id: "x", partial_execution_targets: ["14"] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// queuePromptScopeArgs / signatures / pure verdicts
// ---------------------------------------------------------------------------

test("#556 queuePromptScopeArgs: no scope ⇒ a single undefined arg (plain full run, historical call shape)", () => {
  assert.deepEqual(queuePromptScopeArgs(undefined), [undefined]);
  assert.deepEqual(queuePromptScopeArgs(null), [undefined]);
  assert.deepEqual(queuePromptScopeArgs([]), [undefined]);
});

test("#556 queuePromptScopeArgs: a scope ⇒ positional array FIRST, then the options object", () => {
  const [first, second] = queuePromptScopeArgs(["76:34"]);
  assert.deepEqual(first, ["76:34"]);
  assert.deepEqual(second, { queueNodeIds: ["76:34"] });
});

test("#556 promptSignature: node-id|class_type set, widget values excluded, order-insensitive", () => {
  const a = promptSignature({ "9": { class_type: "B", inputs: { seed: 1 } }, "3": { class_type: "A" } });
  const b = promptSignature({ "3": { class_type: "A" }, "9": { class_type: "B", inputs: { seed: 999 } } });
  assert.equal(a, b, "same node set with different widget values ⇒ same signature");
  assert.notEqual(promptSignature({ "3": { class_type: "A" } }), a, "different node set ⇒ different signature");
  assert.equal(promptSignature(null), null);
  assert.equal(promptSignature({}), null);
});

test("#556 promptSignatureFromBody: reads body.prompt; unparseable ⇒ null", () => {
  assert.equal(promptSignatureFromBody(JSON.stringify({ prompt: OUR_OUTPUT })), OUR_SIGNATURE);
  assert.equal(promptSignatureFromBody("not-json{"), null);
  assert.equal(promptSignatureFromBody(undefined), null);
});

test("#556 verifyScopedPromptBody: exact scope passes; missing/empty/wrong/extra/unparseable all refuse", () => {
  assert.deepEqual(verifyScopedPromptBody(JSON.stringify({ partial_execution_targets: ["10:15:359"] }), ["10:15:359"]), { ok: true });
  assert.equal(verifyScopedPromptBody(JSON.stringify({ prompt: {} }), ["14"]).reason, "scope_missing");
  assert.equal(verifyScopedPromptBody(JSON.stringify({ partial_execution_targets: [] }), ["14"]).reason, "scope_missing");
  assert.equal(verifyScopedPromptBody(JSON.stringify({ partial_execution_targets: ["9"] }), ["14"]).reason, "scope_mismatch");
  assert.equal(verifyScopedPromptBody(JSON.stringify({ partial_execution_targets: ["14", "9"] }), ["14"]).reason, "scope_mismatch");
  assert.equal(verifyScopedPromptBody("garbage{", ["14"]).ok, false);
  assert.deepEqual(verifyScopedPromptBody("garbage", null), { ok: true });
});

test("#556 scopeDroppedError: names the node and states NOTHING was queued", () => {
  const msg = scopeDroppedError({ toNodeId: 14, verdict: { ok: false, reason: "scope_missing", expected: ["14"], got: null } });
  assert.match(msg, /node 14/);
  assert.match(msg, /NOT applied/);
  assert.match(msg, /Nothing was queued/);
});

test("#556 scopeUnverifiedError: truthful — nothing CONFIRMED queued, never claims a scoped run happened", () => {
  const lingering = scopeUnverifiedError({ toNodeId: 14, timeoutMs: 5000, cancelled: false, lingerMs: 600000 });
  assert.match(lingering, /node 14/);
  assert.match(lingering, /could not be verified/);
  assert.match(lingering, /CONFIRMED queued/i);
  assert.match(lingering, /sentinel/, "says the guard stays installed when cancellation was impossible");
  assert.doesNotMatch(lingering, /Nothing was queued/, "a deferred post may still land — must not claim otherwise");
  const cancelled = scopeUnverifiedError({ toNodeId: 14, timeoutMs: 5000, cancelled: true });
  assert.match(cancelled, /REMOVED/);
  assert.match(cancelled, /nothing was queued/i, "after a successful cancel, 'nothing was queued' is literally true");
});

// ---------------------------------------------------------------------------
// createRunFetchInterceptor — the UNSCOPED path (historical #358/#370 capture)
// ---------------------------------------------------------------------------

test("#556 unscoped interceptor: captures top-level rejection and prompt_id, leaves the request untouched", async () => {
  const spy = makeFetchSpy(async () => jsonResponse(400, { error: { type: "missing_node_type" } }));
  let rejection = null;
  const intercepted = createRunFetchInterceptor({ origFetchApi: spy, onRejection: (r) => (rejection = r) });
  const [route, options] = promptPost({ prompt: {} });
  const res = await intercepted(route, options);
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].options, options);
  assert.equal(res.status, 400);
  assert.deepEqual(rejection, { error: { type: "missing_node_type" }, node_errors: null });

  const spy2 = makeFetchSpy(async () => jsonResponse(200, { prompt_id: 0 }));
  const ids = [];
  const intercepted2 = createRunFetchInterceptor({ origFetchApi: spy2, onPromptId: (p) => ids.push(p) });
  await intercepted2(...promptPost({ prompt: {} }));
  assert.deepEqual(ids, ["0"], "falsy-but-valid id 0 is captured, string-normalized");
});

test("#556 unscoped interceptor: non-/prompt routes are not inspected", async () => {
  const spy = makeFetchSpy(async () => jsonResponse(200, {}));
  const intercepted = createRunFetchInterceptor({ origFetchApi: spy, onRejection: () => assert.fail("no capture") });
  await intercepted("/history", { method: "GET" });
  assert.equal(spy.calls.length, 1);
});

// ---------------------------------------------------------------------------
// createScopedRunGuard — the SCOPED path
// ---------------------------------------------------------------------------

test("#556 guard: OUR scoped dispatch (body carries exactly our targets) is observed, dispatched verbatim, prompt_id captured", async () => {
  const spy = makeFetchSpy(async () => jsonResponse(200, { prompt_id: "p1" }));
  const ids = [];
  const guard = createScopedRunGuard({
    origFetchApi: spy, execIds: ["14"], signature: OUR_SIGNATURE, batch: 1, toNodeId: 14,
    onPromptId: (p) => ids.push(p),
  });
  const [route, options] = promptPost(OUR_SCOPED_BODY);
  const res = await guard(route, options);
  assert.equal(spy.calls.length, 1, "scoped prompt dispatched");
  assert.equal(spy.calls[0].options, options, "request passed through untouched");
  assert.equal(res.status, 200);
  assert.equal(guard.state.observed, 1);
  assert.equal(guard.state.dropped, null);
  assert.deepEqual(ids, ["p1"]);
});

test("#556 guard: a server rejection of OUR scoped dispatch is captured (#358 channel preserved)", async () => {
  const spy = makeFetchSpy(async () => jsonResponse(400, { error: { type: "prompt_outputs_failed_validation" } }));
  let rejection = null;
  const guard = createScopedRunGuard({
    origFetchApi: spy, execIds: ["14"], signature: OUR_SIGNATURE, batch: 1, toNodeId: 14,
    onRejection: (r) => (rejection = r),
  });
  await guard(...promptPost(OUR_SCOPED_BODY));
  assert.equal(spy.calls.length, 1, "a verifiably scoped prompt IS dispatched (and may be refused by the server)");
  assert.equal(rejection?.error?.type, "prompt_outputs_failed_validation");
});

test("#556 REGRESSION: OUR dispatch gone wrong (targetless body with OUR signature) is REFUSED — origFetchApi NEVER called (no full-graph dispatch)", async () => {
  const spy = makeFetchSpy(async () => jsonResponse(200, { prompt_id: "must-never-happen" }));
  let dropped = null;
  const guard = createScopedRunGuard({
    origFetchApi: spy, execIds: ["14"], signature: OUR_SIGNATURE, batch: 1, toNodeId: 14,
    onScopeDropped: (m) => (dropped = m),
  });
  const res = await guard(...promptPost(OUR_FULL_BODY));
  assert.equal(spy.calls.length, 0, "the scopeless prompt must NEVER be dispatched");
  assert.equal(res.status, 400, "refusal shaped like a server rejection");
  assert.equal(guard.state.observed, 0);
  assert.match(guard.state.dropped, /node 14/);
  assert.match(dropped, /Nothing was queued/);
});

test("#556 P1: an UNRELATED full run (different signature) during the window passes through untouched and is NOT captured", async () => {
  const spy = makeFetchSpy(async () => jsonResponse(200, { prompt_id: "user-run" }));
  let dropped = null, captured = null;
  const guard = createScopedRunGuard({
    origFetchApi: spy, execIds: ["14"], signature: OUR_SIGNATURE, batch: 1, toNodeId: 14,
    onScopeDropped: (m) => (dropped = m),
    onPromptId: (p) => (captured = p),
  });
  const otherGraph = { prompt: { "1": { class_type: "LoadImage" }, "2": { class_type: "SaveImage" } }, client_id: "x" };
  const [route, options] = promptPost(otherGraph);
  const res = await guard(route, options);
  assert.equal(spy.calls.length, 1, "the user's run is dispatched");
  assert.equal(spy.calls[0].options, options);
  assert.equal(res.status, 200);
  assert.equal(dropped, null, "no refusal");
  assert.equal(captured, null, "not captured as ours");
  assert.equal(guard.state.observed, 0);
  assert.equal(guard.state.dropped, null);
});

test("#556 P1: an unrelated SCOPED run (foreign signature, its own targets) passes through untouched", async () => {
  const spy = makeFetchSpy(async () => jsonResponse(200, { prompt_id: "other-scoped" }));
  let captured = null;
  const guard = createScopedRunGuard({
    origFetchApi: spy, execIds: ["14"], signature: OUR_SIGNATURE, batch: 1, toNodeId: 14,
    onPromptId: (p) => (captured = p),
  });
  const body = { prompt: { "1": { class_type: "LoadImage" }, "2": { class_type: "PreviewImage" } }, client_id: "x", partial_execution_targets: ["2"] };
  const res = await guard(...promptPost(body));
  assert.equal(spy.calls.length, 1);
  assert.equal(res.status, 200);
  assert.equal(captured, null, "another scope's prompt_id is never claimed as ours");
  assert.equal(guard.state.observed, 0);
});

test("#556 r2 P0-1: OUR signature with WRONG/EXTRA/PARTIAL targets is OUR corrupted dispatch — REFUSED with zero dispatch (not forwarded as 'someone else's')", async () => {
  for (const badTargets of [["14", "9"], ["9"], ["14", "76:34"]]) {
    const spy = makeFetchSpy(async () => jsonResponse(200, { prompt_id: "must-never-happen" }));
    let dropped = null;
    const guard = createScopedRunGuard({
      origFetchApi: spy, execIds: ["14"], signature: OUR_SIGNATURE, batch: 1, toNodeId: 14,
      onScopeDropped: (m) => (dropped = m),
    });
    const body = { prompt: OUR_OUTPUT, client_id: "x", partial_execution_targets: badTargets };
    const res = await guard(...promptPost(body));
    assert.equal(spy.calls.length, 0, `targets ${JSON.stringify(badTargets)} must never leave the tab`);
    assert.equal(res.status, 400);
    assert.match(dropped, /node 14/);
    assert.match(dropped, /instead of/, "scope_mismatch names what the body carried");
    assert.equal(guard.state.observed, 0, "a corrupted dispatch never counts as observed");
  }
});

test("#556 r2 P0-2: a FOREIGN post carrying the SAME targets does NOT satisfy observation — our deferred corrupted post is still refused afterwards", async () => {
  const spy = makeFetchSpy(async () => jsonResponse(200, { prompt_id: "foreign-pid" }));
  let captured = null;
  const guard = createScopedRunGuard({
    origFetchApi: spy, execIds: ["14"], signature: OUR_SIGNATURE, batch: 1, toNodeId: 14,
    onPromptId: (p) => (captured = p),
  });
  // Another workflow whose prompt ALSO carries ["14"] but has a different node set.
  const foreign = { prompt: { "14": { class_type: "SaveImage" }, "2": { class_type: "LoadImage" } }, client_id: "x", partial_execution_targets: ["14"] };
  const foreignRes = await guard(...promptPost(foreign));
  assert.equal(spy.calls.length, 1, "the foreign scoped run passes through");
  assert.equal(foreignRes.status, 200);
  assert.equal(guard.state.observed, 0, "same targets + different signature is NOT our dispatch");
  assert.equal(captured, null, "its prompt_id is never claimed as ours");
  // graph_run would still be waiting (observed==0) — and when OUR deferred
  // corrupted post finally surfaces, the guard is still there to refuse it.
  assert.equal(guard.state.dropped, null);
  const spy2 = spy;
  const res = await guard(...promptPost(OUR_FULL_BODY));
  assert.equal(res.status, 400, "our scope-dropped dispatch is still refused");
  assert.equal(spy2.calls.length, 1, "and never dispatches");
});

test("#556 P1: refusal is bounded by the batch — a same-signature full body BEYOND our batch count passes through", async () => {
  const spy = makeFetchSpy(async () => jsonResponse(200, { prompt_id: "late-run" }));
  const guard = createScopedRunGuard({
    origFetchApi: spy, execIds: ["14"], signature: OUR_SIGNATURE, batch: 1, toNodeId: 14,
  });
  const first = await guard(...promptPost(OUR_FULL_BODY));
  assert.equal(first.status, 400, "our own dropped dispatch is refused");
  assert.equal(spy.calls.length, 0);
  const second = await guard(...promptPost(OUR_FULL_BODY));
  assert.equal(second.status, 200, "a further same-signature full run is NOT ours to refuse");
  assert.equal(spy.calls.length, 1, "it passes through");
});

test("#556 guard: an unparseable body is unattributable ⇒ passed through, never blocked (fail-safe toward strangers)", async () => {
  const spy = makeFetchSpy(async () => jsonResponse(200, {}));
  const guard = createScopedRunGuard({ origFetchApi: spy, execIds: ["14"], signature: OUR_SIGNATURE, batch: 1, toNodeId: 14 });
  await guard("/prompt", { method: "POST", body: "not-json{" });
  assert.equal(spy.calls.length, 1);
  assert.equal(guard.state.dropped, null);
});

test("#556 P0 DEFERRED RACE: queuePrompt returned early (busy) — the guard is STILL installed and refuses the deferred invalid-shape dispatch, zero real posts", async () => {
  const spy = makeFetchSpy(async () => jsonResponse(200, { prompt_id: "must-never-happen" }));
  let dropped = null;
  const guard = createScopedRunGuard({
    origFetchApi: spy, execIds: ["14"], signature: OUR_SIGNATURE, batch: 1, toNodeId: 14,
    onScopeDropped: (m) => (dropped = m),
  });
  // graph_run awaits queuePrompt (which returned early), then waits on the guard.
  const verdict = guard.waitForVerdict(1000);
  // …the in-flight processor serializes and posts OUR item 30ms later, through
  // the still-installed guard, with the scope dropped (invalid shape).
  await sleep(30);
  const res = await guard(...promptPost(OUR_FULL_BODY));
  assert.equal(await verdict, true, "the deferred dispatch is OBSERVED by the still-installed guard");
  assert.equal(res.status, 400);
  assert.equal(spy.calls.length, 0, "the deferred full-graph prompt never left the tab");
  assert.match(dropped, /node 14/);
});

test("#556 P0 DEFERRED, correct shape: the late scoped post IS observed and its prompt_id captured", async () => {
  const spy = makeFetchSpy(async () => jsonResponse(200, { prompt_id: "deferred-pid" }));
  const ids = [];
  const guard = createScopedRunGuard({
    origFetchApi: spy, execIds: ["14"], signature: OUR_SIGNATURE, batch: 1, toNodeId: 14,
    onPromptId: (p) => ids.push(p),
  });
  const verdict = guard.waitForVerdict(1000);
  await sleep(30);
  await guard(...promptPost(OUR_SCOPED_BODY));
  assert.equal(await verdict, true);
  assert.equal(guard.state.observed, 1);
  assert.deepEqual(ids, ["deferred-pid"]);
});

test("#556 P0 TIMEOUT: nothing surfaces within the window ⇒ waitForVerdict false, state clean ⇒ graph_run reports UNVERIFIED (never queued:true)", async () => {
  const spy = makeFetchSpy(async () => jsonResponse(200, { prompt_id: "nope" }));
  const guard = createScopedRunGuard({ origFetchApi: spy, execIds: ["14"], signature: OUR_SIGNATURE, batch: 1, toNodeId: 14 });
  const seen = await guard.waitForVerdict(50);
  assert.equal(seen, false);
  assert.equal(guard.state.observed, 0);
  assert.equal(guard.state.dropped, null);
  assert.equal(spy.calls.length, 0);
});

test("#556 r2 P0-3: timeout CANCELS our still-pending queue item — the deferred scope-dropped dispatch can never execute", () => {
  // The frontend's pending list holds OUR deferred item (targets stored in
  // either shape) plus a user's targetless full-run item and a foreign scoped
  // item — only ours may be removed.
  const ourItemArray = { number: 0, batchCount: 1, queueNodeIds: ["14"] };
  const ourItemOptions = { number: 0, batchCount: 1, queueNodeIds: { queueNodeIds: ["14"] } };
  const userFullRun = { number: 0, batchCount: 1, queueNodeIds: undefined };
  const foreignScoped = { number: 0, batchCount: 1, queueNodeIds: ["9"] };
  const app = { queueItems: [userFullRun, ourItemArray, foreignScoped, ourItemOptions] };
  const res = cancelPendingScopedQueueItem(app, ["14"]);
  assert.equal(res.accessible, true);
  assert.equal(res.removed, 2, "both of our pending items are removed, in either stored shape");
  assert.deepEqual(app.queueItems, [userFullRun, foreignScoped], "foreign items are never touched");
});

test("#556 r2 P0-3: cancellation is impossible on builds that hard-privatize queueItems ⇒ reported inaccessible (caller keeps the sentinel guard)", () => {
  const res = cancelPendingScopedQueueItem({}, ["14"]);
  assert.deepEqual(res, { accessible: false, removed: 0 });
  assert.deepEqual(cancelPendingScopedQueueItem(null, ["14"]), { accessible: false, removed: 0 });
});

test("#556 r2 P0-3 SENTINEL: when cancellation failed, the guard (never restored) still refuses the late scope-dropped dispatch — zero dispatch post-timeout", async () => {
  const spy = makeFetchSpy(async () => jsonResponse(200, { prompt_id: "must-never-happen" }));
  let dropped = null;
  const guard = createScopedRunGuard({
    origFetchApi: spy, execIds: ["14"], signature: OUR_SIGNATURE, batch: 1, toNodeId: 14,
    onScopeDropped: (m) => (dropped = m),
  });
  // The give-up path: timeout expired, cancelPendingScopedQueueItem removed
  // nothing, so graph_run leaves THIS guard installed and returns unverified.
  const seen = await guard.waitForVerdict(50);
  assert.equal(seen, false, "timed out unverified");
  // …the deferred item finally posts, well after the run returned.
  await sleep(20);
  const res = await guard(...promptPost(OUR_FULL_BODY));
  assert.equal(res.status, 400, "the sentinel still refuses the scope-dropped dispatch");
  assert.equal(spy.calls.length, 0, "no full-graph dispatch ever escapes — even after the timeout");
  assert.match(dropped, /node 14/);
});

// ---------------------------------------------------------------------------
// End-to-end across frontend build shapes, driving the guard the way
// graph_run's loop does (try shape, observe, retry on dropped, else unverified).
// ---------------------------------------------------------------------------

// A fake app.queuePrompt for a build that ONLY honors the QueuePromptOptions
// object — the legacy positional array is silently ignored (#556's build).
function makeOptionsOnlyQueuePrompt(fetchApi, posted) {
  return async (number, batch, arg) => {
    const queueNodeIds = Array.isArray(arg) ? undefined : arg?.queueNodeIds;
    const body = { prompt: OUR_OUTPUT, client_id: "x" };
    if (queueNodeIds) body.partial_execution_targets = queueNodeIds;
    await fetchApi("/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    posted.push(body);
  };
}

test("#556 e2e: an options-only frontend (drops the legacy array) still runs SCOPED — the blocked attempt never dispatched, the retry delivers", async () => {
  const posted = [];
  const dispatched = [];
  const origFetchApi = makeFetchSpy(async () => {
    dispatched.push(true);
    return jsonResponse(200, { prompt_id: "p1" });
  });
  let outcome = null;
  for (const scopeArg of queuePromptScopeArgs(["14"])) {
    const guard = createScopedRunGuard({
      origFetchApi, execIds: ["14"], signature: OUR_SIGNATURE, batch: 1, toNodeId: 14,
    });
    const queuePrompt = makeOptionsOnlyQueuePrompt(guard, posted);
    await queuePrompt(0, 1, scopeArg);
    if (guard.state.observed > 0) { outcome = "scoped"; break; }
    if (guard.state.dropped) { outcome = "dropped"; continue; }
    outcome = "unverified";
    break;
  }
  assert.equal(outcome, "scoped", "the retry shape delivered the scope");
  assert.equal(dispatched.length, 1, "exactly ONE prompt actually dispatched (no double-queue)");
  assert.equal(posted.length, 2, "both shapes were attempted");
  assert.equal(posted[0].partial_execution_targets, undefined, "attempt 1 (array) dropped by this build");
  assert.deepEqual(posted[1].partial_execution_targets, ["14"], "attempt 2 (options object) delivered the scope");
});

test("#556 e2e: a build that honors NEITHER shape ⇒ truthful refusal, ZERO dispatches", async () => {
  const dispatched = [];
  const origFetchApi = makeFetchSpy(async () => {
    dispatched.push(true);
    return jsonResponse(200, { prompt_id: "p1" });
  });
  let dropped = null;
  for (const scopeArg of queuePromptScopeArgs(["14"])) {
    const guard = createScopedRunGuard({
      origFetchApi, execIds: ["14"], signature: OUR_SIGNATURE, batch: 1, toNodeId: 14,
      onScopeDropped: (m) => (dropped = m),
    });
    // This build posts OUR prompt with NO targets regardless of the arg shape.
    await guard("/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(OUR_FULL_BODY),
    });
    if (guard.state.observed > 0) break;
    if (!guard.state.dropped) break;
  }
  assert.match(dropped, /node 14/);
  assert.match(dropped, /Nothing was queued/);
  assert.equal(dispatched.length, 0, "no full-graph prompt ever left the tab");
});

test("#556 e2e: a signature-less run still verifies a post that CARRIES the scope (degraded attribution never blocks, never lies)", async () => {
  const spy = makeFetchSpy(async () => jsonResponse(200, { prompt_id: "p1" }));
  const guard = createScopedRunGuard({ origFetchApi: spy, execIds: ["14"], signature: null, batch: 1, toNodeId: 14 });
  // Our scoped post is still observed without a signature…
  await guard(...promptPost(OUR_SCOPED_BODY));
  assert.equal(guard.state.observed, 1);
  assert.equal(spy.calls.length, 1);
  // …and a targetless body CANNOT be attributed ⇒ passed through, not blocked.
  await guard(...promptPost(OUR_FULL_BODY));
  assert.equal(spy.calls.length, 2);
  assert.equal(guard.state.dropped, null);
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
  const res = resolveRunToNodeTarget(liveRoot, null, 14);
  assert.deepEqual(res, { ok: false, code: "not_found", node: null });
});

test("#556: a NON-output target is refused (not_output) — it can never be an execution root", () => {
  const ksampler = { id: 3, type: "KSampler", constructor: { nodeData: { output_node: false } } };
  const root = { _nodes: [ksampler], getNodeById(id) { return this._nodes.find((n) => Number(n.id) === Number(id)) ?? null; } };
  const res = resolveRunToNodeTarget(root, null, 3);
  assert.equal(res.ok, false);
  assert.equal(res.code, "not_output");
});
