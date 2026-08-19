/**
 * #1413 — `graph_set_widget`'s stale-combo recovery must answer inside the relay window.
 *
 * THE DEFECT. The recovery falls back to the full frontend refresh when the /object_info
 * already fetched for authorization cannot key the target's concrete type. That call passed
 * NO `joinMs`, so the single deadline `makeRefreshCoalescer` takes at invocation was never
 * armed and the recovery waited without any bound at all — on a run someone else started,
 * or, with an empty slot, on one of its own. `graph_set_widget` is relayed at
 * OBJECT_INFO_REFRESH_ACK_TIMEOUT_MS (30,000 ms), the constant that produced #1404's
 * exact-30-second symptom, and the recovery is reached only AFTER the baseline seed and the
 * authorization fetch have already spent part of that window.
 *
 * WHY A HELPER-LEVEL TEST CANNOT SEE IT — the same reason #1404's could not. The coalescer
 * has honoured `joinMs` correctly since #1192, and #1351 already made that one deadline span
 * the join AND the run behind it; refresh-coalesce.test.mjs proves both. The whole bug was
 * the CALL SITE passing no bound. So these drive the SHIPPED `refreshCombos` wiring, pulled
 * out of the panel source, over the REAL `makeRefreshCoalescer` and the REAL `withTimeout`,
 * against a REAL run that never settles.
 *
 * THE CLOCK IS DRIVEN, THE TIMERS ARE NOT. `makeCommandBudget` reads the clock this harness
 * supplies, so a test can put the command 24-and-a-bit seconds in without waiting; the
 * coalescer's bound is then a real `setTimeout` of a few dozen milliseconds. That keeps the
 * abandonment a genuine race between a real timer and a real promise rather than a
 * simulation of one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { runSetWidget } from "../../web/js/lib/set-widget.js";
import { makeRefreshCoalescer, REFRESH_JOIN_ABANDONED } from "../../web/js/lib/refresh-coalesce.js";
import { withTimeout } from "../../web/js/lib/bounded-step.js";
import { makeCommandBudget } from "../../web/js/lib/command-budget.js";
import { NODE_DEF_REFRESH_REASONS } from "../../web/js/lib/node-def-refresh.js";
import {
  PANEL_SRC,
  SET_WIDGET_COMMAND_BUDGET_MS,
  SET_WIDGET_ASSET_PROBE_MS,
} from "./_panel-constants.mjs";

/** The shipped `refreshCombos` wiring, verbatim from the panel. */
const REFRESH_COMBOS_SRC = (() => {
  const m = PANEL_SRC.match(/refreshCombos: \(defs, target, concreteType, nameMap\) => \{[\s\S]*?\n {6}\},/);
  assert.ok(m, "could not locate the panel's refreshCombos wiring — update this harness");
  return m[0].replace(/^refreshCombos: /, "").replace(/,$/, "");
})();

/** The shipped #387 upload-asset probe, verbatim from the panel. */
const CONFIRM_ASSET_SRC = (() => {
  const m = PANEL_SRC.match(/confirmServerAsset: async \(assetValue\) => \{[\s\S]*?\n {6}\},/);
  assert.ok(m, "could not locate the panel's confirmServerAsset wiring — update this harness");
  return m[0].replace(/^confirmServerAsset: /, "").replace(/,$/, "");
})();

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * The shipped fallback, wired to a REAL coalescer.
 *
 * `spentMs` moves the command's clock forward before the callback is built, which is how a
 * 25,000 ms budget becomes a bound this test can wait out. The clock is monotonic and only
 * moves when a test moves it — the panel measures on `monotonicNow`, never `Date.now`, and a
 * harness that used the wall clock here would be testing a different function.
 */
function shippedFallback({ runRegister, spentMs = 0 }) {
  let inFlight = null;
  const registered = [];
  const refreshComfyNodeDefs = makeRefreshCoalescer({
    getInFlight: () => inFlight,
    setInFlight: (p) => {
      inFlight = p;
    },
    runRegister: async (defs) => {
      registered.push(defs);
      return runRegister(defs);
    },
    withTimeout,
  });

  let now = 0;
  const monotonicNow = () => now;
  const budget = makeCommandBudget(SET_WIDGET_COMMAND_BUDGET_MS, monotonicNow);
  now = spentMs;

  let comboRefreshUnavailable = null;
  const factory = new Function(
    "refreshComboOptionsFromDefs",
    "refreshComfyNodeDefs",
    "budget",
    "NODE_DEF_REFRESH_REASONS",
    "REFRESH_JOIN_ABANDONED",
    "SET_WIDGET_POST_REFRESH_RESERVE_MS",
    "setToken",
    `let comboRefreshUnavailable = null;
     const refreshCombos = ${REFRESH_COMBOS_SRC};
     return (...args) => {
       const out = refreshCombos(...args);
       return Promise.resolve(out).then(
         (v) => { setToken(comboRefreshUnavailable); return v; },
         (e) => { setToken(comboRefreshUnavailable); throw e; },
       );
     };`,
  );
  const fn = factory(
    () => 1,
    refreshComfyNodeDefs,
    budget,
    NODE_DEF_REFRESH_REASONS,
    REFRESH_JOIN_ABANDONED,
    SET_WIDGET_ASSET_PROBE_MS,
    (t) => {
      comboRefreshUnavailable = t;
    },
  );
  return {
    fn,
    registered,
    readToken: () => comboRefreshUnavailable,
    slotOccupied: () => inFlight !== null,
    // Start a run the way any other panel trigger would, so the recovery meets a REAL
    // in-flight registration rather than a promise parked in the slot by hand.
    startForeignRun: () => refreshComfyNodeDefs(),
  };
}

/** A promise that rejects if `p` has not settled within `ms` — so a hang FAILS instead of hanging. */
function mustSettleWithin(p, ms, what) {
  let timer;
  const failsafe = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms — the wait is unbounded`)), ms);
    // A passing run must not idle on this timer for the full bound.
    timer.unref?.();
  });
  return Promise.race([p, failsafe]).finally(() => clearTimeout(timer));
}

test("#1413 the fallback ABANDONS a run it did not start, instead of waiting it out", async () => {
  // The reported shape: something else — a reconnect, a finished install, this panel's own
  // missing-asset check after an upload — is already refreshing when the write's combo
  // rejection sends it here. Before the fix this awaited that run with no bound.
  const never = deferred();
  const h = shippedFallback({ runRegister: () => never.promise, spentMs: SET_WIDGET_COMMAND_BUDGET_MS - 3000 - 80 });
  const foreign = h.startForeignRun();

  const outcome = await mustSettleWithin(
    h.fn(undefined, { type: "CheckpointLoaderSimple" }, "CheckpointLoaderSimple", undefined),
    3000,
    "the stale-combo recovery",
  );

  // A LITERAL, not only a lookup in the map the panel reads from. #1404 recorded why:
  // deleting the token from NODE_DEF_REFRESH_REASONS killed zero tests, because the panel
  // and the tests degraded to `undefined` together while the shipped reply would have
  // carried a key JSON.stringify drops outright.
  assert.equal(outcome, "refresh_still_running");
  assert.equal(h.readToken(), "refresh_still_running", "and the command records it for the reply");
  assert.equal(outcome, NODE_DEF_REFRESH_REASONS.REFRESH_STILL_RUNNING);

  // NOT CANCELLED, which is the whole argument for telling the caller to retry: the run
  // still holds the coalescer's slot and is still fetching the /object_info this write
  // wanted, so the retry joins work in progress rather than starting a second pass.
  assert.equal(h.slotOccupied(), true, "the abandoned run still holds the slot");
  never.resolve({ refreshed: true });
  await foreign;
  assert.deepEqual(h.registered, [undefined], "exactly one registration ran — no stampede");
});

test("#1413 a run the fallback started ITSELF is bounded too", async () => {
  // The uncontended case, and the one the issue sizes the exposure from: with an empty slot
  // the coalescer starts a run for this caller, whose own budget deliberately stops its
  // clock across registerNodesFromDefs/reapplyDefsToLiveNodes. #1351 made one `joinMs` span
  // that too — but only for a caller that passes one, which this call site did not.
  const never = deferred();
  const h = shippedFallback({ runRegister: () => never.promise, spentMs: SET_WIDGET_COMMAND_BUDGET_MS - 3000 - 80 });

  const outcome = await mustSettleWithin(
    h.fn(undefined, { type: "CheckpointLoaderSimple" }, "CheckpointLoaderSimple", undefined),
    3000,
    "the uncontended stale-combo recovery",
  );
  assert.equal(outcome, "refresh_still_running");
  assert.deepEqual(h.registered, [undefined], "it started the run and kept it running");
  never.resolve({ refreshed: true });
});

test("#1413 a refresh that lands INSIDE the budget is reported as a refresh, unchanged", async () => {
  // The bound must not turn a healthy recovery into a refusal. This is the ordinary path:
  // the run settles, the fallback resolves the run's own verdict, and nothing is disclosed.
  const h = shippedFallback({ runRegister: async () => ({ refreshed: true }), spentMs: 0 });
  const outcome = await h.fn(undefined, { type: "CheckpointLoaderSimple" }, "CheckpointLoaderSimple", undefined);
  assert.deepEqual(outcome, { refreshed: true });
  assert.equal(h.readToken(), null, "nothing to disclose — the list really was re-read");
});

test("#1413 an EXHAUSTED budget starts nothing it then has to abandon at once", async () => {
  // A negative `joinMs` must never reach `withTimeout`, which reads a non-positive bound as
  // NO BOUND — the trap #1188 recorded. A command whose window is already gone must report
  // that, not remove its own bound at the moment it is most needed.
  const never = deferred();
  const h = shippedFallback({ runRegister: () => never.promise, spentMs: SET_WIDGET_COMMAND_BUDGET_MS + 5000 });
  const outcome = await mustSettleWithin(
    h.fn(undefined, { type: "CheckpointLoaderSimple" }, "CheckpointLoaderSimple", undefined),
    3000,
    "the recovery on an exhausted budget",
  );
  assert.equal(outcome, "refresh_still_running");
  // AND NOTHING IS RUNNING. This is the state the reply's wording has to survive: the same
  // symbol comes back here as when a real run held the slot, so any sentence asserting "a
  // node-def refresh is still running" is flatly wrong in this arm. Found by the gate, not
  // by the first version of these tests.
  assert.deepEqual(h.registered, [], "no run was started");
  assert.equal(h.slotOccupied(), false, "and none is in flight to be waiting for");
  never.resolve({ refreshed: true });
});

test("#1413 a payload that DOES key the type never reaches the bounded path at all", async () => {
  // #458 P2's single-fetch rule is untouched: the in-place refresh is synchronous, takes no
  // budget, and discloses nothing.
  const h = shippedFallback({ runRegister: async () => ({ refreshed: true }), spentMs: 0 });
  const defs = { CheckpointLoaderSimple: { input: { required: { ckpt_name: [["a.safetensors"]] } } } };
  const outcome = await h.fn(defs, { type: "CheckpointLoaderSimple" }, "CheckpointLoaderSimple", undefined);
  assert.equal(outcome, undefined);
  assert.deepEqual(h.registered, [], "no run was started");
  assert.equal(h.readToken(), null);
});

// ---------------------------------------------------------------------------
// What the reply says about a refresh that did not happen (web/js/lib/set-widget.js)
// ---------------------------------------------------------------------------

const REGISTRY = { CheckpointLoaderSimple: {} };
const FRESH = { CheckpointLoaderSimple: {} };
const freshOracle = { getFreshObjectInfo: async () => FRESH };

function loaderNode() {
  return {
    id: 7,
    type: "CheckpointLoaderSimple",
    widgets: [
      { name: "ckpt_name", type: "combo", options: { values: ["old.safetensors"] }, value: "old.safetensors" },
    ],
  };
}

test("#1413 a refusal after an abandoned refresh does NOT claim the list was refreshed", async () => {
  // The false-confidence half of this defect, and the one that outlives the timeout: an
  // agent told a FRESH list rejected its value stops retrying a value that is fine.
  const node = loaderNode();
  const err = await runSetWidget(node, "ckpt_name", "just_downloaded.safetensors", {
    registry: REGISTRY,
    ...freshOracle,
    refreshCombos: async () => NODE_DEF_REFRESH_REASONS.REFRESH_STILL_RUNNING,
  }).then(
    () => null,
    (e) => e,
  );

  assert.ok(err, "the write must still be refused — a bound never admits a value");
  assert.ok(
    !/after refreshing combo options/.test(err.message),
    `the refusal must not claim a refresh that did not happen: ${err.message}`,
  );
  assert.match(err.message, /combo options NOT refreshed/);
  assert.match(err.message, /refresh_still_running/, "the structured reason is named");
  assert.match(err.message, /RETRY/, "and a retry is expected to succeed, not merely hoped for");
  assert.equal(node.widgets[0].value, "old.safetensors", "nothing was written");
});

test("#1413 a refusal after a REAL refresh still reads exactly as it did", async () => {
  // The control. A bound that quietly reworded every refusal would be a regression of its
  // own — #240's rejection of a genuinely-invalid value must still say what it always said.
  const node = loaderNode();
  const err = await runSetWidget(node, "ckpt_name", "not_a_real_model.safetensors", {
    registry: REGISTRY,
    ...freshOracle,
    refreshCombos: async () => {},
  }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err);
  assert.match(err.message, /after refreshing combo options/);
  assert.ok(!/refresh_still_running/.test(err.message));
});

test("#1413 a write that SUCCEEDS after an abandoned refresh discloses that it was not refreshed", async () => {
  // The in-flight run this command stopped waiting for can land between the two attempts, so
  // the retry can succeed. `refreshed: true` would then credit a refresh this command did
  // not perform — a small lie, but the field is what a caller reads to decide whether the
  // option list it just saw was authoritative.
  const node = loaderNode();
  const res = await runSetWidget(node, "ckpt_name", "landed_underneath.safetensors", {
    registry: REGISTRY,
    ...freshOracle,
    refreshCombos: async () => {
      // Something else's run finished and rebuilt the list — the recovery still did not.
      node.widgets[0].options.values.push("landed_underneath.safetensors");
      return NODE_DEF_REFRESH_REASONS.REFRESH_STILL_RUNNING;
    },
  });

  assert.equal(res.set.value, "landed_underneath.safetensors");
  assert.equal(res.refreshed, false, "the command did not refresh the list");
  assert.equal(res.combo_refresh_incomplete, "refresh_still_running");
  assert.match(res.combo_refresh_note, /NOT re-read from the server/);
});

test("#1413 an ordinary successful refresh still reports refreshed:true and no disclosure", async () => {
  const node = loaderNode();
  const res = await runSetWidget(node, "ckpt_name", "new.safetensors", {
    registry: REGISTRY,
    ...freshOracle,
    refreshCombos: async () => {
      node.widgets[0].options.values.push("new.safetensors");
    },
  });
  assert.equal(res.refreshed, true);
  assert.equal(res.combo_refresh_incomplete, undefined);
  assert.equal(res.combo_refresh_note, undefined);
});

test("#1413 only a STRING is read as the token — a verdict object is not a refusal to refresh", async () => {
  // The contract is deliberately narrow. `undefined` is what the in-place path returns and
  // what a settled plain join resolves to; a verdict OBJECT is what a completed run
  // resolves to. Widening this to "anything truthy" would make every completed run disclose
  // that it had not run.
  const node = loaderNode();
  const res = await runSetWidget(node, "ckpt_name", "new.safetensors", {
    registry: REGISTRY,
    ...freshOracle,
    refreshCombos: async () => {
      node.widgets[0].options.values.push("new.safetensors");
      return { refreshed: true, reason: undefined };
    },
  });
  assert.equal(res.refreshed, true);
  assert.equal(res.combo_refresh_incomplete, undefined);
});

test("#1413 neither the disclosure nor the refusal asserts a refresh that may not exist", async () => {
  // The same symbol comes back whether the budget went on a run already in flight or was
  // already spent before one could be started, so no reply may name only the first — the
  // over-claim #1409 had to correct in `refresh_nodes`' own refusal, caught here by the gate.
  const node = loaderNode();
  const res = await runSetWidget(node, "ckpt_name", "landed.safetensors", {
    registry: REGISTRY,
    ...freshOracle,
    refreshCombos: async () => {
      node.widgets[0].options.values.push("landed.safetensors");
      return NODE_DEF_REFRESH_REASONS.REFRESH_STILL_RUNNING;
    },
  });
  assert.ok(
    !/refresh was still running|is still running|still fetching/.test(res.combo_refresh_note),
    `the disclosure asserts a run it cannot see: ${res.combo_refresh_note}`,
  );
  assert.match(res.combo_refresh_note, /either waiting on a node-def refresh already in flight, or before one could be started/);

  const err = await runSetWidget(loaderNode(), "ckpt_name", "nope.safetensors", {
    registry: REGISTRY,
    ...freshOracle,
    refreshCombos: async () => NODE_DEF_REFRESH_REASONS.REFRESH_STILL_RUNNING,
  }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err);
  assert.ok(
    !/still fetching exactly the/.test(err.message),
    "the refusal promises a fetch it cannot know happened",
  );
  assert.match(err.message, /either waiting on a node-def refresh already in flight, or before one could be started/);
  // The retry argument that IS true in every arm, including the one with no run at all.
  assert.match(err.message, /re-enters this recovery|runs this recovery again with a fresh budget/);
});

// ---------------------------------------------------------------------------
// The last unbounded network step in this command
// ---------------------------------------------------------------------------

test("#1413 the #387 upload-asset probe answers false instead of parking the command", async () => {
  // A `/view` GET with `Range: bytes=0-0` against the server's input directory, and until
  // now the one step in this command with no bound at all — reached at the END of the
  // ladder, so a stalled connection here spends a window every step before it drew down.
  // Failing closed costs nothing: the probe already answers false for every error, and one
  // that did not answer has confirmed nothing.
  let now = 0;
  const budget = makeCommandBudget(SET_WIDGET_COMMAND_BUDGET_MS, () => now);
  const factory = new Function(
    "api",
    "withTimeout",
    "budget",
    "SET_WIDGET_ASSET_PROBE_MS",
    `return ${CONFIRM_ASSET_SRC};`,
  );
  const probe = factory(
    { fetchApi: () => new Promise(() => {}) },
    withTimeout,
    budget,
    // Shrunk from the panel's own constant so the test waits milliseconds rather than
    // seconds; the code path, the primitive and the failing-closed answer are the shipped
    // ones. The panel's real value is asserted below.
    40,
    );

  const answered = await mustSettleWithin(probe("nested/dir/photo.png"), 3000, "the upload-asset probe");
  assert.equal(answered, false, "a probe that did not answer has confirmed nothing");
  assert.ok(SET_WIDGET_ASSET_PROBE_MS > 0, "and the panel holds a real, positive bound for it");
});

// ---------------------------------------------------------------------------
// Wiring pins — the parts a behavioural test cannot see
// ---------------------------------------------------------------------------

/**
 * `graph_set_widget`'s body alone.
 *
 * SCOPED, because a body-wide `PANEL_SRC` match is satisfied by a SIBLING call site:
 * `graph_add_node` bounds its own copy of the baseline-seed wait, so a pin that searched the
 * whole file stayed green with THIS command's bound deleted. Found by mutating the panel and
 * watching the pin pass.
 */
const SET_WIDGET_BODY = (() => {
  const start = PANEL_SRC.indexOf("async graph_set_widget({ node_id, widget, value, workflow_uuid }) {");
  assert.ok(start > 0, "graph_set_widget's signature has changed — update this harness");
  const end = PANEL_SRC.indexOf("async graph_remove_widget(", start);
  assert.ok(end > start, "graph_remove_widget no longer follows it — update this harness");
  return PANEL_SRC.slice(start, end);
})();

test("#1413 the budget is taken on graph_set_widget's FIRST line", () => {
  // Placement is the fix, not an incidental. The recovery is reached after the baseline seed
  // and the authorization /object_info, so a clock started later would hand it time the
  // command had already spent.
  const m = SET_WIDGET_BODY.match(/^async graph_set_widget\(\{ node_id, widget, value, workflow_uuid \}\) \{([\s\S]{0,2400}?)const \{ app, graph, LG, rootGraph \} = getGraphCtx\(\);/);
  assert.ok(m, "graph_set_widget's opening no longer looks like this — update this pin");
  assert.match(
    m[1],
    /const budget = makeCommandBudget\(SET_WIDGET_COMMAND_BUDGET_MS, monotonicNow\)/,
    "the budget must be taken before anything else the command does",
  );
});

test("#1413 the recovery's joinMs is DERIVED from the budget, never a constant of its own", () => {
  // The distinction the issue asked for. A fresh constant here could only disagree with what
  // the command had already spent; the remainder is the only honest number.
  const m = SET_WIDGET_BODY.match(/return refreshComfyNodeDefs\(undefined, \{\s*joinMs: ([^\r\n]+),/);
  assert.ok(m, "the stale-combo fallback no longer passes a joinMs — #1413 has regressed");
  assert.match(m[1], /budget\.remaining\(\) - SET_WIDGET_POST_REFRESH_RESERVE_MS/);
});

test("#1413 the seed wait and the authorization fetch draw from the same budget", () => {
  // Without these the budget's clock would be running while the two largest waits in the
  // command ignored it, and `budget.remaining()` at the recovery would be a true statement
  // about a window nothing else respected.
  assert.match(SET_WIDGET_BODY, /await awaitObjectInfoHistorySeed\(budget\.bounded\(OBJECT_INFO_SEED_WAIT_MS\)\);/);
  assert.match(SET_WIDGET_BODY, /deadlineMs: budget\.bounded\(OBJECT_INFO_DEADLINE_MS\),/);
  // The UNBOUNDED forms must be gone from THIS body. An added bound that leaves the old call
  // beside it reads as fixed and is not — and the positive match above cannot see that.
  assert.ok(
    !/await awaitObjectInfoHistorySeed\(\);/.test(SET_WIDGET_BODY),
    "an unbounded baseline-seed wait is back in graph_set_widget",
  );
});

test("#1413 the token the panel emits is the one the reasons map publishes", () => {
  // Read from the SOURCE, not from the import, so a panel that starts emitting a hand-typed
  // string fails here rather than agreeing with a test that imports the map it stopped using.
  assert.match(SET_WIDGET_BODY, /comboRefreshUnavailable = NODE_DEF_REFRESH_REASONS\.REFRESH_STILL_RUNNING;/);
  assert.equal(NODE_DEF_REFRESH_REASONS.REFRESH_STILL_RUNNING, "refresh_still_running");
});

test("#1413 the corrected #1192 note no longer claims set_widget's oracle allows 10,000 ms", () => {
  // #1409's own comment asserted refresh_nodes was "the last one that never took" a budget,
  // and that false reassurance concealed THIS occurrence. The same shape lived in
  // graph_add_node's fetch note, which said graph_set_widget's oracle "allows 10,000 ms" —
  // it goes through fetchWholeObjectInfo, whose deadline is 20,000 ms. A claim about another
  // command's numbers is checkable, so it is checked.
  const oracleSrc = readFileSync(new URL("../../web/js/lib/object-info-oracle.js", import.meta.url), "utf8");
  const declared = oracleSrc.match(/export const OBJECT_INFO_DEADLINE_MS = (\d+);/);
  assert.ok(declared, "OBJECT_INFO_DEADLINE_MS has moved — update this pin");
  assert.ok(
    !/the same request `graph_set_widget`'s oracle allows 10,000 ms/.test(PANEL_SRC),
    "the false claim is back in the panel",
  );
  assert.match(PANEL_SRC, new RegExp(`OBJECT_INFO_DEADLINE_MS is ${Number(declared[1]).toLocaleString("en-US")} ms`));
});

test("#1413 the other two relayed commands still hold ONE self-bounded wait each", () => {
  // THE AUDIT THE ISSUE ASKED FOR, checked rather than asserted in a comment. Six commands
  // are relayed in the orchestrator's 30,000 ms window; four now hold a budget
  // (graph_add_node, nodes_install, refresh_nodes, graph_set_widget) and these two do not.
  // They do not need one TODAY, for a reason that is a property of their bodies rather than
  // a promise: each has exactly one await and it lands on `fetchWholeObjectInfo`, which
  // bounds itself below the window and has nothing to compose against.
  //
  // Which is precisely the kind of claim that rots. #1409's comment said refresh_nodes was
  // "the last one that never took" a budget and that sentence concealed THIS issue, so this
  // one is a test: grow either command a second wait and it goes red, whether or not anyone
  // remembers to reread the note beside the constant.
  const oracleSrc = readFileSync(new URL("../../web/js/lib/object-info-oracle.js", import.meta.url), "utf8");
  assert.match(oracleSrc, /export const OBJECT_INFO_DEADLINE_MS = \d+;/, "the oracle's self-bound has moved");

  for (const name of ["graph_get_object_info", "graph_remove_widget"]) {
    const start = PANEL_SRC.indexOf(`async ${name}(`);
    assert.ok(start > 0, `${name} is no longer an async executor — update this audit`);
    const end = PANEL_SRC.indexOf("\n  },", start);
    assert.ok(end > start, `could not find the end of ${name}`);
    const body = PANEL_SRC.slice(start, end);

    const awaits = body
      .split(/\r?\n/)
      .filter((line) => /\bawait /.test(line) && !/^\s*(\/\/|\*)/.test(line));
    assert.equal(
      awaits.length,
      1,
      `${name} has grown to ${awaits.length} awaits — it now COMPOSES waits inside the ` +
        `30,000 ms relay window and needs a command budget like graph_set_widget's:\n` +
        awaits.map((l) => `    ${l.trim()}`).join("\n"),
    );
    assert.ok(
      !/refreshComfyNodeDefs/.test(body),
      `${name} now awaits the node-def coalescer — bound it with a command budget (#1413)`,
    );
  }
});
