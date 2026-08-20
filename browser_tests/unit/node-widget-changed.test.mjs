/**
 * #1519 — `panel_set_widget` never fired the NODE-level litegraph hook
 * `node.onWidgetChanged(name, value, prevValue, widget)`, so a pack that rebuilds its
 * slot topology from that hook kept the new widget value and its OLD slots, silently.
 *
 * These drive `applyWidgetWrite()` — the same function `graph_set_widget` delegates to
 * — rather than the helper in isolation, because the whole defect was a MISSING CALL
 * SITE: a helper-level test of `fireNodeWidgetChanged` passes just as happily with the
 * write path never calling it, which is exactly the state main was in.
 *
 * Run with `node --test`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { applyWidgetWrite, WidgetWriteError } from "../../web/js/lib/widget-write.js";
import { fireNodeWidgetChanged, nodeWidgetChangedHook } from "../../web/js/lib/node-widget-changed.js";

const HOOKS = {};

/**
 * The reported node, reduced to its mechanism: `comfyui-subworkflow`'s SWF_Subworkflow
 * patches `onWidgetChanged` in `beforeRegisterNodeDef` and builds its `swf_in_*` /
 * `out_*` slots from the selected child workflow. `panel_add_node` creates it with an
 * empty `workflow` widget (so its `onAdded` fetches nothing), and the panel write then
 * set the value while the slots stayed generic.
 *
 * The rebuild here is synchronous so the test can observe it; the real pack's is a
 * `fetch`, which is why the result field is emitted only on an observed change.
 */
function makeSubworkflowNode({ onChange } = {}) {
  const calls = [];
  const node = {
    id: 7,
    type: "SWF_Subworkflow",
    widgets: [
      { name: "workflow", type: "combo", options: { values: ["", "child.json"] }, value: "" },
      { name: "reload_each_execution", type: "toggle", value: false },
    ],
    inputs: [{ name: "workflow" }, { name: "reload_each_execution" }],
    outputs: Array.from({ length: 8 }, (_, i) => ({ name: `out_${i}`, type: "*" })),
    // Installed on the instance here; on the real pack it is on the node TYPE's
    // prototype. Either way the lookup this file performs is `node.onWidgetChanged`.
    onWidgetChanged(name, value, prevValue, widget) {
      calls.push({ name, value, prevValue, widget, this: this });
      if (onChange) return onChange.call(this, name, value, prevValue, widget);
      if (name !== "workflow" || !value) return;
      // What the pack does once `/subworkflow/info` answers: the boundary nodes of the
      // selected child become real slots.
      this.inputs = [
        { name: "workflow" },
        { name: "reload_each_execution" },
        { name: "swf_in_0" },
        { name: "swf_in_1" },
      ];
      this.outputs = [{ name: "out_0", type: "IMAGE" }];
    },
  };
  return { node, calls };
}

// ---- the defect ------------------------------------------------------------

test("#1519: a programmatic write FIRES the node's onWidgetChanged, so dynamic slots materialise", () => {
  const { node, calls } = makeSubworkflowNode();

  const set = applyWidgetWrite(node, "workflow", "child.json", HOOKS);

  assert.equal(set.value, "child.json");
  assert.equal(calls.length, 1, "the node-level hook must fire exactly once");
  // The slots the report says never appeared. Without the hook these stay
  // ["workflow", "reload_each_execution"] and every panel_connect to swf_in_0 fails.
  assert.deepEqual(
    node.inputs.map((i) => i.name),
    ["workflow", "reload_each_execution", "swf_in_0", "swf_in_1"],
  );
  assert.deepEqual(
    node.outputs.map((o) => o.name),
    ["out_0"],
  );
});

test("#1519: the hook gets litegraph's argument shape — (name, value, prevValue, widget) on the node", () => {
  const { node, calls } = makeSubworkflowNode();
  const widget = node.widgets[0];

  applyWidgetWrite(node, "workflow", "child.json", HOOKS);

  const call = calls[0];
  assert.equal(call.name, "workflow");
  assert.equal(call.value, "child.json");
  assert.equal(call.prevValue, "", "the PRIOR value, as BaseWidget.setValue passes it");
  assert.equal(call.widget, widget, "the widget object itself, not its name");
  assert.equal(call.this, node, "invoked with the NODE as the receiver");
});

test("#1519: the widget's own callback runs BEFORE the node hook, as the frontend orders them", () => {
  const order = [];
  const node = {
    id: 3,
    type: "N",
    widgets: [
      {
        name: "w",
        type: "number",
        value: 1,
        callback() {
          order.push("callback");
        },
      },
    ],
    onWidgetChanged() {
      order.push("onWidgetChanged");
    },
  };

  applyWidgetWrite(node, "w", 5, HOOKS);

  assert.deepEqual(order, ["callback", "onWidgetChanged"]);
});

// ---- the ordering constraint the report asked for --------------------------

test("#1519: a write that FAILS verification and rolls back does NOT fire the hook", () => {
  const calls = [];
  const node = {
    id: 4,
    type: "N",
    widgets: [
      {
        name: "c",
        options: { values: ["a", "b"] },
        value: "a",
        callback() {
          this.value = "b"; // silent drift → verification fails → rollback + throw
        },
      },
    ],
    onWidgetChanged(...args) {
      calls.push(args);
    },
  };

  assert.throws(
    () => applyWidgetWrite(node, "c", "a", HOOKS),
    (err) => err instanceof WidgetWriteError && /did not retain the requested value/.test(err.message),
  );
  assert.equal(
    calls.length,
    0,
    "a pack rebuilt against a value that was rolled back is worse than the stale slots this fixes",
  );
});

// ---- containment: the hook never decides the write's verdict ---------------

test("#1519: a THROWING hook does not fail the write — the value is in effect and the throw is disclosed", () => {
  const node = {
    id: 5,
    type: "N",
    widgets: [{ name: "w", type: "number", value: 1 }],
    onWidgetChanged() {
      throw new Error("pack blew up");
    },
  };

  const set = applyWidgetWrite(node, "w", 5, HOOKS);

  assert.equal(set.value, 5);
  assert.equal(node.widgets[0].value, 5, "the write is NOT rolled back over a hook failure");
  assert.match(set.widget_changed_hook_failed, /succeeded and was verified/);
  assert.match(set.widget_changed_hook_failed, /pack blew up/);
  assert.match(set.widget_changed_hook_failed, /may be stale/);
});

test("#1519: a NON-CALLABLE onWidgetChanged is invoked and disclosed, not silently skipped", () => {
  const node = {
    id: 6,
    type: "N",
    widgets: [{ name: "w", type: "number", value: 1 }],
    // The frontend's `node.onWidgetChanged?.(…)` would throw here too. Skipping it
    // silently would restore exactly the silent staleness this fixes.
    onWidgetChanged: { call() {} },
  };

  const set = applyWidgetWrite(node, "w", 5, HOOKS);

  assert.equal(set.value, 5);
  assert.match(set.widget_changed_hook_failed, /is of type "object", not a function/);
  assert.doesNotMatch(
    set.widget_changed_hook_failed,
    /a object/,
    "typeof yields 'object'; 'a object' reads as a panel bug",
  );
});

test("#1519: an onWidgetChanged that is a THROWING ACCESSOR yields no hook and no escape", () => {
  const node = {
    id: 8,
    type: "N",
    widgets: [{ name: "w", type: "number", value: 1 }],
  };
  Object.defineProperty(node, "onWidgetChanged", {
    get() {
      throw new Error("poisoned accessor");
    },
  });

  const set = applyWidgetWrite(node, "w", 5, HOOKS);
  assert.equal(set.value, 5);
  assert.equal(nodeWidgetChangedHook(node), null);
});

test("#1519: a hook that PARTIALLY rebuilt before throwing says so, and reports what it left", () => {
  const node = {
    id: 9,
    type: "N",
    widgets: [{ name: "w", type: "number", value: 1 }],
    inputs: [{ name: "a" }],
    outputs: [],
    onWidgetChanged() {
      this.inputs = [{ name: "a" }, { name: "b" }];
      throw new Error("halfway");
    },
  };

  const set = applyWidgetWrite(node, "w", 5, HOOKS);

  assert.match(set.widget_changed_hook_failed, /PARTIALLY rebuilt/);
  assert.deepEqual(set.widget_changed_slots, { inputs: ["a", "b"], outputs: [] });
});

// ---- what the result reports -----------------------------------------------

test("#1519: rebuilt slots are reported as DATA so the caller can wire without a re-read", () => {
  const { node } = makeSubworkflowNode();

  const set = applyWidgetWrite(node, "workflow", "child.json", HOOKS);

  assert.deepEqual(set.widget_changed_slots, {
    inputs: ["workflow", "reload_each_execution", "swf_in_0", "swf_in_1"],
    outputs: ["out_0"],
  });
  assert.equal(set.widget_changed_hook_failed, undefined);
});

test("#1519: a hook that changed no slots claims NOTHING — an async rebuild is 'not yet', not 'nothing'", () => {
  let fired = 0;
  const node = {
    id: 10,
    type: "N",
    widgets: [{ name: "w", type: "number", value: 1 }],
    inputs: [{ name: "a" }],
    outputs: [{ name: "b" }],
    onWidgetChanged() {
      fired++; // a real pack would kick off a fetch here and return
    },
  };

  const set = applyWidgetWrite(node, "w", 5, HOOKS);

  assert.equal(fired, 1, "the hook still fires — that is the fix");
  assert.equal(set.widget_changed_slots, undefined);
  assert.equal(set.widget_changed_hook_failed, undefined);
});

test("#1519: a node with NO hook replies exactly as it did before — no new fields", () => {
  const node = { id: 11, type: "N", widgets: [{ name: "w", type: "number", value: 1 }] };

  const set = applyWidgetWrite(node, "w", 5, HOOKS);

  assert.equal("widget_changed_slots" in set, false);
  assert.equal("widget_changed_hook_failed" in set, false);
  assert.equal(set.value, 5);
  assert.equal(set.previous, 1);
});

// ---- what the hook is told, vs what the reply reports ----------------------

test("#1519: the hook is handed the VERIFIED value, not the requested one, when a widget normalizes", () => {
  // #805 — a widget declaring min 1 / step 2 snaps 4096 onto its own grid to 4097.
  // Handing a pack a value the widget does not hold is how a rebuild lands on state
  // nothing agrees with, so the hook must see 4097 — the same value the reply reports.
  const seen = [];
  const node = {
    id: 12,
    type: "N",
    widgets: [
      {
        name: "w",
        type: "number",
        value: 1,
        options: { min: 1, step: 2 },
        callback() {
          this.value = 4097; // the widget doing exactly what a numeric widget does
        },
      },
    ],
    onWidgetChanged(name, value) {
      seen.push(value);
    },
  };

  const set = applyWidgetWrite(node, "w", 4096, HOOKS);

  assert.equal(set.normalized, true, "the fixture must actually normalize, or this proves nothing");
  assert.equal(set.requested_value, 4096);
  assert.equal(set.value, 4097);
  assert.deepEqual(seen, [4097], "never the requested 4096, which the widget does not hold");
});

test("#1519: a hook that mutates the widget afterwards cannot rewrite the VERIFIED reply", () => {
  const node = {
    id: 13,
    type: "N",
    widgets: [{ name: "w", type: "number", value: 1 }],
    onWidgetChanged(name, value, prevValue, widget) {
      // A rebuild that re-touches the widget IN PLACE, after the verification that
      // decided this write is done. The reply must state what the verification
      // established — a post-hook read would report a value nothing checked.
      widget.value = 999;
      widget.name = "renamed_by_pack";
    },
  };

  const set = applyWidgetWrite(node, "w", 5, HOOKS);

  assert.equal(node.widgets[0].value, 999, "the hook really did move it");
  assert.equal(set.value, 5, "the reply states the VERIFIED value, not the post-hook read");
  assert.equal(set.widget, "w");
});

// ---- history bracketing ----------------------------------------------------

test("#1519: the hook runs inside its OWN before/afterChange bracket, after the write's", () => {
  const events = [];
  const node = {
    id: 14,
    type: "N",
    widgets: [{ name: "w", type: "number", value: 1 }],
    onWidgetChanged() {
      events.push("hook");
    },
  };

  applyWidgetWrite(node, "w", 5, {
    beforeChange: () => events.push("before"),
    afterChange: () => events.push("after"),
  });

  assert.deepEqual(
    events,
    ["before", "after", "before", "hook", "after"],
    "the write's envelope closes (and verifies) first; the slot changes then join the undo history",
  );
});

test("#1519: a THROWING history hook does not decide the outcome it merely brackets", () => {
  let fired = 0;
  const node = {
    id: 15,
    type: "N",
    widgets: [{ name: "w", type: "number", value: 1 }],
    onWidgetChanged() {
      fired++;
    },
  };

  const set = applyWidgetWrite(node, "w", 5, {
    beforeChange: () => {
      throw new Error("history hook down");
    },
    afterChange: () => {
      throw new Error("history hook down");
    },
  });

  assert.equal(fired, 1);
  assert.equal(set.value, 5);
  assert.equal(set.widget_changed_hook_failed, undefined);
});

// ---- promoted writes: exactly once, on the widget whose callback fired -----

/**
 * The promoted fixture widget-write.test.mjs uses, with a node-level hook on BOTH
 * ends. The promotion is RENAMED (outer `sched_alias` → inner `scheduler`), the
 * parent's authoritative rail is identity-linked from the host input, and there is a
 * decoy parent widget named after the inner source.
 *
 * `instance: true` gives the host input a per-instance `widgetId` keyed to this
 * wrapper, which is what `promotedValueScope` reads to classify the write.
 */
function makePromotedFixture({ instance = false } = {}) {
  const innerCalls = [];
  const outerCalls = [];
  const inner = {
    id: 54,
    type: "KSampler",
    widgets: [
      { name: "seed", type: "INT", value: 959948902156062 },
      { name: "scheduler", type: "combo", options: { values: ["simple", "karras"] }, value: "simple" },
    ],
    onWidgetChanged(...args) {
      innerCalls.push(args);
    },
  };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "54" ? inner : null) };
  const railWidget = { name: "sched_alias", type: "combo", options: { values: ["simple", "karras"] }, value: "simple" };
  const parent = {
    id: 66,
    type: "SubgraphNode",
    subgraph,
    inputs: [
      {
        name: "sched_alias",
        _widget: railWidget,
        widget: { name: "sched_alias" },
        _subgraphSlot: { name: "sched_alias" },
        ...(instance ? { widgetId: "x:66:sched_alias" } : {}),
      },
    ],
    widgets: [
      { name: "scheduler", type: "combo", options: { values: ["simple"] }, value: 999 },
      railWidget,
    ],
    onWidgetChanged(...args) {
      outerCalls.push(args);
    },
  };
  const resolveSource = (_node, subgraphInput) =>
    subgraphInput?.name === "sched_alias" ? { sourceNodeId: "54", sourceWidgetName: "scheduler" } : null;
  return { parent, inner, railWidget, resolveSource, innerCalls, outerCalls };
}

test("#1519: a DEFINITION-SCOPED promoted write announces on the INNER node, exactly once", () => {
  const { parent, inner, resolveSource, innerCalls, outerCalls } = makePromotedFixture();

  const set = applyWidgetWrite(parent, "sched_alias", "karras", { resolveSource });

  assert.equal(set.value, "karras");
  // Exactly one announcement, on the same node/widget pair whose callback this write
  // fires. Announcing the other end too would report a change for a widget that did
  // not move — widget-write.js's own reasoning for firing ONE semantic callback.
  assert.equal(outerCalls.length, 0, "the rail's own value change is a projection, not a second edit");
  assert.deepEqual(innerCalls.length, 1);
  const [name, value, prev, widget] = innerCalls[0];
  assert.equal(name, "scheduler", "the INNER widget's name — the one that was written");
  assert.equal(value, "karras");
  assert.equal(prev, "simple", "that widget's OWN prior value");
  assert.equal(widget, inner.widgets.find((w) => w.name === "scheduler"));
});

test("#1519: an INSTANCE-SCOPED promoted write announces on the WRAPPER, whose rail it wrote", () => {
  const { parent, resolveSource, railWidget, innerCalls, outerCalls } = makePromotedFixture({ instance: true });

  const set = applyWidgetWrite(parent, "sched_alias", "karras", { resolveSource });

  assert.equal(set.promoted_from.value_scope, "instance");
  // The shared subgraph DEFINITION is deliberately left alone on this path, so the
  // inner node has nothing to announce and must not be told otherwise.
  assert.equal(innerCalls.length, 0);
  assert.equal(outerCalls.length, 1);
  const [name, value, prev, widget] = outerCalls[0];
  assert.equal(name, "sched_alias");
  assert.equal(value, "karras");
  assert.equal(prev, "simple");
  assert.equal(widget, railWidget);
});

// ---- the hook EVERY node on a real page carries -----------------------------

/**
 * On a real page this hook is not exotic — the FRONTEND installs one on every node.
 * `installNodeHooksRecursive` (comfyui-frontend-package 1.48.7, GraphView-*.js) runs
 * over every node in the graph on attach and again from `onNodeAdded`, wrapping
 * `onWidgetChanged` to clear widget-related validation errors:
 *
 *     e.onWidgetChanged = Mc(e.onWidgetChanged, function (t, n, r, i) {
 *       if (!Z.rootGraph) return
 *       let a = is(Z.rootGraph, e); if (!a) return
 *       let o = { min: i.options?.min, max: i.options?.max }
 *       let s = wa(Z.rootGraph, e, i)
 *       s?.sourceExecutionId && ia().clearWidgetRelatedErrors(s.sourceExecutionId, …, n, o)
 *       ia().clearWidgetRelatedErrors(a, t, i.name, n, o)
 *     })
 *
 * So this change fires on ordinary writes to ordinary nodes, and the argument shape is
 * load-bearing rather than cosmetic: the wrapper dereferences the FOURTH argument
 * (`i.options`, `i.name`). Handing it `undefined` there would make every panel write on
 * a real page throw and newly report `widget_changed_hook_failed`.
 */
test("#1519: the frontend's OWN installed hook receives what it dereferences — an ordinary write stays clean", () => {
  const cleared = [];
  const node = {
    id: 30,
    type: "KSampler",
    widgets: [{ name: "steps", type: "INT", value: 20, options: { min: 1, max: 100 } }],
    // The wrapper's body, transcribed from the bundle above.
    onWidgetChanged(name, value, prevValue, widget) {
      const bounds = { min: widget.options?.min, max: widget.options?.max };
      cleared.push({ executionId: `node:${this.id}`, name, widgetName: widget.name, value, bounds });
    },
  };

  const set = applyWidgetWrite(node, "steps", 30, HOOKS);

  assert.equal(set.value, 30);
  assert.equal(
    set.widget_changed_hook_failed,
    undefined,
    "an ordinary write on an ordinary node must not newly carry a hook failure",
  );
  assert.equal(set.widget_changed_slots, undefined, "clearing an error moves no slots");
  assert.deepEqual(cleared, [
    { executionId: "node:30", name: "steps", widgetName: "steps", value: 30, bounds: { min: 1, max: 100 } },
  ]);
});

test("#1519: a widget with NO options does not break the wrapper's optional reads", () => {
  const seen = [];
  const node = {
    id: 31,
    type: "N",
    widgets: [{ name: "text", type: "customtext", value: "a" }],
    onWidgetChanged(name, value, prevValue, widget) {
      seen.push({ min: widget.options?.min, widgetName: widget.name });
    },
  };

  const set = applyWidgetWrite(node, "text", "b", HOOKS);

  assert.equal(set.widget_changed_hook_failed, undefined);
  assert.deepEqual(seen, [{ min: undefined, widgetName: "text" }]);
});

test("#1519: a node whose `inputs` is a THROWING accessor still gets its hook fired", () => {
  // The slot snapshot is instrumentation, not a precondition. A node that defines its
  // slots as accessors is exactly the kind of node this route exists for, and letting
  // the BEFORE snapshot abort the route would leave behind the stale slots it fixes —
  // dressed up as a machinery failure.
  let fired = 0;
  const node = {
    id: 32,
    type: "N",
    widgets: [{ name: "w", type: "number", value: 1 }],
    outputs: [],
    onWidgetChanged() {
      fired++;
    },
  };
  Object.defineProperty(node, "inputs", {
    get() {
      throw new Error("slots are computed");
    },
  });

  const set = applyWidgetWrite(node, "w", 5, HOOKS);

  assert.equal(fired, 1, "the hook must fire even when the slots cannot be read");
  assert.equal(set.value, 5);
  assert.equal(set.widget_changed_hook_failed, undefined);
  assert.equal(set.widget_changed_slots, undefined, "an unreadable snapshot claims nothing either way");
});

// ---- the helper's own contract ---------------------------------------------

test("#1519: fireNodeWidgetChanged never throws, whatever it is handed", () => {
  assert.equal(fireNodeWidgetChanged(null, null, {}), null);
  assert.equal(fireNodeWidgetChanged(undefined, undefined), null);
  assert.equal(fireNodeWidgetChanged({}, {}, { name: "w" }), null);

  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const out = fireNodeWidgetChanged({ onWidgetChanged: revoked.proxy }, {}, { name: "w" });
  assert.match(out.failed, /attempting to invoke/);
});
