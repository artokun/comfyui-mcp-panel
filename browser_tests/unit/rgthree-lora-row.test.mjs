/**
 * #757 — `panel_set_widget` could not CREATE an rgthree Power Lora Loader row.
 *
 * The rows exist only after the user clicks "➕ Add Lora", a DOM-only control an agent
 * cannot activate, so every write to `lora_1` on a fresh node was refused for a widget no
 * tool could bring into existence.
 *
 * The load-bearing constraint is what this must NOT become. The panel deliberately refuses
 * to auto-press a pressable control, because a generic "press this node's button" rule
 * would mutate the graph on an ordinary TYPO — the overwhelmingly common reason a widget
 * name misses. Most of these tests exist to pin that the route cannot be reached by
 * anything but the real case.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  isRgthreeLoraRowCreation,
  createRgthreeLoraRow,
  POWER_LORA_LOADER_TYPE,
} from "../../web/js/lib/rgthree-lora-row.js";

const SLOT = { on: true, lora: "x.safetensors", strength: 0.5, strengthTwo: null };

/** A Power Lora Loader as it looks fresh from panel_add_node: no rows yet. */
function loader({ counter = 1, addNew = true, widgets = null } = {}) {
  const node = {
    id: 153,
    type: POWER_LORA_LOADER_TYPE,
    widgets: widgets ?? [
      { name: "divider" },
      { name: "PowerLoraLoaderHeaderWidget" },
      { name: "divider" },
      { name: "➕ Add Lora" },
    ],
    removeWidget(w) {
      const i = node.widgets.indexOf(w);
      if (i >= 0) node.widgets.splice(i, 1);
    },
  };
  if (addNew) {
    // rgthree's real behaviour: a MONOTONIC counter, so names are not positional.
    node.addNewLoraWidget = () => {
      node.widgets.push({ name: `lora_${counter++}`, value: { on: true, lora: null, strength: 1, strengthTwo: null } });
    };
  }
  return node;
}

// ---------------------------------------------------------------------------
// The classifier — three independent facts, all required
// ---------------------------------------------------------------------------

test("#757 the reported case classifies: right type, lora_N name, slot-shaped value", () => {
  assert.equal(isRgthreeLoraRowCreation(loader(), "lora_1", SLOT), true);
});

test("#757 a TYPO does not reach the creation route", () => {
  // The whole reason the panel refuses to auto-press a button. `strenght` or `lora1` or
  // `seed` must all get the ordinary refusal (and its pressable hint), never a new row.
  for (const name of ["lora1", "loras_1", "lora_", "seed", "strenght", "LORA_1", ""]) {
    assert.equal(isRgthreeLoraRowCreation(loader(), name, SLOT), false, `name ${JSON.stringify(name)}`);
  }
});

test("#757 another node type never reaches it, even with a lora_N name and a slot value", () => {
  const other = { ...loader(), type: "LoraLoader" };
  assert.equal(isRgthreeLoraRowCreation(other, "lora_1", SLOT), false);
  const noType = { ...loader(), type: undefined, comfyClass: undefined };
  assert.equal(isRgthreeLoraRowCreation(noType, "lora_1", SLOT), false);
});

test("#757 a value that is not a lora slot never reaches it", () => {
  // A slot is minted to receive a row. Growing the node for a value the writer would then
  // refuse leaves a stray row behind and reports a failure — worse than refusing up front.
  for (const value of [null, undefined, 5, "x.safetensors", [], { on: true }, { on: true, lora: "a", strength: 1, extra: 1 }]) {
    assert.equal(isRgthreeLoraRowCreation(loader(), "lora_1", value), false, `value ${JSON.stringify(value)}`);
  }
});

test("#757 an EXISTING row is left to the ordinary write path", () => {
  const n = loader();
  n.widgets.push({ name: "lora_1", value: { on: false, lora: null, strength: 1, strengthTwo: null } });
  assert.equal(isRgthreeLoraRowCreation(n, "lora_1", SLOT), false, "minting over it would duplicate the row");
});

test("#757 the classifier is total — a hostile node answers false, never throws", () => {
  const hostile = {
    get type() {
      throw new TypeError("disposed");
    },
  };
  assert.doesNotThrow(() => isRgthreeLoraRowCreation(hostile, "lora_1", SLOT));
  assert.equal(isRgthreeLoraRowCreation(hostile, "lora_1", SLOT), false);
});

// ---------------------------------------------------------------------------
// Creation, and the post-verify that makes a pack-private call safe
// ---------------------------------------------------------------------------

test("#757 the reported case: the row is created and named", () => {
  const n = loader();
  const events = [];
  const r = createRgthreeLoraRow(n, "lora_1", {
    beforeChange: () => events.push("before"),
    afterChange: () => events.push("after"),
    setDirty: () => events.push("dirty"),
  });
  assert.deepEqual(r, { created: "lora_1" });
  assert.ok(n.widgets.some((w) => w.name === "lora_1"), "the row now exists for the write that follows");
  assert.deepEqual(events, ["before", "after", "dirty"], "the mutation is bracketed for undo");
});

test("#757 a pack without addNewLoraWidget refuses LOUDLY, and changes nothing", () => {
  // Feature detection, as ltx-director.js does for its own pack-private entry point. A
  // renamed or dropped method must produce an actionable refusal, never a silent no-op.
  const n = loader({ addNew: false });
  const before = n.widgets.length;
  assert.throws(() => createRgthreeLoraRow(n, "lora_1", {}), /does not expose addNewLoraWidget/);
  assert.equal(n.widgets.length, before);
});

test("#757 a call that adds NOTHING is caught — the effect is verified, not the call", () => {
  // The probe that motivated this file found pack callbacks that accept a call and create
  // nothing. Only comparing the widget list catches that.
  const n = loader();
  n.addNewLoraWidget = () => {};
  assert.throws(() => createRgthreeLoraRow(n, "lora_1", {}), /ran but added no widget/);
});

test("#757 a pack method that THROWS is attributed to the pack", () => {
  const n = loader();
  n.addNewLoraWidget = () => {
    throw new Error("rgthree exploded");
  };
  assert.throws(() => createRgthreeLoraRow(n, "lora_1", {}), /rgthree pack's own addNewLoraWidget\(\) threw \(rgthree exploded\)/);
});

test("#757 afterChange still runs when the pack method throws", () => {
  const n = loader();
  n.addNewLoraWidget = () => {
    throw new Error("boom");
  };
  const events = [];
  assert.throws(() =>
    createRgthreeLoraRow(n, "lora_1", {
      beforeChange: () => events.push("before"),
      afterChange: () => events.push("after"),
    }),
  );
  assert.deepEqual(events, ["before", "after"], "an unclosed beforeChange would corrupt the undo stack");
});

test("#757 a MONOTONIC counter: the wrong row is taken back out and the real name is named", () => {
  // rgthree's loraWidgetsCounter only ever increases, so after a row is removed the next
  // created row is NOT the removed name. A refusal that left the stray row behind could not
  // be safely retried.
  const n = loader({ counter: 7 });
  const before = n.widgets.length;
  assert.throws(
    () => createRgthreeLoraRow(n, "lora_1", {}),
    /this node's next row is "lora_7", not "lora_1"[\s\S]*has been removed again/,
  );
  assert.equal(n.widgets.length, before, "nothing is left behind");
  assert.ok(!n.widgets.some((w) => w.name === "lora_7"), "including the row it minted");
});

test("#757 the stray row is removed even on a node with no removeWidget method", () => {
  const n = loader({ counter: 9 });
  delete n.removeWidget;
  const before = n.widgets.length;
  assert.throws(() => createRgthreeLoraRow(n, "lora_2", {}), /next row is "lora_9"/);
  assert.equal(n.widgets.length, before, "the splice fallback still cleans up");
});

test("#757 consecutive creates work: lora_1 then lora_2", () => {
  const n = loader();
  assert.deepEqual(createRgthreeLoraRow(n, "lora_1", {}), { created: "lora_1" });
  assert.deepEqual(createRgthreeLoraRow(n, "lora_2", {}), { created: "lora_2" });
  assert.deepEqual(
    n.widgets.map((w) => w.name).filter((x) => x.startsWith("lora_")),
    ["lora_1", "lora_2"],
  );
});

// ---------------------------------------------------------------------------
// The panel wiring
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
const PANEL_SRC = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");

test("#757 creation runs AFTER the history seed and BEFORE runSetWidget", () => {
  // The seed is what makes the #458 authorization meaningful, and growing a node is a
  // mutation: it must not happen on a call authorization is about to refuse.
  const seed = PANEL_SRC.indexOf("await awaitObjectInfoHistorySeed();", PANEL_SRC.indexOf("async graph_set_widget("));
  const create = PANEL_SRC.indexOf("createRgthreeLoraRow(node, widget, {");
  const run = PANEL_SRC.indexOf("const result = await runSetWidget(");
  assert.ok(seed > 0 && create > seed, "creation is after the history seed");
  assert.ok(run > create, "…and before the write");
});

test("#757 the uuid fence brackets the creation", () => {
  // The user can switch workflows during the awaits above; a row must never be grown on a
  // canvas the caller did not address (#570/#718).
  const at = PANEL_SRC.indexOf("if (isRgthreeLoraRowCreation(node, widget, value)) {");
  assert.notEqual(at, -1);
  const block = PANEL_SRC.slice(at, PANEL_SRC.indexOf("createRgthreeLoraRow(node, widget, {", at));
  assert.match(block, /assertActiveWorkflowCommandTarget\(\{/, "the fence runs before the mutation");
});

test("#757 the created row is disclosed on its own field, not in `warning`", () => {
  assert.match(PANEL_SRC, /created_widget: createdLoraRow/);
  const sw = PANEL_SRC.slice(PANEL_SRC.indexOf("async graph_set_widget("));
  const body = sw.slice(0, sw.indexOf("async graph_remove_widget("));
  assert.ok(!/warning:[^\n]*createdLoraRow/.test(body), "it must not displace a warning about the write");
});
