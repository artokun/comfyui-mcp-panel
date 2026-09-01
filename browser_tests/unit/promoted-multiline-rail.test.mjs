/**
 * comfyui-mcp#2709 — the #2148 repair, on a promoted MULTILINE STRING rail.
 *
 * #2148 fixed "a promoted rail that writes through to the shared subgraph
 * definition is REPAIRED, not refused". Its fixture (promoted-value-scope.test.mjs)
 * models the rail frontend `SubgraphNode._projectPromotedWidget` projects: a plain
 * object whose `value` accessor reads and writes `widgetValueStore[widgetId]`.
 *
 * That is NOT the rail a promoted multiline STRING gets. On comfyui-frontend 1.49.6
 * the app-level SubgraphNode OVERRIDES the projection hook:
 *
 *   createPromotedHostWidget(input, widgetId, sourceWidget) {
 *     return createPromotedMultilineWidget({ subgraphNode: this, input, widgetId, sourceWidget })
 *   }
 *
 * and that builds a DOM widget instead:
 *
 *   new DOMWidgetImpl({ node, name, type: "customtext", element: <textarea>, options: {
 *     getValue: () => store.getWidget(widgetId)?.value,
 *     setValue: v => { textarea.value = v; store.setValue(widgetId, v) } } })
 *
 *   class BaseDOMWidgetImpl {
 *     get value() { return this.options.getValue?.() ?? "" }
 *     set value(v) { this.options.setValue?.(v); this.callback?.(this.value) }
 *   }
 *
 * The distinction is load-bearing, not cosmetic. #2148 gates its repair on
 * `strictlyRetained` — the rail's own `.value` — and deliberately NOT on
 * `widgetMatchesExpected`, precisely because the latter also accepts a live
 * customtext widget whose DOM editor holds the value while `.value` does not
 * (#2020). A `customtext` rail is therefore the one shape where the repair could
 * decline to run at all, leaving the write refused. It survives here only because
 * `getValue` reads the per-instance store — a frontend detail that a future
 * frontend release could change without anything else noticing.
 *
 * That is what this file pins. It also pins the direction the repair depends on:
 * nothing on the inner widget reads back into the rail, so restoring the shared
 * definition cannot drag the rail down with it (`bindMultilineTextareaWidget`
 * listens only for the textarea's `input` event, which a programmatic assignment
 * does not fire).
 *
 * Reported against panel 0.15.149 (pre-fix). Verified with a control: on
 * `24c5a884^` the first test below fails with the reporter's message verbatim.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { applyWidgetWrite, WidgetWriteError } from "../../web/js/lib/widget-write.js";

const ROOT_GRAPH_ID = "c4a254bb-935e-4013-b380-5e36954de4b0";

const OLD_PROMPT = "a cat sitting on a windowsill";
// The report wrote "a long string". Length is what a textarea round-trip could
// silently clip, so this is long enough that a clip would show up as a failure.
const NEW_PROMPT = ("a sweeping cinematic establishing shot, " + "volumetric haze, ".repeat(40)).trim();

/**
 * One reusable subgraph whose promoted input is a multiline STRING backed by a
 * PrimitiveStringMultiline — the reporter's LTX-2.5 FLF2V prompt rail.
 *
 * `railWritesDefinition` models the collateral write the report OBSERVED: the
 * shared inner widget moved when the rail was written. The MECHANISM for that is
 * not asserted here (it is a frontend behaviour, and it differs across builds);
 * the observation is what the repair has to survive.
 */
function makeMultilinePromotedSubgraph({ railWritesDefinition = true } = {}) {
  const store = new Map();

  // The SHARED definition's inner widget. On a real canvas PrimitiveStringMultiline's
  // own `value` is a customtext DOM widget too, so it is modelled as one.
  const innerEl = { tagName: "TEXTAREA", value: OLD_PROMPT };
  let innerBacking = OLD_PROMPT;
  const innerWidget = {
    name: "value",
    type: "customtext",
    element: innerEl,
    options: {
      getValue: () => innerBacking,
      setValue: (v) => {
        innerBacking = v;
        innerEl.value = v;
      },
    },
    get value() {
      return this.options.getValue?.() ?? "";
    },
    set value(v) {
      this.options.setValue?.(v);
    },
  };
  const inner = { id: 10, type: "PrimitiveStringMultiline", widgets: [innerWidget] };
  const subgraph = {
    id: "sg-uuid",
    _nodes: [inner],
    getNodeById: (id) => (String(id) === "10" ? inner : null),
  };

  function instance(id) {
    const widgetId = `${ROOT_GRAPH_ID}:${encodeURIComponent(String(id))}:${encodeURIComponent("value")}`;
    if (!store.has(widgetId)) {
      // `_setWidget` → `registerWidget`: a new instance is SEEDED from the inner
      // (definition) widget's value at promotion time.
      store.set(widgetId, { name: "value", type: "customtext", value: innerBacking, options: {} });
    }
    // `createPromotedMultilineWidget` gives the rail its OWN textarea, seeded from
    // the store — never the inner widget's element.
    const railEl = { tagName: "TEXTAREA", value: store.get(widgetId).value };
    const rail = {
      name: "value",
      type: "customtext",
      element: railEl,
      options: {
        getValue: () => {
          const v = store.get(widgetId)?.value;
          return typeof v === "string" ? v : "";
        },
        setValue: (v) => {
          railEl.value = v;
          const st = store.get(widgetId);
          if (st) st.value = v;
          if (railWritesDefinition) innerWidget.value = v;
        },
      },
      get value() {
        return this.options.getValue?.() ?? "";
      },
      set value(v) {
        this.options.setValue?.(v);
      },
    };
    Object.defineProperty(rail, "widgetId", { value: widgetId, enumerable: false, configurable: true });

    const input = {
      name: "value",
      widgetId,
      _widget: rail,
      // Real ComfyUI stores only a NAME STUB here, never a widget object.
      widget: { name: "value" },
      _subgraphSlot: { name: "value" },
    };
    const node = {
      id,
      type: "SubgraphNode",
      subgraph,
      inputs: [input],
      // 1.49.6: `widgets` is a GETTER projecting ONE widget per promoted input, so
      // there is no separate #477 display proxy on this shape.
      get widgets() {
        return [rail];
      },
    };
    return { node, rail, input, widgetId };
  }

  return {
    store,
    instance,
    definition: () => innerBacking,
    // What queue compilation reads for an unlinked promoted input.
    queuedValue: (inst) => store.get(inst.widgetId)?.value,
  };
}

const resolveSource = (_node, subgraphInput) =>
  subgraphInput?.name === "value" ? { sourceNodeId: "10", sourceWidgetName: "value" } : null;

test("#2709: a promoted MULTILINE STRING rail that writes through is repaired, not refused", () => {
  const sg = makeMultilinePromotedSubgraph({ railWritesDefinition: true });
  const target = sg.instance(251);
  const sibling = sg.instance(252);

  let set;
  try {
    set = applyWidgetWrite(target.node, "value", NEW_PROMPT, { resolveSource });
  } catch (err) {
    assert.fail(
      `the write was REFUSED on the reported shape: ${
        err instanceof WidgetWriteError ? err.message : String(err)
      }`,
    );
  }

  // The addressed wrapper took the value, including what QUEUE COMPILATION reads —
  // asserted on the store, never on the rail's textarea, because a value that lives
  // only in the DOM editor is exactly the state #2148 refuses to call a write.
  assert.equal(sg.queuedValue(target), NEW_PROMPT, "the wrapper's own store entry must hold the new prompt");
  assert.equal(target.rail.value, NEW_PROMPT, "the rail must still read the new prompt after the repair");
  // The shared definition was moved by the write-through and put back.
  assert.equal(sg.definition(), OLD_PROMPT, "the shared subgraph definition must be repaired");
  // The sibling wrapper nobody addressed.
  assert.equal(sg.queuedValue(sibling), OLD_PROMPT, "a sibling instance must not inherit the write");
  // An instance created AFTER the write is seeded from the definition, so it is the
  // one that would silently inherit a leaked value.
  const later = sg.instance(253);
  assert.equal(sg.queuedValue(later), OLD_PROMPT, "a new instance must inherit the ORIGINAL definition value");

  assert.equal(set.promoted_from.value_scope, "instance");
  assert.equal(
    set.promoted_from.shared_definition_write_through,
    true,
    "the repair must be reported as DATA, not left for the caller to infer from prose",
  );
  assert.equal(set.node_id, 251, "the value landed on the wrapper, so the reply must name the wrapper");
  assert.equal(set.value, NEW_PROMPT);
});

test("#2709: a multiline rail that does NOT write through claims no repair", () => {
  const sg = makeMultilinePromotedSubgraph({ railWritesDefinition: false });
  const target = sg.instance(251);

  const set = applyWidgetWrite(target.node, "value", NEW_PROMPT, { resolveSource });

  assert.equal(sg.queuedValue(target), NEW_PROMPT);
  assert.equal(sg.definition(), OLD_PROMPT);
  assert.equal(set.promoted_from.value_scope, "instance");
  assert.equal(
    set.promoted_from.shared_definition_write_through,
    undefined,
    "nothing was repaired, so nothing may be claimed",
  );
});

test("#2709: restoring the shared definition does not drag a multiline rail back", () => {
  // The direction the repair depends on. If the rail ever became a VIEW of the inner
  // widget, #2148's `railKeptValue` clause would fail and the write would go back to
  // being refused — with "the rail came back with it", not silently.
  const sg = makeMultilinePromotedSubgraph({ railWritesDefinition: true });
  const target = sg.instance(251);

  applyWidgetWrite(target.node, "value", NEW_PROMPT, { resolveSource });

  assert.equal(sg.definition(), OLD_PROMPT);
  assert.equal(
    target.rail.value,
    NEW_PROMPT,
    "the rail reads its own per-instance store, so a definition restore must not reach it",
  );
  assert.equal(
    target.rail.element.value,
    NEW_PROMPT,
    "and the rail's textarea must still render the value the caller asked for",
  );
});
