/**
 * comfyui-mcp#1707 — a promoted-widget write aimed at ONE subgraph instance must
 * not change the shared subgraph DEFINITION, which every sibling instance reads.
 *
 * THE FIXTURE IS BUILT FROM THE REAL FRONTEND SHAPE, not from a convenient
 * approximation. Read off comfyui-frontend 1.48.7 (`SubgraphNode.ts`,
 * `widgetValueStore.ts`, `widgetId.ts`, `ExecutableNodeDTO.ts` — the version the
 * reporter ran) and confirmed against a live 1.48.7 canvas:
 *
 *   * every instance of one reusable subgraph shares ONE `Subgraph` object, so the
 *     inner nodes and their widgets are shared too (`a.subgraph === b.subgraph`
 *     is TRUE for a cloned instance on a live canvas);
 *   * each instance's host input carries `widgetId = "<rootGraphId>:<nodeId>:<name>"`
 *     — the wrapper's OWN node id is in the key;
 *   * the rail widget litegraph projects for that input is a VIEW OF A STORE keyed
 *     by that id: `get value()` reads it, `set value()` writes it, and its
 *     `callback` writes it too (that callback is the only bridge a canvas edit
 *     takes — a canvas edit never touches the inner widget);
 *   * `_setWidget` SEEDS a newly promoted instance's store entry from the INNER
 *     widget's current value, which is how a definition write reaches a wrapper
 *     nobody addressed;
 *   * queue compilation reads `store[input.widgetId].value` for an unlinked
 *     promoted input and never reads the inner widget.
 *
 * A fixture that stored the rail value ON the rail object would pass whatever the
 * code did, because the two stores would be one store. The store below is the point.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { applyWidgetWrite, promotedValueScope, WidgetWriteError } from "../../web/js/lib/widget-write.js";

const ROOT_GRAPH_ID = "c4a254bb-935e-4013-b380-5e36954de4b0";

/**
 * One reusable subgraph definition (an EmptyLatentImage-alike inside), plus a
 * factory for instances of it — the reporter's shape: several wrappers, one
 * definition, a promoted `width`.
 */
function makeReusableSubgraph({
  definitionValue = 512,
  railWritesDefinition = false,
  innerHasCallback = true,
  // comfyui-mcp#2689 — a frontend that hands out a per-instance `widgetId` while its
  // rail READS the shared inner widget as well as writing it. The two directions make
  // the rail and the definition ONE store, so the repair below provably cannot
  // separate them and the write must stay refused.
  railIsInnerView = false,
  // comfyui-mcp#2689 — a #477 parent-facing DISPLAY proxy that READS the shared inner
  // widget. Restoring the definition drags it back to the old value, so a repair that
  // only looked at the rail would report success with a proxy rendering the OLD value.
  displayProxyViewsDefinition = false,
} = {}) {
  const events = { innerCallback: [], railCallback: [], railSets: [] };
  const inner = {
    id: 10,
    type: "EmptyLatentImage",
    widgets: [
      {
        name: "width",
        type: "INT",
        value: definitionValue,
        // #1492: a widget with NO callback has nothing for an instance-scoped write to
        // skip, so it must produce NO disclosure. The fixture has to be able to build
        // that shape, or the "does not over-claim" test below cannot exist at all.
        ...(innerHasCallback
          ? {
              callback(next) {
                events.innerCallback.push(next);
              },
            }
          : {}),
      },
    ],
  };
  const subgraph = {
    id: "sg-uuid",
    _nodes: [inner],
    getNodeById: (id) => (String(id) === "10" ? inner : null),
  };
  // The per-widgetId value store. One store for the whole graph, exactly as the
  // frontend has one — which is what makes a leak observable at all.
  const store = new Map();

  /**
   * A SubgraphNode instance. `promoted: false` models an older frontend that
   * gives the host input no per-instance key at all (the rail is then a live view
   * of the inner widget).
   */
  function instance(id, { instanceKey = true } = {}) {
    const widgetId = instanceKey
      ? `${ROOT_GRAPH_ID}:${encodeURIComponent(String(id))}:${encodeURIComponent("width")}`
      : undefined;
    if (widgetId && !store.has(widgetId)) {
      // `_setWidget` → `registerWidget`: a new instance is SEEDED from the inner
      // (definition) widget's value at promotion time.
      store.set(widgetId, { name: "width", type: "INT", value: inner.widgets[0].value, options: {} });
    }
    const rail = widgetId && railIsInnerView
      ? {
          name: "width",
          type: "INT",
          options: {},
          get value() {
            return inner.widgets[0].value;
          },
          set value(next) {
            events.railSets.push(next);
            inner.widgets[0].value = next;
          },
          callback(next) {
            events.railCallback.push(next);
            inner.widgets[0].value = next;
          },
        }
      : widgetId
      ? {
          get name() {
            return store.get(widgetId)?.name ?? "width";
          },
          get type() {
            return store.get(widgetId)?.type ?? "text";
          },
          get options() {
            return store.get(widgetId)?.options ?? {};
          },
          get value() {
            return store.get(widgetId)?.value;
          },
          set value(next) {
            events.railSets.push(next);
            const state = store.get(widgetId);
            if (state) state.value = next;
            // A frontend whose rail is NOT really instance-scoped, despite handing
            // out an instance key — the case the write must detect rather than
            // assume away.
            if (railWritesDefinition) inner.widgets[0].value = next;
          },
          callback(next) {
            events.railCallback.push(next);
            const state = store.get(widgetId);
            if (state) state.value = next;
          },
        }
      : // Older shape: the rail IS a view of the inner widget, with nowhere else to put a value.
        {
          name: "width",
          type: "INT",
          get value() {
            return inner.widgets[0].value;
          },
          set value(next) {
            inner.widgets[0].value = next;
          },
        };
    if (widgetId) {
      Object.defineProperty(rail, "widgetId", { value: widgetId, enumerable: false, configurable: true });
    }
    // #477: newer ComfyUI can reference a REAL second widget here — the parent-facing
    // display proxy — alongside the serializing rail. It carries no `widgetId`, which is
    // how resolveHostPromotedWidgets tells the two apart.
    const displayProxy = displayProxyViewsDefinition
      ? {
          name: "width",
          type: "INT",
          get value() {
            return inner.widgets[0].value;
          },
          set value(next) {
            inner.widgets[0].value = next;
          },
        }
      : null;
    const input = {
      name: "width",
      widgetId,
      _widget: rail,
      // Real ComfyUI stores only a NAME STUB here, never a widget object.
      widget: displayProxy ?? { name: "width" },
      _subgraphSlot: { name: "width" },
    };
    const node = {
      id,
      type: "SubgraphNode",
      subgraph,
      inputs: [input],
      // `SubgraphNode.widgets` is a GETTER that projects the promoted widgets.
      get widgets() {
        return displayProxy ? [rail, displayProxy] : [rail];
      },
    };
    return { node, rail, input, widgetId, displayProxy };
  }

  // What queue compilation reads for an unlinked promoted input
  // (`ExecutableNodeDTO.resolveInput`).
  const queuedValue = (inst) => store.get(inst.widgetId)?.value;
  const definition = () => inner.widgets[0].value;

  return { inner, subgraph, store, instance, queuedValue, definition, events };
}

const resolveSource = (_node, subgraphInput) =>
  subgraphInput?.name === "width" ? { sourceNodeId: "10", sourceWidgetName: "width" } : null;

// ---------------------------------------------------------------- scope helper

test("#1707 promotedValueScope: an instance-keyed host input is instance-scoped", () => {
  const sg = makeReusableSubgraph();
  const a = sg.instance(293);
  assert.equal(promotedValueScope(a.node, a.input), "instance");
});

test("#1707 promotedValueScope: no key, a key naming ANOTHER node, and a malformed key are all definition-scoped", () => {
  const sg = makeReusableSubgraph();
  const a = sg.instance(293);
  assert.equal(promotedValueScope(a.node, { name: "width" }), "subgraph_definition", "no widgetId at all");
  assert.equal(
    promotedValueScope(a.node, { widgetId: `${ROOT_GRAPH_ID}:279:width` }),
    "subgraph_definition",
    "a key that names a DIFFERENT instance is not proof this write is scoped to THIS one",
  );
  assert.equal(promotedValueScope(a.node, { widgetId: `${ROOT_GRAPH_ID}:293` }), "subgraph_definition", "malformed");
  assert.equal(promotedValueScope(a.node, { widgetId: 42 }), "subgraph_definition", "non-string");
  assert.equal(promotedValueScope(a.node, { widgetId: "" }), "subgraph_definition", "empty");
  assert.equal(
    promotedValueScope(
      a.node,
      Object.defineProperty({}, "widgetId", {
        get() {
          throw new Error("hostile getter");
        },
      }),
    ),
    "subgraph_definition",
    "a throwing getter must not be read as an instance claim",
  );
});

test("#1707 promotedValueScope: an id whose node segment is percent-encoded still matches its own node", () => {
  const sg = makeReusableSubgraph();
  const a = sg.instance("a:b");
  assert.equal(a.widgetId, `${ROOT_GRAPH_ID}:a%3Ab:width`);
  assert.equal(promotedValueScope(a.node, a.input), "instance");
});

// -------------------------------------------------------- the reported defect

test("#1707: a write aimed at ONE instance leaves the shared definition — and every sibling — alone", () => {
  const sg = makeReusableSubgraph({ definitionValue: 512 });
  const target = sg.instance(293);
  const sibling = sg.instance(279);
  // Each wrapper starts on its own value, as the reporter's did (1920x1080 vs 1024x1536).
  target.rail.value = 1920;
  sibling.rail.value = 1536;

  const set = applyWidgetWrite(target.node, "width", 1024, { resolveSource });

  // The addressed wrapper took the value — including what QUEUE COMPILATION reads.
  assert.equal(sg.queuedValue(target), 1024);
  assert.equal(target.rail.value, 1024);
  // The shared definition did NOT move. This is the assertion that fails on
  // origin/main, where the write assigns the inner widget.
  assert.equal(sg.definition(), 512, "the shared subgraph definition must be untouched");
  // The sibling wrapper nobody addressed kept its own value.
  assert.equal(sibling.rail.value, 1536);
  assert.equal(sg.queuedValue(sibling), 1536);

  // An instance created AFTER the write is seeded from the definition, so it is
  // the one that would silently inherit a leaked value (the wrapper "nobody
  // touched" in the report).
  const later = sg.instance(300);
  assert.equal(later.rail.value, 512, "a new instance must inherit the ORIGINAL definition value");

  // And the reply says which store it wrote, naming the wrapper the caller addressed.
  assert.equal(set.promoted_from.value_scope, "instance");
  assert.equal(set.promoted_from.subgraph_node_id, 293);
  assert.equal(set.promoted_from.inner_node_id, 10);
  assert.equal(set.node_id, 293, "the value landed on the wrapper, so the reply must name the wrapper");
  assert.equal(set.widget, "width");
  assert.equal(set.value, 1024);
  assert.equal(set.previous, 1920, "the outer rail's previous value");
  assert.equal(set.inner_previous, 512, "the definition's value, reported and NOT changed");
});

test("#1707: the instance-scoped write fires the RAIL's callback, not the shared inner node's", () => {
  const sg = makeReusableSubgraph();
  const target = sg.instance(293);

  applyWidgetWrite(target.node, "width", 1024, { resolveSource });

  assert.deepEqual(sg.events.railCallback, [1024], "the written widget's own callback runs once");
  assert.deepEqual(
    sg.events.innerCallback,
    [],
    "the shared definition node's callback must not run for an edit made on one instance",
  );
});

test("comfyui-mcp#2689: a rail that writes THROUGH to the definition is REPAIRED, not refused", () => {
  // WAS a refusal (#1707). The rail writes the wrapper's own store entry — the value
  // queue compilation reads — and then ALSO assigns the shared inner widget, which
  // nothing asked it to do and which an on-canvas edit of the promoted control never
  // does. Refusing the whole write made every promoted STRING on the reported frontends
  // permanently unwritable. Undoing the second assignment leaves the first one exactly
  // where it was addressed, and THAT is verified here rather than assumed.
  const sg = makeReusableSubgraph({ definitionValue: 512, railWritesDefinition: true });
  const target = sg.instance(293);
  const sibling = sg.instance(279);
  sibling.rail.value = 1536;
  target.rail.value = 1920;

  const set = applyWidgetWrite(target.node, "width", 1024, { resolveSource });

  // The addressed wrapper took the value, including what queue compilation reads.
  assert.equal(target.rail.value, 1024);
  assert.equal(sg.queuedValue(target), 1024);
  // …and the shared definition is back on its own value, so the claim below is true.
  assert.equal(sg.definition(), 1920, "the shared definition is restored to its captured value");
  assert.equal(sibling.rail.value, 1536, "the sibling nobody addressed is untouched");
  assert.equal(sg.queuedValue(sibling), 1536);
  // An instance created afterwards is seeded from the definition — the wrapper "nobody
  // touched" in the original report. It must not inherit this instance's value.
  assert.equal(sg.instance(300).rail.value, 1920, "a later instance inherits the definition, not this write");

  assert.equal(set.promoted_from.value_scope, "instance");
  assert.equal(set.value, 1024);
  assert.equal(set.node_id, 293);
  // The definition WAS touched and put back. That is disclosed as data, not inferred.
  assert.equal(set.promoted_from.shared_definition_write_through, true);
  assert.match(set.promoted_from.shared_definition_write_through_note, /It was undone/);
  assert.match(set.promoted_from.shared_definition_write_through_note, /node 10/);
});

test("comfyui-mcp#2689: a rail that does NOT write through says nothing about a write-through", () => {
  // The disclosure marks a real event. An unconditional flag would train a caller to
  // ignore the one case where the shared definition was actually assigned.
  const sg = makeReusableSubgraph({ definitionValue: 512 });
  const target = sg.instance(293);

  const set = applyWidgetWrite(target.node, "width", 1024, { resolveSource });

  assert.equal(set.promoted_from.value_scope, "instance");
  assert.equal(
    "shared_definition_write_through" in set.promoted_from,
    false,
    "a rail that never touched the definition must reply exactly as it always did",
  );
  assert.equal(sg.definition(), 512);
});

test("comfyui-mcp#2689: a rail that is genuinely ONE store with the definition is still refused", () => {
  // The fence is not removed, it is made conditional on an OBSERVATION. This frontend
  // hands out a per-instance key — so `promotedValueScope` says "instance" — while its
  // rail both reads and writes the shared inner widget. Restoring the inner widget
  // therefore drags the rail back with it, the repair cannot verify, and reporting
  // `value_scope: "instance"` would be exactly the false claim #1707 exists to stop.
  const sg = makeReusableSubgraph({ definitionValue: 512, railIsInnerView: true });
  const target = sg.instance(293);
  const sibling = sg.instance(279);
  assert.equal(promotedValueScope(target.node, target.input), "instance", "precondition: it claims an instance key");

  let err = null;
  try {
    applyWidgetWrite(target.node, "width", 1024, { resolveSource });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof WidgetWriteError, "a rail that cannot be separated from the definition is refused");
  assert.match(err.message, /ALSO changed the shared subgraph definition/);
  // …and it says WHICH shape this is, so the caller is not told to retry something that
  // will fail identically forever.
  assert.match(err.message, /are one store here/);
  assert.match(err.message, /the rail came back with it/);
  assert.match(err.message, /comfyui-mcp#2689/);

  // The requested value survives nowhere, and the SHARED definition is whole.
  assert.equal(sg.definition(), 512, "the shared definition is back on exactly the value it held");
  assert.equal(target.rail.value, 512);
  assert.equal(sibling.rail.value, 512, "the sibling nobody addressed is untouched");
  // A clean rollback must not be reported as a partial state.
  assert.doesNotMatch(err.message, /did not take effect/);
  assert.doesNotMatch(err.message, /partial state/);
});

test("#2132 × comfyui-mcp#2689: a REPAIRED write that then fails still restores the SHARED definition last", () => {
  // The #2132 shape (panel 0.15.149, frontend 1.51.9): a write-through rail whose own
  // store and the shared inner widget have DIVERGED before the write. That divergence is
  // what makes the rollback ORDER observable — restore the inner first and the rail's own
  // restore forwards its captured value straight back onto the SHARED definition, leaving
  // every sibling instance and every later instance on a value nobody asked for.
  //
  // Under #2689 the collateral definition write is repaired, so this write no longer
  // fails on `definitionMoved`. It is failed here by a promotion DRIFT raised after the
  // repair has already run — which is the case that pins BOTH properties at once: the
  // rollback must still restore the inner widget even though the definition-moved verdict
  // was cleared, and it must do it AFTER the rail.
  const sg = makeReusableSubgraph({ definitionValue: 512, railWritesDefinition: true });
  const sibling = sg.instance(279);
  const target = sg.instance(293);
  target.rail.value = 1920; // forwards to the inner widget, as this rail does
  sg.inner.widgets[0].value = 512; // …and the definition is then edited back, on its own
  assert.equal(sg.definition(), 512, "precondition: rail 1920, shared definition 512");
  assert.equal(target.rail.value, 1920);

  // A rail callback that re-points the host input's serialization binding: the write is
  // applied and repaired, and only the post-write recheck rejects it.
  const railCallback = target.rail.callback.bind(target.rail);
  target.rail.callback = (next) => {
    railCallback(next);
    target.input.widgetId = ROOT_GRAPH_ID + ":999:width";
  };

  let err = null;
  try {
    applyWidgetWrite(target.node, "width", 1024, { resolveSource });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof WidgetWriteError, "a drifted promotion is still refused");
  assert.match(err.message, /CHANGED during the write/);

  // THE PIN. Restore the inner widget after the rail, or the shared definition is left
  // holding 1920 — the rail's value, forwarded onto it by the rail's own rollback.
  assert.equal(sg.definition(), 512, "the shared definition is restored to its own captured value");
  assert.equal(target.rail.value, 1920, "and the rail is restored to its own, independently");
  assert.equal(sg.queuedValue(target), 1920, "including what queue compilation reads");
  assert.equal(sibling.rail.value, 512, "the sibling nobody addressed is untouched");
  assert.doesNotMatch(err.message, /did not take effect/);
  assert.doesNotMatch(err.message, /partial state/);
});

test("comfyui-mcp#2689: the REPORTED shape — a promoted multiline prompt on a CLIPTextEncode", () => {
  // The reproduction from the report, node ids and all: parent SubgraphNode 5646 with
  // inner CLIPTextEncode 5606, the promotion RENAMED (`text_1` outside, `text` inside),
  // and the rail a live custom-text widget whose `options.setValue` writes this wrapper's
  // store entry — and, on this frontend, the shared inner widget as well.
  //
  // Modelled as a DOM-backed rail rather than a plain accessor because that is what the
  // frontend registers for a promoted STRING, and it is why the COMBO reports (#2688)
  // took a different path while every promoted prompt hit this one.
  const store = new Map();
  const widgetId = `${ROOT_GRAPH_ID}:5646:${encodeURIComponent("text_1")}`;
  const inner = {
    id: 5606,
    type: "CLIPTextEncode",
    widgets: [{ name: "text", type: "customtext", value: "OLD PROMPT", options: { multiline: true } }],
  };
  const subgraph = {
    id: "sg-prompt",
    _nodes: [inner],
    getNodeById: (id) => (String(id) === "5606" ? inner : null),
  };
  store.set(widgetId, { name: "text_1", type: "customtext", value: inner.widgets[0].value, options: {} });
  const rail = {
    name: "text_1",
    type: "customtext",
    get value() {
      return store.get(widgetId)?.value;
    },
    set value(next) {
      const state = store.get(widgetId);
      if (state) state.value = next;
    },
    options: {
      getValue: () => store.get(widgetId)?.value,
      setValue: (next) => {
        const state = store.get(widgetId);
        if (state) state.value = next;
        // The write-through this issue is about.
        inner.widgets[0].value = next;
      },
    },
  };
  const input = {
    name: "text_1",
    widgetId,
    _widget: rail,
    widget: { name: "text_1" },
    _subgraphSlot: { name: "text_1" },
  };
  const host = {
    id: 5646,
    type: "SubgraphNode",
    subgraph,
    inputs: [input],
    get widgets() {
      return [rail];
    },
  };
  const resolvePrompt = (_node, subgraphInput) =>
    subgraphInput?.name === "text_1" ? { sourceNodeId: "5606", sourceWidgetName: "text" } : null;

  // This is the call that failed on panel 0.15.149 with "Rolled back rather than report
  // an instance-scoped write that was not one".
  const set = applyWidgetWrite(host, "text_1", "a NEW prompt", { resolveSource: resolvePrompt });

  assert.equal(rail.value, "a NEW prompt", "the promoted control holds the new prompt");
  assert.equal(store.get(widgetId).value, "a NEW prompt", "and so does what queue compilation reads");
  assert.equal(inner.widgets[0].value, "OLD PROMPT", "the shared definition's inner widget is untouched");
  assert.equal(set.promoted_from.value_scope, "instance");
  assert.equal(set.promoted_from.inner_node_id, 5606);
  assert.equal(set.node_id, 5646);
  assert.equal(set.value, "a NEW prompt");
  assert.equal(set.promoted_from.shared_definition_write_through, true);
});

test("comfyui-mcp#2689: a refusal the repair never ATTEMPTED does not claim it was attempted", () => {
  // The repair only runs when the rail RETAINED the requested value exactly, so a rail
  // that snapped it onto its own grid AND writes through to the definition is refused
  // without one. The message must not then describe an attempt nothing made — "restoring
  // the inner widget did not separate the two" would be a claim about a check that never
  // ran, and it points the caller at the wrong remedy.
  const sg = makeReusableSubgraph({ definitionValue: 512, railWritesDefinition: true });
  const target = sg.instance(293);
  const state = sg.store.get(target.widgetId);
  state.options = { min: 1, step: 2 };
  const snap = (v) => (typeof v === "number" ? state.options.min + Math.round((v - state.options.min) / 2) * 2 : v);
  Object.defineProperty(target.rail, "value", {
    get: () => state.value,
    set: (next) => {
      state.value = snap(next);
      sg.inner.widgets[0].value = state.value;
    },
    configurable: true,
  });
  Object.defineProperty(target.rail, "callback", {
    value: (next) => {
      state.value = snap(next);
      sg.inner.widgets[0].value = state.value;
    },
    configurable: true,
  });

  let err = null;
  try {
    applyWidgetWrite(target.node, "width", 4096, { resolveSource });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof WidgetWriteError, "a write-through rail that also normalizes is still refused");
  assert.match(err.message, /ALSO changed the shared subgraph definition/);
  assert.doesNotMatch(
    err.message,
    /did not separate the two/,
    "the repair was skipped, so the message must not report its outcome",
  );
  assert.equal(sg.definition(), 512, "and the shared definition is restored either way");
});

test("comfyui-mcp#2689: an inner widget that will not take the restore is NOT a repaired write", () => {
  // The repair is only worth anything if it is VERIFIED. Here the shared inner widget
  // latches: it takes the rail's write-through and then ignores every later assignment,
  // so the definition stays moved. Claiming `value_scope: "instance"` on the strength of
  // having ATTEMPTED the restore would be the exact false claim #1707 exists to stop —
  // worse than the old refusal, because the leak would now be reported as a success.
  const sg = makeReusableSubgraph({ definitionValue: 512, railWritesDefinition: true });
  const target = sg.instance(293);
  const innerWidget = sg.inner.widgets[0];
  let backing = innerWidget.value;
  let accepted = 0;
  Object.defineProperty(innerWidget, "value", {
    get: () => backing,
    set: (next) => {
      if (accepted === 0) backing = next;
      accepted += 1;
    },
    configurable: true,
  });

  let err = null;
  try {
    applyWidgetWrite(target.node, "width", 1024, { resolveSource });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof WidgetWriteError, "an unverifiable repair must not become a success");
  assert.match(err.message, /ALSO changed the shared subgraph definition/);
  // …and the state it actually left is reported, not a rollback it did not achieve.
  assert.equal(sg.definition(), 1024, "the definition is genuinely still moved");
  assert.match(err.message, /would not take its own value back/, "and the refusal names THAT, not a shared store");
  assert.doesNotMatch(err.message, /are one store here/);
  assert.match(err.message, /did not take effect/, "so the partial state is disclosed, not hidden");
});

test("comfyui-mcp#2689: a repair that leaves a #477 display proxy stale is rejected", () => {
  // The parent-facing display proxy READS the shared inner widget, so restoring the
  // definition drags the outer node's rendered value back to the old one while the
  // serializing rail keeps the new one. Checking only the rail would report success with
  // the wrapper still showing the OLD prompt — #477's stale-outer-widget symptom.
  const sg = makeReusableSubgraph({
    definitionValue: 512,
    railWritesDefinition: true,
    displayProxyViewsDefinition: true,
  });
  const target = sg.instance(293);
  assert.ok(target.displayProxy, "precondition: the promotion exposes a display proxy");

  let err = null;
  try {
    applyWidgetWrite(target.node, "width", 1024, { resolveSource });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof WidgetWriteError, "a repair that cannot keep every projection in sync is refused");
  assert.match(err.message, /ALSO changed the shared subgraph definition/);
  // And it says WHY. The two value stores DID separate here — the rail kept the value and
  // the definition came back — so telling this caller the rail and the definition are one
  // store, and to unpack the subgraph, would send them to rebuild a graph over a stale
  // parent-facing PROJECTION that a reopen rebuilds.
  assert.match(err.message, /parent-facing display widget/);
  assert.match(err.message, /stale PROJECTION, not a shared store/);
  assert.doesNotMatch(err.message, /are one store here/);
  assert.equal(sg.definition(), 512, "and the shared definition is restored");
  assert.equal(target.displayProxy.value, 512, "the outer node is not left rendering the requested value");
});

test("comfyui-mcp#2689: a rail holding the value only in its TEXTAREA is not repaired on that evidence", () => {
  // The repair spends its judgement erasing the only other copy of the value, so it needs
  // the rail's OWN store — the per-widgetId entry queue compilation reads — to hold it.
  // #2020's allowance accepts a live custom-text widget whose DOM editor holds the value
  // while `.value` does not, which is right for judging a write that has already landed
  // and wrong here: restoring the definition would leave the write nowhere durable at all.
  const store = new Map();
  const widgetId = `${ROOT_GRAPH_ID}:5646:text`;
  const inner = {
    id: 5606,
    type: "CLIPTextEncode",
    widgets: [{ name: "text", type: "customtext", value: "OLD PROMPT", options: { multiline: true } }],
  };
  const subgraph = { id: "sg", _nodes: [inner], getNodeById: (id) => (String(id) === "5606" ? inner : null) };
  store.set(widgetId, { value: "OLD PROMPT" });
  const editor = { tagName: "TEXTAREA", value: "OLD PROMPT" };
  const rail = {
    name: "text",
    type: "customtext",
    inputEl: editor,
    get value() {
      return store.get(widgetId).value;
    },
    // The store REFUSES the write — the shape #2020 describes, where the widget's own
    // value accessor has not caught up with the editor.
    set value(_next) {},
    options: {
      getValue: () => store.get(widgetId).value,
      setValue: (next) => {
        // …while the write-through to the SHARED definition happens anyway.
        inner.widgets[0].value = next;
      },
    },
  };
  const input = { name: "text", widgetId, _widget: rail, widget: { name: "text" }, _subgraphSlot: { name: "text" } };
  const host = {
    id: 5646,
    type: "SubgraphNode",
    subgraph,
    inputs: [input],
    get widgets() {
      return [rail];
    },
  };
  const resolve = (_n, si) => (si?.name === "text" ? { sourceNodeId: "5606", sourceWidgetName: "text" } : null);

  let err = null;
  try {
    applyWidgetWrite(host, "text", "a NEW prompt", { resolveSource: resolve });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof WidgetWriteError, "a rail whose own store did not take the value is not repaired");
  // …and the refusal does not claim the two stores are inseparable. They were never
  // TESTED for that: the repair was skipped because the rail's own store is stale, and a
  // message asserting the outcome of a check that did not run sends the caller to unpack
  // a subgraph over what is really a rail that did not take the value.
  assert.doesNotMatch(err.message, /are one store here/);
  assert.equal(store.get(widgetId).value, "OLD PROMPT", "precondition held: the store never took it");
  assert.equal(inner.widgets[0].value, "OLD PROMPT", "and the shared definition is restored");
});

test("comfyui-mcp#2689: the repair is structural — an OBJECT-valued promoted widget repairs too", () => {
  // The repair compares the definition STRUCTURALLY against a pre-write deep clone, so it
  // has to work for a widget whose value is an object and not only for the scalars the
  // rest of these fixtures use.
  const store = new Map();
  const widgetId = `${ROOT_GRAPH_ID}:7:cfg`;
  const inner = { id: 11, type: "Composite", widgets: [{ name: "cfg", type: "OBJECT", value: { steps: 20 } }] };
  const subgraph = { id: "sg", _nodes: [inner], getNodeById: (id) => (String(id) === "11" ? inner : null) };
  store.set(widgetId, { value: { steps: 20 } });
  const rail = {
    name: "cfg",
    type: "OBJECT",
    get value() {
      return store.get(widgetId).value;
    },
    set value(next) {
      store.get(widgetId).value = next;
      inner.widgets[0].value = next; // the write-through
    },
  };
  const input = { name: "cfg", widgetId, _widget: rail, widget: { name: "cfg" }, _subgraphSlot: { name: "cfg" } };
  const host = {
    id: 7,
    type: "SubgraphNode",
    subgraph,
    inputs: [input],
    get widgets() {
      return [rail];
    },
  };
  const resolve = (_n, si) => (si?.name === "cfg" ? { sourceNodeId: "11", sourceWidgetName: "cfg" } : null);

  const set = applyWidgetWrite(host, "cfg", { steps: 40 }, { resolveSource: resolve });

  assert.deepEqual(store.get(widgetId).value, { steps: 40 }, "the wrapper's own store took the object");
  assert.deepEqual(inner.widgets[0].value, { steps: 20 }, "and the shared definition is structurally restored");
  assert.equal(set.promoted_from.value_scope, "instance");
  assert.equal(set.promoted_from.shared_definition_write_through, true);
});

test("comfyui-mcp#2689: a repair is judged on the STORE, not on a textarea the restore did not repaint", () => {
  // The sharp form of the same rule. Here the rail's own store DID take the value, so the
  // repair runs — and restoring the shared inner widget writes back through to that store,
  // which is what the queue compiler reads. The textarea still shows the new prompt, because
  // nothing repainted it. Judged on the editor, the repair looks clean and the write would be
  // reported as an instance-scoped success while the value that executes is the OLD one.
  const store = new Map();
  const widgetId = `${ROOT_GRAPH_ID}:5646:text`;
  const innerWidget = { name: "text", type: "customtext", options: { multiline: true } };
  let innerBacking = "OLD PROMPT";
  const inner = { id: 5606, type: "CLIPTextEncode", widgets: [innerWidget] };
  const subgraph = { id: "sg", _nodes: [inner], getNodeById: (id) => (String(id) === "5606" ? inner : null) };
  store.set(widgetId, { value: "OLD PROMPT" });
  // The definition writes BACK through to the store — the other direction of the same
  // write-through. Only the store side is bidirectional; the editor is not repainted.
  Object.defineProperty(innerWidget, "value", {
    get: () => innerBacking,
    set: (next) => {
      innerBacking = next;
      store.get(widgetId).value = next;
    },
    configurable: true,
  });
  const editor = { tagName: "TEXTAREA", value: "OLD PROMPT" };
  const rail = {
    name: "text",
    type: "customtext",
    inputEl: editor,
    get value() {
      return store.get(widgetId).value;
    },
    set value(next) {
      store.get(widgetId).value = next;
    },
    options: {
      getValue: () => store.get(widgetId).value,
      setValue: (next) => {
        store.get(widgetId).value = next;
        innerBacking = next; // the write-through this issue is about
      },
    },
  };
  const input = { name: "text", widgetId, _widget: rail, widget: { name: "text" }, _subgraphSlot: { name: "text" } };
  const host = {
    id: 5646,
    type: "SubgraphNode",
    subgraph,
    inputs: [input],
    get widgets() {
      return [rail];
    },
  };
  const resolve = (_n, si) => (si?.name === "text" ? { sourceNodeId: "5606", sourceWidgetName: "text" } : null);

  let err = null;
  try {
    applyWidgetWrite(host, "text", "a NEW prompt", { resolveSource: resolve });
  } catch (e) {
    err = e;
  }
  // The trap is not visible in the end state — the rollback repaints the editor too. It is
  // visible in the DECISION: judged on the editor this write is a clean instance-scoped
  // success, and mutating the acceptance clause back to `widgetMatchesExpected` makes this
  // test report exactly that.
  assert.ok(err instanceof WidgetWriteError, "the repair must not be accepted on the editor's word");
  assert.match(err.message, /ALSO changed the shared subgraph definition/);
  assert.equal(store.get(widgetId).value, "OLD PROMPT", "the store queue compilation reads is not left claiming a write");
  assert.equal(editor.value, "OLD PROMPT", "and the rollback repainted the editor too, so nothing renders a value that did not land");
  assert.equal(innerWidget.value, "OLD PROMPT", "and the shared definition is whole");
});

test("comfyui-mcp#2689: an inner widget that locks after the repair's restore cannot produce a success", () => {
  // Raised by the merge gate: if the UNDO of a blocked repair is itself rejected, the
  // re-classification sees the definition sitting on its pre-write value and clears
  // `definitionMoved` — so, the argument went, a rail that kept the requested value could
  // return a clean instance-scoped success over a stale definition or display proxy.
  //
  // It cannot, and this is the shape that was claimed to do it: the inner widget accepts
  // the rail's write-through and accepts the repair's restore, then refuses every later
  // write, so BOTH undo attempts (the captured reference and the post-write clone) fail.
  // Two things stop it. `definitionMoved` is a LIVE structural read against the pre-write
  // clone, so "not moved" and "stale definition" are contradictory by construction; and a
  // display proxy left behind is caught by the #477 branch below it, which does not depend
  // on the repair at all.
  const store = new Map();
  const widgetId = `${ROOT_GRAPH_ID}:293:width`;
  store.set(widgetId, { name: "width", type: "INT", value: 512, options: {} });
  const innerWidget = { name: "width", type: "INT" };
  let backing = 512;
  let sawNew = false;
  let locked = false;
  Object.defineProperty(innerWidget, "value", {
    get: () => backing,
    set: (next) => {
      if (locked) return;
      backing = next;
      if (next === 1024) sawNew = true;
      else if (next === 512 && sawNew) locked = true; // the repair's restore is the last write it takes
    },
    configurable: true,
  });
  const inner = { id: 10, type: "EmptyLatentImage", widgets: [innerWidget] };
  const subgraph = { id: "sg", _nodes: [inner], getNodeById: (id) => (String(id) === "10" ? inner : null) };
  const rail = {
    name: "width",
    type: "INT",
    options: {},
    get value() {
      return store.get(widgetId).value;
    },
    set value(next) {
      store.get(widgetId).value = next;
      innerWidget.value = next; // the write-through
    },
    callback(next) {
      store.get(widgetId).value = next;
    },
  };
  Object.defineProperty(rail, "widgetId", { value: widgetId, enumerable: false, configurable: true });
  const displayProxy = {
    name: "width",
    type: "INT",
    get value() {
      return innerWidget.value;
    },
    set value(next) {
      innerWidget.value = next;
    },
  };
  const input = { name: "width", widgetId, _widget: rail, widget: displayProxy, _subgraphSlot: { name: "width" } };
  const host = {
    id: 293,
    type: "SubgraphNode",
    subgraph,
    inputs: [input],
    get widgets() {
      return [rail, displayProxy];
    },
  };

  let err = null;
  let result = null;
  try {
    result = applyWidgetWrite(host, "width", 1024, { resolveSource });
  } catch (e) {
    err = e;
  }
  assert.equal(result, null, "no success may be reported for this shape");
  assert.ok(err instanceof WidgetWriteError);
  assert.ok(locked, "precondition: the inner widget really did refuse both undo attempts");
  assert.match(err.message, /stale parent-facing widget \(#477\)/);
  // Nothing is left claiming a write: not the definition, not the store, not the proxy.
  assert.equal(innerWidget.value, 512);
  assert.equal(store.get(widgetId).value, 512);
  assert.equal(displayProxy.value, 512);
});

test("comfyui-mcp#2689: the repair mutates the shared definition inside an UNDO bracket", () => {
  // `beforeChange`/`afterChange` are litegraph's `graph.beforeChange`/`afterChange`, and
  // panel_set_widget advertises "Undoable with Ctrl+Z". The repair changes the SHARED
  // subgraph definition, so it has to be a step the history can see: unbracketed, the
  // snapshot taken when the write's own envelope closed still holds the write-through the
  // repair removed, and a redo would put that leak back into every sibling instance.
  const sg = makeReusableSubgraph({ definitionValue: 512, railWritesDefinition: true });
  const target = sg.instance(293);
  const events = [];

  const set = applyWidgetWrite(target.node, "width", 1024, {
    resolveSource,
    beforeChange: () => events.push("before"),
    afterChange: () => events.push("after"),
  });

  assert.equal(set.promoted_from.shared_definition_write_through, true, "precondition: the repair ran");
  // The write's own envelope, then the repair's: every mutation of the definition is
  // inside one, and every bracket is balanced.
  assert.deepEqual(events, ["before", "after", "before", "after"]);
  assert.equal(sg.definition(), 512);
});

test("comfyui-mcp#2689: a repair that is undone brackets the undo too", () => {
  // Otherwise the repair's step is stranded in the history with nothing reversing it.
  const sg = makeReusableSubgraph({ definitionValue: 512, railIsInnerView: true });
  const target = sg.instance(293);
  const events = [];

  assert.throws(() =>
    applyWidgetWrite(target.node, "width", 1024, {
      resolveSource,
      beforeChange: () => events.push("before"),
      afterChange: () => events.push("after"),
    }),
  );

  // write envelope, repair envelope, undo envelope, rollback envelope — four, balanced.
  assert.deepEqual(events, ["before", "after", "before", "after", "before", "after", "before", "after"]);
  assert.equal(sg.definition(), 512);
});

test("#1707: a failed instance-scoped write does not touch the definition on the ROLLBACK either", () => {
  const sg = makeReusableSubgraph({ definitionValue: 512 });
  const target = sg.instance(293);
  // A rail that silently refuses the value: the write must fail verification.
  Object.defineProperty(target.rail, "value", {
    get: () => 1920,
    set: () => {},
    configurable: true,
  });
  let definitionWrites = 0;
  const innerWidget = sg.inner.widgets[0];
  let backing = innerWidget.value;
  Object.defineProperty(innerWidget, "value", {
    get: () => backing,
    set: (next) => {
      definitionWrites += 1;
      backing = next;
    },
    configurable: true,
  });

  assert.throws(
    () => applyWidgetWrite(target.node, "width", 1024, { resolveSource }),
    (err) => err instanceof WidgetWriteError && /did not retain the requested value/.test(err.message),
  );
  assert.equal(definitionWrites, 0, "neither the write nor its rollback may assign the shared definition");
  assert.equal(sg.definition(), 512);
});

test("#1707 × #805: a rail that snaps the value onto its own grid is a NORMALIZED success, read back from the rail", () => {
  // The read-back, the normalization explanation and the reported value all have to
  // come from the widget that was written. Taken from the shared inner widget instead,
  // an instance-scoped write can never look normalized — the inner value did not move
  // at all — and a write that APPLIED is reported as "did not retain the requested
  // value", which is the #805 defect reintroduced through the promoted path.
  const sg = makeReusableSubgraph({ definitionValue: 512 });
  const target = sg.instance(293);
  // The wrapper's own store entry declares the grid, and the rail snaps onto it —
  // the projection's options come from the store, as they do in the frontend.
  const state = sg.store.get(target.widgetId);
  state.options = { min: 1, step: 2 };
  const snap = (v) => (typeof v === "number" ? state.options.min + Math.round((v - state.options.min) / 2) * 2 : v);
  // Both doors into the store quantize — a widget that snapped through one and not
  // the other would not be a snapping widget, it would be an inconsistent fixture.
  Object.defineProperty(target.rail, "value", {
    get: () => state.value,
    set: (next) => {
      state.value = snap(next);
    },
    configurable: true,
  });
  Object.defineProperty(target.rail, "callback", {
    value: (next) => {
      state.value = snap(next);
    },
    configurable: true,
  });

  const set = applyWidgetWrite(target.node, "width", 4096, { resolveSource });

  assert.equal(set.normalized, true);
  assert.equal(set.requested_value, 4096);
  assert.equal(set.value, 4097, "the reply carries the value the RAIL stored");
  assert.equal(sg.queuedValue(target), 4097);
  assert.match(set.normalization_note, /width/);
  assert.equal(sg.definition(), 512, "and the shared definition still did not move");
});

test("#1707 × #805: a definition that happens to hold the requested value does not decide the read-back", () => {
  // The narrow case that separates "read the widget we wrote" from "read whichever
  // widget already agrees": the shared definition is ALREADY 4096, so an early-out
  // taken from the inner widget would conclude "the value stuck" without ever looking
  // at the rail — and then reject the rail's legitimately quantized 4097 as a failure,
  // because nothing computed the normalization that explains it.
  const sg = makeReusableSubgraph({ definitionValue: 4096 });
  const target = sg.instance(293);
  const state = sg.store.get(target.widgetId);
  state.options = { min: 1, step: 2 };
  const snap = (v) => (typeof v === "number" ? state.options.min + Math.round((v - state.options.min) / 2) * 2 : v);
  Object.defineProperty(target.rail, "value", {
    get: () => state.value,
    set: (next) => {
      state.value = snap(next);
    },
    configurable: true,
  });
  Object.defineProperty(target.rail, "callback", {
    value: (next) => {
      state.value = snap(next);
    },
    configurable: true,
  });

  const set = applyWidgetWrite(target.node, "width", 4096, { resolveSource });

  assert.equal(set.normalized, true);
  assert.equal(set.value, 4097);
  assert.equal(sg.queuedValue(target), 4097);
  assert.equal(sg.definition(), 4096, "the definition is untouched — it was never this write's store");
});

// ------------------------------------------- the shape with no per-instance home

test("#1707: a frontend with no per-instance key keeps the old behaviour, and the reply SAYS the definition was written", () => {
  const sg = makeReusableSubgraph({ definitionValue: 512 });
  const legacy = sg.instance(293, { instanceKey: false });

  const set = applyWidgetWrite(legacy.node, "width", 1024, { resolveSource });

  // Unchanged: with no store to write, the value has to live on the definition —
  // refusing here would block every write on such a frontend, including the
  // single-instance case that has nothing to leak into.
  assert.equal(sg.definition(), 1024);
  assert.equal(legacy.rail.value, 1024);
  assert.equal(set.node_id, 10, "the inner node is where the value landed");
  assert.equal(set.promoted_from.value_scope, "subgraph_definition");
  assert.deepEqual(sg.events.innerCallback, [1024], "the inner widget's callback still fires on this path");
});

// -------------------------------------------- #1492: the side effects it did NOT run

/**
 * #1492 — the REPORTED shape, on the same real frontend plumbing as the fixture above
 * (one shared `Subgraph`, one per-`widgetId` value store, a rail projection that is a
 * VIEW of that store) but with the inner widget the reporter actually had: a status
 * switch whose BOOLEAN `enabled` widget does not merely hold a value — its callback
 * flips ANOTHER node between ACTIVE and BYPASS.
 *
 * The ids are the report's own (wrapper 1512, inner switch 2448, switched node 2528),
 * because the whole defect is that a caller reading a clean success went and found
 * 2528 still where it was.
 */
function makeStatusSwitchSubgraph({ innerCallback = "side-effecting" } = {}) {
  // LGraphEventMode: 0 = ALWAYS (active), 4 = BYPASS.
  const ALWAYS = 0;
  const BYPASS = 4;
  const switched = { id: 2528, type: "RTXDetailer", mode: ALWAYS };
  const innerRuns = [];
  const enabled = { name: "enabled", type: "BOOLEAN", value: true, options: {} };
  if (innerCallback === "side-effecting") {
    enabled.callback = (next) => {
      innerRuns.push(next);
      switched.mode = next ? ALWAYS : BYPASS;
    };
  } else if (innerCallback === "throwing-accessor") {
    Object.defineProperty(enabled, "callback", {
      get() {
        throw new Error("hostile callback accessor");
      },
      configurable: true,
    });
  }
  const inner = { id: 2448, type: "DaSiWa_NodeStatusSwitch", widgets: [enabled] };
  const subgraph = {
    id: "sg-switch",
    _nodes: [inner, switched],
    getNodeById: (id) => (String(id) === "2448" ? inner : String(id) === "2528" ? switched : null),
  };
  const store = new Map();

  function instance(id) {
    const widgetId = `${ROOT_GRAPH_ID}:${encodeURIComponent(String(id))}:${encodeURIComponent("enabled")}`;
    if (!store.has(widgetId)) {
      store.set(widgetId, { name: "enabled", type: "BOOLEAN", value: enabled.value, options: {} });
    }
    const rail = {
      get name() {
        return store.get(widgetId)?.name ?? "enabled";
      },
      get type() {
        return store.get(widgetId)?.type ?? "BOOLEAN";
      },
      get options() {
        return store.get(widgetId)?.options ?? {};
      },
      get value() {
        return store.get(widgetId)?.value;
      },
      set value(next) {
        const state = store.get(widgetId);
        if (state) state.value = next;
      },
      callback(next) {
        const state = store.get(widgetId);
        if (state) state.value = next;
      },
    };
    Object.defineProperty(rail, "widgetId", { value: widgetId, enumerable: false, configurable: true });
    const input = {
      name: "enabled",
      widgetId,
      _widget: rail,
      widget: { name: "enabled" },
      _subgraphSlot: { name: "enabled" },
    };
    const node = {
      id,
      type: "SubgraphNode",
      subgraph,
      inputs: [input],
      get widgets() {
        return [rail];
      },
    };
    return { node, rail, input, widgetId };
  }

  return {
    inner,
    enabled,
    switched,
    store,
    instance,
    innerRuns,
    queuedValue: (inst) => store.get(inst.widgetId)?.value,
    definition: () => enabled.value,
  };
}

const resolveSwitchSource = (_node, subgraphInput) =>
  subgraphInput?.name === "enabled" ? { sourceNodeId: "2448", sourceWidgetName: "enabled" } : null;

test("#1492: the reported case — the value lands, the inner switch's callback does NOT, and the reply says so", () => {
  const sg = makeStatusSwitchSubgraph();
  const wrapper = sg.instance(1512);

  const set = applyWidgetWrite(wrapper.node, "enabled", false, { resolveSource: resolveSwitchSource });

  // Unchanged and correct: the value IS in effect where queue compilation reads it,
  // and the shared definition every sibling instance reads did not move.
  assert.equal(sg.queuedValue(wrapper), false);
  assert.equal(sg.definition(), true, "the shared definition is deliberately untouched");
  assert.equal(set.promoted_from.value_scope, "instance");
  assert.equal(set.promoted_from.parent_widget_synced, true);

  // The fact the old reply hid. The switch never ran, so the node it drives is still
  // ACTIVE while the caller — told parent_widget_synced:true — believes it is bypassed.
  assert.deepEqual(sg.innerRuns, [], "the shared definition's callback is not invoked, by design");
  assert.equal(sg.switched.mode, 0, "so the node that callback drives did NOT move");

  // …now disclosed, as DATA plus an actionable note.
  assert.equal(set.promoted_from.inner_callback_not_invoked, true);
  assert.match(set.promoted_from.inner_callback_note, /was not invoked/);
  assert.match(set.promoted_from.inner_callback_note, /2448/, "names the inner node the caller must inspect");
  assert.match(set.promoted_from.inner_callback_note, /DaSiWa_NodeStatusSwitch/);
  assert.match(
    set.promoted_from.inner_callback_note,
    /panel_set_node_mode/,
    "and the remedy the reporter had to find by hand",
  );
  // It must not overstate: the write itself succeeded and is not being called into doubt.
  assert.equal(set.write_warning, undefined, "nothing threw — this is not the #639 disclosure");
});

test("#1492: a shared inner widget with NO callback discloses NOTHING — the field marks a real skip, not the path", () => {
  // The over-claim to avoid. An unconditional flag on every instance-scoped write would
  // fire on the stock EmptyLatentImage case, where nothing whatsoever was skipped — and
  // a disclosure that is always present is one a caller learns to ignore.
  const sg = makeReusableSubgraph({ definitionValue: 512, innerHasCallback: false });
  const target = sg.instance(293);

  const set = applyWidgetWrite(target.node, "width", 1024, { resolveSource });

  assert.equal(set.promoted_from.value_scope, "instance");
  assert.equal(sg.queuedValue(target), 1024);
  assert.equal("inner_callback_not_invoked" in set.promoted_from, false, "nothing skipped ⇒ nothing disclosed");
  assert.equal("inner_callback_note" in set.promoted_from, false);
});

test("#1492: the definition-scoped path DOES invoke the inner callback, so it must never claim otherwise", () => {
  const sg = makeReusableSubgraph({ definitionValue: 512 });
  const legacy = sg.instance(293, { instanceKey: false });

  const set = applyWidgetWrite(legacy.node, "width", 1024, { resolveSource });

  assert.equal(set.promoted_from.value_scope, "subgraph_definition");
  assert.deepEqual(sg.events.innerCallback, [1024], "it ran, so there is nothing to disclose");
  assert.equal("inner_callback_not_invoked" in set.promoted_from, false);
});

test("#1492: a plain non-promoted write is byte-identical — its own callback ran and there is no promotion to describe", () => {
  const runs = [];
  const node = {
    id: 7,
    type: "EmptyLatentImage",
    widgets: [{ name: "width", type: "INT", value: 512, callback: (next) => runs.push(next) }],
  };

  const set = applyWidgetWrite(node, "width", 1024);

  assert.deepEqual(runs, [1024]);
  assert.equal(set.promoted_from, undefined);
  assert.equal(set.inner_callback_not_invoked, undefined);
});

test("#1492: an UNREADABLE inner callback discloses too — only ABSENCE licenses silence", () => {
  // `callback` can be an accessor. A throw while merely CLASSIFYING must not fail a
  // write that is otherwise fine and verified; and it is not evidence that there is no
  // callback, so treating it as absence would restore exactly the silence this fixes.
  const sg = makeStatusSwitchSubgraph({ innerCallback: "throwing-accessor" });
  const wrapper = sg.instance(1512);

  const set = applyWidgetWrite(wrapper.node, "enabled", false, { resolveSource: resolveSwitchSource });

  assert.equal(sg.queuedValue(wrapper), false, "the write still succeeds");
  assert.equal(set.promoted_from.inner_callback_not_invoked, true);
  assert.match(
    set.promoted_from.inner_callback_note,
    /could not even be READ/,
    "and the note reports what was observed rather than claiming a callback exists",
  );
});
