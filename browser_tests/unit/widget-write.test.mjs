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
  isCompositeObjectWidget,
  isNumericWidget,
  resolvePromotedInnerTarget,
  WidgetWriteError,
} from "../../web/js/lib/widget-write.js";

// No-op graph hooks so applyWidgetWrite exercises the full write path.
const HOOKS = {};

// ---- #347: empty-string clear vs missing value -----------------------------

test("#347: a text/string widget can be CLEARED with an explicit empty string", () => {
  for (const type of ["customtext", "text", "string", undefined]) {
    const node = {
      id: 39,
      type: "Florence2Run",
      widgets: [{ name: "text_input", type, value: "some prompt" }],
    };
    const set = applyWidgetWrite(node, "text_input", "", HOOKS);
    assert.equal(set.value, "");
    assert.equal(node.widgets[0].value, "");
  }
});

test("#347: a MISSING value (undefined/null) is refused, not silently written", () => {
  const w = { name: "text_input", type: "customtext", value: "x" };
  assert.throws(() => coerceWidgetValue(w, undefined), /No value provided/);
  assert.throws(() => coerceWidgetValue(w, null), /No value provided/);
});

test("#347: clearing to '' does NOT weaken combo/numeric strictness (#240)", () => {
  const combo = { name: "sampler", options: { values: ["euler", "dpmpp_2m"] } };
  assert.throws(() => coerceWidgetValue(combo, ""), WidgetWriteError);
  const num = { name: "steps", type: "INT", value: 20 };
  assert.throws(() => coerceWidgetValue(num, ""), /not a number/);
});

// ---- #179: rgthree Power Lora Loader composite widget ----------------------

test("#179: a composite lora_N widget is detected by its object value", () => {
  const w = { name: "lora_10", value: { on: false, lora: null, strength: 1 } };
  assert.equal(isCompositeObjectWidget(w), true);
  assert.equal(isCompositeObjectWidget({ name: "text", value: "hello" }), false);
});

test("#179: setting a Power Lora row from a JSON STRING writes the composite object", () => {
  const node = {
    id: 77,
    type: "Power Lora Loader (rgthree)",
    widgets: [
      { name: "lora_10", value: { on: false, lora: null, strength: 1, strengthTwo: null } },
    ],
  };
  const set = applyWidgetWrite(
    node,
    "lora_10",
    '{"on":true,"lora":"some.safetensors","strength":0.6}',
    HOOKS,
  );
  // The lora filename and strength are preserved (not lora:null / strength:1).
  assert.equal(set.value.on, true);
  assert.equal(set.value.lora, "some.safetensors");
  assert.equal(set.value.strength, 0.6);
  // Unspecified field carried over from the prior value.
  assert.equal(set.value.strengthTwo, null);
  assert.equal(node.widgets[0].value.lora, "some.safetensors");
});

test("#179: an rgthree callback that CLONES the object still verifies as stuck", () => {
  const node = {
    id: 78,
    type: "Power Lora Loader (rgthree)",
    widgets: [
      {
        name: "lora_1",
        value: { on: false, lora: null, strength: 1 },
        // rgthree normalizes by replacing the object reference — must not
        // false-fail the write-stuck check.
        callback(v, _canvas, _node) {
          this.value = { ...v };
        },
      },
    ],
  };
  const set = applyWidgetWrite(node, "lora_1", '{"on":true,"lora":"x.safetensors","strength":0.8}', {});
  assert.equal(set.value.lora, "x.safetensors");
  assert.equal(node.widgets[0].value.strength, 0.8);
});

test("#179: a callback that DRIFTS a composite field is still caught (not false-pass)", () => {
  const node = {
    id: 80,
    type: "Power Lora Loader (rgthree)",
    widgets: [
      {
        name: "lora_3",
        value: { on: false, lora: null, strength: 1 },
        // Malicious/buggy callback that mutates the object in place to a WRONG
        // value — must be detected as drift (the expected snapshot is taken
        // before the callback), never reported as retained.
        callback(v) {
          v.lora = "WRONG.safetensors";
        },
      },
    ],
  };
  assert.throws(
    () => applyWidgetWrite(node, "lora_3", '{"on":true,"lora":"right.safetensors","strength":1}', {}),
    /did not.*retain/s,
  );
});

test("#179: a non-JSON string for a composite widget is refused, not written raw", () => {
  const node = {
    id: 79,
    type: "Power Lora Loader (rgthree)",
    widgets: [{ name: "lora_2", value: { on: false, lora: null, strength: 1 } }],
  };
  assert.throws(() => applyWidgetWrite(node, "lora_2", "not-json", {}), /not valid JSON/);
});

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
 * inner "scheduler" widget. The parent has an AUTHORITATIVE rail widget named
 * "sched_alias" (backed by the host input via the promotion relationship —
 * `input.widget` / `getWidgetFromSlot`) that is what serializes at queue time,
 * AND a decoy own-widget literally named "scheduler" (the inner source name, the
 * shifted-slot corruption vector) — a correct write must sync the rail widget and
 * never touch the decoy. `resolveSource` mimics the live subgraph link walk.
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
      // OUTER alias "sched_alias" (renamed) → inner "scheduler". `widget` is the
      // litegraph backlink to the parent's authoritative rail widget.
      { name: "sched_alias", widget: { name: "sched_alias" }, _subgraphSlot: { name: "sched_alias" } },
    ],
    widgets: [
      // Decoy own-widget named after the INNER source — must stay untouched (#233).
      { name: "scheduler", type: "combo", options: { values: ["simple"] }, value: 999 },
      // AUTHORITATIVE parent rail widget (backed by the host input) — gets synced.
      { name: "sched_alias", type: "combo", options: { values: ["simple", "karras"] }, value: "simple" },
    ],
    // litegraph slot→widget resolution used by the promotion-relationship lookup.
    getWidgetFromSlot(input) {
      const n = input?.widget?.name;
      return this.widgets.find((w) => w.name === n) ?? null;
    },
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

test("writing a RENAMED promoted widget hits the inner target + syncs the rail, not the decoy parent slot (#233 blocker 1)", () => {
  const { parent, inner, resolveSource } = makeSubgraphFixture();
  const before = inner.widgets.map((w) => w.value);

  const set = applyWidgetWrite(parent, "sched_alias", "karras", { resolveSource });

  // Wrote the INNER scheduler, reported as an inner-node write.
  assert.equal(set.value, "karras");
  assert.equal(set.promoted_from.subgraph_node_id, 66);
  assert.equal(set.promoted_from.inner_node_id, 54);
  assert.equal(inner.widgets.find((w) => w.name === "scheduler").value, "karras");
  // The AUTHORITATIVE rail widget "sched_alias" is synced (what serializes at queue).
  assert.equal(parent.widgets.find((w) => w.name === "sched_alias").value, "karras");
  assert.equal(set.promoted_from.parent_widget_synced, true);
  // The decoy parent widget literally named "scheduler" is untouched.
  assert.equal(parent.widgets[0].value, 999);
  // Every OTHER inner widget is unchanged — no positional-shift corruption.
  inner.widgets.forEach((w, i) => {
    if (w.name !== "scheduler") assert.equal(w.value, before[i], `${w.name} must be untouched`);
  });
});

test("promoted numeric slot REJECTS a non-numeric value (silent-corruption signature)", () => {
  const { parent, inner, resolveSource } = makeSubgraphFixture();
  // Re-point the promotion at inner numeric "steps", WITH a valid authoritative
  // rail widget (so the write reaches coercion, not the missing-rail fail-closed).
  parent.inputs = [{ name: "steps", widget: { name: "steps" }, _subgraphSlot: { name: "steps" } }];
  parent.widgets.push({ name: "steps", type: "INT", value: 1 });
  const rs = (_n, si) => (si?.name === "steps" ? { sourceNodeId: "54", sourceWidgetName: "steps" } : null);
  assert.throws(
    () => applyWidgetWrite(parent, "steps", "euler", { resolveSource: rs }),
    (err) => err instanceof WidgetWriteError && /is numeric/.test(err.message),
  );
  assert.equal(inner.widgets.find((w) => w.name === "steps").value, 1);
  assert.equal(parent.widgets.find((w) => w.name === "steps").value, 1, "rail not mutated on coercion reject");
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

// ---- #366: write the AUTHORITATIVE parent rail widget atomically with the inner
//            widget; fail CLOSED (never silent inner-only) when it can't be found -

/**
 * Real LTX-2.3 shape: a SubgraphNode whose OWN promoted widget "value_2" is
 * backed by an inner PrimitiveInt (id 257) whose widget is literally named
 * "value". The parent widget "value_2" is what serializes into the subgraph
 * INPUT RAIL at queue time. The host input carries the litegraph `widget`
 * backlink (and the node a `getWidgetFromSlot`) so the parent rail widget is
 * located by the PROMOTION RELATIONSHIP, not a name guess.
 */
function makePromotedMirrorFixture() {
  const inner = {
    id: 257,
    type: "PrimitiveInt",
    widgets: [{ name: "value", type: "INT", value: 1280 }],
  };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "257" ? inner : null) };
  const parent = {
    id: 267,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "value_2", widget: { name: "value_2" }, _subgraphSlot: { name: "value_2" } }],
    // The parent's OWN promoted rail widget — the authoritative value, stale.
    widgets: [{ name: "value_2", type: "INT", value: 1280 }],
    // Production litegraph resolves a slot's widget BY NAME.
    getWidgetFromSlot(input) {
      return this.widgets.find((w) => w.name === input?.widget?.name) ?? null;
    },
  };
  const resolveSource = (_node, subgraphInput) =>
    subgraphInput?.name === "value_2" ? { sourceNodeId: "257", sourceWidgetName: "value" } : null;
  return { parent, inner, resolveSource };
}

test("#366: a promoted write syncs the AUTHORITATIVE parent rail widget (no stale render)", () => {
  const { parent, inner, resolveSource } = makePromotedMirrorFixture();

  const set = applyWidgetWrite(parent, "value_2", 704, { resolveSource });

  // Inner write landed + is reported (unchanged behaviour).
  assert.equal(set.value, 704);
  assert.equal(set.node_id, 257);
  assert.equal(set.widget, "value");
  assert.equal(inner.widgets[0].value, 704);

  // THE FIX: the parent's OWN "value_2" rail widget — what serializes at queue
  // time — now holds the NEW value, not the stale 1280. Before the fix this
  // assertion fails (parent stays 1280 → silent stale render).
  assert.equal(parent.widgets[0].value, 704, "parent rail widget must reflect the new value");
  assert.equal(set.promoted_from.subgraph_node_id, 267);
  assert.equal(set.promoted_from.inner_node_id, 257);
  assert.equal(set.promoted_from.parent_widget_synced, true);
});

test("#366: the rail widget is resolved by the promotion's own NAME — a DIFFERENTLY-named decoy is never selected (#233)", () => {
  // Realistic promotion: the rail widget is named "value_2" (the host input's
  // backlink name). A decoy own-widget has a DIFFERENT name ("value_3"). Production
  // litegraph resolves the slot BY NAME, so it returns the rail, never the decoy.
  const inner = { id: 257, type: "PrimitiveInt", widgets: [{ name: "value", type: "INT", value: 1280 }] };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "257" ? inner : null) };
  const railWidget = { name: "value_2", type: "INT", value: 1280 };
  const decoy = { name: "value_3", type: "INT", value: 9999 };
  const parent = {
    id: 267,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "value_2", widget: { name: "value_2" }, _subgraphSlot: { name: "value_2" } }],
    widgets: [decoy, railWidget], // decoy first, but resolution keys on the NAME
    getWidgetFromSlot(input) {
      return this.widgets.find((w) => w.name === input?.widget?.name) ?? null;
    },
  };
  const resolveSource = (_n, si) =>
    si?.name === "value_2" ? { sourceNodeId: "257", sourceWidgetName: "value" } : null;

  const set = applyWidgetWrite(parent, "value_2", 704, { resolveSource });

  assert.equal(railWidget.value, 704, "authoritative rail widget synced");
  assert.equal(decoy.value, 9999, "differently-named decoy must never be written");
  assert.equal(set.promoted_from.parent_widget_synced, true);
});

test("#366 FAIL CLOSED runs BEFORE any side-effecting coercion — a dynamic-combo inner is never invoked when the rail is refused", () => {
  // The inner is a DYNAMIC combo whose options.values() has a side effect. With a
  // linked (non-authoritative) host input the write must fail closed BEFORE
  // coercion invokes that callback — otherwise a missing-rail refusal could still
  // leave an uncaptured inner mutation.
  let optionsInvoked = false;
  const innerWidget = {
    name: "sampler",
    type: "combo",
    value: "euler",
    options: {
      values: () => {
        optionsInvoked = true;
        return ["euler", "dpmpp_2m"];
      },
    },
  };
  const inner = { id: 54, type: "KSampler", widgets: [innerWidget] };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "54" ? inner : null) };
  const parent = {
    id: 66,
    type: "SubgraphNode",
    subgraph,
    // linked host input ⇒ non-authoritative rail ⇒ fail closed.
    inputs: [{ name: "sampler", link: 99, widget: { name: "sampler" }, _subgraphSlot: { name: "sampler" } }],
    widgets: [{ name: "sampler", type: "combo", value: "euler", options: { values: ["euler", "dpmpp_2m"] } }],
    getWidgetFromSlot(input) {
      return this.widgets.find((w) => w.name === input?.widget?.name) ?? null;
    },
  };
  const resolveSource = (_n, si) =>
    si?.name === "sampler" ? { sourceNodeId: "54", sourceWidgetName: "sampler" } : null;

  assert.throws(
    () => applyWidgetWrite(parent, "sampler", "dpmpp_2m", { resolveSource }),
    (err) => err instanceof WidgetWriteError && /parent rail widget could not be identified/.test(err.message),
  );
  assert.equal(optionsInvoked, false, "no dynamic-combo coercion side effect before the fail-closed refusal");
});

test("#366 FAIL CLOSED: an EXTERNALLY-LINKED host input (nested/further promotion) refuses — the local widget is not the authoritative rail", () => {
  // The host input carries an OUTER link (this promoted widget is further promoted
  // to an enclosing subgraph). getWidgetFromSlot still returns a valid member widget
  // (ComfyUI returns slot._widget even when linked), but queue compilation ignores
  // it and follows the outer rail — so writing it would be a FALSE success.
  const inner = { id: 257, type: "PrimitiveInt", widgets: [{ name: "value", type: "INT", value: 1280 }] };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "257" ? inner : null) };
  const localWidget = { name: "value_2", type: "INT", value: 1280 };
  const parent = {
    id: 267,
    type: "SubgraphNode",
    subgraph,
    // `link` is NON-NULL ⇒ fed by an enclosing subgraph's rail (non-authoritative).
    inputs: [{ name: "value_2", link: 4242, widget: { name: "value_2" }, _subgraphSlot: { name: "value_2" } }],
    widgets: [localWidget],
    getWidgetFromSlot(input) {
      return this.widgets.find((w) => w.name === input?.widget?.name) ?? null;
    },
  };
  const resolveSource = (_n, si) =>
    si?.name === "value_2" ? { sourceNodeId: "257", sourceWidgetName: "value" } : null;

  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource }),
    (err) => err instanceof WidgetWriteError && /parent rail widget could not be identified/.test(err.message),
  );
  assert.equal(localWidget.value, 1280, "non-authoritative local widget must not be written");
  assert.equal(inner.widgets[0].value, 1280, "inner must not be written on fail-closed");
});

test("#366 FAIL CLOSED: DUPLICATE widget names (rail ambiguous with a same-named sibling) refuses rather than guess", () => {
  // Pathological: TWO widgets share the resolved name, so litegraph's name-based
  // getWidgetFromSlot returns the FIRST — which may diverge from what the queue
  // serializer reads. We cannot prove which one queues, so FAIL CLOSED.
  const inner = { id: 257, type: "PrimitiveInt", widgets: [{ name: "value", type: "INT", value: 1280 }] };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "257" ? inner : null) };
  const first = { name: "value_2", type: "INT", value: 1111 };
  const second = { name: "value_2", type: "INT", value: 2222 };
  const parent = {
    id: 267,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "value_2", widget: { name: "value_2" }, _subgraphSlot: { name: "value_2" } }],
    widgets: [first, second], // duplicate names
    getWidgetFromSlot(input) {
      return this.widgets.find((w) => w.name === input?.widget?.name) ?? null; // returns `first`
    },
  };
  const resolveSource = (_n, si) =>
    si?.name === "value_2" ? { sourceNodeId: "257", sourceWidgetName: "value" } : null;

  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource }),
    (err) => err instanceof WidgetWriteError && /parent rail widget could not be identified/.test(err.message),
  );
  assert.equal(first.value, 1111, "ambiguous rail: neither sibling written");
  assert.equal(second.value, 2222, "ambiguous rail: neither sibling written");
  assert.equal(inner.widgets[0].value, 1280, "inner not written on fail-closed");
});

test("#366 FAIL CLOSED: a promoted write whose authoritative rail widget cannot be identified THROWS — never writes inner-only", () => {
  // No litegraph backlink and no getWidgetFromSlot → the rail widget cannot be
  // positively identified (the outward/double-promotion or malformed case). Even
  // though a same-named widget exists, matching it by name is forbidden; we FAIL
  // CLOSED so the render can never silently use the OLD value.
  const inner = { id: 257, type: "PrimitiveInt", widgets: [{ name: "value", type: "INT", value: 1280 }] };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "257" ? inner : null) };
  const parent = {
    id: 267,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "value_2", _subgraphSlot: { name: "value_2" } }], // no `widget` backlink
    widgets: [{ name: "value_2", type: "INT", value: 1280 }], // tempting same-named widget
    // no getWidgetFromSlot
  };
  const resolveSource = (_n, si) =>
    si?.name === "value_2" ? { sourceNodeId: "257", sourceWidgetName: "value" } : null;

  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource }),
    (err) => err instanceof WidgetWriteError && /parent rail widget could not be identified/.test(err.message),
  );
  // Neither the inner widget nor the tempting same-named parent widget was written.
  assert.equal(inner.widgets[0].value, 1280, "inner must not be written on fail-closed");
  assert.equal(parent.widgets[0].value, 1280, "same-named parent widget must not be written on fail-closed");
});

test("#366: a promotion addressed by its LABEL still syncs the rail widget (relationship, not name)", () => {
  // Renamed promotion: display label "sched_label"; the parent rail widget carries
  // the stable name "scheduler". The caller addresses by the LABEL. The rail widget
  // is found by the promotion backlink regardless of the label.
  const inner = {
    id: 54,
    type: "KSampler",
    widgets: [{ name: "scheduler", type: "combo", options: { values: ["simple", "karras"] }, value: "simple" }],
  };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "54" ? inner : null) };
  const railWidget = { name: "scheduler", type: "combo", options: { values: ["simple", "karras"] }, value: "simple" };
  const parent = {
    id: 66,
    type: "SubgraphNode",
    subgraph,
    inputs: [
      { name: "scheduler", label: "sched_label", widget: { name: "scheduler" }, _subgraphSlot: { name: "scheduler", label: "sched_label" } },
    ],
    widgets: [railWidget],
    getWidgetFromSlot(input) {
      return this.widgets.find((w) => w.name === input?.widget?.name) ?? null;
    },
  };
  const resolveSource = (_n, si) =>
    si?.name === "scheduler" ? { sourceNodeId: "54", sourceWidgetName: "scheduler" } : null;

  // Address by the LABEL, not the stable name.
  const set = applyWidgetWrite(parent, "sched_label", "karras", { resolveSource });

  assert.equal(inner.widgets[0].value, "karras");
  assert.equal(railWidget.value, "karras", "rail widget must be synced when addressed by label");
  assert.equal(set.promoted_from.parent_widget_synced, true);
});

test("#366: the rail write lands INSIDE the undo envelope (before afterChange fires)", () => {
  const { parent, inner, resolveSource } = makePromotedMirrorFixture();
  let parentValueAtAfterChange;
  applyWidgetWrite(parent, "value_2", 704, {
    resolveSource,
    beforeChange: () => {
      // Envelope opened but nothing written yet.
      assert.equal(parent.widgets[0].value, 1280);
    },
    afterChange: () => {
      // BOTH inner and parent must already be written when the envelope closes,
      // so the two mutations are one atomic undo.
      parentValueAtAfterChange = parent.widgets[0].value;
    },
  });
  assert.equal(inner.widgets[0].value, 704);
  assert.equal(parentValueAtAfterChange, 704, "parent must be written before afterChange (single undo op)");
});

test("#366 ATOMIC: an INNER callback that throws rolls BOTH back — no partial write, surfaced as failure", () => {
  const { parent, inner, resolveSource } = makePromotedMirrorFixture();
  // Inner widget callback throws AFTER the inner value is assigned.
  inner.widgets[0].callback = () => {
    throw new Error("inner boom");
  };
  let afterChangeRan = false;
  assert.throws(
    () =>
      applyWidgetWrite(parent, "value_2", 704, {
        resolveSource,
        afterChange: () => {
          afterChangeRan = true;
        },
      }),
    (err) => err instanceof WidgetWriteError && /callback threw|inner boom/.test(err.message),
  );
  // ROLLED BACK: neither inner nor parent rail left at the new value.
  assert.equal(inner.widgets[0].value, 1280, "inner rolled back");
  assert.equal(parent.widgets[0].value, 1280, "parent rolled back — never inner=new/parent=stale");
  assert.equal(afterChangeRan, true, "afterChange still closes the envelope");
});

test("#366 ATOMIC: a PARENT rail callback that throws rolls BOTH back — no inner=new/parent=stale", () => {
  const { parent, inner, resolveSource } = makePromotedMirrorFixture();
  // Parent rail widget callback throws AFTER its value is assigned.
  parent.widgets[0].callback = () => {
    throw new Error("parent boom");
  };
  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource }),
    (err) => err instanceof WidgetWriteError && /callback threw|parent boom/.test(err.message),
  );
  assert.equal(inner.widgets[0].value, 1280, "inner rolled back on parent-callback throw");
  assert.equal(parent.widgets[0].value, 1280, "parent rolled back on its own throw");
});

test("#366: a value setter that REJECTS the rollback surfaces an HONEST partial-state failure (never falsely claims 'rolled back')", () => {
  const inner = { id: 257, type: "PrimitiveInt", widgets: [] };
  // A widget whose `value` accepts the forward write but REJECTS the restore.
  const w = {
    name: "value",
    type: "INT",
    _v: 1280,
    _touched: false,
    get value() {
      return this._v;
    },
    set value(x) {
      if (x === 1280 && this._touched) throw new Error("setter refuses restore");
      this._v = x;
      this._touched = true;
    },
    callback() {
      throw new Error("inner boom");
    },
  };
  inner.widgets.push(w);
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "257" ? inner : null) };
  const railWidget = { name: "value_2", type: "INT", value: 1280 };
  const parent = {
    id: 267,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "value_2", widget: { name: "value_2" }, _subgraphSlot: { name: "value_2" } }],
    widgets: [railWidget],
    getWidgetFromSlot(input) {
      return this.widgets.find((x) => x.name === input?.widget?.name) ?? null;
    },
  };
  const resolveSource = (_n, si) =>
    si?.name === "value_2" ? { sourceNodeId: "257", sourceWidgetName: "value" } : null;

  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource }),
    (err) => err instanceof WidgetWriteError && /partial state/.test(err.message) && !/rolled back to avoid/.test(err.message),
  );
});

test("#366: a value setter that SILENTLY IGNORES the rollback (keeps the new value) is detected via read-back, not falsely claimed rolled back", () => {
  const inner = { id: 257, type: "PrimitiveInt", widgets: [] };
  // A widget whose setter accepts the forward write but silently REFUSES to go back.
  const w = {
    name: "value",
    type: "INT",
    _v: 1280,
    get value() {
      return this._v;
    },
    set value(x) {
      // Ignore any attempt to restore the old value (silent no-op rollback).
      if (x === 1280 && this._v === 704) return;
      this._v = x;
    },
    callback() {
      throw new Error("inner boom");
    },
  };
  inner.widgets.push(w);
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "257" ? inner : null) };
  const railWidget = { name: "value_2", type: "INT", value: 1280 };
  const parent = {
    id: 267,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "value_2", widget: { name: "value_2" }, _subgraphSlot: { name: "value_2" } }],
    widgets: [railWidget],
    getWidgetFromSlot(input) {
      return this.widgets.find((x) => x.name === input?.widget?.name) ?? null;
    },
  };
  const resolveSource = (_n, si) =>
    si?.name === "value_2" ? { sourceNodeId: "257", sourceWidgetName: "value" } : null;

  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource }),
    (err) =>
      err instanceof WidgetWriteError && /partial state/.test(err.message) && !/rolled back to avoid/.test(err.message),
  );
});

test("#366 ATOMIC: a THROWING afterChange hook does not bypass rollback", () => {
  const { parent, inner, resolveSource } = makePromotedMirrorFixture();
  inner.widgets[0].callback = () => {
    throw new Error("inner boom");
  };
  const afterChange = () => {
    throw new Error("afterChange boom");
  };
  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource, afterChange }),
    (err) => err instanceof WidgetWriteError && /callback threw|inner boom/.test(err.message),
  );
  assert.equal(inner.widgets[0].value, 1280, "inner rolled back despite a throwing afterChange hook");
  assert.equal(parent.widgets[0].value, 1280, "rail untouched / rolled back");
});

test("#366 HARD FAIL: an afterChange HOOK that re-stales the rail (after all callbacks) is still caught + rolled back", () => {
  const { parent, inner, resolveSource } = makePromotedMirrorFixture();
  // Verification must run AFTER afterChange: a hook that reverts the rail value must
  // not escape detection and report success.
  const afterChange = () => {
    // Re-stale the rail to its OLD value after the write completed.
    if (parent.widgets[0].value === 704) parent.widgets[0].value = 1280;
  };
  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource, afterChange }),
    (err) => err instanceof WidgetWriteError && /did not retain the requested value/.test(err.message),
  );
  // Rolled back: inner restored too (never inner=new/rail=stale reported as success).
  assert.equal(inner.widgets[0].value, 1280, "inner rolled back after afterChange re-stale");
  assert.equal(parent.widgets[0].value, 1280, "rail left at its stale value, not the half-applied new one");
});

test("#366 HARD FAIL: a callback that CHANGES the promotion topology (adds an outer link) fails + rolls back — never a false synced success", () => {
  const { parent, inner, resolveSource } = makePromotedMirrorFixture();
  // The rail callback keeps the requested VALUE but mutates the host input to be
  // externally linked — so at queue time litegraph would follow the outer link and
  // ignore this rail. The post-callback re-authentication must catch this.
  parent.widgets[0].callback = () => {
    parent.inputs[0].link = 7777; // now non-authoritative
  };
  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource }),
    (err) => err instanceof WidgetWriteError && /CHANGED during the write/.test(err.message),
  );
  assert.equal(inner.widgets[0].value, 1280, "inner rolled back on relationship drift");
  assert.equal(parent.widgets[0].value, 1280, "rail rolled back on relationship drift");
});

test("#366 HARD FAIL: a callback that REPLACES node.inputs[i] with a new detached host input fails + rolls back", () => {
  const { parent, inner, resolveSource } = makePromotedMirrorFixture();
  // The callback swaps the live host input for a NEW object (the captured one is now
  // detached). Re-resolving from live node.inputs must detect the identity change.
  parent.widgets[0].callback = () => {
    parent.inputs[0] = { name: "value_2", link: 5, widget: { name: "value_2" }, _subgraphSlot: { name: "value_2" } };
  };
  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource }),
    (err) => err instanceof WidgetWriteError && /CHANGED during the write/.test(err.message),
  );
  assert.equal(inner.widgets[0].value, 1280, "inner rolled back on host-input replacement");
  assert.equal(parent.widgets[0].value, 1280, "rail rolled back on host-input replacement");
});

test("#366 HARD FAIL + ROLLBACK: a parent rail callback that DRIFTS the value fails loudly AND rolls both back (never inner=new/parent=stale)", () => {
  const { parent, inner, resolveSource } = makePromotedMirrorFixture();
  // Parent callback silently reverts the rail to a stale value (drift signature).
  parent.widgets[0].callback = () => {
    parent.widgets[0].value = 1280;
  };
  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource }),
    (err) => err instanceof WidgetWriteError && /did not\s+retain the requested value/.test(err.message),
  );
  // Drift verification happens INSIDE the rollback try, so BOTH are restored — the
  // graph is never left inner=new / parent=stale after the failure.
  assert.equal(inner.widgets[0].value, 1280, "inner rolled back on parent drift");
  assert.equal(parent.widgets[0].value, 1280, "parent left at its (stale) value, not the half-applied new one");
});

test("#366 FAIL CLOSED: a NAME-only backlink pointing at a decoy (real rail absent) is refused, never written by name", () => {
  // Host input has a `widget` NAME stub (not an object in node.widgets) and there
  // is NO getWidgetFromSlot. A widget named "value_2" exists but is a DECOY — the
  // true rail widget is absent. A name-based lookup would select the decoy and
  // report success; identity/relationship authentication refuses and FAILS CLOSED.
  const inner = { id: 257, type: "PrimitiveInt", widgets: [{ name: "value", type: "INT", value: 1280 }] };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "257" ? inner : null) };
  const decoy = { name: "value_2", type: "INT", value: 9999 };
  const parent = {
    id: 267,
    type: "SubgraphNode",
    subgraph,
    // `widget` is a NAME STUB, not one of node.widgets by identity.
    inputs: [{ name: "value_2", widget: { name: "value_2" }, _subgraphSlot: { name: "value_2" } }],
    widgets: [decoy],
    // no getWidgetFromSlot
  };
  const resolveSource = (_n, si) =>
    si?.name === "value_2" ? { sourceNodeId: "257", sourceWidgetName: "value" } : null;

  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource }),
    (err) => err instanceof WidgetWriteError && /parent rail widget could not be identified/.test(err.message),
  );
  assert.equal(decoy.value, 9999, "decoy must NOT be written by name");
  assert.equal(inner.widgets[0].value, 1280, "inner must not be written on fail-closed");
});

test("#366: a promoted STRING widget also syncs the parent rail (prompt text)", () => {
  const inner = {
    id: 266,
    type: "PrimitiveStringMultiline",
    widgets: [{ name: "value", type: "customtext", value: "old landscape prompt" }],
  };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "266" ? inner : null) };
  const railWidget = { name: "value", type: "customtext", value: "old landscape prompt" };
  const parent = {
    id: 267,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "value", widget: { name: "value" }, _subgraphSlot: { name: "value" } }],
    widgets: [railWidget],
    getWidgetFromSlot(input) {
      return this.widgets.find((w) => w.name === input?.widget?.name) ?? null;
    },
  };
  const resolveSource = (_n, si) =>
    si?.name === "value" ? { sourceNodeId: "266", sourceWidgetName: "value" } : null;

  const set = applyWidgetWrite(parent, "value", "new vertical prompt", { resolveSource });

  assert.equal(inner.widgets[0].value, "new vertical prompt");
  assert.equal(railWidget.value, "new vertical prompt", "parent prompt rail widget must reflect the new text");
  assert.equal(set.promoted_from.parent_widget_synced, true);
});

test("#366×#179: a promoted COMPOSITE write merges onto the RAIL's current object — the rail's unspecified fields are NOT clobbered by the stale inner", () => {
  // Inner (non-authoritative) and rail (authoritative) hold DIVERGENT composite
  // values. A partial write {strength:0.6} must preserve the RAIL's `lora`
  // ("current"), not resurrect the inner's stale `lora` ("old").
  const inner = {
    id: 300,
    type: "Power Lora Loader (rgthree)",
    widgets: [{ name: "lora_1", value: { on: true, lora: "old.safetensors", strength: 1 } }],
  };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "300" ? inner : null) };
  const railWidget = { name: "lora_1", value: { on: true, lora: "current.safetensors", strength: 0.8 } };
  const parent = {
    id: 267,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "lora_1", widget: { name: "lora_1" }, _subgraphSlot: { name: "lora_1" } }],
    widgets: [railWidget],
    getWidgetFromSlot(input) {
      return this.widgets.find((w) => w.name === input?.widget?.name) ?? null;
    },
  };
  const resolveSource = (_n, si) =>
    si?.name === "lora_1" ? { sourceNodeId: "300", sourceWidgetName: "lora_1" } : null;

  const set = applyWidgetWrite(parent, "lora_1", '{"strength":0.6}', { resolveSource });

  assert.equal(railWidget.value.lora, "current.safetensors", "rail's authoritative lora must be preserved, not clobbered by the stale inner");
  assert.equal(railWidget.value.strength, 0.6, "requested field applied to the rail");
  assert.equal(railWidget.value.on, true, "rail's other unspecified field preserved");
  // Inner is written to the SAME authoritative merged value (read-consistency).
  assert.equal(inner.widgets[0].value.lora, "current.safetensors");
  assert.equal(inner.widgets[0].value.strength, 0.6);
  assert.equal(set.promoted_from.parent_widget_synced, true);
});
