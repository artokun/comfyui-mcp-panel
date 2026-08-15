// artokun/comfyui-mcp#938 — removing ONE dynamic widget row.
//
// The interesting half of this feature is the REFUSALS. Removing a row rgthree added is a
// splice; removing an input the BACKEND declared changes what is sent at queue time, and
// the two are indistinguishable from the widget object alone — only the node def separates
// them. So the tests below spend most of their effort on the cases where we must NOT
// remove, including the one that matters most: the def could not be read.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyWidgetRemoval,
  declaredInputNames,
  removalRefusal,
  reportableWidgetValue,
  runRemoveWidget,
} from "../../web/js/lib/remove-widget.js";

/**
 * TWO REAL removeWidget IMPLEMENTATIONS, because the ecosystem has two.
 *
 * LGraphNode.removeWidget (frontend 1.50.3, recovered from the shipped source map at
 * src/lib/litegraph/src/LGraphNode.ts) takes the WIDGET OBJECT and throws on a miss:
 *
 *   removeWidget(widget) {
 *     if (!this.widgets) throw new Error('removeWidget called on node without widgets')
 *     const i = this.widgets.indexOf(widget)
 *     if (i === -1) throw new Error('Widget not found on this node')
 *     ...clears input._widget/.widget/.pos, sets _widgetSlotsDirty, widget.onRemove?.()
 *     this.widgets.splice(i, 1)
 *   }
 *
 * rgthree OVERRIDES it (rgthree-comfy/web/comfyui/base_node.js:97) and accepts EITHER:
 *
 *   removeWidget(widget) { if (typeof widget === "number") widget = this.widgets[widget]; ... }
 *
 * MY FIRST VERSION OF THIS FILE GOT BOTH WRONG, IN OPPOSITE DIRECTIONS. It hand-built an
 * index-based double — `node.removeWidget = (i) => node.widgets.splice(i, 1)` — and 15
 * tests passed while production threw "Widget not found on this node" on every call. Then
 * the fix commit over-corrected: it asserted rgthree's own `removeWidget(0)` "throws on the
 * current frontend", which rgthree's shipped source directly contradicts, and installed
 * LGraphNode's method on a factory named "a Power Lora Loader as it actually appears" —
 * unfaithful for the exact node it models.
 *
 * The production fix (pass the widget) is right either way, and that is the point: it is
 * the only argument BOTH implementations accept. What was wrong was the story and the
 * double. Both are modelled below so neither belief can be re-encoded.
 */
function installLGraphNodeRemoveWidget(node) {
  node.removeWidget = function (w) {
    if (!this.widgets) throw new Error("removeWidget called on node without widgets");
    const t = this.widgets.indexOf(w);
    if (t === -1) throw new Error("Widget not found on this node");
    this.widgets.splice(t, 1);
  };
  return node;
}

/** rgthree's override: coerces a number, ignores a miss, calls onRemove. */
function installRgthreeRemoveWidget(node) {
  node.removeWidget = function (w) {
    if (typeof w === "number") w = this.widgets[w];
    if (!w) return;
    const i = this.widgets.indexOf(w);
    if (i > -1) this.widgets.splice(i, 1);
    w.onRemove?.();
  };
  return node;
}

/** A Power Lora Loader as it actually appears: rows the def does not declare. */
function powerLoraNode() {
  // A Power Lora Loader really does carry rgthree's override.
  return installRgthreeRemoveWidget({
    id: 35,
    type: "Power Lora Loader (rgthree)",
    inputs: [],
    widgets: [
      { name: "lora_1", value: { on: false, lora: "a.safetensors", strength: 0.8, strengthTwo: null } },
      { name: "lora_2", value: { on: true, lora: "b.safetensors", strength: 1, strengthTwo: null } },
      { name: "lora_3", value: { on: false, lora: "c.safetensors", strength: 1, strengthTwo: null } },
    ],
  });
}

const LORA_DEF = { input: { required: { model: ["MODEL"], clip: ["CLIP"] }, optional: {} } };
const LORA_DECLARED = declaredInputNames(LORA_DEF);

test("declaredInputNames reads required, optional AND hidden", () => {
  const names = declaredInputNames({
    input: { required: { a: [] }, optional: { b: [] }, hidden: { c: [] } },
  });
  assert.deepEqual([...names].sort(), ["a", "b", "c"]);
});

test("declaredInputNames returns NULL for a def it cannot read — not an empty set", () => {
  // The distinction is the whole safety story: an empty Set means "the backend declares
  // nothing, so every widget is dynamic", which would authorize removing ANY widget on a
  // node whose def failed to load. null means "I don't know" and is refused downstream.
  assert.equal(declaredInputNames(undefined), null);
  assert.equal(declaredInputNames(null), null);
  assert.equal(declaredInputNames({}), null);
  assert.equal(declaredInputNames({ input: null }), null);
  // …but a def that genuinely declares nothing IS an empty set, not null.
  assert.deepEqual([...declaredInputNames({ input: { required: {} } })], []);
});

test("a dynamic row is removable, and the rows are NOT renumbered", () => {
  const node = powerLoraNode();
  const out = runRemoveWidget(node, "lora_2", { declaredNames: LORA_DECLARED });

  assert.equal(out.removed.widget, "lora_2");
  assert.equal(out.removed.index, 1);
  assert.equal(out.removed.previous_value.lora, "b.safetensors");
  // THE POINT: lora_3 stays lora_3. rgthree's loraWidgetsCounter is monotonic and its
  // python reads **kwargs filtered by startswith('lora_'), so a gap is harmless — while
  // renumbering would collide the counter and be undone by the next configure().
  assert.deepEqual(out.remaining_widgets, ["lora_1", "lora_3"]);
  assert.deepEqual(node.widgets.map((w) => w.name), ["lora_1", "lora_3"]);
  // Order is what IS load-bearing (serialization is positional), and the splice keeps it.
  assert.equal(node.widgets[1].value.lora, "c.safetensors");
});

test("the removal is bracketed for ONE Ctrl+Z, and marks the canvas dirty", () => {
  const calls = [];
  const node = powerLoraNode();
  runRemoveWidget(node, "lora_1", {
    declaredNames: LORA_DECLARED,
    beforeChange: () => calls.push("before"),
    afterChange: () => calls.push("after"),
    setDirty: () => calls.push("dirty"),
  });
  assert.deepEqual(calls, ["before", "after", "dirty"]);
});

test("afterChange still runs when the removal throws — the undo envelope never leaks", () => {
  const calls = [];
  const node = powerLoraNode();
  node.removeWidget = () => {
    throw new Error("boom");
  };
  assert.throws(
    () =>
      runRemoveWidget(node, "lora_1", {
        declaredNames: LORA_DECLARED,
        beforeChange: () => calls.push("before"),
        afterChange: () => calls.push("after"),
      }),
    /boom/,
  );
  // An unclosed beforeChange() leaves LiteGraph accumulating into an undo step that never
  // ends, so the user's NEXT unrelated edit gets swallowed into this one.
  assert.deepEqual(calls, ["before", "after"]);
});

test("the node's own removeWidget is called with the WIDGET, not its index", () => {
  // The regression test for the P0. An index reaches the real method as an argument its
  // indexOf() cannot find, so it throws "Widget not found on this node" and removes
  // nothing — while a double that accepts an index reports a pass.
  const node = powerLoraNode();
  const target = node.widgets[2];
  const seen = [];
  const real = node.removeWidget.bind(node);
  node.removeWidget = (w) => {
    seen.push(w);
    real(w);
  };
  runRemoveWidget(node, "lora_3", { declaredNames: LORA_DECLARED });
  assert.equal(seen.length, 1);
  assert.equal(seen[0], target, "removeWidget must receive the widget object itself");
  assert.deepEqual(node.widgets.map((w) => w.name), ["lora_1", "lora_2"]);
});

test("passing the WIDGET is the only argument both real implementations accept", () => {
  // rgthree coerces a number, so an index happens to work THERE — which is why my
  // "rgthree's removeWidget(0) throws too" claim was false. On a plain LGraphNode it
  // throws, and Impact/Inspire list nodes have no override. The widget object is accepted
  // by both; that is the whole justification for the fix, and it is not "rgthree is broken".
  const rg = installRgthreeRemoveWidget({ id: 1, type: "T", inputs: [], widgets: [{ name: "a" }, { name: "b" }] });
  rg.removeWidget(0);
  assert.deepEqual(rg.widgets.map((w) => w.name), ["b"], "rgthree tolerates an index");

  const plain = installLGraphNodeRemoveWidget({ id: 2, type: "T", inputs: [], widgets: [{ name: "a" }, { name: "b" }] });
  assert.throws(() => plain.removeWidget(0), /Widget not found on this node/, "LGraphNode does not");
  assert.equal(plain.widgets.length, 2, "and removes nothing when it throws");

  // The widget object works on both.
  rg.removeWidget(rg.widgets[0]);
  plain.removeWidget(plain.widgets[0]);
  assert.equal(rg.widgets.length, 0);
  assert.deepEqual(plain.widgets.map((w) => w.name), ["b"]);
});

test("the fix works against a PLAIN LGraphNode too — the case the P0 actually broke", () => {
  // Impact/Inspire list nodes have no rgthree override, so they get LGraphNode's method
  // verbatim. This is where passing an index genuinely threw and removed nothing.
  const node = installLGraphNodeRemoveWidget({
    id: 7,
    type: "ImpactSomethingList",
    inputs: [],
    widgets: [{ name: "row_1", value: 1 }, { name: "row_2", value: 2 }],
  });
  const out = runRemoveWidget(node, "row_1", { declaredNames: new Set(["mode"]) });
  assert.equal(out.removed.widget, "row_1");
  assert.deepEqual(node.widgets.map((w) => w.name), ["row_2"]);
});

test("a removeWidget that silently NO-OPS is reported as a failure, not a success", () => {
  // node.removeWidget is an override point and custom nodes do reimplement it. A no-op
  // that we reported as success is the worst outcome available: the agent moves on
  // believing the row is gone and the user is looking at it.
  const node = powerLoraNode();
  node.removeWidget = () => {};  // accepts anything, removes nothing
  assert.throws(
    () => runRemoveWidget(node, "lora_2", { declaredNames: LORA_DECLARED }),
    /still on node 35 .*Nothing was changed/s,
  );
  assert.equal(node.widgets.length, 3);
});

test("REFUSES a backend-declared input, and points at the tool that IS right", () => {
  const node = {
    id: 7,
    type: "KSampler",
    widgets: [{ name: "steps", value: 20 }],
    inputs: [],
  };
  const declared = declaredInputNames({ input: { required: { steps: ["INT"] } } });
  assert.throws(() => runRemoveWidget(node, "steps", { declaredNames: declared }), /backend declares/);
  assert.throws(() => runRemoveWidget(node, "steps", { declaredNames: declared }), /panel_set_widget/);
  assert.equal(node.widgets.length, 1);
});

test("REFUSES when the def could not be read — 'unknown' never collapses into 'dynamic' (#796)", () => {
  // Without this, an /object_info fetch that failed would authorize removing a KSampler's
  // `steps`: no declared names → nothing matches → "dynamic". The failure mode is silent
  // and destructive, and it is the same shape as every #796-class bug in this codebase.
  const node = powerLoraNode();
  assert.throws(
    () => runRemoveWidget(node, "lora_2", { declaredNames: null }),
    /could not read the node definitions/,
  );
  assert.equal(node.widgets.length, 3);
  // The refusal carries WHAT was tried, when the caller knows.
  const msg = removalRefusal(node, "lora_2", { kind: "unknown" }, { objectInfoNote: "GET /object_info returned 503." });
  assert.match(msg, /503/);
});

test("REFUSES a frontend-synthesized control widget, detected by SHAPE not name", () => {
  // control_after_generate is re-created by the frontend, so removing it looks like it
  // worked and changes nothing. Detected via the shared #558 detector — a node def may
  // name the control anything, so a name test would miss a renamed one.
  const node = {
    id: 3,
    type: "KSampler",
    inputs: [],
    widgets: [
      { name: "seed", value: 1 },
      {
        name: "seed_behavior",
        value: "randomize",
        options: { serialize: false, canvasOnly: true, values: ["fixed", "increment", "decrement", "randomize"] },
      },
    ],
  };
  assert.throws(
    () => runRemoveWidget(node, "seed_behavior", { declaredNames: new Set(["seed"]) }),
    /control widget the ComfyUI frontend generates/,
  );
});

test("REFUSES a widget whose input slot is currently LINKED", () => {
  const node = {
    id: 9,
    type: "Whatever",
    widgets: [{ name: "value", value: 5 }],
    inputs: [{ name: "value", link: 42, widget: { name: "value" } }],
  };
  assert.throws(() => runRemoveWidget(node, "value", { declaredNames: new Set() }), /dangling/);
  // …but the same widget with NO link is fine.
  const unlinked = {
    id: 9,
    type: "Whatever",
    widgets: [{ name: "value", value: 5 }],
    inputs: [{ name: "value", link: null, widget: { name: "value" } }],
  };
  runRemoveWidget(unlinked, "value", { declaredNames: new Set() });
  assert.equal(unlinked.widgets.length, 0);
});

test("REFUSES a SUBGRAPH node with the true reason, not a fabricated lookup failure", () => {
  // A SubgraphNode's `type` is the subgraph's UUID, so `defs[node.type]` misses — and it
  // would have been refused with "I could not read the node definitions", which is false:
  // the defs read fine, this node just is not a backend type. Claiming a lookup failure
  // that never happened is the same defect class as the refusal this tool exists to avoid.
  const node = {
    id: 12,
    type: "0f6a1e1e-1111-4111-8111-111111111111",
    inputs: [],
    widgets: [{ name: "promoted_steps", value: 20 }],
    subgraph: { _nodes: [] },
  };
  assert.throws(
    () => runRemoveWidget(node, "promoted_steps", { declaredNames: null }),
    /SUBGRAPH node/,
  );
  assert.throws(
    () => runRemoveWidget(node, "promoted_steps", { declaredNames: null }),
    /panel_promote_widget with demote:true/,
  );
  // …and it must NOT claim the definitions were unreadable.
  try {
    runRemoveWidget(node, "promoted_steps", { declaredNames: null });
  } catch (err) {
    assert.doesNotMatch(err.message, /could not read the node definitions/);
  }
  assert.equal(node.widgets.length, 1);
});

test("a missing widget is refused by NAME, listing what the node actually has", () => {
  const node = powerLoraNode();
  assert.throws(() => runRemoveWidget(node, "lora_9", { declaredNames: LORA_DECLARED }), /lora_1, lora_2, lora_3/);
});

test("the classifier is ordered so a decidable answer beats 'I could not read the def'", () => {
  // A linked or synthesized widget is decidable from the graph alone. Reporting
  // "I could not read /object_info" for one of those would be a true statement and the
  // wrong answer.
  const node = {
    id: 1,
    type: "T",
    widgets: [{ name: "v", value: 1 }],
    inputs: [{ name: "v", link: 3, widget: { name: "v" } }],
  };
  assert.equal(classifyWidgetRemoval(node, "v", { declaredNames: null }).kind, "linked");
});

test("a credential-ish widget value is never echoed back", () => {
  // The reply lands in a transcript. Report presence, not the value.
  assert.equal(reportableWidgetValue("api_key", "sk-live-abcdef"), "<redacted>");
  assert.equal(reportableWidgetValue("comfy_api_token", "t"), "<redacted>");
  assert.equal(reportableWidgetValue("api_key", ""), null);
  // …and an ordinary row is reported as-is, or the reply would be useless for undo.
  assert.equal(reportableWidgetValue("lora_1", "x.safetensors"), "x.safetensors");
});

test("WIRING: the panel command routes through runRemoveWidget and refuses on an unread def", async () => {
  // A green unit suite proves the helper works; it says nothing about whether the command
  // handler CALLS it, or whether it passes declaredNames at all — a handler that passed a
  // bare `new Set()` would make every refusal above unreachable in production while every
  // test here stayed green.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "../../web/js/comfyui-mcp-panel.js"), "utf8");
  const idx = src.indexOf("async graph_remove_widget(");
  assert.ok(idx > 0, "graph_remove_widget handler is missing");
  // Bounded at the NEXT handler, not at a fixed width. A `slice(idx, idx + 2000)` silently
  // stops covering the handler as soon as anything is added above the assertion it looks
  // for — a comment is enough — so the test starts passing-by-not-looking rather than
  // failing. That is the same trap a sibling test hit with a fixed slice over the socket
  // listeners (#1223).
  const next = src.indexOf("\n  async graph_", idx + 1);
  const block = src.slice(idx, next === -1 ? src.length : next);
  assert.match(block, /runRemoveWidget\(/);
  // declaredNames must come from the FETCHED defs, not a literal.
  assert.match(block, /declaredNames,/);
  assert.match(block, /declaredInputNames\(defs\?\.\[/);
  // …and the workflow-target fence must run at the write boundary (#718), because the
  // /object_info read above it is awaited and the user can switch workflows during it.
  assert.match(block, /assertActiveWorkflowCommandTarget/);
});
