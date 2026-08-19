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
function makeReusableSubgraph({ definitionValue = 512, railWritesDefinition = false } = {}) {
  const events = { innerCallback: [], railCallback: [], railSets: [] };
  const inner = {
    id: 10,
    type: "EmptyLatentImage",
    widgets: [
      {
        name: "width",
        type: "INT",
        value: definitionValue,
        callback(next) {
          events.innerCallback.push(next);
        },
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
    const rail = widgetId
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
    const input = {
      name: "width",
      widgetId,
      _widget: rail,
      // Real ComfyUI stores only a NAME STUB here, never a widget object.
      widget: { name: "width" },
      _subgraphSlot: { name: "width" },
    };
    const node = {
      id,
      type: "SubgraphNode",
      subgraph,
      inputs: [input],
      // `SubgraphNode.widgets` is a GETTER that projects the promoted widgets.
      get widgets() {
        return [rail];
      },
    };
    return { node, rail, input, widgetId };
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

test("#1707: an instance key does NOT license the claim — a rail that still writes the definition fails closed", () => {
  // The discriminator reads the frontend's own store key. If that key is present but
  // the rail turns out to forward to the inner widget anyway, the write DID reach every
  // sibling, and reporting `value_scope: "instance"` would be false. Refuse instead.
  const sg = makeReusableSubgraph({ definitionValue: 512, railWritesDefinition: true });
  const target = sg.instance(293);
  const sibling = sg.instance(279);
  sibling.rail.value = 1536;
  target.rail.value = 1920;

  assert.throws(
    () => applyWidgetWrite(target.node, "width", 1024, { resolveSource }),
    (err) => err instanceof WidgetWriteError && /ALSO changed the shared subgraph definition/.test(err.message),
  );

  // The REQUESTED value survives nowhere: not on the rail, not in the store queue
  // compilation reads, and not on the definition every sibling reads. (A rail that
  // forwards to the definition cannot have both restored independently — the two are
  // one store — so the refusal is reported as a partial state rather than a clean
  // rollback, which is what it is.)
  assert.notEqual(target.rail.value, 1024);
  assert.notEqual(sg.queuedValue(target), 1024);
  assert.notEqual(sg.definition(), 1024);
  assert.notEqual(sibling.rail.value, 1024);
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
