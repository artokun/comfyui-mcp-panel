// panel#1565 — `panel_run` timed out on `graph_run` (20,000 ms) twice in a row, including
// an explicit `retry_of` retry, while `panel_query_graph` reads to the SAME tab answered
// sub-second throughout. That asymmetry rules out a dead socket, a lost `hello` and a
// wedged bridge: something makes the RUN path specifically block while the read path is
// fine.
//
// WHAT THE RUN PATH AWAITS THAT THE READ PATH DOES NOT — measured on the shipped module,
// not read off the source:
//
//   1. `app.graphToPrompt()` — serializing the whole workflow, every extension's own
//      serializeValue included. No bound of any kind.
//   2. `app.queuePrompt()` — the frontend's queue processor. No bound of any kind, and on
//      the reporter's machine BOTH `app.queuePrompt` and `api.queuePrompt` are shadowed by
//      an extension's own property. A wrapper that never settles held `graph_run` open
//      FOREVER while a read of the same objects answered in 0.06 ms.
//   3. the scoped-dispatch observation wait — ONCE PER ARGUMENT SHAPE, each starting a
//      fresh `verifyTimeoutMs`. Four shapes × 5,000 ms is 20,000 ms: EXACTLY the window
//      `panel_run` relays this command in, with nothing left for the reply itself.
//
// `panel_query_graph` takes none of them — it reads live LiteGraph objects.
//
// MEASURED BEFORE THE FIX, driving the shipped `dispatchScopedRun` with a busy queue
// processor draining at 4,990 ms per item (the reporter had user Queue presses interleaved
// with agent runs): dispatchScopedRun took **20,003 ms**, and the prompt POSTED at
// 20,003 ms — i.e. the run genuinely queued AFTER the caller had already been told the tab
// "may be backgrounded or frozen". A retry of that "failed" run renders the branch twice,
// which is a worse bug than the one reported.
//
// The fix is ONE deadline for the whole command, taken on `graph_run`'s first line and
// threaded into the dispatch, so those bounds COMPOSE instead of summing — the same shape
// #1192 (`graph_add_node`) and #671 (`nodes_install`) already needed. These tests drive the
// REAL `dispatchScopedRun` and the SHIPPED `graph_run` body; a helper-level test cannot
// reach this defect, because every individual bound here is defensible on its own and the
// bug lives entirely in whether the call site threads one budget through them.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { dispatchScopedRun, createRunFetchInterceptor } from "../../web/js/lib/run-scope-guard.js";
import { makeCommandBudget } from "../../web/js/lib/command-budget.js";
import { withTimeout } from "../../web/js/lib/bounded-step.js";
import {
  graphToPromptUnusable,
  unrunnableNodeIdsInScope,
  unserializableGraphRefusal,
  unresolvedNodeTypes,
  missingNodeRunRefusal,
  describeUnrunnable,
} from "../../web/js/lib/missing-node-preflight.js";
import { buildQueueAcceptResult, summarizePromptRejection } from "../../web/js/lib/queue-rejection.js";
import { installGraphToPromptNullSafety } from "../../web/js/lib/widget-null-safety.js";
import {
  installGraphToPromptSnapshotBarrier,
  queuePromptWithGraphToPromptSnapshot,
  reserveGraphToPromptSnapshot,
  releaseGraphToPromptSnapshot,
} from "../../web/js/lib/run-prompt-snapshot.js";
import { collectAllGraphs } from "../../web/js/lib/asset-staleness.js";
import {
  findRepeatingControlWidgets,
  findRgthreeSeedNodes,
  repeatingRgthreeSeeds,
  scopedBatchSeedNote,
  driveControlHooksAcrossScopedBatch,
  scopedBatchDriveNote,
  rgthreeFixedSeedNote,
} from "../../web/js/lib/scoped-batch-seed.js";
import { collectVirtualSourceFeeds, virtualSourceNote } from "../../web/js/lib/virtual-source-promotion.js";
import { collectDisabledAncestorOutputs, disabledOutputsNote } from "../../web/js/lib/muted-subgraph-outputs.js";
import { prunedRetryNote } from "../../web/js/lib/partial-run-prune.js";
import {
  describeQueuePromptChain,
  describeQueuePromptChainForReport,
  queuePromptChainDeps,
} from "../../web/js/lib/queue-prompt-chain.js";
import { MUTATION_BINDING_BAR } from "../../web/js/lib/graph-binding.js";
import { createRunCompletionTracker } from "../../web/js/lib/run-completion.js";
import { composeRunCompletionFrame } from "../../web/js/lib/run-completion-frame.js";
import { createRunReconcileSweep } from "../../web/js/lib/run-reconcile-sweep.js";
import { createRunReceiptOutbox } from "../../web/js/lib/run-receipt-outbox.js";
import { createRehelloGate, routeIsStale } from "../../web/js/lib/rehello-gate.js";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8").replace(/\r\n/g, "\n");

function extractFunctionSource(source, marker, endMarker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `could not locate ${marker}`);
  if (endMarker) {
    const end = source.indexOf(endMarker, start);
    assert.notEqual(end, -1, `could not locate the end of ${marker}`);
    return source.slice(start, end + 2);
  }
  const open = source.indexOf("{", start);
  assert.notEqual(open, -1, `could not locate the body of ${marker}`);
  let depth = 1;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = open + 1; i < source.length; i++) {
    const c = source[i];
    const n = source[i + 1];
    if (lineComment) {
      if (c === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (c === "*" && n === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (c === "\\") {
        i++;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === "/" && n === "/") {
      lineComment = true;
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      blockComment = true;
      i++;
      continue;
    }
    if (c === "\"" || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`could not close ${marker}`);
}

const createBridgeClientSource = extractFunctionSource(
  panelSrc,
  "function createBridgeClient(",
  "\n}\n\n// ---------------------------------------------------------------------------\n// Panel DOM",
);

class RuntimeBridgeSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    RuntimeBridgeSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  send(raw) {
    if (this.readyState !== RuntimeBridgeSocket.OPEN) throw new Error("socket is not open");
    this.sent.push(JSON.parse(raw));
  }

  open() {
    this.readyState = RuntimeBridgeSocket.OPEN;
    this.onopen?.();
    this.listeners.get("open")?.();
  }

  receive(frame) {
    const event = { data: JSON.stringify(frame) };
    this.onmessage?.(event);
    this.listeners.get("message")?.(event);
  }

  close() {
    if (this.readyState === RuntimeBridgeSocket.CLOSED) return;
    this.readyState = RuntimeBridgeSocket.CLOSED;
    this.onclose?.();
    this.listeners.get("close")?.();
  }
}

function buildRuntimeBridgeClient({ routeRef, failNextSend = false } = {}) {
  RuntimeBridgeSocket.instances = [];
  const storage = new Map();
  const bridgeState = { failNextSend };
  const helloState = { block: false, release: null };
  const noop = () => {};
  const env = new Proxy(
    {
      WebSocket: RuntimeBridgeSocket,
      DEFAULT_BRIDGE_URL: "ws://bridge.test",
      STORAGE_KEY_BACKEND: "backend",
      window: {
        localStorage: {
          getItem: (key) => storage.get(key) ?? null,
          setItem: (key, value) => storage.set(key, String(value)),
          removeItem: (key) => storage.delete(key),
        },
        location: { protocol: "http:", href: "http://panel.test/" },
      },
      location: { protocol: "http:", href: "http://panel.test/" },
      document: { addEventListener: noop, removeEventListener: noop, querySelector: () => null },
      loadBridgeUrl: () => "ws://bridge.test",
      saveBridgeUrl: noop,
      bridgeRouteId: () => routeRef.current,
      tabRouteIdentity: { adopt: noop, settled: () => true },
      describeRefusedRoute: () => "route unavailable",
      routeIsStale,
      createRehelloGate,
      monotonicNow: () => performance.now(),
      buildHelloPayload: () => ({ type: "hello", tab_id: routeRef.current, workflow_uuid: "wf-1728" }),
      sendBridgeHello: async ({ socket, isCurrent, makePayload }) => {
        if (!isCurrent()) return false;
        if (helloState.block) await new Promise((resolve) => (helloState.release = resolve));
        socket.send(JSON.stringify(makePayload()));
        return true;
      },
      createRestartTabIdentity: () => ({ resolve: async () => "tab-1728" }),
      bridgeOutage: { noteHandshake: noop, noteBridgeClosed: noop },
      lostReplies: { list: () => [], size: () => 0, summaries: () => [], replace: noop },
      pruneAttempts: (items) => items,
      shouldReRegister: () => false,
      reRegisterExhaustedHint: () => "re-register exhausted",
      describeUndeliveredReply: () => "undelivered",
      lsSet: noop,
      lsGet: () => null,
      SESSION_ORDERED_FRAMES: new Set(["resume_session", "new_session"]),
      AGENT_SESSION_RESET_FRAMES: new Set(),
      AGENT_MUTED: false,
      AGENT_BLIND: false,
      onStatus: noop,
      onSay: noop,
      onStream: noop,
      onLog: noop,
      onCommand: noop,
      onCommandReceived: noop,
      onAsk: noop,
      onSecret: noop,
      onSecretSaved: noop,
      onReload: noop,
      onTodo: noop,
      onShowMedia: noop,
      onOpenCivitai: noop,
      onCivitaiCmd: noop,
      onTrainingCmd: noop,
      onUiRender: noop,
      onUiUpdate: noop,
      onDownloads: noop,
      onThinking: noop,
      onAgentStatus: noop,
      onSession: noop,
      onModels: noop,
      onCommands: noop,
      onBackends: noop,
      onAck: noop,
      onTurn: noop,
      onAction: noop,
      onTurnAnchor: noop,
      getResume: () => null,
      getBackend: () => "claude",
      onHandshakeTimeout: noop,
      onBridgeClosed: noop,
      onPairUrl: noop,
      onPairError: noop,
      onRunpodStatus: noop,
      onComfyuiTarget: noop,
      onRunpodAlert: noop,
    },
    {
      has: () => true,
      get(target, key) {
        if (key in target) return target[key];
        if (key in globalThis) return globalThis[key];
        return noop;
      },
    },
  );
  const client = new Function("env", `with (env) { return (${createBridgeClientSource}); }`)(env)({
    onStatus: noop,
    onSay: noop,
    onStream: noop,
    onLog: noop,
    onModels: noop,
    onBridgeClosed: noop,
  });
  const originalSend = RuntimeBridgeSocket.prototype.send;
  RuntimeBridgeSocket.prototype.send = function (raw) {
    if (bridgeState.failNextSend) {
      bridgeState.failNextSend = false;
      throw new Error("simulated send failure");
    }
    return originalSend.call(this, raw);
  };
  return { client, routeRef, bridgeState, helloState, socket: () => RuntimeBridgeSocket.instances.at(-1) };
}

const runMatch = panelSrc.match(/\n {2}async graph_run\(\{ batch_count, to_node_id \}\) \{[\s\S]*?\n {2}\},/);
assert.ok(runMatch, "could not locate graph_run in panel source");

/** The window the OTHER repo relays this command in (`ctx.call(runCmd, 20000, …)`). */
const RUN_RELAY_WINDOW_MS = 20000;

/** Node 22 cancels pending tests when only unref'd timers remain (the guard unrefs by design). */
function keepAlive() {
  const ka = setInterval(() => {}, 25);
  return () => clearInterval(ka);
}

// ---------------------------------------------------------------------------
// Fixtures — a frontend whose queue processor is BUSY, and which drops the scope
// in every app.queuePrompt argument shape. That is the reporter's own machine:
// every successful run in their session came back `scope_applied_by:
// "request_body_repair"`, i.e. the first three shapes always drop and only the
// fourth (the panel writing partial_execution_targets into the body) carries it.
// ---------------------------------------------------------------------------

const OUR_OUTPUT = {
  "3": { class_type: "KSampler", inputs: {} },
  "9": { class_type: "SaveImage", inputs: {} },
  "327": { class_type: "SaveImage", inputs: {} },
};

function jsonResponse(status, obj) {
  return {
    status,
    clone: () => ({ json: async () => JSON.parse(JSON.stringify(obj)) }),
    text: async () => JSON.stringify(obj),
  };
}

function makeServer() {
  const calls = [];
  const fetchApi = async (route, options) => {
    calls.push({ route, options, at: Date.now() });
    return jsonResponse(200, { prompt_id: `srv-${calls.length}` });
  };
  fetchApi.calls = calls;
  return fetchApi;
}

function makeServerWithoutPromptId() {
  const calls = [];
  const fetchApi = async (route, options) => {
    calls.push({ route, options, at: Date.now() });
    return jsonResponse(200, {});
  };
  fetchApi.calls = calls;
  return fetchApi;
}

function makeServerSequence(bodies) {
  const calls = [];
  const fetchApi = async (route, options) => {
    calls.push({ route, options, at: Date.now() });
    const entry = bodies[Math.min(calls.length - 1, bodies.length - 1)];
    const described = entry && typeof entry === "object" && Object.hasOwn(entry, "status");
    return jsonResponse(described ? entry.status : 200, described ? entry.body : entry);
  };
  fetchApi.calls = calls;
  return fetchApi;
}

/**
 * @param {object} o
 * @param {number} o.drainMs how long the busy processor takes to get to our item
 * @param {"defer"|"never"|"throw"} [o.queue] how app.queuePrompt itself behaves
 * @param {"ok"|"never"} [o.serialize] how app.graphToPrompt behaves
 */
function makeBusyDroppingFrontend({ apiTarget, drainMs = 4990, queue = "defer", serialize = "ok" }) {
  const app = {
    queueItems: [],
    posted: [],
    graphToPrompt: serialize === "never" ? () => new Promise(() => {}) : async () => ({ output: OUR_OUTPUT, workflow: {} }),
    queuePrompt: async (number, batch) => {
      if (queue === "never") return new Promise(() => {});
      if (queue === "throw") throw new Error("frontend refused the queue call");
      // "dropping": no argument shape carries the scope through to the request.
      const item = { number, batchCount: batch, queueNodeIds: undefined };
      app.queueItems.push(item);
      // The busy processor serializes and posts our item LATER — exactly what the real
      // frontend does while `processingQueue` is true.
      const t = setTimeout(() => {
        const i = app.queueItems.indexOf(item);
        if (i < 0) return; // the panel cancelled it
        app.queueItems.splice(i, 1);
        const body = { prompt: OUR_OUTPUT, client_id: "x", number: item.number };
        app.posted.push({ body, at: Date.now() });
        apiTarget.fetchApi("/prompt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }, drainMs);
      if (typeof t.unref === "function") t.unref();
      return false; // busy — returns immediately, like the real one
    },
  };
  return app;
}

// ---------------------------------------------------------------------------
// 1. The reported composition, at the library the run path actually uses.
// ---------------------------------------------------------------------------

test("#1565: four argument shapes on a busy frontend cannot outlast ONE command budget", async () => {
  const stop = keepAlive();
  try {
    const apiTarget = { fetchApi: makeServer() };
    const server = apiTarget.fetchApi;
    // Per-attempt wait 500 ms, budget 600 ms. WITHOUT the budget the four attempts each
    // start their own 500 ms clock and the command runs ~2,000 ms — the same 4× shape that
    // measured 20,003 ms against the real 5,000 ms/20,000 ms pair.
    const app = makeBusyDroppingFrontend({ apiTarget, drainMs: 490 });
    const started = Date.now();
    const result = await dispatchScopedRun({
      app,
      apiTarget,
      execIds: ["327"],
      batch: 1,
      toNodeId: 327,
      verifyTimeoutMs: 500,
      budget: makeCommandBudget(600),
    });
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed <= 600 + 250,
      `the scoped dispatch spent ${elapsed}ms of a 600ms command budget — the per-attempt ` +
        `waits are not composing, which is what put a real run past its 20,000ms relay window`,
    );
    assert.notEqual(
      result.outcome,
      "dispatched",
      "a run that ran out of budget must not report a dispatch it never observed",
    );
    // The prompt must not queue AFTER the caller has been answered. Before the fix this is
    // exactly what happened: the post left at 20,003 ms, past the caller's deadline, so a
    // retry of the "failed" run rendered the branch twice.
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(
      server.calls.length,
      0,
      "a post that arrives after the run was reported must meet the fence, not ComfyUI",
    );
  } finally {
    stop();
  }
});

test("#1565: an app.queuePrompt that NEVER SETTLES is bounded by the command budget", async () => {
  const stop = keepAlive();
  try {
    const apiTarget = { fetchApi: makeServer() };
    const app = makeBusyDroppingFrontend({ apiTarget, queue: "never" });
    const started = Date.now();
    // Raced, so an unbounded await FAILS this test instead of hanging the runner.
    const outcome = await Promise.race([
      dispatchScopedRun({
        app,
        apiTarget,
        execIds: ["327"],
        batch: 1,
        toNodeId: 327,
        verifyTimeoutMs: 500,
        budget: makeCommandBudget(600),
      }).then((r) => ({ replied: r })),
      new Promise((r) => setTimeout(() => r({ hung: true }), 4000)),
    ]);
    const elapsed = Date.now() - started;
    assert.ok(
      !outcome.hung,
      `dispatchScopedRun never answered — a frontend queue call that does not settle must ` +
        `not be able to hold graph_run open past the window its reply is relayed in`,
    );
    assert.ok(elapsed <= 4000, `answered in ${elapsed}ms`);
    assert.notEqual(outcome.replied.outcome, "dispatched");
  } finally {
    stop();
  }
});

test("#1565: an app.graphToPrompt that NEVER SETTLES is bounded, and nothing is queued", async () => {
  const stop = keepAlive();
  try {
    const apiTarget = { fetchApi: makeServer() };
    const app = makeBusyDroppingFrontend({ apiTarget, serialize: "never" });
    const outcome = await Promise.race([
      dispatchScopedRun({
        app,
        apiTarget,
        execIds: ["327"],
        batch: 1,
        toNodeId: 327,
        verifyTimeoutMs: 500,
        budget: makeCommandBudget(600),
      }).then((r) => ({ replied: r })),
      new Promise((r) => setTimeout(() => r({ hung: true }), 4000)),
    ]);
    assert.ok(!outcome.hung, "a serializer that never answers must not hold the command open");
    assert.equal(
      outcome.replied.outcome,
      "unverifiable",
      "no fingerprint means no attribution — the established fail-closed state, nothing queued",
    );
    assert.equal(apiTarget.fetchApi.calls.length, 0, "nothing was posted");
  } finally {
    stop();
  }
});

// ---------------------------------------------------------------------------
// 2. The bound must not invent outcomes. Two regressions the bound could cause.
// ---------------------------------------------------------------------------

test("#1565: a queuePrompt that THROWS still throws — a bound must not relabel a refusal as a timeout", async () => {
  const stop = keepAlive();
  try {
    const apiTarget = { fetchApi: makeServer() };
    const app = makeBusyDroppingFrontend({ apiTarget, queue: "throw" });
    await assert.rejects(
      () =>
        dispatchScopedRun({
          app,
          apiTarget,
          execIds: ["327"],
          batch: 1,
          toNodeId: 327,
          verifyTimeoutMs: 500,
          budget: makeCommandBudget(600),
        }),
      /frontend refused the queue call/,
      "the frontend's own error is what the caller has to see; a timeout story would be a wrong one",
    );
  } finally {
    stop();
  }
});

test("#1565: even a FALSY thrown value still throws — the bound settles into {value}/{error}, and `error` may be undefined", async () => {
  const stop = keepAlive();
  try {
    const apiTarget = { fetchApi: makeServer() };
    const app = makeBusyDroppingFrontend({ apiTarget });
    // `throw undefined` is legal. A truthiness test on the settled object would read it as
    // "no error" and continue into the give-up path, reporting a timeout for a frontend
    // that actually refused. The bare `await` it replaced propagated it.
    app.queuePrompt = async () => {
      throw undefined;
    };
    let threw = false;
    try {
      await dispatchScopedRun({
        app, apiTarget, execIds: ["327"], batch: 1, toNodeId: 327,
        verifyTimeoutMs: 500, budget: makeCommandBudget(600),
      });
    } catch (err) {
      threw = true;
      assert.equal(err, undefined, "and it is the SAME value the frontend threw");
    }
    assert.ok(threw, "a falsy throw must still reject, not be relabelled as a timeout");
  } finally {
    stop();
  }
});

test("#1565: NO budget ⇒ no new bound — an existing caller keeps today's behaviour", async () => {
  const stop = keepAlive();
  try {
    const apiTarget = { fetchApi: makeServer() };
    // Posts promptly, so the happy path still dispatches with no budget in sight.
    const app = makeBusyDroppingFrontend({ apiTarget, drainMs: 5 });
    const result = await dispatchScopedRun({
      app,
      apiTarget,
      execIds: ["327"],
      batch: 1,
      toNodeId: 327,
      verifyTimeoutMs: 500,
    });
    assert.equal(result.outcome, "dispatched");
    assert.equal(result.scopeAppliedBy, "request_body_repair", "the 4th shape is what carries it on this build");
  } finally {
    stop();
  }
});

test("#1565 P0: a run abandoned at its bound still FENCES its own late post, with another run's guard installed on top", async () => {
  const stop = keepAlive();
  try {
    const apiTarget = { fetchApi: makeServer() };
    const server = apiTarget.fetchApi;
    const raw = apiTarget.fetchApi;
    // Run A: its queue call never settles, so it is abandoned at the bound. The post it
    // already handed to the busy processor arrives LATER — after A has been reported.
    let latePost = null;
    const appA = {
      queueItems: [],
      graphToPrompt: async () => ({ output: OUR_OUTPUT, workflow: {} }),
      queuePrompt: async (number) => {
        // The processor will emit this run's post long after queuePrompt is abandoned,
        // through WHATEVER fetchApi is installed by then — which is another run's guard.
        latePost = () =>
          apiTarget.fetchApi("/prompt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: OUR_OUTPUT, client_id: "x", number }),
          });
        return new Promise(() => {});
      },
    };
    const a = await dispatchScopedRun({
      app: appA, apiTarget, execIds: ["327"], batch: 1, toNodeId: 327,
      verifyTimeoutMs: 300, budget: makeCommandBudget(400),
    });
    assert.notEqual(a.outcome, "dispatched", "A was abandoned at its bound");
    assert.notEqual(apiTarget.fetchApi, raw, "and its fence is still in the chain, never restored to raw fetch");

    // Run B starts afterwards and installs ITS guard on top of A's closed one.
    const appB = makeBusyDroppingFrontend({ apiTarget, drainMs: 5 });
    const b = await dispatchScopedRun({
      app: appB, apiTarget, execIds: ["327"], batch: 1, toNodeId: 327,
      verifyTimeoutMs: 300, budget: makeCommandBudget(2000),
    });
    assert.equal(b.outcome, "dispatched", "B is unaffected by A's abandoned fence");
    const postsAfterB = server.calls.length;

    // NOW A's late post arrives. It must travel B's guard (mark mismatch, passed through)
    // and meet A's CLOSED guard below it — refused, never forwarded to the server.
    const res = await latePost();
    assert.equal(res.status, 400, "A's late post is refused by A's own closed fence");
    assert.equal(
      server.calls.length,
      postsAfterB,
      "a post from an abandoned run must never reach ComfyUI scopeless — that is the " +
        "full-graph execution this whole module exists to prevent",
    );
  } finally {
    stop();
  }
});

// ---------------------------------------------------------------------------
// 3. THE CALL SITE. The whole fix is one budget reaching the dispatch, and a
//    library-level test cannot see whether it does. This runs the SHIPPED
//    graph_run body with injected collaborators.
// ---------------------------------------------------------------------------

/**
 * Build the real `graph_run` executor from panel source.
 *
 * `budgetMs` / `serializeMs` are injected in place of the shipped constants (the same
 * technique add-node-command-budget.test.mjs uses) so the wiring can be exercised in
 * milliseconds; the shipped VALUES are pinned separately below.
 */
function realGraphRun({ app, apiTarget, budgetMs, serializeMs, dispatch, runCompletionRef, armRunReconcileSweepRef, runReceiptSender, runReceiptRouteRef, panelRunOwnerRef }) {
  const seen = { dispatchArgs: null };
  const deps = {
    RUN_COMMAND_BUDGET_MS: budgetMs,
    RUN_SERIALIZE_TIMEOUT_MS: serializeMs,
    makeCommandBudget,
    monotonicNow: () => performance.now(),
    withTimeout,
    api: apiTarget,
    window: { LiteGraph: { registered_node_types: {} } },
    getGraphCtx: () => ({ app, graph: app.graph, rootGraph: app.graph }),
    assertGraphBoundToActiveWorkflow: () => {},
    MUTATION_BINDING_BAR,
    // Target resolution is not what this test is about; the run-to-node resolver has its
    // own suite (subgraph-scope). Answer the way it answers for a root-level output node.
    resolveRunToNodeTarget: () => ({ ok: true, execId: "327", node: { type: "SaveImage" } }),
    dispatchScopedRun: async (args) => {
      seen.dispatchArgs = args;
      return dispatch ? dispatch(args) : { outcome: "unverified", queueMark: 1, verified: 0, error: "stub" };
    },
    createRunFetchInterceptor,
    graphToPromptUnusable,
    unrunnableNodeIdsInScope,
    unserializableGraphRefusal,
    unresolvedNodeTypes,
    missingNodeRunRefusal,
    describeUnrunnable,
    installGraphToPromptNullSafety,
    installGraphToPromptSnapshotBarrier,
    queuePromptWithGraphToPromptSnapshot,
    reserveGraphToPromptSnapshot,
    releaseGraphToPromptSnapshot,
    collectAllGraphs,
    findRepeatingControlWidgets,
    findRgthreeSeedNodes,
    repeatingRgthreeSeeds,
    scopedBatchSeedNote,
    // mcp#1998 — graph_run now also drives the frontend's control hooks across a scoped
    // batch. Every free name in the executor has to be injected here or the eval throws
    // ReferenceError at RUN time, which is how this harness caught the omission.
    driveControlHooksAcrossScopedBatch,
    scopedBatchDriveNote,
    rgthreeFixedSeedNote,
    summarizePromptRejection,
    buildQueueAcceptResult,
    collectVirtualSourceFeeds,
    virtualSourceNote,
    collectDisabledAncestorOutputs,
    disabledOutputsNote,
    prunedRetryNote,
    describeQueuePromptChain,
    describeQueuePromptChainForReport,
    queuePromptChainDeps,
    runCompletionRef: runCompletionRef ?? { onQueued() {} },
    armRunReconcileSweepRef: armRunReconcileSweepRef ?? (() => {}),
    runReceiptSender: runReceiptSender ?? null,
    runReceiptRouteRef: runReceiptRouteRef ?? (() => null),
    panelRunOwnerRef: panelRunOwnerRef ?? { current: {} },
  };
  const names = Object.keys(deps);
  const factory = new Function(
    ...names,
    `const executors = {${runMatch[0]}};
     return executors.graph_run;`,
  );
  return { graph_run: factory(...names.map((n) => deps[n])), seen };
}

test("#1565 CALL SITE: graph_run hands the dispatch its own command budget", async () => {
  const stop = keepAlive();
  try {
    const apiTarget = { fetchApi: makeServer() };
    const app = makeBusyDroppingFrontend({ apiTarget, drainMs: 5 });
    app.graph = { _nodes: [] };
    const built = realGraphRun({ app, apiTarget, budgetMs: 600, serializeMs: 400 });
    await built.graph_run({ to_node_id: 327 });
    const passed = built.seen.dispatchArgs?.budget;
    assert.ok(
      passed && typeof passed.bounded === "function",
      "graph_run dispatched a scoped run WITHOUT a command budget — the dispatch then keeps " +
        "its per-attempt clocks (4 × 5,000 ms = the whole 20,000 ms relay window) and its " +
        "unbounded queue call, which is the reported hang",
    );
    assert.equal(passed.totalMs, 600, "the budget is the command's own, not one invented inside the dispatch");
    assert.ok(passed.bounded(999999) <= 600, "every allowance is capped by what the COMMAND has left");
  } finally {
    stop();
  }
});

test("#1588 CALL SITE: a busy queue serializes each deliberate-sweep prompt snapshot", async () => {
  const stop = keepAlive();
  try {
    const promptFor = (label) => {
      const output = {
        "1": { class_type: "CLIPTextEncode", inputs: { text: label } },
      };
      for (let i = 0; i < 5; i++) {
        output[String(i + 2)] = {
          class_type: "SaveImage",
          inputs: { filename_prefix: `${label}/stage${i}` },
        };
      }
      return { output, workflow: {} };
    };

    let livePrompt = promptFor("A");
    const calls = [];
    const apiTarget = { fetchApi: makeServer() };
    const app = {
      graph: { _nodes: [] },
      // The first item represents the already-running render. New graph_run
      // calls are accepted into the frontend's pending queue and return false.
      queueItems: [{ active: true }],
      processing: true,
      graphToPrompt: async () => JSON.parse(JSON.stringify(livePrompt)),
      queuePrompt: async (number, batchCount) => {
        app.queueItems.push({ number, batchCount });
        return false;
      },
      async drain() {
        while (app.queueItems.length) {
          const item = app.queueItems.pop();
          if (!item.active) calls.push(await app.graphToPrompt(app.graph));
        }
        app.processing = false;
      },
    };

    const built = realGraphRun({ app, apiTarget, budgetMs: 3000, serializeMs: 500 });
    await built.graph_run({});

    livePrompt = promptFor("B");
    const foreign = await app.graphToPrompt();
    assert.equal(
      foreign.output["1"].inputs.text,
      "B",
      "an intervening foreign graphToPrompt call uses the live graph and cannot consume A's reservation",
    );
    await built.graph_run({});
    livePrompt = promptFor("C");
    await built.graph_run({});

    await app.drain();

    assert.equal(calls.length, 3, "the three pending graph_run items must serialize");
    assert.deepEqual(
      calls.map((prompt) => prompt.output["1"].inputs.text),
      ["C", "B", "A"],
      "the frontend queue is LIFO, and each item must retain its own command snapshot",
    );
    for (const [index, label] of ["C", "B", "A"].entries()) {
      assert.deepEqual(
        Array.from({ length: 5 }, (_, i) => calls[index].output[String(i + 2)].inputs.filename_prefix),
        Array.from({ length: 5 }, (_, i) => `${label}/stage${i}`),
        `${label}'s five SaveImage filename_prefix widgets must stay with its prompt`,
      );
    }
  } finally {
    stop();
  }
});

test("#1588: deferred serialization runs queue hooks on the correct graph snapshot", async () => {
  const stop = keepAlive();
  try {
    const widget = {
      name: "seed",
      type: "number",
      value: 10,
      beforeQueued() {
        this.value += 1;
      },
    };
    const calls = [];
    const apiTarget = { fetchApi: makeServer() };
    const app = {
      graph: { _nodes: [{ id: 1, widgets: [widget] }] },
      queueItems: [{ active: true }],
      graphToPrompt: async () => ({
        output: { "1": { class_type: "KSampler", inputs: { seed: widget.value } } },
        workflow: {},
      }),
      queuePrompt: async (number, batchCount) => {
        app.queueItems.push({ number, batchCount });
        return false;
      },
      async drain() {
        while (app.queueItems.length) {
          const item = app.queueItems.pop();
          if (!item.active) {
            widget.beforeQueued({ isPartialExecution: false });
            calls.push(await app.graphToPrompt(app.graph));
          }
        }
      },
    };

    const built = realGraphRun({ app, apiTarget, budgetMs: 3000, serializeMs: 500 });
    await built.graph_run({});
    widget.value = 20;
    await built.graph_run({});

    await app.drain();

    assert.deepEqual(
      calls.map((prompt) => prompt.output["1"].inputs.seed),
      [21, 11],
      "the LIFO queue serializes each run's captured widget state, then applies beforeQueued",
    );
    assert.equal(widget.value, 20, "temporary snapshot restoration does not clobber the live graph");
  } finally {
    stop();
  }
});

test("#1588 P1: a foreign graphToPrompt between the hook and queue serializer cannot consume the item snapshot", async () => {
  const stop = keepAlive();
  try {
    const widget = {
      name: "seed",
      type: "number",
      value: 10,
      beforeQueued() {
        this.value += 1;
      },
    };
    const apiTarget = { fetchApi: makeServer() };
    const app = {
      graph: { _nodes: [{ id: 1, widgets: [widget] }] },
      queueItems: [{ active: true }],
      graphToPrompt: async () => ({
        output: { "1": { class_type: "KSampler", inputs: { seed: widget.value } } },
        workflow: {},
      }),
      queuePrompt: async (number, batchCount) => {
        app.queueItems.push({ number, batchCount });
        return false;
      },
    };
    const built = realGraphRun({ app, apiTarget, budgetMs: 3000, serializeMs: 500 });

    await built.graph_run({});
    widget.value = 20;

    // This is the pinned queue gap: the exact item has been popped and its
    // beforeQueued hook has run, but the queue loop has not called its real
    // graphToPrompt(this.rootGraph) yet.
    app.queueItems.pop();
    widget.beforeQueued({ isPartialExecution: false });
    const foreign = await app.graphToPrompt();
    const actual = await app.graphToPrompt(app.graph);

    assert.equal(foreign.output["1"].inputs.seed, 11, "the foreign call may observe the queue snapshot");
    assert.equal(actual.output["1"].inputs.seed, 11, "the real queue serializer still consumes that same snapshot");
    assert.equal(widget.value, 20, "finishing the exact queue item restores the live graph");
  } finally {
    stop();
  }
});

test("#1588/#445: the first graph_run preflight is null-widget safe", async () => {
  const stop = keepAlive();
  try {
    const widget = { name: "filename_prefix", type: "text", value: null };
    let preflightSawSafeValue = false;
    const apiTarget = { fetchApi: makeServer() };
    const app = {
      graph: { _nodes: [{ id: 1, widgets: [widget] }] },
      queueItems: [],
      graphToPrompt: async () => {
        if (widget.value == null) throw new Error("null widget reached serializer");
        preflightSawSafeValue = true;
        return {
          output: { "1": { class_type: "SaveImage", inputs: { filename_prefix: widget.value } } },
          workflow: {},
        };
      },
      queuePrompt: async (number, batchCount) => {
        app.queueItems.push({ number, batchCount });
        return false;
      },
    };
    const built = realGraphRun({ app, apiTarget, budgetMs: 3000, serializeMs: 500 });

    await built.graph_run({});

    assert.equal(preflightSawSafeValue, true, "null-safety was installed before the first preflight");
    assert.equal(widget.value, null, "the preflight guard restores the live null widget");
  } finally {
    stop();
  }
});

test("#1588: a post-enqueue queuePrompt failure removes its queued item", async () => {
  const stop = keepAlive();
  try {
    const calls = [];
    const apiTarget = { fetchApi: makeServer() };
    const app = {
      graph: { _nodes: [] },
      queueItems: [],
      graphToPrompt: async () => ({
        output: { "1": { class_type: "KSampler", inputs: { text: "A" } } },
        workflow: {},
      }),
      queuePrompt: async (number, batchCount) => {
        app.queueItems.push({ number, batchCount });
        throw new Error("post-enqueue queue failure");
      },
      async drain() {
        while (app.queueItems.length) calls.push(await app.graphToPrompt(app.graph));
      },
    };
    const built = realGraphRun({ app, apiTarget, budgetMs: 3000, serializeMs: 500 });

    await assert.rejects(() => built.graph_run({}), /post-enqueue queue failure/);
    await app.drain();

    assert.equal(app.queueItems.length, 0, "the item that failed after enqueue is cleaned up");
    assert.equal(calls.length, 0, "cleanup prevents a later serializer from using the wrong prompt");
  } finally {
    stop();
  }
});

test("#1588: a failure after dequeue cancels an unsupported snapshot before serialization", async () => {
  const stop = keepAlive();
  try {
    const widget = { name: "host_value", type: "custom", value: new WeakMap() };
    const apiTarget = { fetchApi: makeServer() };
    const app = {
      graph: { _nodes: [{ id: 1, widgets: [widget] }] },
      queueItems: [],
      graphToPrompt: async () => ({
        output: { "1": { class_type: "Custom", inputs: { host_value: widget.value } } },
        workflow: {},
      }),
      queuePrompt: async (number, batchCount) => {
        app.queueItems.push({ number, batchCount });
        await Promise.resolve();
        app.queueItems.pop();
        await Promise.resolve();
        throw new Error("post-dequeue queue failure");
      },
    };
    const built = realGraphRun({ app, apiTarget, budgetMs: 3000, serializeMs: 500 });

    await assert.rejects(() => built.graph_run({}), /post-dequeue queue failure/);
    assert.equal(app.queueItems.length, 0, "the dequeued item is no longer pending");
    assert.throws(
      () => app.graphToPrompt(app.graph),
      /graph_run queue item was cancelled after queuePrompt failed/,
      "a later serializer cannot fall through to the live graph after failure",
    );
  } finally {
    stop();
  }
});

test("#1565 CALL SITE: graph_run answers inside its budget when the frontend queue call never settles", async () => {
  const stop = keepAlive();
  try {
    const apiTarget = { fetchApi: makeServer() };
    const app = makeBusyDroppingFrontend({ apiTarget, queue: "never" });
    app.graph = { _nodes: [] };
    // The REAL dispatch, so the budget has to travel from graph_run's first line all the
    // way into the per-attempt bounds for this to answer at all.
    const built = realGraphRun({
      app,
      apiTarget,
      budgetMs: 800,
      serializeMs: 400,
      dispatch: (args) => dispatchScopedRun({ ...args, verifyTimeoutMs: 500 }),
    });
    const started = Date.now();
    const answer = await Promise.race([
      built.graph_run({ to_node_id: 327 }).then((r) => ({ replied: r })),
      new Promise((r) => setTimeout(() => r({ hung: true }), 5000)),
    ]);
    const elapsed = Date.now() - started;
    assert.ok(
      !answer.hung,
      "graph_run never replied — this is the reported symptom: the run path blocks while " +
        "reads on the same tab answer instantly",
    );
    assert.ok(elapsed <= 5000, `graph_run answered in ${elapsed}ms`);
    assert.equal(answer.replied.queued, false, "and it says truthfully that nothing was queued");
    assert.ok(
      typeof answer.replied.error === "string" && answer.replied.error.length > 0,
      "with words, not a bare relay timeout that blames a tab which is answering reads fine",
    );
  } finally {
    stop();
  }
});

test("#1728 CALL SITE: late capture crosses the bridge, arms the real sweep, and emits one completion", async () => {
  const stop = keepAlive();
  let sweep;
  try {
    const apiTarget = { fetchApi: makeServer() };
    const app = makeBusyDroppingFrontend({ apiTarget, queue: "never" });
    app.graph = { _nodes: [] };
    const flushes = [];
    const receiptFrames = [];
    const timers = new Set();
    const schedule = (fn, ms) => {
      const timer = { fn, ms };
      timers.add(timer);
      return timer;
    };
    const cancel = (timer) => timers.delete(timer);
    const tracker = createRunCompletionTracker({
      onFlush: (payload) => flushes.push(payload),
      now: () => 1000,
      setTimer: schedule,
      clearTimer: cancel,
    });
    sweep = createRunReconcileSweep({
      hasPending: () => tracker.hasPending(),
      reconcile: async () => {},
      setTimer: schedule,
      clearTimer: cancel,
      intervalMs: 60000,
    });
    let latePromptId;
    const built = realGraphRun({
      app,
      apiTarget,
      budgetMs: 800,
      serializeMs: 400,
      runCompletionRef: tracker,
      armRunReconcileSweepRef: () => sweep.arm(),
      runReceiptSender: (rid, promptId) =>
        receiptFrames.push({ type: "run_receipt", run_rid: rid, prompt_id: promptId }),
      dispatch: async (args) => {
        // The production guard can invoke this callback after dispatchScopedRun
        // has returned its bounded unverified result.
        latePromptId = () => args.onPromptId("late-prompt-1728");
        return { outcome: "unverified", queueMark: 1, verified: 0, inFlight: 1, error: "stub" };
      },
    });

    const result = await built.graph_run({ to_node_id: 327, rid: "run-rid-1728" });
    assert.equal(result.queued_unknown, true, "the bounded call remains honest about its unknown receipt");
    latePromptId();
    assert.deepEqual(receiptFrames, [
      { type: "run_receipt", run_rid: "run-rid-1728", prompt_id: "late-prompt-1728" },
    ], "the late prompt id crosses the bridge as a non-agent receipt");
    assert.equal(sweep._hasTimer(), true, "the real safety sweep is armed by the late capture");

    // The prompt can finish before the delayed /prompt response reaches the
    // capture callback. The tracker must retain that media-less success and
    // apply the panel_run promise when onQueued finally arrives.
    tracker.onExecutionStart("late-prompt-1728");
    tracker.onExecutionSuccess("late-prompt-1728");
    assert.equal(flushes.length, 1, "the late capture produces one terminal completion");
    assert.equal(flushes[0].noMedia, true);

    const sent = [];
    await composeRunCompletionFrame(flushes[0], {
      sendFrame: (frame) => (sent.push(frame), true),
      coerceMessageText: (value) => String(value ?? ""),
      formatDuration: (ms) => `${(ms / 1000).toFixed(1)}s`,
      formatClock: () => "12:00:00",
      agentReceivesImages: () => true,
      warn: () => {},
    });
    assert.equal(sent.length, 1, "the bridge receives exactly one completion frame");

    latePromptId();
    tracker.onExecutionSuccess("late-prompt-1728");
    assert.equal(flushes.length, 1, "duplicate capture/lifecycle signals stay fenced");
    assert.equal(sent.length, 1, "duplicate capture/lifecycle signals do not duplicate the frame");
  } finally {
    sweep?.dispose();
    stop();
  }
});

test("#1728 CALL SITE: a closed-route receipt is retained and flushed once on reconnect", async () => {
  const stop = keepAlive();
  try {
    const apiTarget = { fetchApi: makeServer() };
    const app = makeBusyDroppingFrontend({ apiTarget, queue: "never" });
    app.graph = { _nodes: [] };
    const receiptFrames = [];
    let routeReady = false;
    const outbox = createRunReceiptOutbox({ retryMs: 60000 });
    outbox.setTransport({
      routeId: () => "panel-route-1728",
      ready: () => routeReady,
      sendFrame: (frame) => {
        if (!routeReady) return false;
        receiptFrames.push(frame);
        return true;
      },
    });
    let latePromptId;
    const built = realGraphRun({
      app,
      apiTarget,
      budgetMs: 800,
      serializeMs: 400,
      panelRunOwnerRef: { current: { generation: 1 } },
      runReceiptRouteRef: () => "panel-route-1728",
      runReceiptSender: (rid, promptId, routeId) => outbox.enqueue(rid, promptId, routeId),
      dispatch: async (args) => {
        latePromptId = () => args.onPromptId("late-reconnect-prompt-1728");
        return { outcome: "unverified", queueMark: 1, verified: 0, inFlight: 1, error: "stub" };
      },
    });

    const result = await built.graph_run({ to_node_id: 327, rid: "run-rid-reconnect-1728" });
    assert.equal(result.queued_unknown, true);
    latePromptId();
    assert.equal(outbox.pendingSize(), 1, "sendFrame false keeps the exact receipt pending");
    assert.deepEqual(receiptFrames, []);

    routeReady = true;
    outbox.notifyRouteReady();
    assert.equal(outbox.pendingSize(), 0, "the reconnect flush retires the receipt only after sendFrame true");
    assert.deepEqual(receiptFrames, [
      { type: "run_receipt", run_rid: "run-rid-reconnect-1728", prompt_id: "late-reconnect-prompt-1728" },
    ]);
  } finally {
    stop();
  }
});

test("#1728 runtime bridge path fences receipt outbox across same-route re-advertisement and remount", async () => {
  const routeRef = { current: "panel-route-runtime-1728" };
  const built = buildRuntimeBridgeClient({ routeRef });
  const outbox = createRunReceiptOutbox({ retryMs: 60000 });
  const receiptFrames = [];
  outbox.setTransport({
    routeId: () => routeRef.current,
    ready: () => built.client.isRouteReady() === true,
    sendFrame: (frame) => built.client.sendFrame(frame),
  });
  try {
    built.client.start();
    const socket = built.socket();
    socket.open();
    await Promise.resolve();
    assert.deepEqual(socket.sent[0], {
      type: "hello",
      tab_id: "panel-route-runtime-1728",
      workflow_uuid: "wf-1728",
    });
    assert.equal(built.client.isRouteReady(), false, "socket-open is not a route handshake");

    socket.receive({ type: "models", epoch: "epoch-runtime-1728", models: [] });
    assert.equal(built.client.isRouteReady(), true, "the landed hello establishes the captured route");

    built.bridgeState.failNextSend = true;
    outbox.enqueue("run-failure-1728", "prompt-failure-1728", routeRef.current);
    assert.equal(outbox.pendingSize(), 1, "sendFrame false retains the receipt for retry");
    assert.deepEqual(receiptFrames, []);

    built.helloState.block = true;
    const rehello = built.client.rehello();
    await Promise.resolve();
    assert.equal(built.client.isRouteReady(), false, "a same-route replacement hello creates a new readiness fence");
    outbox.enqueue("run-held-1728", "prompt-held-1728", routeRef.current);
    assert.equal(outbox.pendingSize(), 2, "receipts remain held while the replacement hello is unresolved");

    built.helloState.block = false;
    built.helloState.release?.();
    await rehello;
    assert.equal(built.client.isRouteReady(), true, "the replacement hello restores readiness only after it lands");
    outbox.notifyRouteReady();
    assert.equal(outbox.pendingSize(), 0, "both at-least-once receipts flush after the same binding is live");

    const sentBeforeReplacement = socket.sent.length;
    routeRef.current = "replacement-route-runtime-1728";
    assert.equal(built.client.isRouteReady(), false, "a remounted route is not equal to the advertised generation");
    outbox.enqueue("run-old-route-1728", "prompt-old-route-1728", "panel-route-runtime-1728");
    assert.equal(outbox.pendingSize(), 1, "an old dispatch is retained rather than attributed to the replacement");

    await built.client.rehello();
    assert.equal(built.client.isRouteReady(), true, "the replacement route has its own landed hello");
    outbox.enqueue("run-new-route-1728", "prompt-new-route-1728", routeRef.current);
    outbox.notifyRouteReady();
    assert.equal(outbox.pendingSize(), 1, "the old route receipt remains fenced after the replacement hello");
    assert.deepEqual(
      socket.sent.slice(sentBeforeReplacement).filter((frame) => frame.type === "run_receipt"),
      [{ type: "run_receipt", run_rid: "run-new-route-1728", prompt_id: "prompt-new-route-1728", tab_id: "replacement-route-runtime-1728" }],
      "only the replacement dispatch can flush on the replacement binding",
    );

    routeRef.current = null;
    assert.equal(built.client.isRouteReady(), false, "a null captured route is never substituted from the live mount");
    assert.equal(
      built.client.sendFrame({ type: "run_receipt", run_rid: "run-null-route-1728", prompt_id: "prompt-null-route-1728" }),
      false,
    );
  } finally {
    outbox.clearPending();
    built.client.stop();
  }
});

test("#1728 production bridge wiring fences same-route re-advertisement before receipts", () => {
  const sendHelloAt = panelSrc.indexOf("  function sendHello() {");
  const sendHelloEnd = panelSrc.indexOf("\n\n  /** Returns a promise", sendHelloAt);
  const sendHello = panelSrc.slice(sendHelloAt, sendHelloEnd);
  const readyAt = panelSrc.indexOf("    isRouteReady() {");
  const readyEnd = panelSrc.indexOf("\n    },", readyAt);
  const ready = panelSrc.slice(readyAt, readyEnd);
  const senderAt = panelSrc.indexOf("  const panelRunReceiptSender =");
  const senderEnd = panelSrc.indexOf("\n  const panelRunReceiptTransport", senderAt);
  const sender = panelSrc.slice(senderAt, senderEnd);

  assert.match(sendHello, /nextRouteBindingGeneration/);
  assert.match(sendHello, /pendingRouteBindingGeneration = bindingGeneration/);
  assert.match(sendHello, /sent === true/);
  assert.match(ready, /pendingRouteBindingGeneration !== null/);
  assert.match(sender, /runReceiptOutbox\.enqueue\(rid, promptId, routeId\)/);
  assert.doesNotMatch(sender, /routeId\s*\?\?/);
});

test("#1728 CALL SITE: a null dispatch route is refused rather than substituted from the remount", async () => {
  const stop = keepAlive();
  try {
    const apiTarget = { fetchApi: makeServer() };
    const app = makeBusyDroppingFrontend({ apiTarget, queue: "never" });
    app.graph = { _nodes: [] };
    const receiptFrames = [];
    const outbox = createRunReceiptOutbox({ retryMs: 60000 });
    outbox.setTransport({
      routeId: () => "replacement-route-1728",
      ready: () => true,
      sendFrame: (frame) => {
        receiptFrames.push(frame);
        return true;
      },
    });
    let capturedRoute = "unset";
    let latePromptId;
    const built = realGraphRun({
      app,
      apiTarget,
      budgetMs: 800,
      serializeMs: 400,
      panelRunOwnerRef: { current: { generation: 1 } },
      runReceiptRouteRef: () => null,
      runReceiptSender: (rid, promptId, routeId) => {
        capturedRoute = routeId;
        return outbox.enqueue(rid, promptId, routeId);
      },
      dispatch: async (args) => {
        latePromptId = () => args.onPromptId("null-route-prompt-1728");
        return { outcome: "unverified", queueMark: 1, verified: 0, inFlight: 1, error: "stub" };
      },
    });

    await built.graph_run({ to_node_id: 327, rid: "run-rid-null-route-1728" });
    latePromptId();

    assert.equal(capturedRoute, null, "the sender receives the dispatch's captured null route");
    assert.equal(outbox.pendingSize(), 0, "a null route is not queued for a different mount");
    assert.deepEqual(receiptFrames, [], "the receipt is not attributed to the replacement route");
  } finally {
    stop();
  }
});

test("#1728 CALL SITE: a late callback after remount cannot touch the replacement tracker", async () => {
  const stop = keepAlive();
  try {
    const apiTarget = { fetchApi: makeServer() };
    const app = makeBusyDroppingFrontend({ apiTarget, queue: "never" });
    app.graph = { _nodes: [] };
    const ownerRef = { current: { generation: 1 } };
    const trackerEvents = { old: [], replacement: [] };
    const trackerSlot = {
      current: { onQueued: (id) => trackerEvents.old.push(id) },
    };
    const liveTracker = { onQueued: (id) => trackerSlot.current.onQueued(id) };
    const sweepOwners = [];
    const receiptFrames = [];
    let latePromptId;
    const built = realGraphRun({
      app,
      apiTarget,
      budgetMs: 800,
      serializeMs: 400,
      panelRunOwnerRef: ownerRef,
      runCompletionRef: liveTracker,
      armRunReconcileSweepRef: () => sweepOwners.push(ownerRef.current),
      runReceiptRouteRef: () => "panel-route-remount-1728",
      runReceiptSender: (rid, promptId) => receiptFrames.push({ rid, promptId }),
      dispatch: async (args) => {
        latePromptId = () => args.onPromptId("stale-remount-prompt-1728");
        return { outcome: "unverified", queueMark: 1, verified: 0, inFlight: 1, error: "stub" };
      },
    });

    await built.graph_run({ to_node_id: 327, rid: "run-rid-remount-1728" });
    ownerRef.current = { generation: 2 };
    trackerSlot.current = { onQueued: (id) => trackerEvents.replacement.push(id) };
    latePromptId();

    assert.deepEqual(trackerEvents, { old: [], replacement: [] });
    assert.deepEqual(sweepOwners, []);
    assert.deepEqual(receiptFrames, [
      { rid: "run-rid-remount-1728", promptId: "stale-remount-prompt-1728" },
    ], "the stale callback may still deliver its exact server receipt");
  } finally {
    stop();
  }
});

// ---------------------------------------------------------------------------
// 4. The shipped numbers. Injected above so the wiring tests run in ms; pinned
//    here so the values that actually ship cannot drift past the relay window.
// ---------------------------------------------------------------------------

test("#1565: the shipped run budget leaves room inside the 20,000 ms window the reply is relayed in", () => {
  const budget = Number(panelSrc.match(/const RUN_COMMAND_BUDGET_MS = (\d+);/)?.[1]);
  const serialize = Number(panelSrc.match(/const RUN_SERIALIZE_TIMEOUT_MS = (\d+);/)?.[1]);
  assert.ok(Number.isFinite(budget), "RUN_COMMAND_BUDGET_MS must exist — graph_run is relayed in a fixed window");
  assert.ok(Number.isFinite(serialize), "RUN_SERIALIZE_TIMEOUT_MS must exist");
  assert.ok(
    budget < RUN_RELAY_WINDOW_MS,
    `a ${budget}ms budget cannot answer inside a ${RUN_RELAY_WINDOW_MS}ms relay window`,
  );
  assert.ok(
    RUN_RELAY_WINDOW_MS - budget >= 5000,
    "leave the same 5,000 ms of slack the other command budgets leave, for composing the " +
      "reply and the websocket hop",
  );
  assert.ok(serialize <= budget, "one serialization may not be allowed more than the whole command");
});

test("#1565 CALL SITE: graph_run takes its budget from RUN_COMMAND_BUDGET_MS on the monotonic clock", () => {
  assert.match(
    runMatch[0],
    /const budget = makeCommandBudget\(RUN_COMMAND_BUDGET_MS, monotonicNow\);/,
    "the budget must be taken before anything can spend the window, on the monotonic clock " +
      "(a wall clock jump either refuses a run that did nothing wrong or extends it past the relay)",
  );
  assert.match(
    runMatch[0],
    /budget\.bounded\(RUN_SERIALIZE_TIMEOUT_MS\)/,
    "the pre-flight serialization draws from the command budget, not its own fresh clock",
  );
});

// ---------------------------------------------------------------------------
// 5. THE UNSCOPED FULL RUN — `graph_run({})`, no to_node_id.
//
// The first cut of #1565 bounded only the scoped path and disclosed the unscoped one as
// deliberately out of scope, on the argument that abandoning an unbounded queue call
// risks claiming `queued` with no receipt. A review returned that as a P1. MEASURED
// against the shipped body, both halves of the argument turned out to be true and only
// one of them survives:
//
//   - the harm is REAL and identical to the scoped one. `graph_run({})` against a
//     frontend whose queue processor never answers never replied; the caller timed out
//     at 20,007 ms, retried on the advice of a message blaming a "backgrounded or
//     frozen" tab, and the retry queued at 20,022 ms while the FIRST run's post landed
//     at 21,011 ms — TWO full-graph renders from one user intent, on the MORE COMMON
//     path;
//   - and the receipt objection is real: `buildQueueAcceptResult` with no ids answers a
//     bare `{queued: true, batch_count: N}` — a definite positive with nothing behind it.
//
// What resolves it is that the honest vocabulary already existed. `queued_unknown` was
// built for exactly this epistemic state on the scoped path, so the bound routes into it
// rather than into a `queued` the run cannot back.
// ---------------------------------------------------------------------------

/**
 * A frontend for the UNSCOPED path.
 * @param {"late"|"never"|"silent"|"postThenHang"} mode
 *   late         posts and settles after drainMs (healthy)
 *   never        never settles; posts drainMs later (the busy processor)
 *   silent       never settles, never posts
 *   postThenHang posts and captures a prompt_id, then never settles (partial batch)
 */
function makeUnscopedFrontend({ apiTarget, mode, drainMs = 5 }) {
  const app = {
    queueItems: [],
    graph: { _nodes: [] },
    graphToPrompt: async () => ({ output: OUR_OUTPUT, workflow: {} }),
    queuePrompt: async (_number, batch = 1) => {
      const post = () =>
        apiTarget.fetchApi("/prompt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: OUR_OUTPUT, client_id: "x" }),
        });
      if (mode === "silent") return new Promise(() => {});
      if (mode === "postThenHang") {
        await post();
        return new Promise(() => {});
      }
      if (mode === "never") {
        const t = setTimeout(post, drainMs);
        if (typeof t.unref === "function") t.unref();
        return new Promise(() => {});
      }
      for (let i = 0; i < Math.max(1, Math.floor(Number(batch)) || 1); i++) await post();
      return true;
    },
  };
  return app;
}

test("#1565 P1: a full run whose queue call never settles ANSWERS inside its budget — it does not hang to the relay timeout", async () => {
  const stop = keepAlive();
  try {
    const apiTarget = { fetchApi: makeServer() };
    const app = makeUnscopedFrontend({ apiTarget, mode: "never", drainMs: 60000 });
    const built = realGraphRun({ app, apiTarget, budgetMs: 600, serializeMs: 400 });
    const started = Date.now();
    const answer = await Promise.race([
      built.graph_run({}).then((r) => ({ replied: r })),
      new Promise((r) => setTimeout(() => r({ hung: true }), 5000)),
    ]);
    assert.ok(
      !answer.hung,
      "graph_run({}) never replied — the unbounded queue call is the reported hang, on the " +
        "MORE COMMON path: the caller then times out and retries, and the late post still lands",
    );
    assert.ok(Date.now() - started <= 5000);
  } finally {
    stop();
  }
});

test("#1565 P1: an abandoned full run NEVER answers a bare queued:true — the receipt objection, honoured", async () => {
  const stop = keepAlive();
  try {
    const apiTarget = { fetchApi: makeServer() };
    const app = makeUnscopedFrontend({ apiTarget, mode: "silent" });
    const built = realGraphRun({ app, apiTarget, budgetMs: 600, serializeMs: 400 });
    const res = await built.graph_run({});
    // buildQueueAcceptResult with no ids answers {queued:true, batch_count:N}. Routing an
    // abandoned run through it would assert a render nobody observed.
    assert.notEqual(res.queued, true, "a run with no receipt must never claim it queued");
    assert.equal(res.queued_unknown, true, "it takes the honest shape the scoped path already uses");
    assert.equal("queued" in res, false, "and OMITS `queued` — there is no boolean that means unknown");
    assert.match(String(res.retry_guidance), /blind retry renders the whole graph twice/);
  } finally {
    stop();
  }
});

test("#1565 P1: `queued:false` is never earned by an abandoned run — a bounded observation cannot license an unbounded negative", async () => {
  const stop = keepAlive();
  try {
    const apiTarget = { fetchApi: makeServer() };
    const server = apiTarget.fetchApi;
    // Nothing has left the panel when the budget expires — but the queue call is STILL
    // RUNNING and posts afterwards. Measured on the real body: answered at 1.5 s with
    // posted === 0, and the post left at 21 s anyway. Telling the caller "nothing was
    // queued, safe to re-issue" there moves the duplicate render rather than removing it.
    const app = makeUnscopedFrontend({ apiTarget, mode: "never", drainMs: 400 });
    const built = realGraphRun({ app, apiTarget, budgetMs: 250, serializeMs: 150 });
    const res = await built.graph_run({});
    assert.equal(server.calls.length, 0, "nothing had left the panel at the moment of the reply");
    assert.notEqual(
      res.queued,
      false,
      "`queued:false` says the run can be re-issued safely; the frontend can still post it",
    );
    assert.equal(res.queued_unknown, true);
    assert.match(String(res.retry_guidance), /STILL RUNNING/);
    // And the late post does arrive, which is exactly why the negative was not honest.
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(server.calls.length, 1, "the abandoned queue call posted after the reply");
  } finally {
    stop();
  }
});

test("#1565 P1: prompts that DID queue before the budget expired are reported with their real ids", async () => {
  const stop = keepAlive();
  try {
    const apiTarget = { fetchApi: makeServer() };
    const app = makeUnscopedFrontend({ apiTarget, mode: "postThenHang" });
    const built = realGraphRun({ app, apiTarget, budgetMs: 600, serializeMs: 400 });
    const res = await built.graph_run({});
    // Reporting this as a failure would send the caller to re-run work that is rendering.
    assert.equal(res.queued, true);
    assert.equal(res.partially_queued, true);
    assert.deepEqual(res.queued_prompt_ids, ["srv-1"]);
    assert.equal(res.complete, false);
    assert.match(String(res.incomplete_reason), /command budget/);
  } finally {
    stop();
  }
});

test("#1565 P1: a HEALTHY full run is untouched — same accept result, no budget in sight", async () => {
  const stop = keepAlive();
  try {
    const apiTarget = { fetchApi: makeServer() };
    const app = makeUnscopedFrontend({ apiTarget, mode: "late", drainMs: 5 });
    const built = realGraphRun({ app, apiTarget, budgetMs: 15000, serializeMs: 8000 });
    const res = await built.graph_run({});
    assert.deepEqual(res, { queued: true, batch_count: 1, prompt_id: "srv-1" });
  } finally {
    stop();
  }
});

test("#1690 production path: a full run without a prompt_id is outcome-unknown, never queued:true", async () => {
  const stop = keepAlive();
  try {
    const apiTarget = { fetchApi: makeServerWithoutPromptId() };
    const app = makeUnscopedFrontend({ apiTarget, mode: "late" });
    const built = realGraphRun({ app, apiTarget, budgetMs: 15000, serializeMs: 8000 });
    const res = await built.graph_run({});
    assert.equal(apiTarget.fetchApi.calls.length, 1, "the production queue path made one /prompt request");
    assert.equal(res.queued_unknown, true);
    assert.notEqual(res.queued, true, "a queue acknowledgement without a receipt must not claim success");
    assert.equal(res.prompt_id, undefined);
    assert.match(String(res.error), /prompt_id/);
  } finally {
    stop();
  }
});

test("#1690 production path: a blank plus valid batch receipt is outcome-unknown, never queued:true", async () => {
  const stop = keepAlive();
  try {
    const apiTarget = {
      fetchApi: makeServerSequence([{ prompt_id: "   " }, { prompt_id: "p2" }]),
    };
    const app = makeUnscopedFrontend({ apiTarget, mode: "late" });
    const built = realGraphRun({ app, apiTarget, budgetMs: 15000, serializeMs: 8000 });
    const res = await built.graph_run({ batch_count: 2 });
    assert.equal(apiTarget.fetchApi.calls.length, 2, "the production batch path made both /prompt requests");
    assert.equal(res.queued_unknown, true);
    assert.notEqual(res.queued, true, "one unusable receipt taints the whole batch acknowledgement");
    assert.equal(res.prompt_id, "p2", "the valid receipt remains available for correlation");
    assert.equal(res.queued_count, 1);
    assert.equal(res.indeterminate_count, 1);
  } finally {
    stop();
  }
});

test("#1690 production path: a missing receipt with node errors stays queued_unknown", async () => {
  const stop = keepAlive();
  try {
    const nodeErrors = { "9": { errors: [{ message: "stale validation metadata" }] } };
    const apiTarget = { fetchApi: makeServerSequence([{ node_errors: nodeErrors }]) };
    const app = makeUnscopedFrontend({ apiTarget, mode: "late" });
    // This is the frontend fallback channel under review: it is populated even
    // though the current 200 response did not provide a usable receipt.
    app.lastNodeErrors = nodeErrors;
    const built = realGraphRun({ app, apiTarget, budgetMs: 15000, serializeMs: 8000 });
    const res = await built.graph_run({});
    assert.equal(res.queued_unknown, true);
    assert.equal(res.queued, undefined, "missing receipt must not become queued:false from stale node errors");
    assert.notEqual(res.queued, false);
    assert.match(String(res.error), /prompt_id|acknowledgement/i);
  } finally {
    stop();
  }
});

test("#1690 production path: a definitive refusal beats another batch item's missing receipt", async () => {
  const stop = keepAlive();
  try {
    const apiTarget = {
      fetchApi: makeServerSequence([
        {},
        {
          status: 400,
          body: { error: { type: "prompt_outputs_failed_validation", message: "definitive refusal" } },
        },
      ]),
    };
    const app = makeUnscopedFrontend({ apiTarget, mode: "late" });
    const built = realGraphRun({ app, apiTarget, budgetMs: 15000, serializeMs: 8000 });
    const res = await built.graph_run({ batch_count: 2 });
    assert.equal(apiTarget.fetchApi.calls.length, 2, "the production batch path observed both /prompt responses");
    assert.equal(res.queued, false, "a definitive refusal remains a refusal for the whole acknowledgement");
    assert.equal(res.queued_unknown, undefined);
    assert.match(String(res.error), /definitive refusal|prompt_outputs_failed_validation/i);
  } finally {
    stop();
  }
});

test("#1565 P1: the run interceptor COUNTS what left the panel, so the reply states it rather than assuming it", async () => {
  const stop = keepAlive();
  try {
    let release;
    const gate = new Promise((r) => (release = r));
    const inner = async (route, options) => {
      await gate;
      return { status: 200, clone: () => ({ json: async () => ({ prompt_id: "p1" }) }), text: async () => "{}" };
    };
    const interceptor = createRunFetchInterceptor({ origFetchApi: inner });
    assert.deepEqual(interceptor.state, { posted: 0, inFlight: 0, missingPromptIds: 0 });
    const post = interceptor("/prompt", { method: "POST", body: JSON.stringify({ prompt: {} }) });
    assert.deepEqual(interceptor.state, { posted: 1, inFlight: 1, missingPromptIds: 0 }, "counted BEFORE the request leaves");
    release();
    await post;
    assert.deepEqual(interceptor.state, { posted: 1, inFlight: 0, missingPromptIds: 0 }, "and settled when it answers");
    // A non-prompt request is never counted as this run's work.
    await interceptor("/queue", { method: "GET" });
    assert.deepEqual(interceptor.state, { posted: 1, inFlight: 0, missingPromptIds: 0 });
  } finally {
    stop();
  }
});

test("#1565 P1: an unreadable request cannot stop a fetch that previously went out", async () => {
  const stop = keepAlive();
  try {
    let reached = false;
    const inner = async () => {
      reached = true;
      return { status: 200, clone: () => ({ json: async () => ({}) }), text: async () => "{}" };
    };
    const interceptor = createRunFetchInterceptor({ origFetchApi: inner });
    // Classification moved BEFORE the await, so a throwing `options` must not become a
    // request that never leaves — this used to run only after the fetch.
    const hostile = new Proxy({}, { get() { throw new Error("hostile options"); } });
    await interceptor("/prompt", hostile);
    assert.equal(reached, true, "the request still went out");
    assert.equal(interceptor.state.posted, 0, "it simply is not counted");
  } finally {
    stop();
  }
});
