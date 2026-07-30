/**
 * Unit tests for web/js/lib/widget-write.js — run with `node --test`.
 *
 * These drive applyWidgetWrite(), the SAME function graph_set_widget delegates
 * to (resolve target → validate/coerce → write + callback → verify stuck), so
 * the handler's real code path is exercised — not a parallel reimplementation.
 *
 * Covers the graph_set_widget integrity fixes:
 *   #233 — a PROMOTED subgraph widget resolves to the correct INNER widget (even
 *          when the promotion was RENAMED), leaves inner neighbours untouched,
 *          rejects a non-numeric value into a numeric slot, and NEVER falls back
 *          to the shifted parent slot when the promotion can't be resolved.
 *   #240 — a COMBO widget is set by EXACT value; invalid / index / unreadable-
 *          option-list cases are rejected, never silently coerced.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  applyWidgetWrite,
  coerceWidgetValue,
  comboOptions,
  isComboWidget,
  isNumericWidget,
  resolvePromotedInnerTarget,
  WidgetWriteError,
} from "../../web/js/lib/widget-write.js";

// No-op graph hooks so applyWidgetWrite exercises the full write path.
const HOOKS = {};

// ---- combo classification + exact-value writes (#240) ---------------------

test("combo widget is classified by its option list", () => {
  const combo = { name: "sampler_name", options: { values: ["euler", "dpmpp_2m"] } };
  assert.equal(isComboWidget(combo), true);
  assert.deepEqual(comboOptions(combo), ["euler", "dpmpp_2m"]);
});

test("combo: a valid value writes that EXACT value (via handler path)", () => {
  const node = {
    id: 5,
    type: "AnimaLLLiteApply",
    widgets: [
      {
        name: "lllite_name",
        options: {
          values: [
            "ANIMA\\anima-lllite-pose-1.safetensors",
            "ANIMA\\anima-lllite-any-test-like-v2.safetensors",
          ],
        },
        value: "ANIMA\\anima-lllite-any-test-like-v2.safetensors",
      },
    ],
  };
  const set = applyWidgetWrite(node, "lllite_name", "ANIMA\\anima-lllite-pose-1.safetensors", HOOKS);
  assert.equal(set.value, "ANIMA\\anima-lllite-pose-1.safetensors");
  assert.equal(node.widgets[0].value, "ANIMA\\anima-lllite-pose-1.safetensors");
});

test("combo: an invalid value is REJECTED, not coerced to another enum", () => {
  const node = {
    id: 5,
    type: "AnimaLLLiteApply",
    widgets: [
      { name: "lllite_name", options: { values: ["pose-1.safetensors", "any-test-like-v2.safetensors"] }, value: "pose-1.safetensors" },
    ],
  };
  assert.throws(
    () => applyWidgetWrite(node, "lllite_name", "not-a-real-file.safetensors", HOOKS),
    (err) => err instanceof WidgetWriteError && /not a valid option/.test(err.message),
  );
  assert.equal(node.widgets[0].value, "pose-1.safetensors", "must not have mutated on reject");
});

test("combo: a numeric index is NOT reinterpreted as a dropdown position", () => {
  const node = { id: 1, type: "N", widgets: [{ name: "c", options: { values: ["alpha", "beta", "gamma"] }, value: "alpha" }] };
  assert.throws(() => applyWidgetWrite(node, "c", 1, HOOKS), WidgetWriteError);
  assert.equal(node.widgets[0].value, "alpha");
});

test("combo: numeric-STRING options reject the number 1 (strict, no coercion) but accept \"1\"", () => {
  const mk = () => ({ id: 1, type: "N", widgets: [{ name: "c", options: { values: ["0", "1", "2"] }, value: "0" }] });
  const nNum = mk();
  assert.throws(() => applyWidgetWrite(nNum, "c", 1, HOOKS), WidgetWriteError);
  const nStr = mk();
  assert.equal(applyWidgetWrite(nStr, "c", "1", HOOKS).value, "1");
});

test("combo: numeric options [0,1,2] still accept the number 1", () => {
  const node = { id: 1, type: "N", widgets: [{ name: "c", options: { values: [0, 1, 2] }, value: 0 }] };
  assert.equal(applyWidgetWrite(node, "c", 1, HOOKS).value, 1);
});

test("combo: dynamic (function) option list resolves and validates", () => {
  const mk = () => ({ id: 1, type: "N", widgets: [{ name: "ckpt", type: "combo", options: { values: () => ["a.ckpt", "b.ckpt"] }, value: "a.ckpt" }] });
  assert.equal(applyWidgetWrite(mk(), "ckpt", "b.ckpt", HOOKS).value, "b.ckpt");
  assert.throws(() => applyWidgetWrite(mk(), "ckpt", "c.ckpt", HOOKS), WidgetWriteError);
});

test("combo: declared combo with UNREADABLE options is refused (fail-closed, HIGH #3)", () => {
  // Missing options.values entirely.
  const missing = { id: 1, type: "N", widgets: [{ name: "c", type: "combo", value: "x" }] };
  assert.throws(
    () => applyWidgetWrite(missing, "c", 1, HOOKS),
    (err) => err instanceof WidgetWriteError && /no readable option list/.test(err.message),
  );
  // Dynamic options fn that throws.
  const throwing = {
    id: 1,
    type: "N",
    widgets: [{ name: "c", type: "combo", options: { values: () => { throw new Error("boom"); } }, value: "x" }],
  };
  assert.throws(() => applyWidgetWrite(throwing, "c", 1, HOOKS), WidgetWriteError);
});

// ---- numeric / boolean / string validation --------------------------------

test("numeric widget accepts a number and a numeric string", () => {
  assert.equal(isNumericWidget({ name: "steps", type: "INT" }), true);
  assert.equal(applyWidgetWrite({ id: 1, type: "N", widgets: [{ name: "steps", type: "INT", value: 0 }] }, "steps", 20, HOOKS).value, 20);
  assert.equal(applyWidgetWrite({ id: 1, type: "N", widgets: [{ name: "cfg", type: "number", value: 0 }] }, "cfg", "7.5", HOOKS).value, 7.5);
});

test("numeric widget REJECTS a non-numeric string (no 'euler' into an INT)", () => {
  const node = { id: 1, type: "N", widgets: [{ name: "steps", type: "INT", value: 1 }] };
  assert.throws(
    () => applyWidgetWrite(node, "steps", "euler", HOOKS),
    (err) => err instanceof WidgetWriteError && /not a number/.test(err.message),
  );
  assert.equal(node.widgets[0].value, 1);
});

test("numeric widget REJECTS non-numeric JSON types (array/object/bool/blank), accepts 5 and \"5\"", () => {
  const mk = () => ({ id: 1, type: "N", widgets: [{ name: "steps", type: "INT", value: 1 }] });
  for (const bad of [[], [5], "  ", true, false, {}, null, "", Infinity, NaN]) {
    const n = mk();
    assert.throws(
      () => applyWidgetWrite(n, "steps", bad, HOOKS),
      WidgetWriteError,
      `value ${JSON.stringify(bad)} must be rejected`,
    );
    assert.equal(n.widgets[0].value, 1, `slot untouched after rejecting ${JSON.stringify(bad)}`);
  }
  assert.equal(applyWidgetWrite(mk(), "steps", 5, HOOKS).value, 5);
  assert.equal(applyWidgetWrite(mk(), "steps", "5", HOOKS).value, 5);
});

test("boolean widget coerces true/false strings and rejects garbage", () => {
  assert.equal(applyWidgetWrite({ id: 1, type: "N", widgets: [{ name: "e", type: "toggle", value: false }] }, "e", "true", HOOKS).value, true);
  assert.throws(() => applyWidgetWrite({ id: 1, type: "N", widgets: [{ name: "e", type: "toggle", value: false }] }, "e", "maybe", HOOKS), WidgetWriteError);
});

test("string/text widget passes through unchanged", () => {
  assert.equal(applyWidgetWrite({ id: 1, type: "N", widgets: [{ name: "t", type: "text", value: "" }] }, "t", "hello world", HOOKS).value, "hello world");
});

test("missing widget on a plain node throws", () => {
  assert.throws(
    () => applyWidgetWrite({ id: 1, type: "N", widgets: [{ name: "steps" }] }, "nope", 1, HOOKS),
    (err) => err instanceof WidgetWriteError && /has no widget/.test(err.message),
  );
});

test("stuck-check fails when a widget callback drifts the value (#240)", () => {
  // callback rewrites value to a different enum → applyWidgetWrite must throw.
  const node = {
    id: 1,
    type: "N",
    widgets: [
      {
        name: "c",
        options: { values: ["a", "b"] },
        value: "a",
        callback() {
          this.value = "b"; // silent drift
        },
      },
    ],
  };
  assert.throws(
    () => applyWidgetWrite(node, "c", "a", HOOKS),
    (err) => err instanceof WidgetWriteError && /did not retain the requested value/.test(err.message),
  );
});

// ---- promoted-subgraph-widget resolution + writes (#233) -------------------

/**
 * Parent SubgraphNode over an inner KSampler. The promotion has been RENAMED:
 * the OUTER promoted widget the caller sees is "sched_alias" but it maps to the
 * inner "scheduler" widget. The parent ALSO has a decoy own-widget literally
 * named "scheduler" (the shifted-slot corruption vector) — a correct write must
 * never touch it. `resolveSource` mimics the live subgraph link walk.
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
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "54" ? inner : null) };
  const parent = {
    id: 66,
    type: "SubgraphNode",
    subgraph,
    inputs: [
      // OUTER alias "sched_alias" (renamed) → inner "scheduler".
      { name: "sched_alias", _subgraphSlot: { name: "sched_alias" } },
    ],
    // Decoy shifted parent slot named "scheduler" — must stay untouched.
    widgets: [{ name: "scheduler", type: "combo", options: { values: ["simple"] }, value: 999 }],
  };
  const resolveSource = (_node, subgraphInput) =>
    subgraphInput?.name === "sched_alias"
      ? { sourceNodeId: "54", sourceWidgetName: "scheduler" }
      : null;
  return { parent, inner, resolveSource };
}

test("promoted (renamed) widget resolves to the correct INNER node + widget", () => {
  const { parent, inner, resolveSource } = makeSubgraphFixture();
  const res = resolvePromotedInnerTarget(parent, "sched_alias", resolveSource);
  assert.equal(res.promoted, true);
  assert.equal(res.target.node, inner);
  assert.equal(res.target.widget.name, "scheduler");
});

test("writing a RENAMED promoted widget hits the inner target, not the decoy parent slot (#233 blocker 1)", () => {
  const { parent, inner, resolveSource } = makeSubgraphFixture();
  const before = inner.widgets.map((w) => w.value);

  const set = applyWidgetWrite(parent, "sched_alias", "karras", { resolveSource });

  // Wrote the INNER scheduler, reported as an inner-node write.
  assert.equal(set.value, "karras");
  assert.equal(set.promoted_from.subgraph_node_id, 66);
  assert.equal(set.promoted_from.inner_node_id, 54);
  assert.equal(inner.widgets.find((w) => w.name === "scheduler").value, "karras");
  // The decoy parent widget literally named "scheduler" is untouched.
  assert.equal(parent.widgets[0].value, 999);
  // Every OTHER inner widget is unchanged — no positional-shift corruption.
  inner.widgets.forEach((w, i) => {
    if (w.name !== "scheduler") assert.equal(w.value, before[i], `${w.name} must be untouched`);
  });
});

test("promoted numeric slot REJECTS a non-numeric value (silent-corruption signature)", () => {
  const { parent, inner, resolveSource } = makeSubgraphFixture();
  // Re-point the promotion at inner numeric "steps".
  parent.inputs = [{ name: "steps", _subgraphSlot: { name: "steps" } }];
  const rs = (_n, si) => (si?.name === "steps" ? { sourceNodeId: "54", sourceWidgetName: "steps" } : null);
  assert.throws(() => applyWidgetWrite(parent, "steps", "euler", { resolveSource: rs }), WidgetWriteError);
  assert.equal(inner.widgets.find((w) => w.name === "steps").value, 1);
});

// ---- fail-CLOSED: promoted but unresolvable must NEVER write the parent slot (#233 blocker 2)

test("promoted widget with empty linkIds → THROW, parent slot untouched", () => {
  const { parent } = makeSubgraphFixture();
  // Match the alias but resolver returns null (stale/empty linkIds).
  parent.inputs = [{ name: "scheduler", _subgraphSlot: { name: "scheduler" } }];
  const before = parent.widgets[0].value;
  assert.throws(
    () => applyWidgetWrite(parent, "scheduler", "simple", { resolveSource: () => null }),
    (err) => err instanceof WidgetWriteError && /no resolvable inner link/.test(err.message),
  );
  assert.equal(parent.widgets[0].value, before, "parent slot must not be written on fail-closed");
});

test("promoted widget whose host input LACKS _subgraphSlot → THROW, parent untouched (round-2 HIGH #1)", () => {
  const { parent } = makeSubgraphFixture();
  // Host input matches the requested name but has NO _subgraphSlot — the
  // missing-metadata case that previously fell open to the parent widget.
  parent.inputs = [{ name: "scheduler" /* no _subgraphSlot */ }];
  const before = parent.widgets[0].value;
  assert.throws(
    () => applyWidgetWrite(parent, "scheduler", "simple", { resolveSource: () => null }),
    (err) => err instanceof WidgetWriteError && /no backing subgraph slot/.test(err.message),
  );
  assert.equal(parent.widgets[0].value, before, "parent widget must not be written");
});

test("promoted widget linking to a missing inner node → THROW (no parent fallback)", () => {
  const { parent } = makeSubgraphFixture();
  parent.inputs = [{ name: "scheduler", _subgraphSlot: { name: "scheduler" } }];
  const rs = () => ({ sourceNodeId: "999", sourceWidgetName: "scheduler" });
  assert.throws(
    () => applyWidgetWrite(parent, "scheduler", "simple", { resolveSource: rs }),
    (err) => err instanceof WidgetWriteError && /missing inner node/.test(err.message),
  );
});

test("promoted widget linking to a missing inner widget → THROW", () => {
  const { parent } = makeSubgraphFixture();
  parent.inputs = [{ name: "scheduler", _subgraphSlot: { name: "scheduler" } }];
  const rs = () => ({ sourceNodeId: "54", sourceWidgetName: "ghost_widget" });
  assert.throws(
    () => applyWidgetWrite(parent, "scheduler", "simple", { resolveSource: rs }),
    (err) => err instanceof WidgetWriteError && /missing inner widget/.test(err.message),
  );
});

test("AMBIGUOUS promoted aliases → THROW, no first-match-wins (#233 blocker 2c)", () => {
  const { parent, resolveSource } = makeSubgraphFixture();
  parent.inputs = [
    { name: "scheduler", _subgraphSlot: { name: "scheduler" } },
    { name: "scheduler", _subgraphSlot: { name: "scheduler_2" } },
  ];
  assert.throws(
    () => applyWidgetWrite(parent, "scheduler", "simple", { resolveSource }),
    (err) => err instanceof WidgetWriteError && /ambiguous/.test(err.message),
  );
});

test("subgraph node's OWN non-promoted widget writes normally (case a)", () => {
  const { parent } = makeSubgraphFixture();
  // No input alias matches "scheduler" → not promoted → write parent's own widget.
  parent.inputs = [];
  parent.widgets = [{ name: "scheduler", options: { values: ["simple", "karras"] }, value: "simple" }];
  const set = applyWidgetWrite(parent, "scheduler", "karras", { resolveSource: () => null });
  assert.equal(set.value, "karras");
  assert.equal(set.promoted_from, undefined);
});
