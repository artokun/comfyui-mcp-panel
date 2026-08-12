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
});

test("#1085: a CYCLIC live value fails toward today's behaviour, never a crash", () => {
  // An /object_info default cannot be cyclic, but a live widget value could be. The depth
  // cap answers "different" there — which is exactly what `!==` said before this existed —
  // so the cost is a spurious correction, never a hang or a missed one.
  const cyclic = { x: 0 };
  cyclic.self = cyclic;
  const node = nodeWith("cfg", cyclic);
  let corrections;
  assert.doesNotThrow(() => {
    corrections = applyCurrentDefWidgetValues(node, defWith("cfg", { default: { x: 0, self: {} } }));
  });
  assert.equal(corrections.length, 1);
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
