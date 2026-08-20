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
function makeReusableSubgraph({ definitionValue = 512, railWritesDefinition = false, innerHasCallback = true } = {}) {
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
