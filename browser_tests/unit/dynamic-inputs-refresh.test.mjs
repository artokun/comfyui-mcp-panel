/**
 * Unit tests for #1282 — the dynamic-input-slot refresh after a widget write —
 * run with `node --test`.
 *
 * These drive runSetWidget(), the SAME async unit graph_set_widget delegates to,
 * so the production path is exercised (not a parallel reimplementation).
 *
 * The fixtures reproduce KJNodes' `setupDynamicInputs` (web/js/jsnodes.js)
 * faithfully, because its exact wrapper is the whole bug:
 *
 *     countW.callback = function (value, canvas) {
 *       const r = origCb ? origCb.apply(this, arguments) : undefined;
 *       if (!canvas) rebuild();   // bare = API reload; skip interactive scrub
 *       return r;
 *     };
 *     node.addWidget("button", "Update inputs", null, rebuild);
 *
 * The panel's write path invokes the widget callback WITH the canvas argument
 * (as an interactive edit does), so the pack deliberately skipped the rebuild —
 * the write succeeded, `image_3…` never came into existence, and follow-up reads
 * served the stale slot list.
 *
 * Invariants under test:
 *   1. A count-widget write on such a node now leaves the input slots matching
 *      the count, and the result discloses the refresh (dynamic_inputs_refreshed
 *      + the post-refresh slot names).
 *   2. Shrinking the count removes trailing slots (the pack's own rebuild
 *      behaviour, driven through its own control).
 *   3. The refresh is verified by EFFECT: a control that accepts the press and
 *      changes nothing is never reported as a refresh.
 *   4. A control that THROWS does not fail the verified write; the failure is
 *      disclosed (dynamic_inputs_refresh_failed), including the partial-rebuild
 *      case.
 *   5. Keying is on the CONTROL (a litegraph button named exactly
 *      "Update inputs"), never on a value widget that happens to share the name,
 *      and nodes without the control are untouched.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runSetWidget } from "../../web/js/lib/set-widget.js";
import {
  dynamicInputsRefreshControl,
  refreshDynamicInputsAfterWrite,
} from "../../web/js/lib/dynamic-inputs-refresh.js";

// Registry entries with no `nodeData`, so the placeholder cross-check in
// assertResolvedTargetRegistered is skipped while the type still resolves as
// registered — the same fixture style the stale-combo tests use.
const REGISTRY = { ImageBatchMulti: {}, KSampler: {} };

// The fresh /object_info oracle runSetWidget requires (#458): a live backend that
// defines the fixture types, so the fresh-backend type gate is a no-op here.
const FRESH = { ImageBatchMulti: {}, KSampler: {} };
const freshOracle = { getFreshObjectInfo: async () => FRESH };

// A truthy canvas, as production wires (app.canvas) — the argument KJNodes'
// wrapper takes as the tell to SKIP the rebuild.
const CANVAS = { isFakeCanvas: true };

/**
 * A faithful stand-in for a KJNodes ImageBatchMulti after `setupDynamicInputs`:
 * `count` image_N slots, a count widget whose callback rebuilds ONLY on a bare
 * (canvas-less) invocation, and the "Update inputs" button holding the rebuild.
 */
function makeKjMultiNode(count = 2) {
  const node = {
    id: 42,
    type: "ImageBatchMulti",
    inputs: [],
    widgets: [],
    addInput(name, type) {
      this.inputs.push({ name, type, link: null });
    },
    removeInput(i) {
      this.inputs.splice(i, 1);
    },
  };
  // Verbatim semantics of KJNodes' setupDynamicInputs rebuild.
  const rebuild = () => {
    if (!node.inputs) node.inputs = [];
    const countW = node.widgets?.find((w) => w.name === "inputcount");
    if (!countW) return;
    const target = countW.value;
    const current = node.inputs.filter((i) => i.name?.startsWith("image_")).length;
    if (target === current) return;
    if (target < current) {
      for (let i = 0; i < current - target; i++) node.removeInput(node.inputs.length - 1);
    } else {
      for (let i = current + 1; i <= target; i++) node.addInput(`image_${i}`, "IMAGE");
    }
  };
  // The wrapped count callback: canvas present ⇒ interactive scrub ⇒ skip.
  const countW = {
    name: "inputcount",
    type: "number",
    value: count,
    callback(value, canvas) {
      if (!canvas) rebuild();
    },
  };
  node.widgets.push(countW);
  node.widgets.push({ name: "Update inputs", type: "button", value: null, callback: rebuild });
  for (let i = 1; i <= count; i++) node.addInput(`image_${i}`, "IMAGE");
  return node;
}

const inputNames = (node) => node.inputs.map((i) => i.name);

test("#1282 repro: inputcount 2→5 refreshes the slots and discloses the new list", async () => {
  const node = makeKjMultiNode(2);
  const res = await runSetWidget(node, "inputcount", 5, {
    registry: REGISTRY,
    ...freshOracle,
    canvas: CANVAS,
  });

  assert.equal(res.set.value, 5, "the write itself still reports the value that landed");
  assert.equal(res.set.dynamic_inputs_refreshed, true);
  assert.deepEqual(res.set.dynamic_inputs, ["image_1", "image_2", "image_3", "image_4", "image_5"]);
  // The GRAPH, not just the report: the follow-up read this issue was about.
  assert.deepEqual(inputNames(node), ["image_1", "image_2", "image_3", "image_4", "image_5"]);
});

test("#1282 shrinking the count removes trailing slots through the node's own control", async () => {
  const node = makeKjMultiNode(4);
  const res = await runSetWidget(node, "inputcount", 2, {
    registry: REGISTRY,
    ...freshOracle,
    canvas: CANVAS,
  });

  assert.equal(res.set.dynamic_inputs_refreshed, true);
  assert.deepEqual(res.set.dynamic_inputs, ["image_1", "image_2"]);
  assert.deepEqual(inputNames(node), ["image_1", "image_2"]);
});

test("#1282 WITHOUT the fix the slots stayed stale — the canvas tell is what skipped the rebuild", async () => {
  // Guards the fixture itself: with canvas passed (what the write path does) the
  // KJNodes wrapper must NOT rebuild, or every test above is testing nothing.
  const node = makeKjMultiNode(2);
  node.widgets[0].callback(5, CANVAS);
  node.widgets[0].value = 5;
  assert.deepEqual(inputNames(node), ["image_1", "image_2"], "interactive-style invocation skips the rebuild");
  // …and a bare invocation (API reload) rebuilds — the pack's other entry point.
  node.widgets[0].callback(5, undefined);
  assert.deepEqual(inputNames(node), ["image_1", "image_2", "image_3", "image_4", "image_5"]);
});

test("no refresh control on the node ⇒ the result is untouched and nothing is pressed", async () => {
  const widget = { name: "steps", type: "number", value: 20 };
  const node = { id: 3, type: "KSampler", widgets: [widget], inputs: [] };
  const res = await runSetWidget(node, "steps", 30, {
    registry: REGISTRY,
    ...freshOracle,
    canvas: CANVAS,
  });
  assert.equal(res.set.value, 30);
  assert.equal("dynamic_inputs_refreshed" in res.set, false);
  assert.equal("dynamic_inputs" in res.set, false);
  assert.equal("dynamic_inputs_refresh_failed" in res.set, false);
});

test("a press that changes NOTHING is not reported as a refresh (effect, not the call)", async () => {
  // Slots already match the value being written — the pack's rebuild returns early.
  const node = makeKjMultiNode(2);
  let presses = 0;
  const button = node.widgets[1];
  const orig = button.callback;
  button.callback = (...args) => {
    presses += 1;
    return orig(...args);
  };
  const res = await runSetWidget(node, "inputcount", 2, {
    registry: REGISTRY,
    ...freshOracle,
    canvas: CANVAS,
  });
  assert.equal(presses, 1, "the control is still pressed — idempotence is the pack's early return");
  assert.equal("dynamic_inputs_refreshed" in res.set, false, "nothing changed ⇒ nothing claimed");
});

test("a value widget NAMED like the control is never pressed", async () => {
  // The pressable-widget.js "Add Noise" lesson: keying on a name is only safe
  // because the candidate must be a litegraph BUTTON. A combo carrying the same
  // name holds a value and must keep it.
  const decoy = { name: "Update inputs", type: "combo", options: { values: ["a", "b"] }, value: "a" };
  const countW = { name: "inputcount", type: "number", value: 2 };
  const node = {
    id: 9,
    type: "ImageBatchMulti",
    inputs: [{ name: "image_1" }, { name: "image_2" }],
    widgets: [countW, decoy],
  };
  const res = await runSetWidget(node, "inputcount", 5, {
    registry: REGISTRY,
    ...freshOracle,
    canvas: CANVAS,
  });
  assert.equal(res.set.value, 5);
  assert.equal(decoy.value, "a", "the same-named value widget was not invoked");
  assert.equal("dynamic_inputs_refreshed" in res.set, false);
  assert.deepEqual(inputNames(node), ["image_1", "image_2"], "no control ⇒ slots unchanged, as before the fix");
});

test("a control that THROWS does not fail the verified write; the failure is disclosed", async () => {
  const node = makeKjMultiNode(2);
  node.widgets[1].callback = () => {
    throw new Error("pack code exploded");
  };
  const res = await runSetWidget(node, "inputcount", 5, {
    registry: REGISTRY,
    ...freshOracle,
    canvas: CANVAS,
  });
  assert.equal(res.set.value, 5, "the write is still reported as the verified success it is");
  assert.equal(typeof res.set.dynamic_inputs_refresh_failed, "string");
  assert.match(res.set.dynamic_inputs_refresh_failed, /succeeded and was verified/);
  assert.match(res.set.dynamic_inputs_refresh_failed, /pack code exploded/);
  assert.match(res.set.dynamic_inputs_refresh_failed, /may still be stale/);
  assert.equal("dynamic_inputs_refreshed" in res.set, false);
  assert.deepEqual(inputNames(node), ["image_1", "image_2"], "the throw left the slots as they were");
});

test("a control that partially rebuilds and THEN throws discloses the partial state", async () => {
  const node = makeKjMultiNode(2);
  node.widgets[1].callback = () => {
    node.addInput("image_3", "IMAGE");
    throw new Error("died mid-rebuild");
  };
  const res = await runSetWidget(node, "inputcount", 5, {
    registry: REGISTRY,
    ...freshOracle,
    canvas: CANVAS,
  });
  assert.equal(res.set.value, 5);
  assert.match(res.set.dynamic_inputs_refresh_failed, /PARTIALLY rebuilt/);
  assert.deepEqual(res.set.dynamic_inputs, ["image_1", "image_2", "image_3"], "the observed post-throw list is disclosed");
});

test("the refresh is bracketed by the command's undo-history hooks", async () => {
  const node = makeKjMultiNode(2);
  let before = 0;
  let after = 0;
  const res = await runSetWidget(node, "inputcount", 5, {
    registry: REGISTRY,
    ...freshOracle,
    canvas: CANVAS,
    beforeChange: () => {
      before += 1;
    },
    afterChange: () => {
      after += 1;
    },
  });
  assert.equal(res.set.dynamic_inputs_refreshed, true);
  // One pair for the write itself, one pair for the refresh press.
  assert.equal(before, 2);
  assert.equal(after, 2);
  assert.ok(before > 0 && after > 0);
});

// ── the lib's own contract, driven directly ──────────────────────────────────

test("dynamicInputsRefreshControl finds only a callable button with the exact name", () => {
  const node = makeKjMultiNode(2);
  assert.equal(dynamicInputsRefreshControl(node), node.widgets[1]);
  assert.equal(dynamicInputsRefreshControl({ widgets: [{ name: "Update inputs", type: "combo", callback() {} }] }), null);
  assert.equal(dynamicInputsRefreshControl({ widgets: [{ name: "Update inputs", type: "button" }] }), null, "no callback ⇒ nothing to press");
  assert.equal(dynamicInputsRefreshControl({ widgets: [{ name: "update inputs", type: "button", callback() {} }] }), null, "the name match is exact");
  assert.equal(dynamicInputsRefreshControl({}), null);
  assert.equal(dynamicInputsRefreshControl(null), null);
});

test("refreshDynamicInputsAfterWrite returns null when there is no control, and never throws", () => {
  assert.equal(refreshDynamicInputsAfterWrite({ id: 1 }), null);
  assert.equal(refreshDynamicInputsAfterWrite(null), null);
  // A hostile node whose widgets getter throws must not escape either.
  const hostile = {};
  Object.defineProperty(hostile, "widgets", {
    get() {
      throw new Error("nope");
    },
  });
  const out = refreshDynamicInputsAfterWrite(hostile);
  assert.ok(out === null || typeof out.failed === "string", "hostile reads degrade to a disclosure, never a throw");
});
