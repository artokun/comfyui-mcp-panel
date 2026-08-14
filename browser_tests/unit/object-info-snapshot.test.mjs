/**
 * #1223 — `panel_set_widget` refused a live edit on an existing `H3Keyframes` node because
 * BOTH `/object_info` probes timed out, while the canvas was reachable and `panel_disconnect`
 * mutations had succeeded moments earlier. ComfyUI serves HTTP from the process that runs
 * the graph, so a render blocks the schema fetch: a BUSY backend, not an absent one.
 *
 * The fix authorizes from the last WHOLE schema observed on the CURRENT backend connection,
 * under four conditions that all fail closed. These tests exist to keep each condition
 * load-bearing — every one of them is the difference between this and re-opening #458.
 *
 * The last block drives the SHIPPED `getFreshObjectInfo` body extracted from the panel, not
 * a re-implementation of it. A test that reasons about a copy of the wiring proves the copy.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  createObjectInfoSnapshot,
  transportsWereSilent,
  snapshotAuthorizationNote,
} from "../../web/js/lib/object-info-snapshot.js";
import { TRANSPORT_OUTCOME, fetchWholeObjectInfo } from "../../web/js/lib/object-info-oracle.js";
import { createObjectInfoCache, CACHE_OUTCOME } from "../../web/js/lib/object-info-cache.js";
import { objectInfoOracleFailureNote } from "../../web/js/lib/object-info-oracle.js";

const SCHEMA = { KSampler: { input: {} }, H3Keyframes: { input: {} } };
const silence = [
  { route: "client", kind: TRANSPORT_OUTCOME.NO_ANSWER },
  { route: "http", kind: TRANSPORT_OUTCOME.NO_ANSWER },
];

// ---------------------------------------------------------------------------
// Condition 4: SILENCE, not merely failure
// ---------------------------------------------------------------------------

test("#1223 both probes timing out is the silence this licenses", () => {
  assert.equal(transportsWereSilent(silence), true);
});

test("#1223 a route that THREW disqualifies — a refused connection is a process that is gone", () => {
  // `TypeError: Failed to fetch` is what ECONNREFUSED produces in a browser. That is the
  // signature of a backend that is DOWN, and a down backend may be restarting — the one
  // event that can change the type set. Silence is the signature of one that is busy.
  assert.equal(
    transportsWereSilent([
      { route: "client", kind: TRANSPORT_OUTCOME.NO_ANSWER },
      { route: "http", kind: TRANSPORT_OUTCOME.THREW },
    ]),
    false,
  );
});

test("#1223 a route that ANSWERED something unusable disqualifies", () => {
  // A non-OK status, an empty schema, a body that stalled after its headers arrived. All
  // are a backend saying something, which is a different fault from the reported one.
  assert.equal(
    transportsWereSilent([
      { route: "client", kind: TRANSPORT_OUTCOME.NO_ANSWER },
      { route: "http", kind: TRANSPORT_OUTCOME.ANSWERED_UNUSABLE },
    ]),
    false,
  );
});

test("#1223 never-contacted routes are neutral, but cannot license on their own", () => {
  assert.equal(
    transportsWereSilent([
      { route: "client", kind: TRANSPORT_OUTCOME.NOT_ATTEMPTED },
      { route: "http", kind: TRANSPORT_OUTCOME.NO_ANSWER },
    ]),
    true,
    "one route silent, the other never asked — still the reported condition",
  );
  assert.equal(
    transportsWereSilent([
      { route: "client", kind: TRANSPORT_OUTCOME.NOT_ATTEMPTED },
      { route: "http", kind: TRANSPORT_OUTCOME.NOT_ATTEMPTED },
    ]),
    false,
    "nothing was ever asked, so nothing was observed to be silent",
  );
});

test("#1223 an absent, empty, or unrecognised outcome list licenses nothing", () => {
  // "We recorded nothing" is not evidence of silence. A caller that lost the outcomes — or
  // one handing in a shape this module never produced — must get the refusal.
  assert.equal(transportsWereSilent(undefined), false);
  assert.equal(transportsWereSilent([]), false);
  assert.equal(transportsWereSilent("no-answer"), false);
  assert.equal(transportsWereSilent([{ route: "client", kind: "invented" }]), false);
  assert.equal(transportsWereSilent([null, { kind: TRANSPORT_OUTCOME.NO_ANSWER }]), false);
  assert.equal(transportsWereSilent(["no-answer", "no-answer"]), false, "bare strings are not outcomes");
});

test("#1223 the oracle's real tags drive it — not a list hand-written in this test", async () => {
  // The tags and the prose must describe the SAME attempt. Pinning only hand-made lists
  // would let the oracle stop emitting them, or emit the wrong one, with the suite green.
  const timedOut = await fetchWholeObjectInfo({
    getNodeDefs: () => new Promise(() => {}),
    fetchApi: () => new Promise(() => {}),
    deadlineMs: 20,
  });
  assert.equal(timedOut.defs, null);
  assert.equal(transportsWereSilent(timedOut.outcomes), true, "two hung transports read as silence");
  assert.equal(timedOut.outcomes.length, timedOut.failures.length, "one tag per recorded attempt");

  const refused = await fetchWholeObjectInfo({
    getNodeDefs: async () => {
      throw new TypeError("Failed to fetch");
    },
    fetchApi: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  assert.equal(refused.defs, null);
  assert.equal(transportsWereSilent(refused.outcomes), false, "a refused connection is not silence");

  const notOk = await fetchWholeObjectInfo({
    getNodeDefs: async () => null,
    fetchApi: async () => ({ ok: false, status: 503 }),
  });
  assert.equal(transportsWereSilent(notOk.outcomes), false, "a 503 is an answer");
});

test("#1223 a usable answer still returns its outcomes alongside the schema", async () => {
  const { defs, outcomes } = await fetchWholeObjectInfo({
    getNodeDefs: async () => SCHEMA,
    fetchApi: null,
  });
  assert.equal(defs, SCHEMA);
  assert.deepEqual(outcomes, [], "the route that answered is not a failure, so nothing is tagged");
});

// ---------------------------------------------------------------------------
// Conditions 1–3: a snapshot, an unbroken connection, the same process
// ---------------------------------------------------------------------------

test("#1223 the reported case: silent probes on an unbroken connection authorize", () => {
  const snap = createObjectInfoSnapshot();
  assert.equal(snap.record(SCHEMA, 3), true);
  const { defs, reason } = snap.authorize({ epoch: 3, socketDown: false, outcomes: silence });
  assert.equal(defs, SCHEMA, "the edit the reporter was refused is authorized");
  assert.equal(reason, "");
});

test("#1223 a DOWN socket refuses — a restarting backend is the one thing that moves the type set", () => {
  const snap = createObjectInfoSnapshot();
  snap.record(SCHEMA, 3);
  const { defs, reason } = snap.authorize({ epoch: 3, socketDown: true, outcomes: silence });
  assert.equal(defs, null);
  assert.match(reason, /socket is down/i);
});

test("#1223 a RECONNECT since the observation refuses — it describes a replaced process", () => {
  const snap = createObjectInfoSnapshot();
  snap.record(SCHEMA, 3);
  const { defs, reason } = snap.authorize({ epoch: 4, socketDown: false, outcomes: silence });
  assert.equal(defs, null);
  assert.match(reason, /reconnected/i);
  // Provenance, not freshness: the snapshot is refused outright rather than aged out, so
  // there is no time bound here to get wrong.
  assert.equal(
    snap.authorize({ epoch: 3, socketDown: false, outcomes: silence }).defs,
    SCHEMA,
    "and the SAME epoch still authorizes — age alone was never the question",
  );
});

test("#1223 an unreadable epoch refuses — a snapshot that cannot prove provenance is worse than none", () => {
  const snap = createObjectInfoSnapshot();
  snap.record(SCHEMA, 3);
  for (const epoch of [undefined, null, NaN, Infinity, "3"]) {
    assert.equal(snap.authorize({ epoch, socketDown: false, outcomes: silence }).defs, null, `epoch ${String(epoch)}`);
  }
});

test("#1223 an epoch that cannot be compared later is never stored", () => {
  const snap = createObjectInfoSnapshot();
  assert.equal(snap.record(SCHEMA, undefined), false);
  assert.equal(snap.record(SCHEMA, NaN), false);
  assert.equal(snap.record(SCHEMA, "3"), false);
  assert.equal(snap.peek().held, false);
});

test("#1223 nothing observed yet refuses, and SAYS that rather than blaming a reconnect", () => {
  // #982's lesson: a caller told the wrong cause goes looking in the wrong place.
  const snap = createObjectInfoSnapshot();
  const { defs, reason } = snap.authorize({ epoch: 1, socketDown: false, outcomes: silence });
  assert.equal(defs, null);
  assert.match(reason, /no whole \/object_info has been observed/i);
});

test("#1223 a backend that ANSWERED is told apart from an empty snapshot in the reason", () => {
  const snap = createObjectInfoSnapshot();
  snap.record(SCHEMA, 1);
  const { defs, reason } = snap.authorize({
    epoch: 1,
    socketDown: false,
    outcomes: [{ route: "http", kind: TRANSPORT_OUTCOME.THREW }],
  });
  assert.equal(defs, null);
  assert.match(reason, /ANSWERED/);
});

test("#1223 only a payload that could authorize anything is stored", () => {
  const snap = createObjectInfoSnapshot();
  for (const bad of [null, undefined, {}, [], "schema", 7, [SCHEMA]]) {
    assert.equal(snap.record(bad, 1), false, `${JSON.stringify(bad) ?? String(bad)} is not a schema`);
  }
  assert.equal(snap.peek().held, false, "a failed fetch never displaces a good snapshot with nothing");
});

test("#1223 a payload whose own shape cannot be inspected is not stored", () => {
  // `Object.keys` invokes a Proxy's ownKeys trap, which can throw — the same hazard the
  // oracle's `usableDefs` guards. A diagnostic path must not raise an exception of its own.
  const hostile = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("nope");
      },
    },
  );
  const snap = createObjectInfoSnapshot();
  assert.doesNotThrow(() => snap.record(hostile, 1));
  assert.equal(snap.record(hostile, 1), false);
});

test("#1223 a good snapshot is not displaced by a later failed fetch", () => {
  const snap = createObjectInfoSnapshot();
  snap.record(SCHEMA, 2);
  snap.record(null, 2);
  snap.record({}, 2);
  assert.equal(snap.authorize({ epoch: 2, socketDown: false, outcomes: silence }).defs, SCHEMA);
});

test("#1223 clear() retires it — a suspicion of change outranks a stored schema", () => {
  const snap = createObjectInfoSnapshot();
  snap.record(SCHEMA, 2);
  snap.clear();
  assert.equal(snap.authorize({ epoch: 2, socketDown: false, outcomes: silence }).defs, null);
  assert.equal(snap.peek().held, false);
});

test("#1223 a successful write authorized this way DISCLOSES it", () => {
  // A write reported as SUCCEEDED and VERIFIED, verified against a schema nobody could
  // re-fetch, is indistinguishable from a fully live authorization unless it says so.
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

/** Balanced-brace extraction of the set_widget oracle, by the marker above its body. */
function extractSetWidgetOracle() {
  const anchor = PANEL_SRC.indexOf("// #716 — READ THROUGH THE BURST CACHE.");
  assert.notEqual(anchor, -1, "the set_widget oracle's marker comment moved");
  const start = PANEL_SRC.lastIndexOf("getFreshObjectInfo: async () => {", anchor);
  assert.notEqual(start, -1, "getFreshObjectInfo not found above its own marker");
  const open = PANEL_SRC.indexOf("{", start);
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
 */
function buildShippedOracle({ api, socketDown = false, epoch = 5, snapshot }) {
  const body = extractSetWidgetOracle();
  const factory = new Function(
    "api",
    "objectInfoCache",
    "fetchWholeObjectInfo",
    "CACHE_OUTCOME",
    "objectInfoSnapshot",
    "backendReconnectEpoch",
    "comfyBackendSocketDown",
    "recordObjectInfoTypes",
    "objectInfoOracleFailureNote",
    `let oracleFailures = [];
     let setWidgetSchemaFromSnapshot = null;
     const historyRecorded = [];
     const getFreshObjectInfo = async () => ${body};
     return {
       getFreshObjectInfo,
       readFailures: () => oracleFailures,
       readSnapshotNote: () => setWidgetSchemaFromSnapshot,
       readHistory: () => historyRecorded,
       recordHistory: (defs) => { historyRecorded.push(defs); return defs; },
     };`,
  );
  const built = factory(
    api,
    createObjectInfoCache(),
    // The SHIPPED oracle, on a budget a test can wait for. Only `deadlineMs` is
    // substituted, so the tags these cases read are the ones production produces — the
    // suite must not spend 20 real seconds per hung-transport case to learn that.
    (opts) => fetchWholeObjectInfo({ ...opts, deadlineMs: 20 }),
    CACHE_OUTCOME,
    snapshot,
    epoch,
    socketDown,
    (defs) => built.recordHistory(defs),
    objectInfoOracleFailureNote,
  );
  return built;
}

const hungApi = { getNodeDefs: () => new Promise(() => {}), fetchApi: () => new Promise(() => {}) };

test("#1223 SHIPPED: a live answer is returned and snapshotted", async () => {
  const snapshot = createObjectInfoSnapshot();
  const o = buildShippedOracle({ api: { getNodeDefs: async () => SCHEMA }, snapshot, epoch: 5 });
  assert.equal(await o.getFreshObjectInfo(), SCHEMA);
  assert.deepEqual(snapshot.peek(), { held: true, epoch: 5 }, "stamped with the connection it was read on");
  assert.equal(o.readSnapshotNote(), null, "a live authorization discloses nothing, because there is nothing to disclose");
  assert.deepEqual(o.readHistory(), [SCHEMA], "and it IS a real observation, so the ever-seen history takes it");
});

test("#1223 SHIPPED: the reported case — hung probes fall back and disclose", async () => {
  const snapshot = createObjectInfoSnapshot();
  snapshot.record(SCHEMA, 5);
  const o = buildShippedOracle({ api: hungApi, snapshot, epoch: 5, socketDown: false });
  assert.equal(await o.getFreshObjectInfo(), SCHEMA, "the H3Keyframes edit is no longer refused");
  const note = o.readSnapshotNote();
  assert.equal(typeof note, "string");
  assert.match(note, /did not answer/, "and the reply can say which routes went silent");
});

test("#1223 SHIPPED: a snapshot re-read is NOT recorded as a new backend observation", async () => {
  // Recording it would let a snapshot keep its own types "ever seen" after the backend
  // stopped defining them — the #458 trust root feeding itself.
  const snapshot = createObjectInfoSnapshot();
  snapshot.record(SCHEMA, 5);
  const o = buildShippedOracle({ api: hungApi, snapshot, epoch: 5 });
  await o.getFreshObjectInfo();
  assert.deepEqual(o.readHistory(), [], "nothing new was observed, so nothing is recorded");
});

test("#1223 SHIPPED: a DOWN socket still refuses, and the refusal says why", async () => {
  const snapshot = createObjectInfoSnapshot();
  snapshot.record(SCHEMA, 5);
  const o = buildShippedOracle({ api: hungApi, snapshot, epoch: 5, socketDown: true });
  assert.equal(await o.getFreshObjectInfo(), null, "fails closed exactly as before the fix");
  assert.equal(o.readSnapshotNote(), null);
  assert.match(objectInfoOracleFailureNote(o.readFailures()), /socket is down/i);
});

test("#1223 SHIPPED: a reconnect since the observation still refuses", async () => {
  const snapshot = createObjectInfoSnapshot();
  snapshot.record(SCHEMA, 4);
  const o = buildShippedOracle({ api: hungApi, snapshot, epoch: 5 });
  assert.equal(await o.getFreshObjectInfo(), null);
  assert.match(objectInfoOracleFailureNote(o.readFailures()), /reconnected/i);
});

test("#1223 SHIPPED: a backend that ANSWERED badly still refuses — #458 is untouched", async () => {
  const snapshot = createObjectInfoSnapshot();
  snapshot.record(SCHEMA, 5);
  const o = buildShippedOracle({
    api: {
      getNodeDefs: async () => {
        throw new TypeError("Failed to fetch");
      },
      fetchApi: async () => ({ ok: false, status: 503 }),
    },
    snapshot,
    epoch: 5,
  });
  assert.equal(await o.getFreshObjectInfo(), null, "a down/erroring backend authorizes nothing");
});

test("#1223 SHIPPED: with no snapshot at all, the pre-fix refusal is unchanged", async () => {
  const o = buildShippedOracle({ api: hungApi, snapshot: createObjectInfoSnapshot(), epoch: 5 });
  assert.equal(await o.getFreshObjectInfo(), null);
  const note = objectInfoOracleFailureNote(o.readFailures());
  assert.match(note, /did not answer/, "the routes it tried are still named (#982)");
  assert.match(note, /no whole \/object_info has been observed/i);
});

// ---------------------------------------------------------------------------
// The whole-schema-only contract, which `record` cannot enforce from the value
// ---------------------------------------------------------------------------

test("#1223 the snapshot is recorded ONLY where a WHOLE schema was fetched", () => {
  // A per-class `/object_info/<Type>` payload reaching the snapshot would make every other
  // type read as absent, and the #458 ever-seen gate would diagnose the whole install as
  // removed packs. `recordObjectInfoTypes` legitimately receives such payloads (the
  // add_node single-def path); the snapshot must not.
  const sites = PANEL_SRC.match(/objectInfoSnapshot\.record\(/g) ?? [];
  assert.equal(sites.length, 2, "exactly two whole-schema call sites — add one and justify it here");
  assert.match(
    PANEL_SRC,
    /recordObjectInfoTypes\(defs\);[\s\S]{0,600}?objectInfoSnapshot\.record\(defs, backendReconnectEpoch\);/,
    "the refresh run records the whole map it just fetched",
  );
  assert.match(
    PANEL_SRC,
    /objectInfoSnapshot\.record\(defs, backendReconnectEpoch\);\s*\n\s*return recordObjectInfoTypes\(defs\);/,
    "and so does the set_widget oracle, on the whole-payload route",
  );
  assert.ok(
    !/objectInfoSnapshot\.record\(\s*one\b/.test(PANEL_SRC),
    "the single-def add_node payload never reaches the snapshot",
  );
});

test("#1223 a suspicion of schema change retires the snapshot with the burst cache", () => {
  // The refresh run drops the #716 cache at its START because a refresh that FAILS is when
  // the schema is most likely to have moved. A snapshot that survived that suspicion would
  // authorize writes the cache has already been told not to.
  assert.match(
    PANEL_SRC,
    /objectInfoCache\.invalidate\(\);[\s\S]{0,600}?objectInfoSnapshot\.clear\(\);/,
    "cleared on the same event, for the same reason",
  );
});

test("#1223 the disclosure rides on its OWN field, never on `warning`", () => {
  // `warning` is single-slot and priority-ordered (link-driven outranks
  // control_after_generate). Appending here would silently displace a warning about what
  // the write actually DOES — strictly worse than a separate field.
  assert.match(PANEL_SRC, /schema_source: "last-observed", schema_note: snapshotAuthorizationNote\(/);
  const setWidget = PANEL_SRC.slice(PANEL_SRC.indexOf("async graph_set_widget("));
  const body = setWidget.slice(0, setWidget.indexOf("async graph_remove_widget("));
  assert.ok(
    !/warning:[^\n]*snapshotAuthorizationNote/.test(body),
    "the provenance note never competes for the warning slot",
  );
});
