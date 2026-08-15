/**
 * #1085 — a "correction" to an identical value is not a correction.
 *
 * `applyCurrentDefWidgetValues` reconciles a freshly built node against the backend's
 * CURRENT definition, and every value it changes is disclosed with a "this tab's schema is
 * STALE, reload it" warning. Both of its comparisons were `!==`, which is the right question
 * for a scalar and the wrong one for an OBJECT default: two readings of the same definition
 * produce distinct objects, so `!==` is true no matter what they contain.
 *
 * Core `ImageCropV2` declares `crop_region` as `{x, y, width, height}`, so every add of one
 * reported a correction from `{"x":0,"y":0,"width":512,"height":512}` to the identical
 * `{"x":0,"y":0,"width":512,"height":512}` — and told the user to reload the tab.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { applyCurrentDefWidgetValues } from "../../web/js/lib/node-widget-materialization.js";

/** A node as LG.createNode built it from the REGISTERED schema. */
const nodeWith = (name, value, options) => ({
  widgets: [{ name, value, ...(options ? { options } : {}) }],
});
/** The backend's CURRENT definition for that input. */
const defWith = (name, config, declared = "IMAGE") => ({
  input: { required: { [name]: [declared, config] } },
});

test("#1085: an object default equal by VALUE is not reported as a correction", () => {
  const region = { x: 0, y: 0, width: 512, height: 512 };
  const node = nodeWith("crop_region", { ...region });
  const corrections = applyCurrentDefWidgetValues(node, defWith("crop_region", { default: { ...region } }));
  assert.deepEqual(corrections, [], "identical content must not raise a STALE-schema warning");
  assert.deepEqual(node.widgets[0].value, region, "and the value is untouched");
});

test("#1085: key ORDER does not make two identical objects unequal", () => {
  // The reason this is a structural compare rather than JSON.stringify: two readings of the
  // same definition are free to serialize their keys in different orders, and stringify
  // would call those unequal — reproducing the bug through a second mechanism.
  const node = nodeWith("crop_region", { x: 0, y: 0, width: 512, height: 512 });
  const corrections = applyCurrentDefWidgetValues(
    node,
    defWith("crop_region", { default: { height: 512, width: 512, y: 0, x: 0 } }),
  );
  assert.deepEqual(corrections, []);
});

test("#1085: a GENUINELY changed object default is still corrected and disclosed", () => {
  // The fix must not silence the case the disclosure exists for.
  const node = nodeWith("crop_region", { x: 0, y: 0, width: 512, height: 512 });
  const corrections = applyCurrentDefWidgetValues(
    node,
    defWith("crop_region", { default: { x: 0, y: 0, width: 1024, height: 512 } }),
  );
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].name, "crop_region");
  assert.deepEqual(corrections[0].from, { x: 0, y: 0, width: 512, height: 512 });
  assert.deepEqual(corrections[0].to, { x: 0, y: 0, width: 1024, height: 512 });
  assert.deepEqual(node.widgets[0].value, { x: 0, y: 0, width: 1024, height: 512 });
});

test("#1085: nested and array defaults compare structurally too", () => {
  const node = nodeWith("cfg", { size: [512, 512], meta: { mode: "crop" } });
  assert.deepEqual(
    applyCurrentDefWidgetValues(node, defWith("cfg", { default: { size: [512, 512], meta: { mode: "crop" } } })),
    [],
  );
  // A single differing element is still a real change.
  const changed = nodeWith("cfg", { size: [512, 512], meta: { mode: "crop" } });
  assert.equal(
    applyCurrentDefWidgetValues(changed, defWith("cfg", { default: { size: [512, 768], meta: { mode: "crop" } } }))
      .length,
    1,
  );
});

test("#1085: differing key COUNT is a change even when the shared keys match", () => {
  const node = nodeWith("cfg", { x: 0, y: 0 });
  assert.equal(applyCurrentDefWidgetValues(node, defWith("cfg", { default: { x: 0, y: 0, z: 0 } })).length, 1);
});

test("#1085: scalar behaviour is unchanged — equal stays silent, different is reported", () => {
  const same = nodeWith("steps", 20);
  assert.deepEqual(applyCurrentDefWidgetValues(same, defWith("steps", { default: 20 }, "INT")), []);

  const diff = nodeWith("steps", 20);
  const corrections = applyCurrentDefWidgetValues(diff, defWith("steps", { default: 30 }, "INT"));
  assert.deepEqual(corrections, [{ name: "steps", from: 20, to: 30 }]);
});

test("#1085: null and undefined are not confused with an empty object", () => {
  const fromNull = nodeWith("cfg", null);
  assert.equal(applyCurrentDefWidgetValues(fromNull, defWith("cfg", { default: {} })).length, 1);
  const bothNull = nodeWith("cfg", null);
  assert.deepEqual(applyCurrentDefWidgetValues(bothNull, defWith("cfg", { default: null })), []);
  // undefined, which the title promised and the first version never exercised (codex).
  const fromUndef = nodeWith("cfg", undefined);
  assert.equal(applyCurrentDefWidgetValues(fromUndef, defWith("cfg", { default: {} })).length, 1);
  assert.equal(applyCurrentDefWidgetValues(nodeWith("cfg", undefined), defWith("cfg", { default: null })).length, 1);
});

test("#1085: a CYCLIC value terminates, and two identical cycles are equal", () => {
  // An /object_info default cannot be cyclic, but a live widget value could be. This used to
  // assert a spurious correction, because a depth CAP answered "different" for anything past
  // it. Cycle detection replaced the cap, so the honest answer is available: two structures
  // that close the same loop and agree everywhere else are equal.
  const cyclic = { x: 0 };
  cyclic.self = cyclic;
  const otherCyclic = { x: 0 };
  otherCyclic.self = otherCyclic;
  let corrections;
  assert.doesNotThrow(() => {
    corrections = applyCurrentDefWidgetValues(nodeWith("cfg", cyclic), defWith("cfg", { default: otherCyclic }));
  });
  assert.deepEqual(corrections, [], "identical cycles are not a change");

  // A cycle that differs OUTSIDE the loop is still a change, so this is not "cycles are
  // always equal".
  const differing = { x: 9 };
  differing.self = differing;
  assert.equal(
    applyCurrentDefWidgetValues(nodeWith("cfg", cyclic), defWith("cfg", { default: differing })).length,
    1,
  );
});

test("#1085 (codex r3): non-index own keys and huge sparse arrays are handled", () => {
  // "Infinity" / "1.5" / "1e+21" all satisfy String(Number(k)) === k, so they passed the
  // old index predicate. MUTATION NOTE: loosening that predicate does NOT break this test —
  // what makes these visible is the array branch comparing the PRESENT KEY SET instead of
  // walking 0..length, so every own key is visited whether or not it is an index. The
  // predicate is an additional refusal, not the mechanism.
  for (const key of ["Infinity", "1.5", "1e+21"]) {
    const x = [1];
    x[key] = 1;
    const y = [1];
    y[key] = 2;
    assert.equal(
      applyCurrentDefWidgetValues(nodeWith("cfg", { size: x }), defWith("cfg", { default: { size: y } })).length,
      1,
      `a differing "${key}" property must not hide`,
    );
  }
  // A single high sparse index sets length near 2^32; comparing PRESENT KEYS rather than
  // walking 0..length is what keeps this from spinning through billions of absent slots.
  const big = [];
  big[4294967294] = 1;
  const big2 = [];
  big2[4294967294] = 2;
  const started = Date.now();
  assert.equal(
    applyCurrentDefWidgetValues(nodeWith("cfg", { size: big }), defWith("cfg", { default: { size: big2 } })).length,
    1,
  );
  assert.ok(Date.now() - started < 1000, "must not walk the length");
});

test("#1085 (codex r3): an enumerable ACCESSOR is never invoked by the comparison", () => {
  // A getter would be CALLED by a structural compare — two different shapes could read
  // equal, and a throwing getter would crash a path that used to be a bare !==.
  const withGetter = { x: 1 };
  Object.defineProperty(withGetter, "boom", {
    enumerable: true,
    get() {
      throw new Error("a getter must never run here");
    },
  });
  let corrections;
  assert.doesNotThrow(() => {
    corrections = applyCurrentDefWidgetValues(nodeWith("cfg", withGetter), defWith("cfg", { default: { x: 1, boom: 1 } }));
  });
  assert.equal(corrections.length, 1, "refused structurally, so identity answers");
});

test("#1085: the #1369 self-contradictory COMBO ruling is unaffected", () => {
  // A combo whose declared default is not a member of its own option list is still REFUSED
  // rather than applied, and still reported through the out-param.
  const node = nodeWith("sage_attention", "disabled");
  const out = {};
  const corrections = applyCurrentDefWidgetValues(
    node,
    { input: { required: { sage_attention: [["disabled", "auto"], { default: false }] } } },
    out,
  );
  assert.deepEqual(corrections, [], "nothing applied");
  assert.deepEqual(out.rejected, [{ name: "sage_attention", proposed: false, kept: "disabled" }]);
  assert.equal(node.widgets[0].value, "disabled");
});

// ---- codex round 1: cases where "equal" would have been a FALSE NEGATIVE ----
// Every one of these is a REAL change that must still be reported. A missed correction is
// the dangerous direction: the wrong value ships silently.

test("#1085 (codex): SPARSE array holes are compared, not skipped", () => {
  // `Array.prototype.every` jumps over holes, so [,1] and [0,1] came out equal.
  const node = nodeWith("cfg", { size: [, 1] });
  const corrections = applyCurrentDefWidgetValues(node, defWith("cfg", { default: { size: [0, 1] } }));
  assert.equal(corrections.length, 1, "a hole is not the value 0");
  // The RECIPROCAL direction too — value where the other has a hole.
  const reciprocal = nodeWith("cfg", { size: [0, 1] });
  assert.equal(
    applyCurrentDefWidgetValues(reciprocal, defWith("cfg", { default: { size: [, 1] } })).length,
    1,
  );
  // …and a hole matching a hole is still equal.
  const same = nodeWith("cfg", { size: [, 1] });
  assert.deepEqual(applyCurrentDefWidgetValues(same, defWith("cfg", { default: { size: [, 1] } })), []);
});

test("#1085 (codex): built-ins with no enumerable keys are not all equal", () => {
  // Object.keys() sees nothing on these, so any two instances compared equal whatever they
  // held. Restricted to plain objects now, so they fall back to identity.
  for (const [x, y] of [
    [new Date(1), new Date(2)],
    [new Map([["a", 1]]), new Map([["a", 2]])],
    [new Set([1]), new Set([2])],
    [new ArrayBuffer(8), new ArrayBuffer(16)],
    [new DataView(new ArrayBuffer(8)), new DataView(new ArrayBuffer(16))],
  ]) {
    const node = nodeWith("cfg", x);
    assert.equal(
      applyCurrentDefWidgetValues(node, defWith("cfg", { default: y })).length,
      1,
      `${x.constructor.name} instances with different contents must not compare equal`,
    );
  }
});

test("#1085 (codex): an Array SUBCLASS is not a plain array", () => {
  class Weird extends Array {}
  const sub = Weird.from([1, 2]);
  const node = nodeWith("cfg", { size: sub });
  assert.equal(applyCurrentDefWidgetValues(node, defWith("cfg", { default: { size: [1, 2] } })).length, 1);
});

test("#1085 (codex r2): a difference behind a symbol or non-enumerable own key is REPORTED", () => {
  // Titled by OUTCOME, not mechanism (codex): this proves the difference is reported, which
  // is the caller-visible contract. The implementation gets there by refusing to compare
  // such objects at all, but a comparator that safely compared symbol keys would satisfy
  // this too, and that would also be correct.
  //
  // My first version asserted [] here and called it "symbol keys are outside the compared
  // surface". That was the false negative itself, wearing a reassuring title:
  // Object.keys misses symbol and non-enumerable own keys, so a real difference hid there.
  // The compare now REFUSES any object carrying one, which falls back to identity — the
  // pre-fix answer — so the difference is reported rather than swallowed.
  const sym = Symbol("k");
  const node = nodeWith("cfg", { x: 1, [sym]: 1 });
  assert.equal(
    applyCurrentDefWidgetValues(node, defWith("cfg", { default: { x: 1, [sym]: 2 } })).length,
    1,
    "a differing symbol value must not be invisible",
  );

  // Same for a non-enumerable own property.
  const hidden = { x: 1 };
  Object.defineProperty(hidden, "secret", { value: 1, enumerable: false });
  const other = { x: 1 };
  Object.defineProperty(other, "secret", { value: 2, enumerable: false });
  assert.equal(applyCurrentDefWidgetValues(nodeWith("cfg", hidden), defWith("cfg", { default: other })).length, 1);

  // And an ARRAY with a non-index own property, which the index walk would never see.
  const arr = [1];
  arr.extra = 1;
  const arr2 = [1];
  arr2.extra = 2;
  assert.equal(
    applyCurrentDefWidgetValues(nodeWith("cfg", { size: arr }), defWith("cfg", { default: { size: arr2 } })).length,
    1,
    "arr.extra differences must not hide behind the index walk",
  );

  // The ordinary JSON shape — the only one /object_info can produce — still compares equal.
  assert.deepEqual(
    applyCurrentDefWidgetValues(nodeWith("cfg", { x: 1, y: [2] }), defWith("cfg", { default: { x: 1, y: [2] } })),
    [],
  );
});

test("#1085 (codex): NaN and signed zero are answered deliberately", () => {
  // NaN default: `!==` reported a correction on EVERY add. Now silent.
  const nan = nodeWith("steps", NaN);
  assert.deepEqual(applyCurrentDefWidgetValues(nan, defWith("steps", { default: NaN }, "FLOAT")), []);
  // -0 vs +0: Object.is alone would invent a correction `!==` never reported.
  const zero = nodeWith("steps", -0);
  assert.deepEqual(applyCurrentDefWidgetValues(zero, defWith("steps", { default: 0 }, "FLOAT")), []);
  // Ordinary numbers are untouched.
  const n = nodeWith("steps", 1);
  assert.equal(applyCurrentDefWidgetValues(n, defWith("steps", { default: 2 }, "FLOAT")).length, 1);
});

test("#1085 (codex): an equal object is NOT aliased to the definition's default", () => {
  // Skipping the assignment means the widget keeps its OWN object. That is deliberate: the
  // old behaviour aliased a live widget value to the shared /object_info default, where a
  // later widget edit would have mutated the definition too.
  const widgetValue = { x: 0, y: 0 };
  const defDefault = { x: 0, y: 0 };
  const node = nodeWith("cfg", widgetValue);
  applyCurrentDefWidgetValues(node, defWith("cfg", { default: defDefault }));
  assert.equal(node.widgets[0].value, widgetValue, "still the widget's own object");
  assert.notEqual(node.widgets[0].value, defDefault, "and not the definition's");
});

// ---- codex round 4: a live value can be hostile ----------------------------

test("#1085 (codex r4): a revoked or throwing PROXY answers 'different', never throws", () => {
  // The path this replaced was a bare `!==`, which touches nothing. Every structural read
  // here — Array.isArray, getPrototypeOf, Reflect.ownKeys, getOwnPropertyDescriptor, a
  // property read — is a proxy trap point, so without a guard adding a node could FAIL
  // where it used to succeed.
  const { proxy, revoke } = Proxy.revocable({ x: 1 }, {});
  revoke();
  let corrections;
  assert.doesNotThrow(() => {
    corrections = applyCurrentDefWidgetValues(nodeWith("cfg", proxy), defWith("cfg", { default: { x: 1 } }));
  });
  assert.equal(corrections.length, 1, "answers 'different' — the pre-fix behaviour");

  const hostile = new Proxy(
    { x: 1 },
    {
      ownKeys() {
        throw new Error("trap");
      },
    },
  );
  let hostileCorrections;
  assert.doesNotThrow(() => {
    hostileCorrections = applyCurrentDefWidgetValues(nodeWith("cfg", hostile), defWith("cfg", { default: { x: 1 } }));
  });
  assert.equal(hostileCorrections.length, 1, "a throwing trap also ANSWERS 'different', not just survives");
});

test("#1085 (codex r4): a DEEP but finite equal default is not falsely corrected", () => {
  // Two successive depth caps (8, then 100) each reported a spurious correction for any
  // structurally-equal default nested past them — the very thing this fix removes — and then
  // reassigned, re-aliasing the widget to the definition's object. There is no cap now;
  // cycles are detected directly, so depth is unbounded for a finite structure.
  const deep = (n) => (n === 0 ? { leaf: 1 } : { nest: deep(n - 1) });
  const node = nodeWith("cfg", deep(30));
  assert.deepEqual(
    applyCurrentDefWidgetValues(node, defWith("cfg", { default: deep(30) })),
    [],
    "30 levels of identical structure is not a change",
  );
  // Far past BOTH retired caps (8, then 100), which is the point: no CONSTANT is the right
  // depth at which to call two equal structures different. The remaining bound is the call
  // stack, which a JSON widget default cannot approach.
  assert.deepEqual(
    applyCurrentDefWidgetValues(nodeWith("cfg", deep(400)), defWith("cfg", { default: deep(400) })),
    [],
  );
  // A difference at the bottom of that same depth is still found.
  const changed = nodeWith("cfg", deep(30));
  const other = deep(30);
  let cur = other;
  while (cur.nest) cur = cur.nest;
  cur.leaf = 2;
  assert.equal(applyCurrentDefWidgetValues(changed, defWith("cfg", { default: other })).length, 1);
});

test("#1085 (codex r5): ACCEPTED LIMIT — bisimilar cycles of different topology compare equal", () => {
  // A self-cycle and a two-object mutual cycle are bisimilar: same shape at every step,
  // different objects. This comparator calls them equal. Asserted rather than left silent,
  // so the limit is visible to whoever reads this next.
  //
  // Unreachable in this function's actual job: the other side is always `config.default`,
  // which comes from /object_info and is therefore JSON — and JSON cannot express a cycle.
  const selfCycle = { x: 0 };
  selfCycle.self = selfCycle;
  const b = { x: 0 };
  const c = { x: 0 };
  b.self = c;
  c.self = b;
  assert.deepEqual(
    applyCurrentDefWidgetValues(nodeWith("cfg", selfCycle), defWith("cfg", { default: b })),
    [],
    "documented limit: shape is compared, aliasing topology is not",
  );
});
