// Unit tests for the manual-canvas-change baseline gate (web/js/lib/manual-change-gate.js).
//
// Regression coverage for #369: after a session reload/resume the tracker injected a
// "MANUAL CANVAS CHANGES … 100+ nodes removed" notice that the very next live graph
// read contradicted. Root cause: the baseline (captured before the session boundary)
// was diffed against a rebound / mid-reload canvas. The gate must discard a baseline
// from a prior session epoch, and never diff on an unconfirmable workflow identity.
import test from "node:test";
import assert from "node:assert/strict";

import { classifyManualChangeBaseline } from "../../web/js/lib/manual-change-gate.js";

const KEY_A = "uuid-A";
const KEY_B = "uuid-B";

test("same epoch + same confirmed identity → diff", () => {
  const d = classifyManualChangeBaseline({
    hasBaseline: true,
    baselineKey: KEY_A,
    baselineEpoch: 3,
    currentKey: KEY_A,
    currentEpoch: 3,
  });
  assert.equal(d.action, "diff");
});

test("baseline from a PRIOR session epoch → reseed, never diff (#369 core)", () => {
  // The reported bug: baseline captured at epoch 2, then a reconnect/resume bumped
  // the epoch to 3. Even with a matching workflow identity, the baseline is stale.
  const d = classifyManualChangeBaseline({
    hasBaseline: true,
    baselineKey: KEY_A,
    baselineEpoch: 2,
    currentKey: KEY_A,
    currentEpoch: 3,
  });
  assert.equal(d.action, "reseed", "a cross-epoch baseline must be discarded, not diffed");
});

test("provably different identity (same epoch) → workflow-changed notice", () => {
  const d = classifyManualChangeBaseline({
    hasBaseline: true,
    baselineKey: KEY_A,
    baselineEpoch: 5,
    currentKey: KEY_B,
    currentEpoch: 5,
  });
  assert.equal(d.action, "workflow-changed");
});

test("unknown current identity (same epoch) → reseed, never a false delta (#369)", () => {
  // workflowStableUuid() threw / could not resolve during a mid-reload window.
  const d = classifyManualChangeBaseline({
    hasBaseline: true,
    baselineKey: KEY_A,
    baselineEpoch: 1,
    currentKey: null,
    currentEpoch: 1,
  });
  assert.equal(d.action, "reseed");
});

test("unknown baseline identity (same epoch) → reseed, never a false delta", () => {
  const d = classifyManualChangeBaseline({
    hasBaseline: true,
    baselineKey: null,
    baselineEpoch: 1,
    currentKey: KEY_A,
    currentEpoch: 1,
  });
  assert.equal(d.action, "reseed");
});

test("no baseline yet → reseed (nothing to diff)", () => {
  const d = classifyManualChangeBaseline({
    hasBaseline: false,
    baselineKey: null,
    baselineEpoch: -1,
    currentKey: KEY_A,
    currentEpoch: 0,
  });
  assert.equal(d.action, "reseed");
});

test("epoch precedence: a cross-epoch boundary wins even over a workflow-switch", () => {
  // Different identity AND different epoch — the stale-epoch reseed takes precedence
  // (we don't assert a confident "workflow changed" across a session boundary we
  // can't reason about); either way, no per-node delta is emitted.
  const d = classifyManualChangeBaseline({
    hasBaseline: true,
    baselineKey: KEY_A,
    baselineEpoch: 2,
    currentKey: KEY_B,
    currentEpoch: 4,
  });
  assert.equal(d.action, "reseed");
});

test("non-finite / missing epoch on either side is treated as a boundary → reseed", () => {
  const nonFinite = [NaN, undefined, null, Infinity, "3"];
  for (const bad of nonFinite) {
    assert.equal(
      classifyManualChangeBaseline({
        hasBaseline: true,
        baselineKey: KEY_A,
        baselineEpoch: bad,
        currentKey: KEY_A,
        currentEpoch: 0,
      }).action,
      "reseed",
      `baselineEpoch=${String(bad)} must reseed`,
    );
    assert.equal(
      classifyManualChangeBaseline({
        hasBaseline: true,
        baselineKey: KEY_A,
        baselineEpoch: 0,
        currentKey: KEY_A,
        currentEpoch: bad,
      }).action,
      "reseed",
      `currentEpoch=${String(bad)} must reseed`,
    );
  }
  // Both sides non-finite (the Object.is(NaN,NaN)===true trap) must STILL reseed.
  assert.equal(
    classifyManualChangeBaseline({
      hasBaseline: true,
      baselineKey: KEY_A,
      baselineEpoch: NaN,
      currentKey: KEY_A,
      currentEpoch: NaN,
    }).action,
    "reseed",
    "both-NaN must not diff",
  );
  assert.equal(
    classifyManualChangeBaseline({
      hasBaseline: true,
      baselineKey: KEY_A,
      baselineEpoch: undefined,
      currentKey: KEY_A,
      currentEpoch: undefined,
    }).action,
    "reseed",
    "both-undefined must not diff",
  );
});
