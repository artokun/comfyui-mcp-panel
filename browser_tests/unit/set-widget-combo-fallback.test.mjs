// panel#767 (found while reading #458) — a combo refresh that found nothing was
// reported as a refresh.
//
// `refreshCombos(defs, target, concreteType, nameMap)` handed its payload to
// `refreshComboOptionsFromDefs`, which does:
//
//     const def = type ? defsByType[type] : null;
//     if (!def) return refreshed;        // 0, silently
//
// So a payload that does not contain the type being keyed on refreshes NOTHING,
// and the caller carries on as though it had seen the authoritative option list.
// The documented consequence is that "a genuinely-invalid value simply stays
// rejected on the retry" — except the value may be perfectly valid and the list
// was never loaded. That is this codebase's tracked defect class: "I could not
// look it up" behaving as "I looked, and it is not there".
//
// `concreteType` is resolved through the PROMOTION CHAIN, so it is not always the
// target's own type — which is exactly how a payload can be present and still be
// the wrong one.
//
// The fallback is not new behaviour: it is what a MISSING payload already does.
// This only ever replaces a silent no-op with the refresh that was intended.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { SET_WIDGET_POST_REFRESH_RESERVE_MS } from "./_panel-constants.mjs";
import { REFRESH_JOIN_ABANDONED } from "../../web/js/lib/refresh-coalesce.js";
import { COMBO_REFRESH_NEVER_RAN } from "../../web/js/lib/set-widget.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");
const panelSrc = readFileSync(PANEL_JS, "utf8");

// Drive the SHIPPED callback, not a transcription of it. The other set-widget
// suites re-implement `refreshCombos` in the test file, so none of them would
// notice this wiring changing.
const match = panelSrc.match(/refreshCombos: async \(defs, target, concreteType, nameMap\) => \{[\s\S]*?\n {6}\},/);
assert.ok(match, "could not locate the panel's refreshCombos wiring");

function shippedRefreshCombos({
  onFromDefs,
  onFullRefresh,
  // #1413 — the callback now draws its join bound from the command budget the handler
  // took on its first line. A healthy command's remainder, by default.
  budget = { remaining: () => 21000 },
  // #1418 — the coalescer's live slot, read to tell "a run is still going" apart from
  // "nothing was started". Empty by default.
  nodeDefRefreshInFlight = null,
}) {
  const body = match[0].replace(/^refreshCombos: /, "");
  const factory = new Function(
    "refreshComboOptionsFromDefs",
    "refreshComfyNodeDefs",
    "budget",
    "SET_WIDGET_POST_REFRESH_RESERVE_MS",
    "nodeDefRefreshInFlight",
    "REFRESH_JOIN_ABANDONED",
    "COMBO_REFRESH_NEVER_RAN",
    `return (${body.replace(/,$/, "")});`,
  );
  return factory(
    onFromDefs,
    onFullRefresh,
    budget,
    SET_WIDGET_POST_REFRESH_RESERVE_MS,
    nodeDefRefreshInFlight,
    REFRESH_JOIN_ABANDONED,
    COMBO_REFRESH_NEVER_RAN,
  );
}

function spies(overrides = {}) {
  const calls = { fromDefs: [], full: 0, fullArgs: [] };
  const fn = shippedRefreshCombos({
    onFromDefs: (target, defs, type, nameMap) => {
      calls.fromDefs.push({ target, defs, type, nameMap });
      return 1;
    },
    onFullRefresh: (...args) => {
      calls.full++;
      calls.fullArgs.push(args);
      return Promise.resolve("full");
    },
    ...overrides,
  });
  return { fn, calls };
}

const TARGET = { type: "CheckpointLoaderSimple" };
const DEFS = { CheckpointLoaderSimple: { input: { required: { ckpt_name: [["a.safetensors"]] } } } };

test("#767 a payload CONTAINING the keyed type is used, with no full refresh", () => {
  const { fn, calls } = spies();
  fn(DEFS, TARGET, "CheckpointLoaderSimple", null);
  assert.equal(calls.fromDefs.length, 1, "the payload was used");
  assert.equal(calls.fromDefs[0].type, "CheckpointLoaderSimple");
  assert.equal(calls.full, 0, "and the expensive path was avoided — the #458 P2 single-fetch rule");
});

test("#767 a payload MISSING the keyed type falls back instead of no-opping", () => {
  // The promoted case: concreteType is resolved through the chain, so the payload
  // can be present and still not contain it. Before this, the lookup missed and
  // returned 0 without telling anyone.
  const { fn, calls } = spies();
  fn(DEFS, { type: "SubgraphNode" }, "SomeInnerLoader", null);
  assert.equal(calls.fromDefs.length, 0, "a payload that cannot answer must not be used");
  assert.equal(calls.full, 1, "the full refresh runs — what a missing payload already did");
});

test("#767 no payload at all still takes the full refresh, unchanged", () => {
  const { fn, calls } = spies();
  fn(undefined, TARGET, "CheckpointLoaderSimple", null);
  assert.equal(calls.fromDefs.length, 0);
  assert.equal(calls.full, 1);
});

test("#767 a null/absent concreteType falls back to the target's own type", () => {
  // The chain resolves to nothing for an ordinary, unpromoted node. That must key
  // on the node's own type rather than treat the payload as unusable.
  const { fn, calls } = spies();
  fn(DEFS, TARGET, null, null);
  assert.equal(calls.fromDefs.length, 1, "an unpromoted node still uses the payload");
  assert.equal(calls.fromDefs[0].type, "CheckpointLoaderSimple");
  assert.equal(calls.full, 0);
});

test("#767 an INHERITED key is not the payload containing the type", () => {
  // Object.create({X: …}) answers `defs[X]` but the backend never sent it. Using
  // hasOwnProperty is what keeps a prototype from forging a refresh.
  const { fn, calls } = spies();
  fn(Object.create(DEFS), TARGET, "CheckpointLoaderSimple", null);
  assert.equal(calls.fromDefs.length, 0);
  assert.equal(calls.full, 1);
});

test("#767 nameMap still reaches the refresh for a RENAMED nested promotion", () => {
  // #458x#366 — the bridge that lets a renamed promoted combo be refreshed under
  // its real backend input name. Easy to drop while editing the guard around it.
  const { fn, calls } = spies();
  const nameMap = { outer_name: "ckpt_name" };
  fn(DEFS, TARGET, "CheckpointLoaderSimple", nameMap);
  assert.equal(calls.fromDefs[0].nameMap, nameMap);
});

test("#1413 the full-refresh fallback is bounded by the command's remaining budget", () => {
  // The whole point of the issue: this await used to be a bare `refreshComfyNodeDefs()`,
  // a plain join of a run someone else started with no bound at all, inside the 30s relay
  // window. Deleting the joinMs from the panel must fail HERE — a lib-level test cannot
  // see the wiring, and the other suites re-implement this callback.
  const budget = { remaining: () => 12345 };
  const { fn, calls } = spies({ budget });
  fn(undefined, TARGET, "CheckpointLoaderSimple", null);
  assert.equal(calls.full, 1, "the fallback still runs");
  assert.deepEqual(
    calls.fullArgs[0],
    [undefined, { joinMs: 12345 - SET_WIDGET_POST_REFRESH_RESERVE_MS }],
    "joinMs is the command's remainder minus the reserve — not a fresh constant, not absent",
  );
});

test("#1413 an exhausted command hands the coalescer a non-positive joinMs, not silence", () => {
  // The coalescer treats joinMs <= 0 as "abandon WITHOUT awaiting" (withTimeout would read
  // it as NO BOUND), which is the honest refusal the lib then raises. Wiring that dropped
  // the joinMs instead would restore the unbounded hang at exactly the worst moment.
  const budget = { remaining: () => -50 };
  const { fn, calls } = spies({ budget });
  fn(undefined, TARGET, "CheckpointLoaderSimple", null);
  assert.equal(calls.full, 1);
  const { joinMs } = calls.fullArgs[0][1];
  assert.ok(Number.isFinite(joinMs) && joinMs <= 0, `joinMs must say "spent", got ${joinMs}`);
});

test("#1418 an abandonment with NOTHING running is a distinct token, not REFRESH_JOIN_ABANDONED", async () => {
  // The whole point of the issue: with the budget spent and the slot empty the coalescer
  // starts NOTHING, so "a refresh is still running — retry joins it" would be a claim about
  // a run that does not exist. The wrapper translates that arm to COMBO_REFRESH_NEVER_RAN.
  const { fn } = spies({
    budget: { remaining: () => -50 }, // joinMs <= 0
    nodeDefRefreshInFlight: null, // …and the slot is empty
    onFullRefresh: async () => REFRESH_JOIN_ABANDONED,
  });
  const outcome = await fn(undefined, TARGET, "CheckpointLoaderSimple", null);
  assert.equal(outcome, COMBO_REFRESH_NEVER_RAN, "the refusal must be worded for 'never ran'");
});

test("#1418 an abandonment with a run in flight (or budget for an own run) stays REFRESH_JOIN_ABANDONED", async () => {
  // The state the original wording IS true of: a run occupies the slot and is still
  // registering. Both facts are read BEFORE the coalescer call, so the translation can
  // never disagree with the coalescer's own decision.
  for (const [label, extra] of [
    ["slot occupied, budget spent", { budget: { remaining: () => -50 }, nodeDefRefreshInFlight: Promise.resolve() }],
    ["slot empty, budget left", { budget: { remaining: () => 5000 }, nodeDefRefreshInFlight: null }],
  ]) {
    const { fn } = spies({ ...extra, onFullRefresh: async () => REFRESH_JOIN_ABANDONED });
    const outcome = await fn(undefined, TARGET, "CheckpointLoaderSimple", null);
    assert.equal(outcome, REFRESH_JOIN_ABANDONED, `${label}: a refresh is verifiably running`);
  }
});

test("#1418 a COMPLETED refresh is returned untouched by the translation", async () => {
  const { fn } = spies({ budget: { remaining: () => -50 }, nodeDefRefreshInFlight: null });
  const outcome = await fn(undefined, TARGET, "CheckpointLoaderSimple", null);
  assert.equal(outcome, "full", "only the abandoned state is reworded");
});
