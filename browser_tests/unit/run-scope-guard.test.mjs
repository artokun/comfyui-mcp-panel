/**
 * Unit tests for web/js/lib/run-scope-guard.js — run with `node --test`.
 *
 * Guards #556: a scoped panel_run (to_node_id, "run to node") must NEVER
 * silently fall through to a FULL-graph execution. The queuePrompt 3rd-argument
 * shape differs across frontend builds (positional NodeExecutionId[] vs
 * QueuePromptOptions { queueNodeIds }); a build that accepts only one shape
 * silently IGNORES the other, so the scope never reaches POST /prompt and the
 * full graph queues while panel_run reports ran_to_node. The guard inspects the
 * outgoing /prompt body and REFUSES a scopeless dispatch before it leaves —
 * these tests pin that refusal (no full-graph dispatch) and that a verifiably
 * scoped run still runs scoped on both frontend build shapes.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  queuePromptScopeArgs,
  verifyScopedPromptBody,
  scopeDroppedError,
  createRunFetchInterceptor,
} from "../../web/js/lib/run-scope-guard.js";
import { resolveRunToNodeTarget } from "../../web/js/lib/subgraph-scope.js";

// A Response double with the surface the interceptor + frontend rejection path
// use (status, clone().json(), text()).
function jsonResponse(status, obj) {
  return {
    status,
    clone() {
      return { json: async () => JSON.parse(JSON.stringify(obj)) };
    },
    text: async () => JSON.stringify(obj),
  };
}

// A recording origFetchApi double. `responder(route, options)` produces the
// response; every call is logged so tests can prove a dispatch did/didn't happen.
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

// ---------------------------------------------------------------------------
// queuePromptScopeArgs — the shapes graph_run tries, in order.
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

// ---------------------------------------------------------------------------
// verifyScopedPromptBody — the pure verdict.
// ---------------------------------------------------------------------------

test("#556 verify: body carrying EXACTLY the requested scope passes (incl. colon-path exec ids)", () => {
  assert.deepEqual(verifyScopedPromptBody(JSON.stringify({ partial_execution_targets: ["14"] }), ["14"]), {
    ok: true,
  });
  assert.deepEqual(
    verifyScopedPromptBody(JSON.stringify({ partial_execution_targets: ["10:15:359"] }), ["10:15:359"]),
    { ok: true },
  );
});

test("#556 verify: NO partial_execution_targets in the body ⇒ scope_missing refusal", () => {
  const v = verifyScopedPromptBody(JSON.stringify({ prompt: {}, client_id: "x" }), ["14"]);
  assert.equal(v.ok, false);
  assert.equal(v.reason, "scope_missing");
  assert.deepEqual(v.expected, ["14"]);
});

test("#556 verify: an EMPTY targets list is a dropped scope, not a scoped run", () => {
  const v = verifyScopedPromptBody(JSON.stringify({ partial_execution_targets: [] }), ["14"]);
  assert.equal(v.ok, false);
  assert.equal(v.reason, "scope_missing");
});

test("#556 verify: WRONG or EXTRA targets ⇒ scope_mismatch refusal", () => {
  const wrong = verifyScopedPromptBody(JSON.stringify({ partial_execution_targets: ["9"] }), ["14"]);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, "scope_mismatch");
  assert.deepEqual(wrong.got, ["9"]);
  const extra = verifyScopedPromptBody(JSON.stringify({ partial_execution_targets: ["14", "9"] }), ["14"]);
  assert.equal(extra.ok, false);
  assert.equal(extra.reason, "scope_mismatch");
});

test("#556 verify: an unparseable body is UNVERIFIABLE ⇒ refuse (never fail open)", () => {
  const v = verifyScopedPromptBody("not-json{", ["14"]);
  assert.equal(v.ok, false);
  assert.equal(v.reason, "scope_missing");
  const u = verifyScopedPromptBody(undefined, ["14"]);
  assert.equal(u.ok, false);
});

test("#556 verify: numeric targets normalize to strings; no scope requested ⇒ always ok", () => {
  assert.deepEqual(verifyScopedPromptBody(JSON.stringify({ partial_execution_targets: [14] }), ["14"]), {
    ok: true,
  });
  assert.deepEqual(verifyScopedPromptBody("garbage", null), { ok: true });
  assert.deepEqual(verifyScopedPromptBody("garbage", []), { ok: true });
});

test("#556 scopeDroppedError: names the node and states NOTHING was queued", () => {
  const msg = scopeDroppedError({
    toNodeId: 14,
    verdict: { ok: false, reason: "scope_missing", expected: ["14"], got: null },
  });
  assert.match(msg, /node 14/);
  assert.match(msg, /NOT applied/);
  assert.match(msg, /Nothing was queued/);
  assert.match(msg, /full-graph/);
});

// ---------------------------------------------------------------------------
// createRunFetchInterceptor — the guard graph_run installs.
// ---------------------------------------------------------------------------

test("#556 REGRESSION: a scoped run whose scope the frontend dropped is REFUSED — origFetchApi is NEVER called (no full-graph dispatch)", async () => {
  // Simulates the #556 frontend: queuePrompt accepted the call but the POST
  // /prompt body carries NO partial_execution_targets.
  const spy = makeFetchSpy(async () => jsonResponse(200, { prompt_id: "should-never-happen" }));
  let dropped = null;
  const intercepted = createRunFetchInterceptor({
    origFetchApi: spy,
    partialTargets: ["14"],
    toNodeId: 14,
    onScopeDropped: (m) => (dropped = m),
  });
  const [route, options] = promptPost({ prompt: {}, client_id: "x" });
  const res = await intercepted(route, options);
  assert.equal(spy.calls.length, 0, "the scopeless prompt must NEVER be dispatched");
  assert.equal(res.status, 400, "the refusal is shaped like a server rejection");
  assert.match(dropped, /node 14/);
  assert.match(dropped, /Nothing was queued/);
});

test("#556: a scoped run whose body carries the scope is DISPATCHED verbatim and the prompt_id captured", async () => {
  const spy = makeFetchSpy(async () => jsonResponse(200, { prompt_id: 123 }));
  const ids = [];
  const intercepted = createRunFetchInterceptor({
    origFetchApi: spy,
    partialTargets: ["76:34"],
    toNodeId: 34,
    onPromptId: (pid) => ids.push(pid),
  });
  const [route, options] = promptPost({ prompt: {}, partial_execution_targets: ["76:34"] });
  const res = await intercepted(route, options);
  assert.equal(spy.calls.length, 1, "scoped prompt dispatched");
  assert.equal(spy.calls[0].options, options, "request passed through untouched");
  assert.equal(res.status, 200);
  assert.deepEqual(ids, ["123"], "prompt_id normalized to a string at capture");
});

test("#556: response capture preserved — a top-level server rejection (non-200) is reported (#358 channel)", async () => {
  const rejectionBody = { error: { type: "missing_node_type", message: "no class_type" } };
  const spy = makeFetchSpy(async () => jsonResponse(400, rejectionBody));
  let rejection = null;
  const intercepted = createRunFetchInterceptor({
    origFetchApi: spy,
    partialTargets: ["14"],
    toNodeId: 14,
    onRejection: (r) => (rejection = r),
  });
  const [route, options] = promptPost({ prompt: {}, partial_execution_targets: ["14"] });
  await intercepted(route, options);
  assert.equal(spy.calls.length, 1, "a verifiably scoped prompt IS dispatched (and may be refused by the server)");
  assert.deepEqual(rejection, { error: rejectionBody.error, node_errors: null });
});

test("#556: non-/prompt routes and non-POST methods pass through UNINSPECTED even when scoped", async () => {
  const spy = makeFetchSpy(async () => jsonResponse(200, {}));
  let dropped = null;
  const intercepted = createRunFetchInterceptor({
    origFetchApi: spy,
    partialTargets: ["14"],
    toNodeId: 14,
    onScopeDropped: () => (dropped = true),
  });
  await intercepted("/history", { method: "GET" });
  await intercepted("/prompt", { method: "GET" });
  await intercepted("/upload/image", { method: "POST", body: "..." });
  assert.equal(spy.calls.length, 3);
  assert.equal(dropped, null);
});

test("#556: an UNSCOPED run (partialTargets null) is never scope-checked — the normal full-run path is preserved", async () => {
  const spy = makeFetchSpy(async () => jsonResponse(200, { prompt_id: "p1" }));
  let dropped = null;
  const intercepted = createRunFetchInterceptor({
    origFetchApi: spy,
    partialTargets: null,
    onScopeDropped: () => (dropped = true),
  });
  const [route, options] = promptPost({ prompt: {}, client_id: "x" });
  const res = await intercepted(route, options);
  assert.equal(spy.calls.length, 1, "full run dispatched");
  assert.equal(res.status, 200);
  assert.equal(dropped, null);
});

// ---------------------------------------------------------------------------
// End-to-end across the two frontend build shapes, driving the interceptor the
// way graph_run's retry loop does (array first, then { queueNodeIds }).
// ---------------------------------------------------------------------------

// A fake app.queuePrompt for a build that ONLY honors the QueuePromptOptions
// object — the legacy positional array is silently ignored (#556's build).
function makeOptionsOnlyQueuePrompt(fetchApi, posted) {
  return async (number, batch, arg) => {
    const queueNodeIds = Array.isArray(arg) ? undefined : arg?.queueNodeIds;
    const body = { prompt: {}, client_id: "x" };
    if (queueNodeIds) body.partial_execution_targets = queueNodeIds;
    await fetchApi("/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    posted.push(body);
  };
}

// A fake app.queuePrompt for a build that ONLY honors the positional array.
function makePositionalOnlyQueuePrompt(fetchApi, posted) {
  return async (number, batch, arg) => {
    const queueNodeIds = Array.isArray(arg) ? arg : undefined;
    const body = { prompt: {}, client_id: "x" };
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
  let scopeDropped = null;
  for (const scopeArg of queuePromptScopeArgs(["14"])) {
    scopeDropped = null;
    const intercepted = createRunFetchInterceptor({
      origFetchApi,
      partialTargets: ["14"],
      toNodeId: 14,
      onScopeDropped: (m) => (scopeDropped = m),
    });
    const queuePrompt = makeOptionsOnlyQueuePrompt(intercepted, posted);
    await queuePrompt(0, 1, scopeArg);
    if (!scopeDropped) break;
  }
  assert.equal(scopeDropped, null, "the retry shape delivered the scope");
  assert.equal(dispatched.length, 1, "exactly ONE prompt actually dispatched (no double-queue)");
  assert.equal(posted.length, 2, "both shapes were attempted");
  assert.deepEqual(posted[0].partial_execution_targets, undefined, "attempt 1 (array) dropped by this build");
  assert.deepEqual(posted[1].partial_execution_targets, ["14"], "attempt 2 (options object) delivered the scope");
});

test("#556 e2e: a positional-only frontend runs SCOPED on the FIRST shape (no retry needed)", async () => {
  const posted = [];
  const dispatched = [];
  const origFetchApi = makeFetchSpy(async () => {
    dispatched.push(true);
    return jsonResponse(200, { prompt_id: "p1" });
  });
  let scopeDropped = null;
  let attempts = 0;
  for (const scopeArg of queuePromptScopeArgs(["14"])) {
    attempts++;
    scopeDropped = null;
    const intercepted = createRunFetchInterceptor({
      origFetchApi,
      partialTargets: ["14"],
      toNodeId: 14,
      onScopeDropped: (m) => (scopeDropped = m),
    });
    const queuePrompt = makePositionalOnlyQueuePrompt(intercepted, posted);
    await queuePrompt(0, 1, scopeArg);
    if (!scopeDropped) break;
  }
  assert.equal(scopeDropped, null);
  assert.equal(attempts, 1, "array first ⇒ no retry on positional builds");
  assert.equal(dispatched.length, 1);
  assert.deepEqual(posted[0].partial_execution_targets, ["14"]);
});

test("#556 e2e: a build that honors NEITHER shape ⇒ truthful refusal, ZERO dispatches", async () => {
  const dispatched = [];
  const origFetchApi = makeFetchSpy(async () => {
    dispatched.push(true);
    return jsonResponse(200, { prompt_id: "p1" });
  });
  let scopeDropped = null;
  for (const scopeArg of queuePromptScopeArgs(["14"])) {
    scopeDropped = null;
    const intercepted = createRunFetchInterceptor({
      origFetchApi,
      partialTargets: ["14"],
      toNodeId: 14,
      onScopeDropped: (m) => (scopeDropped = m),
    });
    // This build posts a body with NO targets regardless of the arg shape.
    await intercepted("/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: {}, client_id: "x" }),
    });
    if (!scopeDropped) break;
  }
  assert.match(scopeDropped, /node 14/);
  assert.match(scopeDropped, /Nothing was queued/);
  assert.equal(dispatched.length, 0, "no full-graph prompt ever left the tab");
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
  // The id was valid against the graph the agent last saw…
  const staleRoot = { _nodes: [outputNode(14)], getNodeById(id) { return this._nodes.find((n) => Number(n.id) === Number(id)) ?? null; } };
  assert.equal(resolveRunToNodeTarget(staleRoot, null, 14).ok, true);
  // …but the live root no longer has it (node deleted / workflow reloaded).
  const liveRoot = { _nodes: [outputNode(15)], getNodeById(id) { return this._nodes.find((n) => Number(n.id) === Number(id)) ?? null; } };
  const res = resolveRunToNodeTarget(liveRoot, null, 14);
  assert.deepEqual(res, { ok: false, code: "not_found", node: null });
  // graph_run maps this verdict to { queued:false, error: "node 14 was not found…" }
  // and returns BEFORE queuePrompt — no full-graph dispatch is possible.
});

test("#556: a NON-output target is refused (not_output) — it can never be an execution root", () => {
  const ksampler = { id: 3, type: "KSampler", constructor: { nodeData: { output_node: false } } };
  const root = { _nodes: [ksampler], getNodeById(id) { return this._nodes.find((n) => Number(n.id) === Number(id)) ?? null; } };
  const res = resolveRunToNodeTarget(root, null, 3);
  assert.equal(res.ok, false);
  assert.equal(res.code, "not_output");
});
