/**
 * #1739 — on an install with 8534 node types `panel_set_widget` refused EVERY write, and
 * the refusal said the type-scoped `/object_info/<Type>` read had timed out on a URL the
 * reporter measured by hand at 1.2–12 ms, reproducibly, on the same machine at the same
 * time. Run with `node --test`.
 *
 * The measurements from the report:
 *
 *     GET /object_info                     -> 200  16.08 s   51,957,409 bytes
 *     GET /object_info/CyberpunkWindowNode -> 200   0.0013 s       6,821 bytes
 *
 * THE TYPE-SCOPED READ WAS NOT SLOW. It was queued behind two whole-map computations the
 * PANEL had left running on a backend that can only do one thing at a time. ComfyUI's own
 * `server.py`:
 *
 *     @routes.get("/object_info")
 *     async def get_object_info(request):
 *         asset_seeder.start(...)
 *         with folder_paths.cache_helper:
 *             out = {}
 *             for x in nodes.NODE_CLASS_MAPPINGS:
 *                 out[x] = node_info(x)
 *             return web.json_response(out)
 *
 *     @routes.get("/object_info/{node_class}")        # twelve lines below it
 *     async def get_object_info_node(request): ...
 *
 * There is no `await` anywhere in the first body. It blocks aiohttp's single event loop for
 * as long as it runs, and while it runs the second route cannot be served at all. So the
 * ONE route that can answer an install this size was starved by the two that provably
 * cannot — and #1560's last resort, written for exactly this backend, never got a turn.
 *
 * The oracle now CANCELS its raw `GET /object_info` when it stops waiting on it. That
 * request is pure cost on such a backend: it is only issued after the client route has
 * already spent its whole share, so it starts behind a computation of the identical
 * document that is still running, and its own share is smaller than the one that just
 * expired. Dropping it hands the loop back to the question that can be answered.
 *
 * THE BACKEND BELOW IS A MODEL, AND ITS ONE ASSUMPTION IS STATED. A queued request that is
 * aborted before the loop reaches it is never dispatched (aiohttp reads a closed
 * connection); a request the loop has ALREADY started keeps the loop until its synchronous
 * body returns, because nothing can cancel a Python `for` loop from the client side. Both
 * halves are modelled, and the second is why `getNodeDefs` — which takes no signal and goes
 * first — is not cancelled and does not need to be.
 *
 * Everything runs on a VIRTUAL clock so the SHIPPED constants can be used verbatim: a test
 * that rescales the budgets proves something about numbers the panel does not have.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  fetchWholeObjectInfo,
  OBJECT_INFO_DEADLINE_MS,
  TRANSPORT_OUTCOME,
} from "../../web/js/lib/object-info-oracle.js";
import {
  fetchTypeScopedObjectInfo,
  SCOPED_OBJECT_INFO_DEADLINE_MS,
} from "../../web/js/lib/scoped-object-info.js";
import { noBackendAnswerEstablished } from "../../web/js/lib/object-info-snapshot.js";
import { runSetWidget } from "../../web/js/lib/set-widget.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const HOOKS = { beforeChange() {}, afterChange() {}, setDirty() {} };

/** The reporter's own numbers, so the arithmetic below is theirs and not an invention. */
const WHOLE_MAP_MS = 16080;
const PER_CLASS_MS = 12;
const REPORTED_TYPE = "CyberpunkWindowNode";

// ─────────────────────────────────────── virtual clock ───────────────────────────────────

/**
 * A monotonic clock plus the `{setTimer, clearTimer}` pair `bounded-step.js` accepts, so
 * every wait in this file — the oracle's, the scoped read's, and the fake backend's own
 * work — is measured against ONE timeline that the test advances by hand.
 */
function makeVirtualClock() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    now: () => now,
    at: () => now,
    timers: {
      setTimer(fn, delay) {
        const id = (seq += 1);
        pending.set(id, { at: now + Math.max(0, Number(delay) || 0), fn, seq: id });
        return id;
      },
      clearTimer(id) {
        pending.delete(id);
      },
    },
    hasTimers: () => pending.size > 0,
    /** Fire the single earliest timer, ties broken by arming order. */
    advance() {
      let pick = null;
      for (const [id, t] of pending) {
        if (!pick || t.at < pick.t.at || (t.at === pick.t.at && t.seq < pick.t.seq)) pick = { id, t };
      }
      if (!pick) return false;
      pending.delete(pick.id);
      now = Math.max(now, pick.t.at);
      pick.t.fn();
      return true;
    },
  };
}

const turn = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Run `promise` to completion, advancing the virtual clock whenever nothing else can make
 * progress. A settle-check between every step is what keeps a test from firing timers the
 * production code has already cleared.
 */
async function drive(clock, promise) {
  let settled = false;
  let value;
  let failure = null;
  promise.then(
    (v) => {
      settled = true;
      value = v;
    },
    (e) => {
      settled = true;
      failure = e ?? new Error("rejected with no value");
    },
  );
  for (let guard = 0; guard < 100000; guard += 1) {
    await turn();
    if (settled) break;
    if (!clock.advance()) {
      await turn();
      if (settled) break;
      if (!clock.hasTimers()) throw new Error(`nothing left to run at t=${clock.now()}ms and nothing settled`);
    }
  }
  if (!settled) throw new Error("the driven promise never settled");
  if (failure) throw failure;
  return value;
}

// ─────────────────────────────────── the modelled backend ────────────────────────────────

/**
 * ComfyUI as it actually serves these two routes: ONE lane, first come first served, and a
 * whole-map request that owns the lane for its entire computation.
 */
function singleLaneComfyUI(clock, { defined = [REPORTED_TYPE] } = {}) {
  const queue = [];
  let running = null;
  /** Routes in the order the event loop actually RAN them. */
  const served = [];
  /** Routes that were abandoned before the loop ever reached them. */
  const dropped = [];
  const wholeSchema = Object.fromEntries(defined.map((t) => [t, { input: { required: {} } }]));

  const pump = () => {
    if (running || queue.length === 0) return;
    const job = queue.shift();
    running = job;
    served.push(job.route);
    clock.timers.setTimer(() => {
      running = null;
      job.resolve(job.respond());
      pump();
    }, job.cost);
  };

  const enqueue = (route, cost, respond, signal) =>
    new Promise((resolve, reject) => {
      const job = { route, cost, respond, resolve, reject };
      queue.push(job);
      if (signal) {
        const onAbort = () => {
          const i = queue.indexOf(job);
          // ALREADY RUNNING is deliberately a no-op: a synchronous Python handler cannot be
          // cancelled from here, so the lane stays held until its body returns.
          if (i < 0) return;
          queue.splice(i, 1);
          dropped.push(route);
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          reject(err);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort);
      }
      pump();
    });

  const perClassBody = (type) => (defined.includes(type) ? { [type]: { input: { required: {} } } } : {});

  return {
    served,
    dropped,
    wholeSchema,
    /** The frontend client's whole-map read. Takes no signal — it is the frontend's own. */
    getNodeDefs: () => enqueue("/object_info", WHOLE_MAP_MS, () => wholeSchema, undefined),
    fetchApi: (route, init) => {
      const signal = init?.signal;
      if (route === "/object_info") {
        return enqueue(route, WHOLE_MAP_MS, () => ({ ok: true, status: 200, json: async () => wholeSchema }), signal);
      }
      const m = /^\/object_info\/(.+)$/.exec(route);
      if (!m) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      const type = decodeURIComponent(m[1]);
      return enqueue(
        route,
        PER_CLASS_MS,
        () => ({ ok: true, status: 200, json: async () => perClassBody(type) }),
        signal,
      );
    },
  };
}

/** The panel's own wiring, in shape: the whole-map oracle, then the licensed scoped read. */
function panelShapedCapabilities(clock, backend) {
  let outcomes = [];
  return {
    outcomesNow: () => outcomes,
    getFreshObjectInfo: async () => {
      const result = await fetchWholeObjectInfo({
        getNodeDefs: () => backend.getNodeDefs(),
        fetchApi: (route, init) => backend.fetchApi(route, init),
        deadlineMs: OBJECT_INFO_DEADLINE_MS,
        timers: clock.timers,
        now: clock.now,
      });
      outcomes = result.outcomes ?? [];
      return result.defs;
    },
    fetchScopedObjectInfo: async (types) => {
      if (!noBackendAnswerEstablished(outcomes)) {
        return { defs: null, covered: [], reason: "a whole-schema route ANSWERED rather than going silent" };
      }
      return fetchTypeScopedObjectInfo(types, {
        fetchApi: (route, init) => backend.fetchApi(route, init),
        deadlineMs: SCOPED_OBJECT_INFO_DEADLINE_MS,
        timers: clock.timers,
      });
    },
  };
}

function regEntry() {
  const ctor = function NodeCtor() {};
  ctor.nodeData = { input: { required: {} } };
  return ctor;
}

// ────────────────────────────────────────── tests ────────────────────────────────────────

test("#1739 the reported install: the write the reporter could never land now lands", async () => {
  const clock = makeVirtualClock();
  const backend = singleLaneComfyUI(clock);
  const caps = panelShapedCapabilities(clock, backend);
  const reg = { [REPORTED_TYPE]: regEntry() };
  const node = {
    id: 58,
    type: REPORTED_TYPE,
    widgets: [{ name: "width", type: "INT", value: 512 }],
    constructor: { nodeData: { input: { required: {} } } },
  };

  const { set } = await drive(
    clock,
    runSetWidget(node, "width", 768, {
      registry: reg,
      getRegistry: () => reg,
      getFreshObjectInfo: caps.getFreshObjectInfo,
      fetchScopedObjectInfo: caps.fetchScopedObjectInfo,
      wasTypeEverDefined: () => false,
      ...HOOKS,
    }),
  );

  assert.equal(set.value, 768, "the #458 fence authorized the write from the type-scoped read");
  assert.equal(node.widgets[0].value, 768);

  // WHAT THE BACKEND ACTUALLY DID, which is the whole claim of this issue.
  assert.deepEqual(
    backend.dropped,
    ["/object_info"],
    "the abandoned whole-map request was dropped before the event loop ever reached it",
  );
  assert.deepEqual(
    backend.served,
    ["/object_info", `/object_info/${REPORTED_TYPE}`],
    "the loop ran the client route's fetch and then the per-class read — never a SECOND " +
      "whole map, which is the 16 s of blocking that used to starve the read that works",
  );
  assert.ok(
    clock.now() < OBJECT_INFO_DEADLINE_MS + SCOPED_OBJECT_INFO_DEADLINE_MS,
    `the whole ladder settled at t=${clock.now()}ms, inside the command's window`,
  );
});

test("#1739 both whole-map routes still report SILENCE, so the scoped read stays licensed", async () => {
  const clock = makeVirtualClock();
  const backend = singleLaneComfyUI(clock);
  const result = await drive(
    clock,
    fetchWholeObjectInfo({
      getNodeDefs: () => backend.getNodeDefs(),
      fetchApi: (route, init) => backend.fetchApi(route, init),
      deadlineMs: OBJECT_INFO_DEADLINE_MS,
      timers: clock.timers,
      now: clock.now,
    }),
  );
  assert.equal(result.defs, null, "no whole map landed — fail closed, unchanged");
  assert.deepEqual(
    result.outcomes.map((o) => o.kind),
    [TRANSPORT_OUTCOME.NO_ANSWER, TRANSPORT_OUTCOME.NO_ANSWER],
    "cancelling a request we stopped waiting on must not turn SILENCE into an ANSWER — " +
      "the scoped read and #1223's snapshot are both licensed on exactly that difference",
  );
  assert.ok(
    noBackendAnswerEstablished(result.outcomes),
    "the silence licence the type-scoped route needs still holds after the cancel",
  );
});

test("#1739 an AbortError from the cancelled route never escapes the oracle", async () => {
  // The oracle documents that every failure path returns `defs: null`, and two callers await
  // it with no catch of their own. Cancelling introduces a NEW rejection into that path.
  const clock = makeVirtualClock();
  const backend = singleLaneComfyUI(clock);
  const result = await drive(
    clock,
    fetchWholeObjectInfo({
      getNodeDefs: null,
      fetchApi: (route, init) => backend.fetchApi(route, init),
      deadlineMs: OBJECT_INFO_DEADLINE_MS,
      timers: clock.timers,
      now: clock.now,
    }),
  );
  assert.equal(result.defs, null);
  assert.ok(
    result.failures.some((f) => /GET \/object_info did not answer/.test(f)),
    "the refusal still names the route that went silent, not the abort we issued ourselves",
  );
});

test("#1739 a fetchApi that takes only a route is called exactly as before", async () => {
  // Every test double in this repo, and three of the panel's own wirings before this change,
  // declare `(route) => ...`. Threading an init must not change what they observe.
  const seen = [];
  const schema = { KSampler: { input: {} } };
  const result = await fetchWholeObjectInfo({
    getNodeDefs: null,
    fetchApi: async (...args) => {
      seen.push(args);
      return { ok: true, status: 200, json: async () => schema };
    },
  });
  assert.deepEqual(result.defs, schema, "the fallback still answers");
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], "/object_info");
});

test("#1739 a runtime with no AbortController still fetches, and still fails closed", async () => {
  const original = globalThis.AbortController;
  // eslint-disable-next-line no-global-assign
  delete globalThis.AbortController;
  try {
    const seen = [];
    const schema = { KSampler: { input: {} } };
    const result = await fetchWholeObjectInfo({
      getNodeDefs: null,
      fetchApi: async (route, init) => {
        seen.push({ route, init });
        return { ok: true, status: 200, json: async () => schema };
      },
    });
    assert.deepEqual(result.defs, schema);
    assert.equal(seen[0].init, undefined, "no controller means no init — never a half-built one");
  } finally {
    globalThis.AbortController = original;
  }
});

test("#1739 the PANEL forwards the init at every whole-map wiring, or the cancel is inert", async () => {
  // A one-line wiring change is invisible to a helper-level test: the oracle can cancel
  // perfectly while `api.fetchApi(route)` drops the signal on the floor and the reporter
  // sees no change at all. This asserts the CALL SITES.
  const src = readFileSync(PANEL_JS, "utf8");
  // The EXACT option literal every one of these wirings is written as, so this cannot
  // false-fire on some unrelated `(route) => api.fetchApi(route)` elsewhere in the file.
  const dropped = `fetchApi: typeof api?.fetchApi === "function" ? (route) => api.fetchApi(route) : null`;
  const forwards = `fetchApi: typeof api?.fetchApi === "function" ? (route, init) => api.fetchApi(route, init) : null`;
  assert.equal(
    src.includes(dropped),
    false,
    "an /object_info wiring that drops the second argument silently disables the cancel",
  );
  const forwarded = src.split(forwards).length - 1;
  assert.ok(forwarded >= 5, `expected every oracle/scoped wiring to forward the init, found ${forwarded}`);
});
