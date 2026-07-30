/**
 * Unit tests for web/js/lib/widget-write.js — run with `node --test`.
 *
 * Covers the graph_set_widget integrity fixes:
 *   #233 — a PROMOTED subgraph widget resolves to the correct INNER widget and
 *          the write leaves neighbouring inner widgets untouched; a numeric
 *          slot rejects a non-numeric value instead of silently corrupting it.
 *   #240 — a COMBO widget is set by EXACT value; an invalid value is rejected
 *          (not silently coerced to a different enum / an index).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  coerceWidgetValue,
  comboOptions,
  isComboWidget,
  isNumericWidget,
  resolvePromotedInnerTarget,
  WidgetWriteError,
} from "../../web/js/lib/widget-write.js";

// ---- combo classification + exact-value writes (#240) ---------------------

test("combo widget is classified by its option list", () => {
  const combo = { name: "sampler_name", options: { values: ["euler", "dpmpp_2m"] } };
  assert.equal(isComboWidget(combo), true);
  assert.deepEqual(comboOptions(combo), ["euler", "dpmpp_2m"]);
});

test("combo: a valid value writes that EXACT value", () => {
  const w = {
    name: "lllite_name",
    options: {
      values: [
        "ANIMA\\anima-lllite-pose-1.safetensors",
        "ANIMA\\anima-lllite-any-test-like-v2.safetensors",
      ],
    },
  };
  const out = coerceWidgetValue(w, "ANIMA\\anima-lllite-pose-1.safetensors");
  assert.equal(out, "ANIMA\\anima-lllite-pose-1.safetensors");
});

test("combo: an invalid value is REJECTED, not coerced to another enum", () => {
  const w = {
    name: "lllite_name",
    options: { values: ["pose-1.safetensors", "any-test-like-v2.safetensors"] },
  };
  assert.throws(
    () => coerceWidgetValue(w, "not-a-real-file.safetensors"),
    (err) => err instanceof WidgetWriteError && /not a valid option/.test(err.message),
  );
});

test("combo: a numeric index is NOT reinterpreted as a dropdown position", () => {
  // options[1] would be the WRONG value if an index were honoured (#240 drift).
  const w = { name: "combo", options: { values: ["alpha", "beta", "gamma"] } };
  assert.throws(
    () => coerceWidgetValue(w, 1),
    (err) => err instanceof WidgetWriteError,
  );
});

test("combo: dynamic (function) option list resolves and validates", () => {
  const w = { name: "ckpt", type: "combo", options: { values: () => ["a.ckpt", "b.ckpt"] } };
  assert.equal(coerceWidgetValue(w, "b.ckpt"), "b.ckpt");
  assert.throws(() => coerceWidgetValue(w, "c.ckpt"), WidgetWriteError);
});

// ---- numeric validation (the #233 corruption signature) -------------------

test("numeric widget accepts a number and a numeric string", () => {
  const w = { name: "steps", type: "INT" };
  assert.equal(isNumericWidget(w), true);
  assert.equal(coerceWidgetValue(w, 20), 20);
  assert.equal(coerceWidgetValue({ name: "cfg", type: "number" }, "7.5"), 7.5);
});

test("numeric widget REJECTS a non-numeric string (no 'euler' into an INT)", () => {
  const w = { name: "steps", type: "INT" };
  assert.throws(
    () => coerceWidgetValue(w, "euler"),
    (err) => err instanceof WidgetWriteError && /not a number/.test(err.message),
  );
});

test("boolean widget coerces true/false strings and rejects garbage", () => {
  const w = { name: "enabled", type: "toggle" };
  assert.equal(coerceWidgetValue(w, "true"), true);
  assert.equal(coerceWidgetValue(w, false), false);
  assert.throws(() => coerceWidgetValue(w, "maybe"), WidgetWriteError);
});

test("string/text widget passes through unchanged", () => {
  const w = { name: "text", type: "text" };
  assert.equal(coerceWidgetValue(w, "hello world"), "hello world");
});

// ---- promoted-subgraph-widget target resolution (#233) --------------------

/**
 * Build a mock parent SubgraphNode whose inner KSampler has its `seed`,
 * `sampler_name`, `scheduler`, `denoise` widgets promoted. `sampler_name` is
 * promoted; the parent's own widget array is deliberately SHIFTED (the upstream
 * bug) so writing on the parent by position would hit the wrong slot.
 */
function makeSubgraphFixture() {
  const inner = {
    id: 54,
    type: "KSampler",
    widgets: [
      { name: "seed", type: "INT", value: 959948902156062 },
      { name: "steps", type: "INT", value: 1 },
      { name: "cfg", type: "number", value: 1 },
      { name: "sampler_name", type: "combo", options: { values: ["euler", "dpmpp_2m"] }, value: "euler" },
      { name: "scheduler", type: "combo", options: { values: ["simple", "karras"] }, value: "simple" },
      { name: "denoise", type: "number", value: 1 },
    ],
  };
  const subgraph = {
    _nodes: [inner],
    getNodeById: (id) => (String(id) === "54" ? inner : null),
  };
  const parent = {
    id: 66,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "sampler_name", _subgraphSlot: { name: "sampler_name" } }],
    // Parent's own promoted-view widgets are SHIFTED (reproduces the corruption
    // vector): the widget named sampler_name here sits over the wrong value.
    widgets: [{ name: "sampler_name", type: "combo", options: { values: ["euler"] }, value: 1 }],
  };
  // Stub of the live-graph link walk: sampler_name promotes inner node 54's
  // sampler_name widget.
  const resolveSource = (_node, subgraphInput) =>
    subgraphInput?.name === "sampler_name"
      ? { sourceNodeId: "54", sourceWidgetName: "sampler_name" }
      : null;
  return { parent, inner, resolveSource };
}

test("promoted widget resolves to the correct INNER node + widget", () => {
  const { parent, inner, resolveSource } = makeSubgraphFixture();
  const target = resolvePromotedInnerTarget(parent, "sampler_name", resolveSource);
  assert.ok(target, "should resolve a promoted target");
  assert.equal(target.node, inner);
  assert.equal(target.widget.name, "sampler_name");
});

test("writing the resolved promoted widget leaves inner NEIGHBOURS untouched", () => {
  const { parent, inner, resolveSource } = makeSubgraphFixture();
  const before = inner.widgets.map((w) => w.value);

  const target = resolvePromotedInnerTarget(parent, "sampler_name", resolveSource);
  const coerced = coerceWidgetValue(target.widget, "dpmpp_2m");
  target.widget.value = coerced;

  assert.equal(inner.widgets.find((w) => w.name === "sampler_name").value, "dpmpp_2m");
  // Every OTHER inner widget is unchanged — no positional shift corruption.
  inner.widgets.forEach((w, i) => {
    if (w.name !== "sampler_name") assert.equal(w.value, before[i], `${w.name} must be untouched`);
  });
});

test("promoted resolution returns null for a plain (non-subgraph) node", () => {
  const node = { id: 1, type: "KSampler", widgets: [{ name: "steps" }] };
  assert.equal(resolvePromotedInnerTarget(node, "steps", () => null), null);
});
