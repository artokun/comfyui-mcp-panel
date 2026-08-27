/**
 * Unit tests for #1932 — generated custom-widget refresh after a widget write —
 * run with `node --test`.
 *
 * These drive runSetWidget(), the SAME async unit graph_set_widget delegates to,
 * so the production path is exercised (not a parallel reimplementation).
 *
 * The fixtures reproduce Deno's Multi LoRA generated UI
 * (`web/js/deno_multi_lora.js`) faithfully, because its exact split is the
 * whole bug:
 *
 *     hideBackendWidgets(node);          // active_loras, lora_N, strengths, …
 *     rebuildUi(node);                   // mint deno_multi_lora_row_1..N
 *     function redraw(node) {            // in-node value tweak
 *       node.setDirtyCanvas?.(true, true);
 *     }
 *
 * `rebuildUi` is the only function that mints or drops rows, and it runs from
 * setup/configure and from +Add/remove. `redraw()` never rebuilds. The panel
 * write path updates the hidden backend widget and dirties the canvas, so
 * `active_loras` 1→3 reported success while the visible rows/height stayed at
 * 1 until the subgraph was left and re-entered.
 *
 * Invariants under test:
 *   1. An `active_loras` write leaves generated rows matching the count, and
 *      the result discloses the refresh (generated_widgets_refreshed + names).
 *   2. Shrinking the count drops trailing generated rows and shrinks height.
 *   3. A write to a hidden slot (`lora_2`) on a node whose generated list is
 *      already behind also rebuilds, so the row that displays the value exists.
 *   4. Keying is the PATTERN (hidden backend + serialize:false custom widgets),
 *      never a node-type list — the LTX sibling with a different prefix refreshes
 *      too, and a stock node is untouched.
 *   5. The +Add generated control is never pressed (it would increment the count).
 *   6. A rebuild that THROWS does not fail the verified write; the failure is
 *      disclosed (generated_widgets_refresh_failed).
 *   7. A rebuild that changes nothing is not claimed as a refresh.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runSetWidget } from "../../web/js/lib/set-widget.js";
import {
  hasGeneratedCustomWidgetPattern,
  refreshCustomGeneratedWidgetsAfterWrite,
} from "../../web/js/lib/custom-generated-widgets-refresh.js";

const REGISTRY = { DenoMultiLoraLoader: {}, DenoLTXMultiLoraLoader: {}, KSampler: {} };
const FRESH = { DenoMultiLoraLoader: {}, DenoLTXMultiLoraLoader: {}, KSampler: {} };
const freshOracle = { getFreshObjectInfo: async () => FRESH };
const CANVAS = { isFakeCanvas: true };
const NONE = "__none__";
const LORA_OPTIONS = [NONE, "style.safetensors", "detail.safetensors"];

class GeneratedRow {
  constructor(index) {
    this.name = `${this.constructor.prefix}row_${index}`;
    this.type = "custom";
    this.options = { serialize: false };
    this.index = index;
    this.value = "";
  }
}

class DenoRow extends GeneratedRow {
  static prefix = "deno_multi_lora_";
}

class LtxRow extends GeneratedRow {
  static prefix = "deno_ltx_multi_lora_";
}

function hide(widget) {
  widget.hidden = true;
  widget.type = "converted-widget";
  widget.computeSize = () => [0, -4];
  return widget;
}

function generatedChrome(prefix) {
  return [
    { name: `${prefix}divider`, type: "custom", options: { serialize: false }, value: "" },
    { name: `${prefix}header`, type: "custom", options: { serialize: false }, value: "" },
  ];
}

function addButton(prefix, node) {
  return {
    name: `${prefix}add_button`,
    type: "custom",
    options: { serialize: false },
    value: "",
    presses: 0,
    onMouseClick() {
      this.presses += 1;
      const count = node.widgets.find((w) => w.name === "active_loras");
      if (count) count.value = Number(count.value) + 1;
    },
  };
}

/**
 * A faithful stand-in for DenoMultiLoraLoader after setupNode/rebuildUi:
 * hidden backend widgets, generated chrome + row_1..count + add_button,
 * computeSize from the visible widget list, onConfigure rebuilding rows
 * the way leaving and re-entering a subgraph does.
 */
function makeDenoNode({ count = 1, prefix = "deno_multi_lora_", Row = DenoRow, type = "DenoMultiLoraLoader" } = {}) {
  const MAX = 8;
  const node = {
    id: 42,
    type,
    widgets: [],
    size: [450, 90],
    dirty: 0,
    addCustomWidget(widget) {
      this.widgets.push(widget);
      return widget;
    },
    setDirtyCanvas() {
      this.dirty += 1;
    },
    computeSize() {
      const visible = this.widgets.filter((w) => !w.hidden && w.type !== "converted-widget");
      return [450, 40 + visible.length * 24];
    },
  };

  const backend = [];
  backend.push(hide({ name: "active_loras", type: "number", value: count }));
  for (let i = 1; i <= MAX; i++) {
    backend.push(hide({ name: `enabled_${i}`, type: "toggle", value: true }));
    backend.push(
      hide({
        name: `lora_${i}`,
        type: "combo",
        options: { values: LORA_OPTIONS.slice() },
        value: NONE,
      }),
    );
    backend.push(hide({ name: `model_strength_${i}`, type: "number", value: 1 }));
    backend.push(hide({ name: `clip_strength_${i}`, type: "number", value: 1 }));
  }
  node.widgets.push(...backend);

  const rebuildUi = () => {
    const n = Number(node.widgets.find((w) => w.name === "active_loras")?.value) || 0;
    const clamped = Math.max(0, Math.min(Math.round(n), MAX));
    node.widgets = node.widgets.filter((w) => {
      const name = String(w.name || "");
      return !name.startsWith(prefix);
    });
    for (const chrome of generatedChrome(prefix)) node.addCustomWidget(chrome);
    for (let i = 1; i <= clamped; i++) node.addCustomWidget(new Row(i));
    node.addCustomWidget(addButton(prefix, node));
    const computed = node.computeSize();
    node.size = [Math.max(node.size[0], computed[0]), computed[1]];
    node.setDirtyCanvas(true, true);
  };

  node.onConfigure = function () {
    rebuildUi();
  };
  rebuildUi();
  node.dirty = 0;
  return node;
}

function generatedRowNames(node) {
  return node.widgets
    .filter((w) => typeof w.name === "string" && /row_\d+$/.test(w.name))
    .map((w) => w.name);
}

test("#1932 repro: active_loras 1→3 rebuilds generated rows and discloses the new list", async () => {
  const node = makeDenoNode({ count: 1 });
  assert.deepEqual(generatedRowNames(node), ["deno_multi_lora_row_1"]);
  const heightBefore = node.size[1];

  const res = await runSetWidget(node, "active_loras", 3, {
    registry: REGISTRY,
    ...freshOracle,
    canvas: CANVAS,
  });

  assert.equal(res.set.value, 3, "the write itself still reports the value that landed");
  assert.equal(res.set.generated_widgets_refreshed, true);
  assert.ok(res.set.generated_widgets.includes("deno_multi_lora_row_1"));
  assert.ok(res.set.generated_widgets.includes("deno_multi_lora_row_2"));
  assert.ok(res.set.generated_widgets.includes("deno_multi_lora_row_3"));
  assert.deepEqual(generatedRowNames(node), [
    "deno_multi_lora_row_1",
    "deno_multi_lora_row_2",
    "deno_multi_lora_row_3",
  ]);
  assert.ok(node.size[1] > heightBefore, "height grows with the minted rows");
  const add = node.widgets.find((w) => w.name === "deno_multi_lora_add_button");
  assert.equal(add.presses, 0, "the +Add control is never pressed");
});

test("#1932 shrinking the count drops trailing generated rows", async () => {
  const node = makeDenoNode({ count: 4 });
  const res = await runSetWidget(node, "active_loras", 2, {
    registry: REGISTRY,
    ...freshOracle,
    canvas: CANVAS,
  });

  assert.equal(res.set.generated_widgets_refreshed, true);
  assert.deepEqual(generatedRowNames(node), ["deno_multi_lora_row_1", "deno_multi_lora_row_2"]);
  assert.equal(
    node.widgets.some((w) => w.name === "deno_multi_lora_row_4"),
    false,
  );
});

test("#1932 WITHOUT the fix the generated rows stayed stale — dirty canvas is not a rebuild", () => {
  const node = makeDenoNode({ count: 1 });
  const countW = node.widgets.find((w) => w.name === "active_loras");
  countW.value = 3;
  node.setDirtyCanvas(true, true);
  assert.deepEqual(
    generatedRowNames(node),
    ["deno_multi_lora_row_1"],
    "redraw() dirties the canvas and does not mint rows",
  );
});

test("#1932 a hidden lora_2 write rebuilds when the generated list is already behind", async () => {
  const node = makeDenoNode({ count: 1 });
  node.widgets.find((w) => w.name === "active_loras").value = 2;
  assert.deepEqual(generatedRowNames(node), ["deno_multi_lora_row_1"], "rows have not caught up yet");

  const res = await runSetWidget(node, "lora_2", "style.safetensors", {
    registry: REGISTRY,
    ...freshOracle,
    canvas: CANVAS,
  });

  assert.equal(res.set.value, "style.safetensors");
  assert.equal(res.set.generated_widgets_refreshed, true);
  assert.deepEqual(generatedRowNames(node), ["deno_multi_lora_row_1", "deno_multi_lora_row_2"]);
});

test("the LTX sibling with a different prefix still refreshes — keying is the pattern", async () => {
  const node = makeDenoNode({
    count: 1,
    prefix: "deno_ltx_multi_lora_",
    Row: LtxRow,
    type: "DenoLTXMultiLoraLoader",
  });
  const res = await runSetWidget(node, "active_loras", 2, {
    registry: REGISTRY,
    ...freshOracle,
    canvas: CANVAS,
  });
  assert.equal(res.set.generated_widgets_refreshed, true);
  assert.deepEqual(generatedRowNames(node), ["deno_ltx_multi_lora_row_1", "deno_ltx_multi_lora_row_2"]);
});

test("a stock node without the pattern is untouched and nothing is claimed", async () => {
  const widget = { name: "steps", type: "number", value: 20 };
  const node = { id: 3, type: "KSampler", widgets: [widget] };
  const res = await runSetWidget(node, "steps", 30, {
    registry: REGISTRY,
    ...freshOracle,
    canvas: CANVAS,
  });
  assert.equal(res.set.value, 30);
  assert.equal("generated_widgets_refreshed" in res.set, false);
  assert.equal("generated_widgets" in res.set, false);
  assert.equal("generated_widgets_refresh_failed" in res.set, false);
});

test("a rebuild that changes NOTHING is not reported as a refresh", async () => {
  const node = makeDenoNode({ count: 2 });
  const res = await runSetWidget(node, "active_loras", 2, {
    registry: REGISTRY,
    ...freshOracle,
    canvas: CANVAS,
  });
  assert.equal(res.set.value, 2);
  assert.equal("generated_widgets_refreshed" in res.set, false, "nothing changed ⇒ nothing claimed");
});

test("a rebuild that THROWS does not fail the verified write; the failure is disclosed", async () => {
  const node = makeDenoNode({ count: 1 });
  node.onConfigure = () => {
    throw new Error("pack code exploded");
  };
  const res = await runSetWidget(node, "active_loras", 3, {
    registry: REGISTRY,
    ...freshOracle,
    canvas: CANVAS,
  });
  assert.equal(res.set.value, 3, "the write is still reported as the verified success it is");
  // Sync constructor-clone still mints rows after the throwing onConfigure, so the
  // list may have moved — either way the throw is disclosed and the write is not
  // rethrown.
  assert.equal(typeof res.set.generated_widgets_refresh_failed, "string");
  assert.match(res.set.generated_widgets_refresh_failed, /succeeded and was verified/);
  assert.match(res.set.generated_widgets_refresh_failed, /pack code exploded/);
  assert.equal("generated_widgets_refreshed" in res.set, false);
});

test("the refresh is bracketed by the command's undo-history hooks", async () => {
  const node = makeDenoNode({ count: 1 });
  let before = 0;
  let after = 0;
  const res = await runSetWidget(node, "active_loras", 3, {
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
  assert.equal(res.set.generated_widgets_refreshed, true);
  // One pair for the write itself, one pair for the generated-widget rebuild.
  assert.equal(before, 2);
  assert.equal(after, 2);
});

test("rows still mint when onConfigure is absent, from the existing row constructor", async () => {
  const node = makeDenoNode({ count: 1 });
  delete node.onConfigure;
  const res = await runSetWidget(node, "active_loras", 3, {
    registry: REGISTRY,
    ...freshOracle,
    canvas: CANVAS,
  });
  assert.equal(res.set.generated_widgets_refreshed, true);
  assert.deepEqual(generatedRowNames(node), [
    "deno_multi_lora_row_1",
    "deno_multi_lora_row_2",
    "deno_multi_lora_row_3",
  ]);
});

test("0→1 uses onConfigure when there is no row constructor to clone", async () => {
  const node = makeDenoNode({ count: 0 });
  assert.deepEqual(generatedRowNames(node), []);
  const res = await runSetWidget(node, "active_loras", 1, {
    registry: REGISTRY,
    ...freshOracle,
    canvas: CANVAS,
  });
  assert.equal(res.set.generated_widgets_refreshed, true);
  assert.deepEqual(generatedRowNames(node), ["deno_multi_lora_row_1"]);
});

// ── the lib's own contract, driven directly ──────────────────────────────────

test("hasGeneratedCustomWidgetPattern requires hidden backend AND serialize:false custom widgets", () => {
  assert.equal(hasGeneratedCustomWidgetPattern(makeDenoNode({ count: 1 })), true);
  assert.equal(hasGeneratedCustomWidgetPattern({ widgets: [{ name: "steps", type: "number", value: 20 }] }), false);
  assert.equal(
    hasGeneratedCustomWidgetPattern({
      widgets: [{ name: "active_loras", hidden: true, type: "converted-widget", value: 1 }],
    }),
    false,
    "hidden backend alone is not the pattern",
  );
  assert.equal(
    hasGeneratedCustomWidgetPattern({
      widgets: [{ name: "row_1", type: "custom", options: { serialize: false } }],
    }),
    false,
    "generated chrome alone is not the pattern",
  );
  assert.equal(hasGeneratedCustomWidgetPattern({}), false);
  assert.equal(hasGeneratedCustomWidgetPattern(null), false);
});

test("refreshCustomGeneratedWidgetsAfterWrite returns null when there is no pattern, and never throws", () => {
  assert.equal(refreshCustomGeneratedWidgetsAfterWrite({ id: 1 }), null);
  assert.equal(refreshCustomGeneratedWidgetsAfterWrite(null), null);
  const hostile = {};
  Object.defineProperty(hostile, "widgets", {
    get() {
      throw new Error("nope");
    },
  });
  const out = refreshCustomGeneratedWidgetsAfterWrite(hostile);
  assert.ok(
    out === null || typeof out.failed === "string",
    "hostile reads degrade to a disclosure, never a throw",
  );
});
