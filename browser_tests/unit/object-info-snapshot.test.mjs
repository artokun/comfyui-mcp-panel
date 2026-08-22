/**
 * #1223 — `panel_set_widget` refused a live edit on an existing `H3Keyframes` node because
 * BOTH `/object_info` probes timed out, while the canvas was reachable and `panel_disconnect`
 * mutations had succeeded moments earlier. ComfyUI serves HTTP from the process that runs
 * the graph, so a render blocks the schema fetch: a BUSY backend, not an absent one.
 *
 * The fix authorizes from the last WHOLE schema observed on the CURRENT backend connection,
 * under four conditions that all fail closed. These tests keep each condition load-bearing —
 * every one is the difference between this and re-opening #458.
 *
 * SEVERAL OF THESE EXIST BECAUSE THE FIRST VERSION SHIPPED THE BUG THEY NOW PIN. Review
 * found that the snapshot was never populated on a normal startup (so the reported case was
 * still refused), that the epoch was read AFTER the fetch (so a pre-restart schema could be
 * filed under post-restart provenance), and that the clear it relied on never ran because
 * the reconnect's refresh is coalesced away. Those three have named tests below.
 *
 * The last block drives the SHIPPED `getFreshObjectInfo` body extracted from the panel, not
 * a re-implementation of it. A test that reasons about a copy of the wiring proves the copy.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  createObjectInfoSnapshot,
  noBackendAnswerEstablished,
  snapshotAuthorizationNote,
} from "../../web/js/lib/object-info-snapshot.js";
import { runSetWidget } from "../../web/js/lib/set-widget.js";
import {
  TRANSPORT_OUTCOME,
  fetchWholeObjectInfo,
  objectInfoOracleFailureNote,
  OBJECT_INFO_DEADLINE_MS,
} from "../../web/js/lib/object-info-oracle.js";
import { createObjectInfoCache, CACHE_OUTCOME } from "../../web/js/lib/object-info-cache.js";
import { makeCommandBudget } from "../../web/js/lib/command-budget.js";

const SCHEMA = { KSampler: { input: {} }, H3Keyframes: { input: {} } };
const silence = [
  { route: "client", kind: TRANSPORT_OUTCOME.NO_ANSWER },
  { route: "http", kind: TRANSPORT_OUTCOME.NO_ANSWER },
];
/** The v2 record contract: an epoch captured before the fetch, unchanged since, and a claim. */
const stored = (snap, defs = SCHEMA, epoch = 3) =>
  snap.record(defs, { observedAtEpoch: epoch, currentEpoch: epoch, whole: true });

// ---------------------------------------------------------------------------
// Condition 4: the backend never ANSWERED
// ---------------------------------------------------------------------------

test("#1223 both probes timing out is the silence this licenses", () => {
  assert.equal(noBackendAnswerEstablished(silence), true);
});

test("#1223 a route that THREW disqualifies — a refused connection is a process that is gone", () => {
  // `TypeError: Failed to fetch` is what ECONNREFUSED produces in a browser. That is the
  // signature of a backend that is DOWN, and a down backend may be restarting — the one
  // event that can change the type set. Silence is the signature of one that is busy.
  assert.equal(
    noBackendAnswerEstablished([
      { route: "client", kind: TRANSPORT_OUTCOME.NO_ANSWER },
      { route: "http", kind: TRANSPORT_OUTCOME.THREW },
    ]),
    false,
  );
});

test("#1223 a route that ANSWERED something unusable disqualifies", () => {
  assert.equal(
    noBackendAnswerEstablished([
      { route: "client", kind: TRANSPORT_OUTCOME.NO_ANSWER },
      { route: "http", kind: TRANSPORT_OUTCOME.ANSWERED_UNUSABLE },
    ]),
    false,
  );
});

test("#1223 a client that returned NOTHING leaves the question unanswered, and licenses", () => {
  // Review finding: tagging this ANSWERED_UNUSABLE contradicted the oracle's own stated
  // semantics ("Only a client that returned NOTHING (null/undefined/non-object) or threw
  // leaves the question unanswered") and made the whole fix inert on any frontend whose
  // getNodeDefs swallows its failure and resolves undefined. It failed closed, so it was
  // not dangerous — it just never fired.
  assert.equal(
    noBackendAnswerEstablished([
      { route: "client", kind: TRANSPORT_OUTCOME.NOTHING_RETURNED },
      { route: "http", kind: TRANSPORT_OUTCOME.NO_ANSWER },
    ]),
    true,
  );
  assert.equal(
    noBackendAnswerEstablished([{ route: "client", kind: TRANSPORT_OUTCOME.NOTHING_RETURNED }]),
    true,
    "and on its own, when no fallback transport is wired",
  );
});

test("#1223 never-contacted routes are neutral, but cannot license on their own", () => {
  assert.equal(
    noBackendAnswerEstablished([
      { route: "client", kind: TRANSPORT_OUTCOME.NOT_ATTEMPTED },
      { route: "http", kind: TRANSPORT_OUTCOME.NO_ANSWER },
    ]),
    true,
  );
  assert.equal(
    noBackendAnswerEstablished([
      { route: "client", kind: TRANSPORT_OUTCOME.NOT_ATTEMPTED },
      { route: "http", kind: TRANSPORT_OUTCOME.NOT_ATTEMPTED },
    ]),
    false,
    "nothing was ever asked, so nothing was observed",
  );
});

test("#1223 an absent, empty, or unrecognised outcome list licenses nothing", () => {
  assert.equal(noBackendAnswerEstablished(undefined), false);
  assert.equal(noBackendAnswerEstablished([]), false);
  assert.equal(noBackendAnswerEstablished("no-answer"), false);
  assert.equal(noBackendAnswerEstablished([{ route: "client", kind: "invented" }]), false);
  assert.equal(noBackendAnswerEstablished([null, { kind: TRANSPORT_OUTCOME.NO_ANSWER }]), false);
  assert.equal(noBackendAnswerEstablished(["no-answer", "no-answer"]), false, "bare strings are not outcomes");
});

test("#1223 EACH route's tag is pinned on its own, not through the aggregate", async () => {
  // Mutation-driven. Asserting only the aggregate over a TWO-route failure lets one correct
  // tag mask a wrong one: mistagging the client's THREW as silence survived, because the
  // http route's own THREW still carried the verdict.
  const kinds = async (opts) => (await fetchWholeObjectInfo({ deadlineMs: 40, ...opts })).outcomes.map((o) => o.kind);

  assert.deepEqual(
    await kinds({
      getNodeDefs: async () => {
        throw new TypeError("Failed to fetch");
      },
      fetchApi: null,
    }),
    [TRANSPORT_OUTCOME.THREW, TRANSPORT_OUTCOME.NOT_ATTEMPTED],
    "a refused connection on the client route is an ANSWER, never silence",
  );

  assert.deepEqual(
    await kinds({ getNodeDefs: null, fetchApi: async () => ({ ok: false, status: 500 }) }),
    [TRANSPORT_OUTCOME.NOT_ATTEMPTED, TRANSPORT_OUTCOME.ANSWERED_UNUSABLE],
    "a 500 is ComfyUI answering; an unwired client is a route nobody asked",
  );

  assert.deepEqual(
    await kinds({
      getNodeDefs: null,
      fetchApi: async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }),
    }),
    [TRANSPORT_OUTCOME.NOT_ATTEMPTED, TRANSPORT_OUTCOME.ANSWERED_UNUSABLE],
    "headers arrived, so the backend answered — a stalled BODY is not silence",
  );

  assert.deepEqual(
    await kinds({ getNodeDefs: async () => ({}), fetchApi: async () => ({ ok: true, json: async () => SCHEMA }) }),
    [TRANSPORT_OUTCOME.ANSWERED_UNUSABLE],
    "an EMPTY client schema is its answer (#982), and it short-circuits before the fallback",
  );

  assert.deepEqual(
    await kinds({ getNodeDefs: async () => undefined, fetchApi: null }),
    [TRANSPORT_OUTCOME.NOTHING_RETURNED, TRANSPORT_OUTCOME.NOT_ATTEMPTED],
    "resolving undefined is NOT an answer — it is the question left unanswered",
  );

  assert.deepEqual(
    await kinds({ getNodeDefs: () => new Promise(() => {}), fetchApi: null }),
    [TRANSPORT_OUTCOME.NO_ANSWER, TRANSPORT_OUTCOME.NOT_ATTEMPTED],
    "and a hung client with no fallback wired is the canonical shape",
  );
});

test("#1223 a PROXY gateway error is the backend not answering, not the backend answering", async () => {
  // ComfyUI behind nginx/Caddy is the standard remote and RunPod shape. The proxy answers a
  // hung upstream with 502/504 after its own read timeout — the same event as a bare
  // timeout, arriving over HTTP. Counting it as an answer disabled the fix for every
  // proxied install AND blamed the backend for a message it never sent.
  const kinds = async (status) =>
    (
      await fetchWholeObjectInfo({
        deadlineMs: 40,
        getNodeDefs: () => new Promise(() => {}),
        fetchApi: async () => ({ ok: false, status }),
      })
    ).outcomes.map((o) => o.kind);

  assert.deepEqual(
    await kinds(504),
    [TRANSPORT_OUTCOME.NO_ANSWER, TRANSPORT_OUTCOME.NO_ANSWER],
    "504 Gateway Timeout: the proxy CONNECTED and the upstream did not answer in time",
  );
  // 502 is deliberately NOT in the set, and this is the correction review forced. nginx and
  // Caddy emit it IMMEDIATELY when they cannot CONNECT to a stopped or restarting ComfyUI —
  // evidence the process is GONE, the opposite of what this licenses on. Counting it as
  // silence let a pre-restart schema authorize a write to a type the restart removed, on any
  // frontend whose getNodeDefs swallows its own network error.
  //
  // 503 is excluded because ComfyUI itself can serve it, so it is not unambiguously a proxy.
  for (const status of [502, 503, 500]) {
    assert.deepEqual(
      await kinds(status),
      [TRANSPORT_OUTCOME.NO_ANSWER, TRANSPORT_OUTCOME.ANSWERED_UNUSABLE],
      `status ${status} is an ANSWER, not silence`,
    );
  }
});

test("#1223 a 502 cannot license the fallback even when every other route went quiet", () => {
  // The exact shape from review: a client that swallows its error and returns nothing, plus
  // a proxy 502 arriving BEFORE the websocket-down event. Every gate except this one is
  // satisfied, so the tag is the only thing standing between it and a #458 regression.
  assert.equal(
    noBackendAnswerEstablished([
      { route: "client", kind: TRANSPORT_OUTCOME.NOTHING_RETURNED },
      { route: "http", kind: TRANSPORT_OUTCOME.ANSWERED_UNUSABLE },
    ]),
    false,
  );
});

test("#1223 an UNSTABLE status cannot classify as silence while reporting a disqualifying code", async () => {
  // This module deliberately supports a monkey-patched fetchApi returning a proxied or
  // getter-backed response — its own comments say so — and such a response can answer
  // differently on each read. Two reads let a first value of 504 license the fallback while
  // the second, 502, is what the reply names: the decision and the disclosure would then
  // describe different responses, and the licensing one is invisible to the reader.
  let reads = 0;
  const flipflop = {
    ok: false,
    get status() {
      reads += 1;
      return reads === 1 ? 504 : 502;
    },
  };
  const { outcomes, failures } = await fetchWholeObjectInfo({
    deadlineMs: 40,
    getNodeDefs: null,
    fetchApi: async () => flipflop,
  });
  const reported = /status (\d+)/.exec(failures.join(" "))?.[1];
  const silent = outcomes.at(-1).kind === TRANSPORT_OUTCOME.NO_ANSWER;
  assert.equal(
    silent,
    reported === "504",
    `classification and disclosure must describe the SAME response (reported ${reported}, silent=${silent})`,
  );
});

test("#1223 the gateway refusal SAYS it was a proxy, not the backend", async () => {
  const { failures } = await fetchWholeObjectInfo({
    deadlineMs: 40,
    getNodeDefs: null,
    fetchApi: async () => ({ ok: false, status: 504 }),
  });
  assert.match(failures.join(" "), /proxy in front of ComfyUI/i);
});

test("#1223 a usable answer still returns its outcomes alongside the schema", async () => {
  const { defs, outcomes } = await fetchWholeObjectInfo({ getNodeDefs: async () => SCHEMA, fetchApi: null });
  assert.equal(defs, SCHEMA);
  assert.deepEqual(outcomes, [], "the route that answered is not a failure, so nothing is tagged");
});

// ---------------------------------------------------------------------------
// Conditions 1-3: a vouched-for whole map, an unbroken connection, the same process
// ---------------------------------------------------------------------------

test("#1223 the reported case: silent probes on an unbroken connection authorize", () => {
  const snap = createObjectInfoSnapshot();
  assert.equal(stored(snap), true);
  const { defs, reason } = snap.authorize({ epoch: 3, socketDown: false, outcomes: silence });
  assert.equal(reason, "");
  assert.ok(defs, "the edit the reporter was refused is authorized");
  assert.ok(Object.prototype.hasOwnProperty.call(defs, "H3Keyframes"), "and the reported node type is in it");
});

test("#1582 a same-connection snapshot can shorten the live probe budget", () => {
  const snap = createObjectInfoSnapshot();
  assert.equal(stored(snap, SCHEMA, 3), true);
  assert.equal(snap.isReusable({ epoch: 3, socketDown: false }), true);
});

test("#1582 snapshot budget shortening keeps the reconnect and socket-down fences", () => {
  const empty = createObjectInfoSnapshot();
  assert.equal(empty.isReusable({ epoch: 3, socketDown: false }), false, "nothing observed cannot shorten a probe");

  const snap = createObjectInfoSnapshot();
  stored(snap, SCHEMA, 3);
  assert.equal(snap.isReusable({ epoch: 3, socketDown: true }), false, "a down socket may be restarting");
  assert.equal(snap.isReusable({ epoch: 4, socketDown: false }), false, "a new epoch may define different types");
  assert.equal(snap.isReusable({ epoch: 3, socketDown: false }), true, "the original connection is reusable");
});

test("#1582 the first silence does not skip — an answered error must still be able to refuse", () => {
  const snap = createObjectInfoSnapshot();
  stored(snap, SCHEMA, 3);
  assert.equal(
    snap.shouldSkipProbe({ epoch: 3, socketDown: false }),
    false,
    "holding a snapshot is not itself evidence the live routes went silent",
  );
});

test("#1582 after silence on a held snapshot, later probes may skip", () => {
  const snap = createObjectInfoSnapshot();
  stored(snap, SCHEMA, 3);
  snap.markProbesSilent();
  assert.equal(snap.shouldSkipProbe({ epoch: 3, socketDown: false }), true);
  const held = snap.authorize({ epoch: 3, socketDown: false, requireSilence: false });
  assert.ok(held.defs, "skipping the probe still authorizes from the held map");
  assert.ok(Object.prototype.hasOwnProperty.call(held.defs, "H3Keyframes"));
});

test("#1582 a skip still refuses a down socket, a reconnect, and an empty store", () => {
  const empty = createObjectInfoSnapshot();
  empty.markProbesSilent();
  assert.equal(empty.shouldSkipProbe({ epoch: 3, socketDown: false }), false, "silence without a map licenses nothing");

  const snap = createObjectInfoSnapshot();
  stored(snap, SCHEMA, 3);
  snap.markProbesSilent();
  assert.equal(snap.shouldSkipProbe({ epoch: 3, socketDown: true }), false, "a down socket may be restarting");
  assert.equal(snap.shouldSkipProbe({ epoch: 4, socketDown: false }), false, "a new epoch may define different types");
  snap.clear();
  assert.equal(snap.shouldSkipProbe({ epoch: 3, socketDown: false }), false, "clearing the snapshot clears the silence latch");
});

test("#1582 a later live record unlatches silence so the next write prefers a live schema", () => {
  const snap = createObjectInfoSnapshot();
  stored(snap, SCHEMA, 3);
  snap.markProbesSilent();
  assert.equal(snap.shouldSkipProbe({ epoch: 3, socketDown: false }), true);
  stored(snap, SCHEMA, 3);
  assert.equal(snap.shouldSkipProbe({ epoch: 3, socketDown: false }), false, "a live map means the routes answered again");
});

test("#1223 what is stored is DETACHED — registration hooks mutate defs in place", () => {
  // `registerNodesFromDefs` runs `beforeRegisterNodeDef` hooks that mutate the definitions
  // in place (Comfy's own upload hook adds an input the backend never declared). Retaining
  // the payload by reference would hand frontend-mutated data back as backend evidence.
  const live = { KSampler: { input: {} } };
  const snap = createObjectInfoSnapshot();
  stored(snap, live);
  live.KSampler.input.image = ["IMAGE", { image_upload: true }];
  live.InjectedByAnExtension = { input: {} };
  const { defs } = snap.authorize({ epoch: 3, socketDown: false, outcomes: silence });
  assert.equal(
    Object.prototype.hasOwnProperty.call(defs, "InjectedByAnExtension"),
    false,
    "a type added after the observation is not in the snapshot",
  );
  assert.deepEqual(defs.KSampler, {}, "and the def's own shape is not carried at all");
});

test("#1223 the stored map answers MEMBERSHIP only, so it cannot supply stale combo lists", () => {
  // The values being empty is what stops `refreshComboOptionsFromDefs` rewriting a live
  // dropdown backwards to an older option list (it does `w.options.values = first.slice()`),
  // and what makes `uploadInputConfig` / `serverDeclaresEmptyComboOptions` answer
  // conservatively.
  const snap = createObjectInfoSnapshot();
  stored(snap, { CheckpointLoaderSimple: { input: { required: { ckpt_name: [["old.safetensors"], {}] } } } });
  const { defs } = snap.authorize({ epoch: 3, socketDown: false, outcomes: silence });
  assert.deepEqual(defs.CheckpointLoaderSimple, {}, "no option list survives into the snapshot");
});

test("#1223 a type named __proto__ cannot reach Object.prototype", () => {
  // On a plain object `detached["__proto__"] = x` sets the prototype instead of creating an
  // own property — losing the type AND poisoning every object in the page.
  const snap = createObjectInfoSnapshot();
  stored(snap, { __proto__: { input: {} }, KSampler: {} });
  const { defs } = snap.authorize({ epoch: 3, socketDown: false, outcomes: silence });
  assert.equal({}.polluted, undefined, "nothing was written to Object.prototype");
  assert.ok(defs, "and the snapshot is still usable");
});

test("#1223 a DOWN socket refuses — a restarting backend is the one thing that moves the type set", () => {
  const snap = createObjectInfoSnapshot();
  stored(snap);
  const { defs, reason } = snap.authorize({ epoch: 3, socketDown: true, outcomes: silence });
  assert.equal(defs, null);
  assert.match(reason, /socket is down/i);
});

test("#1223 a RECONNECT since the observation refuses — it describes a replaced process", () => {
  const snap = createObjectInfoSnapshot();
  stored(snap);
  const { defs, reason } = snap.authorize({ epoch: 4, socketDown: false, outcomes: silence });
  assert.equal(defs, null);
  assert.match(reason, /reconnected/i);
  assert.ok(
    snap.authorize({ epoch: 3, socketDown: false, outcomes: silence }).defs,
    "and the SAME epoch still authorizes — age alone was never the question",
  );
});

test("#1223 a reconnect DURING the fetch is refused at record time", () => {
  // THE DEFECT THIS EXISTS FOR. The first version read the epoch at RECORD time, so a
  // schema fetched before a ComfyUI restart was filed under post-restart provenance and
  // would authorize a write to a type the new process no longer defines. The epoch must be
  // captured before the request goes out and re-checked when the answer lands.
  const snap = createObjectInfoSnapshot();
  assert.equal(
    snap.record(SCHEMA, { observedAtEpoch: 3, currentEpoch: 4, whole: true }),
    false,
    "the connection was replaced while this payload was in flight",
  );
  assert.equal(snap.peek().held, false);
  assert.equal(snap.authorize({ epoch: 4, socketDown: false, outcomes: silence }).defs, null);
});

test("#1223 a payload nobody vouched for as WHOLE is refused", () => {
  // A per-class /object_info/<Type> payload reaching the snapshot would make every other
  // type read as absent and the ever-seen gate diagnose the whole install as removed packs.
  // `record` cannot judge wholeness from the value, so it requires the claim.
  const snap = createObjectInfoSnapshot();
  assert.equal(snap.record(SCHEMA, { observedAtEpoch: 1, currentEpoch: 1 }), false);
  assert.equal(snap.record(SCHEMA, { observedAtEpoch: 1, currentEpoch: 1, whole: false }), false);
  assert.equal(snap.record(SCHEMA, { observedAtEpoch: 1, currentEpoch: 1, whole: "yes" }), false);
  assert.equal(snap.peek().held, false);
});

test("#1223 an unreadable epoch refuses, at record time and at authorize time", () => {
  const snap = createObjectInfoSnapshot();
  for (const bad of [undefined, null, NaN, Infinity, "3"]) {
    assert.equal(snap.record(SCHEMA, { observedAtEpoch: bad, currentEpoch: bad, whole: true }), false, `record ${String(bad)}`);
  }
  stored(snap);
  for (const bad of [undefined, null, NaN, Infinity, "3"]) {
    assert.equal(snap.authorize({ epoch: bad, socketDown: false, outcomes: silence }).defs, null, `authorize ${String(bad)}`);
  }
});

test("#1223 nothing observed yet refuses, and SAYS that rather than blaming a reconnect", () => {
  const snap = createObjectInfoSnapshot();
  const { defs, reason } = snap.authorize({ epoch: 1, socketDown: false, outcomes: silence });
  assert.equal(defs, null);
  assert.match(reason, /no whole \/object_info has been observed/i);
});

test("#1223 a backend that ANSWERED is told apart from an empty snapshot in the reason", () => {
  const snap = createObjectInfoSnapshot();
  stored(snap, SCHEMA, 1);
  const { defs, reason } = snap.authorize({
    epoch: 1,
    socketDown: false,
    outcomes: [{ route: "http", kind: TRANSPORT_OUTCOME.THREW }],
  });
  assert.equal(defs, null);
  assert.match(reason, /ANSWERED/);
});

test("#1582 requireSilence false does not invent silence — it only skips the outcomes check", () => {
  const snap = createObjectInfoSnapshot();
  stored(snap, SCHEMA, 1);
  const withoutOutcomes = snap.authorize({ epoch: 1, socketDown: false, requireSilence: false });
  assert.ok(withoutOutcomes.defs, "a held same-connection map authorizes when silence is already known");
  const answered = snap.authorize({
    epoch: 1,
    socketDown: false,
    outcomes: [{ route: "http", kind: TRANSPORT_OUTCOME.THREW }],
    requireSilence: false,
  });
  assert.ok(answered.defs, "an answered-error list must not veto a skip that already established silence earlier");
  const reconnect = snap.authorize({ epoch: 2, socketDown: false, requireSilence: false });
  assert.equal(reconnect.defs, null, "the reconnect fence is still load-bearing");
});

test("#1223 only a payload that could authorize anything is stored", () => {
  const snap = createObjectInfoSnapshot();
  // Called directly, NOT through `stored`: that helper defaults its payload, so passing
  // `undefined` silently tested the good schema and the case passed for the wrong reason.
  for (const bad of [null, undefined, {}, [], "schema", 7, [SCHEMA]]) {
    assert.equal(
      snap.record(bad, { observedAtEpoch: 3, currentEpoch: 3, whole: true }),
      false,
      `${String(bad)} is not a schema`,
    );
  }
  assert.equal(snap.peek().held, false, "a failed fetch never displaces a good snapshot with nothing");
});

test("#1223 a payload whose own shape cannot be inspected is not stored", () => {
  const hostile = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("nope");
      },
    },
  );
  const snap = createObjectInfoSnapshot();
  assert.doesNotThrow(() => stored(snap, hostile));
  assert.equal(stored(snap, hostile), false);
});

test("#1223 a good snapshot is not displaced by a later failed fetch", () => {
  const snap = createObjectInfoSnapshot();
  stored(snap, SCHEMA, 2);
  stored(snap, null, 2);
  stored(snap, {}, 2);
  assert.ok(snap.authorize({ epoch: 2, socketDown: false, outcomes: silence }).defs);
});

test("#1223 clear() retires it — a suspicion of change outranks a stored schema", () => {
  const snap = createObjectInfoSnapshot();
  stored(snap, SCHEMA, 2);
  snap.clear();
  assert.equal(snap.authorize({ epoch: 2, socketDown: false, outcomes: silence }).defs, null);
  assert.equal(snap.peek().held, false);
});

test("#1223 a successful write authorized this way DISCLOSES it", () => {
  const note = snapshotAuthorizationNote(" Tried 2 routes: a; b.");
  assert.match(note, /SUCCEEDED/);
  assert.match(note, /last whole \/object_info observed/);
  assert.match(note, /#1223/);
  assert.match(note, /Tried 2 routes/, "the routes that went silent ride along");
});

// ---------------------------------------------------------------------------
// The SHIPPED wiring, extracted and driven — not a re-implementation
// ---------------------------------------------------------------------------

const PANEL_SRC = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");

/**
 * Balanced-brace extraction of the set_widget oracle, by the marker above its body.
 *
 * #1126 round-5 renamed this from `getFreshObjectInfo` to `readObjectInfo(readThroughCache)`,
 * because the ordinary read and the last-resort forced reread now enter ONE body through
 * different cache methods. The property name is asserted rather than searched loosely: when
 * it moved, `lastIndexOf` silently matched graph_add_node's own `getFreshObjectInfo` further
 * up the file and these tests ran a different executor's oracle — green on the wrong code
 * until it happened to reference an undefined binding.
 */
function extractSetWidgetOracle() {
  const anchor = PANEL_SRC.indexOf("// #716 — READ THROUGH THE BURST CACHE.");
  assert.notEqual(anchor, -1, "the set_widget oracle's marker comment moved");
  const start = PANEL_SRC.lastIndexOf("readObjectInfo: async (readThroughCache, { reuseSnapshot = true } = {}) => {", anchor);
  assert.notEqual(start, -1, "readObjectInfo not found above its own marker");
  const open = PANEL_SRC.indexOf("=> {", start) + 3;
  let depth = 0;
  for (let i = open; i < PANEL_SRC.length; i += 1) {
    const ch = PANEL_SRC[i];
    if (ch === "/" && PANEL_SRC[i + 1] === "/") {
      i = PANEL_SRC.indexOf("\n", i + 2);
      if (i < 0) break;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      for (i += 1; i < PANEL_SRC.length; i += 1) {
        if (PANEL_SRC[i] === "\\") {
          i += 1;
          continue;
        }
        if (PANEL_SRC[i] === quote) break;
      }
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}" && --depth === 0) return PANEL_SRC.slice(open, i + 1);
  }
  throw new Error("unterminated getFreshObjectInfo");
}

/**
 * Build the SHIPPED oracle body with doubles for the module state it closes over, so these
 * cases run the production code path rather than a description of it.
 *
 * `epochDuringFetch` lets a test move the connection epoch WHILE the read is in flight —
 * the reconnect-mid-fetch hazard, which cannot be exercised any other way.
 */
function buildShippedOracle({ api, socketDown = false, epoch = 5, snapshot, epochDuringFetch = null, onFetch = null }) {
  const body = extractSetWidgetOracle();
  const factory = new Function(
    "api",
    "objectInfoCache",
    "realFetchWholeObjectInfo",
    "CACHE_OUTCOME",
    "objectInfoSnapshot",
    "initialEpoch",
    "epochDuringFetch",
    "comfyBackendSocketDown",
    "objectInfoOracleFailureNote",
    "OBJECT_INFO_DEADLINE_MS",
    "OBJECT_INFO_SNAPSHOT_PROBE_DEADLINE_MS",
    "makeCommandBudget",
    "onFetch",
    // #1560 — the shipped body decides the type-scoped route's silence licence beside the
    // snapshot's own verdict, so this sandbox has to supply the same predicate. A name the
    // body closes over and the harness does not provide is a harness that models a panel
    // which does not exist.
    "noBackendAnswerEstablished",
    // `backendReconnectEpoch` MUST be a live mutable binding in the same scope as the
    // extracted body, because the panel's is module state the body re-reads. An earlier
    // version passed it as a frozen value, which made `observedAtEpoch` and the record-time
    // read the same number by construction — the reconnect-mid-fetch case could not fail,
    // and the test passed while proving nothing.
    `let backendReconnectEpoch = initialEpoch;
     let oracleFailures = [];
     let snapshotIneligibility = "";
     let scopedReadLicensed = false;
     let setWidgetSchemaFromSnapshot = null;
     const comfyBackendIsDown = () => comfyBackendSocketDown;
     const historyRecorded = [];
     const recordObjectInfoTypes = (defs) => { historyRecorded.push(defs); return defs; };
     // #1418 — the shipped body now draws the oracle's deadline from the command budget.
     // The REAL budget, freshly minted per build, so the arithmetic is production's; the
     // harness wrapper below still overrides the deadline to its own 20ms, so no test here
     // waits on it either way.
     const budget = makeCommandBudget(25000);
     // Declared HERE so it closes over the mutable epoch above and can move it the moment
     // the read is issued — the panel's real hazard is a reconnect landing mid-fetch.
     const fetchWholeObjectInfo = (opts) => {
       onFetch?.(opts);
       const pending = realFetchWholeObjectInfo({ ...opts, deadlineMs: 20 });
       if (epochDuringFetch !== null) backendReconnectEpoch = epochDuringFetch;
       return pending;
     };
     // The shipped body now takes the cache entry point, so the ordinary read and the
     // last-resort forced reread share it. Driving it the way graph_set_widget's own
     // getFreshObjectInfo does keeps this exercising production wiring, not a paraphrase.
     const readObjectInfo = async (readThroughCache, { reuseSnapshot = true } = {}) => ${body};
     const getFreshObjectInfo = async () =>
       readObjectInfo((loader, opts) => objectInfoCache.readWithProvenance(loader, opts));
     const refetchObjectInfoLive = async () =>
       readObjectInfo((loader, opts) => objectInfoCache.readFresh(loader, opts), { reuseSnapshot: false });
     return {
       getFreshObjectInfo,
       refetchObjectInfoLive,
       setEpoch: (n) => { backendReconnectEpoch = n; },
       readNote: () => setWidgetSchemaFromSnapshot,
       readIneligibility: () => snapshotIneligibility,
       readFailures: () => oracleFailures,
       readScopedLicence: () => scopedReadLicensed,
       readHistory: () => historyRecorded,
     };`,
  );
  return factory(
    api,
    createObjectInfoCache(),
    fetchWholeObjectInfo,
    CACHE_OUTCOME,
    snapshot,
    epoch,
    epochDuringFetch,
    socketDown,
    objectInfoOracleFailureNote,
    OBJECT_INFO_DEADLINE_MS,
    2000,
    makeCommandBudget,
    onFetch,
    noBackendAnswerEstablished,
  );
}

const hungApi = { getNodeDefs: () => new Promise(() => {}), fetchApi: () => new Promise(() => {}) };

test("#1223 SHIPPED: a live answer is returned and snapshotted", async () => {
  const snapshot = createObjectInfoSnapshot();
  const o = buildShippedOracle({ api: { getNodeDefs: async () => SCHEMA }, snapshot, epoch: 5 });
  assert.equal(await o.getFreshObjectInfo(), SCHEMA);
  assert.deepEqual(snapshot.peek(), { held: true, epoch: 5 }, "stamped with the connection it was read on");
  assert.equal(o.readNote(), null, "a live authorization discloses nothing, because there is nothing to disclose");
  assert.deepEqual(o.readHistory(), [SCHEMA], "and it IS a real observation, so the ever-seen history takes it");
});

test("#1223 SHIPPED: a reconnect DURING the read means the answer is not snapshotted", async () => {
  // The burst cache deliberately returns a result to its waiter even after an invalidation
  // has retired it from storage. Without the issuance-epoch check, that retired answer is
  // promoted into a store with NO TTL, stamped with whatever epoch is current when it lands.
  const snapshot = createObjectInfoSnapshot();
  const o = buildShippedOracle({
    api: { getNodeDefs: async () => SCHEMA },
    snapshot,
    epoch: 5,
    epochDuringFetch: 6,
  });
  assert.equal(await o.getFreshObjectInfo(), SCHEMA, "the caller still gets its answer");
  assert.equal(snapshot.peek().held, false, "but it is NOT filed as evidence about the new connection");
});

test("#1223 SHIPPED: a CACHE HIT is never filed as evidence — it can predate a reconnect", async () => {
  // The burst cache serves a payload fetched up to a TTL ago. A reconnect can land in
  // between, and the reconnect's own refresh is payload-less — so it is coalesced into any
  // in-flight run and never reaches objectInfoCache.invalidate() either. Capturing the
  // epoch outside the loader stamped that pre-reconnect schema as current and kept it with
  // no TTL at all. Only the call that ISSUED the fetch may file the answer.
  const snapshot = createObjectInfoSnapshot();
  const o = buildShippedOracle({ api: { getNodeDefs: async () => SCHEMA }, snapshot, epoch: 5 });

  await o.getFreshObjectInfo();
  assert.deepEqual(snapshot.peek(), { held: true, epoch: 5 }, "the fetching call files it");

  snapshot.clear(); // what a reconnect does
  o.setEpoch(6); // ...and the epoch it bumps
  assert.equal(await o.getFreshObjectInfo(), SCHEMA, "the cache still answers its waiter");
  assert.equal(
    snapshot.peek().held,
    false,
    "but a payload fetched before the reconnect is not evidence about the connection after it",
  );
});

test("#1582 SHIPPED: the reported case — a held snapshot shortens hung probes", async () => {
  const snapshot = createObjectInfoSnapshot();
  stored(snapshot, SCHEMA, 5);
  let clientCalls = 0;
  let httpCalls = 0;
  const deadlines = [];
  const o = buildShippedOracle({
    api: {
      getNodeDefs: () => {
        clientCalls += 1;
        return new Promise(() => {});
      },
      fetchApi: () => {
        httpCalls += 1;
        return new Promise(() => {});
      },
    },
    snapshot,
    epoch: 5,
    socketDown: false,
    onFetch: (opts) => deadlines.push(opts.deadlineMs),
  });
  const defs = await o.getFreshObjectInfo();
  assert.ok(defs && Object.prototype.hasOwnProperty.call(defs, "H3Keyframes"), "the edit is no longer refused");
  assert.equal(clientCalls, 1, "the client route is still probed so an answered error can refuse");
  assert.equal(httpCalls, 1, "the raw route is still probed so the fallback transport can answer");
  assert.deepEqual(deadlines, [2000], "the reusable snapshot caps the serial oracle before the 15s stall");
  assert.match(o.readNote(), /did not answer/);
  assert.equal(o.readFailures().length, 2, "the fallback still discloses both silent routes");
});

test("#1582 SHIPPED: a second ordinary read does not re-wait on probes that already went silent", async () => {
  const snapshot = createObjectInfoSnapshot();
  stored(snapshot, SCHEMA, 5);
  let clientCalls = 0;
  let httpCalls = 0;
  const o = buildShippedOracle({
    api: {
      getNodeDefs: () => {
        clientCalls += 1;
        return new Promise(() => {});
      },
      fetchApi: () => {
        httpCalls += 1;
        return new Promise(() => {});
      },
    },
    snapshot,
    epoch: 5,
    socketDown: false,
  });
  assert.ok(await o.getFreshObjectInfo(), "the first write still discovers silence");
  assert.equal(clientCalls, 1);
  assert.equal(httpCalls, 1);

  const started = performance.now();
  const defs = await o.getFreshObjectInfo();
  const elapsed = performance.now() - started;
  assert.ok(defs && Object.prototype.hasOwnProperty.call(defs, "H3Keyframes"), "the second write is still authorized");
  assert.equal(clientCalls, 1, "getNodeDefs is not contacted again");
  assert.equal(httpCalls, 1, "GET /object_info is not contacted again");
  assert.ok(elapsed < 50, `second read stalled ${elapsed}ms on probes that were already silent`);
  assert.match(o.readNote(), /#1582/);
});

test("#1582 SHIPPED set_widget: a second successful write does not re-wait on silent probes", async () => {
  const snapshot = createObjectInfoSnapshot();
  stored(snapshot, SCHEMA, 5);
  let clientCalls = 0;
  const o = buildShippedOracle({
    api: {
      getNodeDefs: () => {
        clientCalls += 1;
        return new Promise(() => {});
      },
      fetchApi: () => new Promise(() => {}),
    },
    snapshot,
    epoch: 5,
  });
  const ctor = function NodeCtor() {};
  ctor.nodeData = { input: { required: {} } };
  const node = {
    id: 3,
    type: "KSampler",
    widgets: [{ name: "steps", type: "INT", value: 20 }],
    constructor: ctor,
  };
  const reg = { KSampler: ctor };
  const hooks = { beforeChange() {}, afterChange() {}, setDirty() {} };
  const opts = {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: o.getFreshObjectInfo,
    schemaProvenance: () => "snapshot",
    ...hooks,
  };

  const first = await runSetWidget(node, "steps", 30, opts);
  assert.equal(first.set.value, 30, "the first write lands");
  assert.equal(node.widgets[0].value, 30);
  assert.equal(clientCalls, 1, "the first write still probes");

  const started = performance.now();
  const second = await runSetWidget(node, "steps", 40, opts);
  const elapsed = performance.now() - started;
  assert.equal(second.set.value, 40, "the second write lands");
  assert.equal(node.widgets[0].value, 40);
  assert.equal(clientCalls, 1, "the second write must not contact the silent routes again");
  assert.ok(elapsed < 50, `second set_widget stalled ${elapsed}ms on probes that were already silent`);
});

test("#1582 the forced live reread does not take the snapshot shortcut", async () => {
  const snapshot = createObjectInfoSnapshot();
  stored(snapshot, SCHEMA, 5);
  let clientCalls = 0;
  const o = buildShippedOracle({
    api: {
      getNodeDefs: async () => {
        clientCalls += 1;
        return SCHEMA;
      },
    },
    snapshot,
    epoch: 5,
  });
  assert.equal(await o.refetchObjectInfoLive(), SCHEMA);
  assert.equal(clientCalls, 1, "the blind-write recovery still forces a live schema read");
  assert.equal(o.readNote(), null, "a live reread does not disclose snapshot authorization");
});

test("#1223 SHIPPED: a snapshot re-read is NOT recorded as a new backend observation", async () => {
  // Recording it would let a snapshot keep its own types "ever seen" after the backend
  // stopped defining them — the #458 trust root feeding itself.
  const snapshot = createObjectInfoSnapshot();
  stored(snapshot, SCHEMA, 5);
  const o = buildShippedOracle({ api: hungApi, snapshot, epoch: 5 });
  await o.getFreshObjectInfo();
  assert.deepEqual(o.readHistory(), [], "nothing new was observed, so nothing is recorded");
});

test("#1223 SHIPPED: a DOWN socket still refuses, and the refusal says why", async () => {
  const snapshot = createObjectInfoSnapshot();
  stored(snapshot, SCHEMA, 5);
  const o = buildShippedOracle({ api: hungApi, snapshot, epoch: 5, socketDown: true });
  assert.equal(await o.getFreshObjectInfo(), null, "fails closed exactly as before the fix");
  assert.equal(o.readNote(), null);
  assert.match(o.readIneligibility(), /socket is down/i);
});

test("#1223 SHIPPED: a reconnect since the observation still refuses", async () => {
  const snapshot = createObjectInfoSnapshot();
  stored(snapshot, SCHEMA, 4);
  const o = buildShippedOracle({ api: hungApi, snapshot, epoch: 5 });
  assert.equal(await o.getFreshObjectInfo(), null);
  assert.match(o.readIneligibility(), /reconnected/i);
});

test("#1223 SHIPPED: a backend that ANSWERED badly still refuses — #458 is untouched", async () => {
  const snapshot = createObjectInfoSnapshot();
  stored(snapshot, SCHEMA, 5);
  const o = buildShippedOracle({
    api: {
      getNodeDefs: async () => {
        throw new TypeError("Failed to fetch");
      },
      fetchApi: async () => ({ ok: false, status: 500 }),
    },
    snapshot,
    epoch: 5,
  });
  assert.equal(await o.getFreshObjectInfo(), null, "a down/erroring backend authorizes nothing");
});

test("#1223 SHIPPED: the ineligibility reason is NOT counted as a transport route", async () => {
  // objectInfoOracleFailureNote renders "Tried N routes:" from failures.length. Splicing a
  // non-route entry in made a two-transport failure report THREE routes tried — #982's own
  // defect (a refusal asserting something that did not happen).
  const o = buildShippedOracle({ api: hungApi, snapshot: createObjectInfoSnapshot(), epoch: 5 });
  assert.equal(await o.getFreshObjectInfo(), null);
  assert.equal(o.readFailures().length, 2, "two transports were tried");
  assert.match(objectInfoOracleFailureNote(o.readFailures()), /Tried 2 routes/);
  assert.match(o.readIneligibility(), /no whole \/object_info has been observed/i);
});

// ---------------------------------------------------------------------------
// The OTHER whole-schema readers, extracted and driven
//
// A source-count assertion cannot pin these: wrapping a record site in `if (false)` leaves
// the call text — and therefore the count — untouched. Mutation caught exactly that, in a
// test written after learning the same lesson about the startup seed.
// ---------------------------------------------------------------------------

/** Balanced-brace extraction of a `async <name>(...) { ... }` executor from the panel. */
function extractExecutor(name) {
  const start = PANEL_SRC.indexOf(`async ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  // Skip the PARAMETER LIST before looking for the body. These executors destructure their
  // argument — `async graph_get_object_info({ if_none_match } = {})` — so the first `{` in
  // the text is the parameter pattern, and a scanner that starts there closes on its own
  // `}` and "extracts" 45 characters of signature.
  const paren = PANEL_SRC.indexOf("(", start);
  let parenDepth = 0;
  let afterParams = -1;
  for (let i = paren; i < PANEL_SRC.length; i += 1) {
    if (PANEL_SRC[i] === "(") parenDepth += 1;
    if (PANEL_SRC[i] === ")" && --parenDepth === 0) {
      afterParams = i;
      break;
    }
  }
  assert.notEqual(afterParams, -1, `${name} parameter list is unterminated`);
  const open = PANEL_SRC.indexOf("{", afterParams);
  let depth = 0;
  for (let i = open; i < PANEL_SRC.length; i += 1) {
    const ch = PANEL_SRC[i];
    if (ch === "/" && PANEL_SRC[i + 1] === "/") {
      i = PANEL_SRC.indexOf("\n", i + 2);
      if (i < 0) break;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      for (i += 1; i < PANEL_SRC.length; i += 1) {
        if (PANEL_SRC[i] === "\\") {
          i += 1;
          continue;
        }
        if (PANEL_SRC[i] === quote) break;
      }
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}" && --depth === 0) return PANEL_SRC.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function buildExecutor(name, deps) {
  const names = Object.keys(deps);
  const factory = new Function(...names, `const executors = { ${extractExecutor(name)} };\nreturn executors.${name};`);
  return factory(...names.map((n) => deps[n]));
}

test("#1223 SHIPPED get_object_info: a successful whole read IS filed", async () => {
  // After a failed startup seed, or a reconnect that cleared the snapshot, this command can
  // be the only thing that has successfully read a whole schema. Dropping it left the next
  // render-time widget edit refused for want of the very map it had just read.
  const snapshot = createObjectInfoSnapshot();
  const get = buildExecutor("graph_get_object_info", {
    fetchWholeObjectInfo: async () => ({ defs: SCHEMA, failures: [], outcomes: [] }),
    objectInfoSnapshot: snapshot,
    backendReconnectEpoch: 9,
    api: { getNodeDefs: async () => SCHEMA },
    pageComfyOrigin: () => "http://127.0.0.1:8188",
    objectInfoOracleFailureNote: () => "",
    objectInfoFingerprint: () => "fp",
    objectInfoUnchanged: (etag) => etag === "fp",
  });

  const res = await get({});
  assert.equal(res.ok, true);
  assert.deepEqual(snapshot.peek(), { held: true, epoch: 9 }, "filed at the epoch it was read on");

  // ...and the if_none_match early-return still keeps it fed, which is why the record sits
  // above that branch: a caller polling with a fingerprint would otherwise never file one.
  const snapshot2 = createObjectInfoSnapshot();
  const get2 = buildExecutor("graph_get_object_info", {
    fetchWholeObjectInfo: async () => ({ defs: SCHEMA, failures: [], outcomes: [] }),
    objectInfoSnapshot: snapshot2,
    backendReconnectEpoch: 9,
    api: { getNodeDefs: async () => SCHEMA },
    pageComfyOrigin: () => "http://127.0.0.1:8188",
    objectInfoOracleFailureNote: () => "",
    objectInfoFingerprint: () => "fp",
    objectInfoUnchanged: (etag) => etag === "fp",
  });
  const unchanged = await get2({ if_none_match: "fp" });
  assert.equal(unchanged.unchanged, true, "the early return still happens");
  assert.equal(snapshot2.peek().held, true, "and the snapshot was still fed on the way there");
});

test("#1223 SHIPPED get_object_info: a FAILED read files nothing", async () => {
  const snapshot = createObjectInfoSnapshot();
  const get = buildExecutor("graph_get_object_info", {
    fetchWholeObjectInfo: async () => ({ defs: null, failures: ["nope"], outcomes: [] }),
    objectInfoSnapshot: snapshot,
    backendReconnectEpoch: 9,
    api: {},
    pageComfyOrigin: () => "http://127.0.0.1:8188",
    objectInfoOracleFailureNote: () => "",
    objectInfoFingerprint: () => "fp",
    objectInfoUnchanged: () => false,
  });
  const res = await get({});
  assert.equal(res.ok, false);
  assert.equal(snapshot.peek().held, false);
});

function buildRemoveWidget({ snapshot, epoch = 4, cache, defs = SCHEMA }) {
  const node = { id: 3, type: "KSampler", comfyClass: "KSampler", widgets: [{ name: "seed" }] };
  return buildExecutor("graph_remove_widget", {
    getGraphCtx: () => ({ graph: {} }),
    resolveNode: () => node,
    objectInfoCache: cache,
    fetchWholeObjectInfo: async () => ({ defs, failures: [], outcomes: [] }),
    CACHE_OUTCOME,
    objectInfoSnapshot: snapshot,
    backendReconnectEpoch: epoch,
    api: {},
    recordObjectInfoTypes: (d) => d,
    declaredInputNames: () => new Set(["seed"]),
    objectInfoOracleFailureNote: () => "",
    assertActiveWorkflowCommandTarget: () => {},
    WORKFLOW_UUID_FIELD: "workflow_uuid",
    runRemoveWidget: async () => ({ ok: true }),
  });
}

test("#1223 SHIPPED remove_widget: the whole schema it paid for IS filed", async () => {
  const snapshot = createObjectInfoSnapshot();
  const remove = buildRemoveWidget({ snapshot, epoch: 4, cache: createObjectInfoCache() });
  await remove({ node_id: 3, widget: "seed" });
  assert.deepEqual(snapshot.peek(), { held: true, epoch: 4 });
});

test("#1223 SHIPPED remove_widget: a CACHE HIT is not filed", async () => {
  // Same rule as set_widget: a cached payload may predate a reconnect, and this call cannot
  // vouch for when it was issued.
  const snapshot = createObjectInfoSnapshot();
  const cache = createObjectInfoCache();
  const remove = buildRemoveWidget({ snapshot, epoch: 4, cache });
  await remove({ node_id: 3, widget: "seed" });
  snapshot.clear();
  await remove({ node_id: 3, widget: "seed" }); // within the TTL ⇒ served from store
  assert.equal(snapshot.peek().held, false, "the second call never issued a request of its own");
});

test("#1223 the snapshot is recorded ONLY where a WHOLE schema was fetched, and vouched for", () => {
  // Each CALL SITE is checked for its own claim. Counting `whole: true` across the file
  // instead counted the comment that documents the rule, which is not a call site.
  const sites = [...PANEL_SRC.matchAll(/objectInfoSnapshot\.record\(/g)];
  assert.equal(
    sites.length,
    6,
    "startup seed, refresh run, set_widget oracle, add_node resolver, get_object_info, " +
      "remove_widget — every reader that obtains a WHOLE schema files it, and adding one " +
      "means justifying it here",
  );
  // The add_node site is gated on the panel's own record of WHICH question it asked. A
  // single-class /object_info/<Type> payload reaching the snapshot would make every other
  // type read as absent and the ever-seen gate diagnose the install as removed packs.
  assert.match(
    PANEL_SRC,
    /if \(freshDefs && !freshDefsAreSingleClass && addNodeObservedAtEpoch !== null\) \{\s*\n\s*objectInfoSnapshot\.record\(/,
    "add_node files its payload only when it fetched the WHOLE schema, and only then",
  );
  for (const site of sites) {
    const call = PANEL_SRC.slice(site.index, site.index + 260);
    assert.match(call, /whole: true/, `the record site at index ${site.index} states the wholeness claim`);
    assert.match(call, /observedAtEpoch/, `the record site at index ${site.index} stamps the issuance epoch`);
  }
  assert.match(
    PANEL_SRC,
    /if \(!preloadedDefs\) \{\s*\n\s*objectInfoSnapshot\.record\(/,
    "the refresh run records only a payload it fetched itself — a caller-supplied one is not provably whole",
  );
});

/**
 * The SHIPPED `seedObjectInfoHistory`, extracted and driven.
 *
 * A source-regex test was tried first and is not good enough: `if (false) record(...)` still
 * MATCHES the pattern, so disabling the startup snapshot left the assertion green. Mutation
 * caught that. A test for whether code RUNS has to run it.
 */
function buildShippedSeed({ api, epoch = 2, snapshot, epochDuringFetch = null }) {
  const start = PANEL_SRC.indexOf("function seedObjectInfoHistory()");
  assert.notEqual(start, -1, "seedObjectInfoHistory not found");
  const open = PANEL_SRC.indexOf("{", start);
  let depth = 0;
  let body = null;
  for (let i = open; i < PANEL_SRC.length; i += 1) {
    const ch = PANEL_SRC[i];
    if (ch === "/" && PANEL_SRC[i + 1] === "/") {
      i = PANEL_SRC.indexOf("\n", i + 2);
      if (i < 0) break;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}" && --depth === 0) {
      body = PANEL_SRC.slice(start, i + 1);
      break;
    }
  }
  assert.ok(body, "unterminated seedObjectInfoHistory");

  const factory = new Function(
    "api",
    "objectInfoSnapshot",
    "initialEpoch",
    "epochDuringFetch",
    "objectInfoHistory",
    `let backendReconnectEpoch = initialEpoch;
     let objectInfoHistorySeed = null;
     const recorded = [];
     let seeded = false;
     const recordObjectInfoTypes = (defs) => { recorded.push(defs); return defs; };
     const markObjectInfoHistorySeeded = () => { seeded = true; return true; };
     ${body}
     return {
       run: () => seedObjectInfoHistory(),
       readRecorded: () => recorded,
       wasSeeded: () => seeded,
       setEpoch: (n) => { backendReconnectEpoch = n; },
     };`,
  );
  const built = factory(
    {
      getNodeDefs: async () => {
        // Move the epoch WHILE the request is outstanding — the reconnect-mid-fetch hazard.
        if (epochDuringFetch !== null) built.setEpoch(epochDuringFetch);
        return api.defs;
      },
    },
    snapshot,
    epoch,
    null,
    { loseBaseline: () => {} },
  );
  return built;
}

test("#1223 SHIPPED STARTUP: the seed's whole read IS snapshotted", async () => {
  // On a normal startup this is the ONLY whole /object_info read that happens —
  // registerComfyNodeDefs does not run unless something triggers a refresh. Without this,
  // the reported case (first widget edit during a render, both probes silent) finds no
  // snapshot and is refused exactly as before the fix. That was the shipped v1 behaviour.
  const snapshot = createObjectInfoSnapshot();
  const seed = buildShippedSeed({ api: { defs: SCHEMA }, epoch: 2, snapshot });
  await seed.run();
  assert.equal(seed.wasSeeded(), true, "the history baseline still lands");
  assert.deepEqual(seed.readRecorded(), [SCHEMA], "and the ever-seen history still takes it");
  assert.deepEqual(snapshot.peek(), { held: true, epoch: 2 }, "and the snapshot is filed at the startup epoch");
});

test("#1223 SHIPPED STARTUP: a failed seed leaves no snapshot", async () => {
  const snapshot = createObjectInfoSnapshot();
  const seed = buildShippedSeed({ api: { defs: null }, epoch: 2, snapshot });
  await seed.run();
  assert.equal(snapshot.peek().held, false, "nothing observed, nothing filed");
});

test("#1223 SHIPPED STARTUP: a reconnect during the seed's fetch is not filed", async () => {
  const snapshot = createObjectInfoSnapshot();
  const seed = buildShippedSeed({ api: { defs: SCHEMA }, epoch: 2, snapshot, epochDuringFetch: 3 });
  await seed.run();
  assert.equal(seed.wasSeeded(), true, "the history is still seeded — that trust root is separate");
  assert.equal(snapshot.peek().held, false, "but the payload describes the connection that was replaced");
});

test("#1223 the socket handlers clear the snapshot DIRECTLY, not by way of a refresh", () => {
  // The `reconnected` handler's refreshComfyNodeDefs() carries no payload and no force,
  // which makeRefreshCoalescer resolves by joining an in-flight run and returning — so
  // registerComfyNodeDefs, and the clear inside it, may never run for that reconnect.
  // Each handler is bounded at the NEXT listener registration. A fixed-width slice ran past
  // the end of `reconnecting` into `status` — which also clears — so deleting the clear from
  // `reconnecting` left this test green. Found by mutation, not by reading.
  for (const evt of ["reconnecting", "status", "reconnected"]) {
    const at = PANEL_SRC.indexOf(`api.addEventListener("${evt}"`);
    assert.notEqual(at, -1, `${evt} handler not found`);
    const next = PANEL_SRC.indexOf("api.addEventListener(", at + 1);
    const handler = PANEL_SRC.slice(at, next === -1 ? PANEL_SRC.length : next);
    assert.match(handler, /objectInfoSnapshot\.clear\(\);/, `${evt} retires the snapshot itself`);
  }
  assert.match(
    PANEL_SRC,
    /objectInfoCache\.invalidate\(\);[\s\S]{0,700}?objectInfoSnapshot\.clear\(\);/,
    "and the refresh run still clears it too, on the same suspicion that drops the burst cache",
  );
});

test("#1223 the disclosure rides on its OWN field, never on `warning`", () => {
  assert.match(PANEL_SRC, /schema_source: "last-observed", schema_note: snapshotAuthorizationNote\(/);
  const setWidget = PANEL_SRC.slice(PANEL_SRC.indexOf("async graph_set_widget("));
  const body = setWidget.slice(0, setWidget.indexOf("async graph_remove_widget("));
  assert.ok(
    !/warning:[^\n]*snapshotAuthorizationNote/.test(body),
    "the provenance note never competes for the warning slot",
  );
});

test("#1223 no comment cites a symbol that does not exist", () => {
  // A backticked identifier reads as a real export; the next reader greps for it and
  // concludes the guard was deleted. `recordsWholeSchemaOnly` was exactly that.
  const snapshotSrc = readFileSync(new URL("../../web/js/lib/object-info-snapshot.js", import.meta.url), "utf8");
  for (const [name, src] of [["panel", PANEL_SRC], ["snapshot module", snapshotSrc]]) {
    assert.ok(!/recordsWholeSchemaOnly/.test(src), `${name} still cites a phantom symbol`);
  }
});

// ───────────── #1560: the SHIPPED body's licence for the type-scoped last resort ──────────

test("#1560 SHIPPED: hung probes LICENSE the type-scoped read; the snapshot and the licence agree", async () => {
  // Both whole-map routes went silent — the #1560 install. That is the one condition under
  // which a per-class read may be asked at all, and it is the SAME evidence #1223's snapshot
  // is licensed on, read once, in the same statement.
  const snapshot = createObjectInfoSnapshot();
  const o = buildShippedOracle({ api: hungApi, snapshot, epoch: 5 });
  assert.equal(await o.getFreshObjectInfo(), null, "nothing usable came back");
  assert.equal(o.readScopedLicence(), true, "silence licenses the type-scoped route");
});

test("#1560 SHIPPED: a client ANSWERING deny-all `{}` licenses NOTHING — it is never overruled", async () => {
  // An empty schema is a client expressing deny-all. Consulting a broader per-class read
  // there is the one direction object-info-oracle.js's note forbids, and the licence is what
  // stops it. If this ever reads true, the fence can be widened past a deliberate refusal.
  const snapshot = createObjectInfoSnapshot();
  const o = buildShippedOracle({ api: { getNodeDefs: async () => ({}) }, snapshot, epoch: 5 });
  assert.equal(await o.getFreshObjectInfo(), null, "an empty schema authorizes nothing, as before");
  assert.equal(o.readScopedLicence(), false, "and it may not be re-asked by another route");
});

test("#1560 SHIPPED: a route that THREW licenses nothing either — something answered", async () => {
  const snapshot = createObjectInfoSnapshot();
  const o = buildShippedOracle({
    api: {
      getNodeDefs: async () => {
        throw new Error("connection refused");
      },
      fetchApi: async () => {
        throw new Error("connection refused");
      },
    },
    snapshot,
    epoch: 5,
  });
  assert.equal(await o.getFreshObjectInfo(), null);
  assert.equal(o.readScopedLicence(), false, "a refused connection is a process that is GONE, not one that is busy");
});

test("#1560 SHIPPED: a LIVE answer leaves the licence false — there is nothing to license", async () => {
  const snapshot = createObjectInfoSnapshot();
  const o = buildShippedOracle({ api: { getNodeDefs: async () => SCHEMA }, snapshot, epoch: 5 });
  assert.equal(await o.getFreshObjectInfo(), SCHEMA);
  assert.equal(o.readScopedLicence(), false);
});
