/**
 * #477 P1's rollback read-back vs. a REAL `SubgraphNode`.
 *
 * The guard snapshots the outer node's widget LIST before a promoted write and, on a
 * failed write's rollback, restores it and verifies it came back. It verified by ARRAY
 * IDENTITY — `node.widgets === <the array we snapshotted>`.
 *
 * That holds only for a node that STORES its widget list. A real ComfyUI SubgraphNode
 * does not. Read off the installed comfyui-frontend 1.49.6 (`SubgraphNode`), its
 * constructor installs:
 *
 *   Object.defineProperty(this, "widgets", {
 *     get: () => [
 *       ...this.inputs.flatMap(i => { const w = this._projectPromotedWidget(i); return w ? [w] : [] }),
 *       ...this._extraWidgets,
 *     ],
 *     set: () => {}, configurable: true, enumerable: true });
 *
 * and `_projectPromotedWidget` MEMOISES each proxy onto `input._widget`:
 *
 *   _projectPromotedWidget(input) {
 *     if (input._widget) return input._widget;
 *     ... input._widget = proxy; return input._widget }
 *
 * So the MEMBERS are stable across reads and the containing ARRAY is fresh on every
 * read. Three consequences, all load-bearing here:
 *
 *   * `node.widgets !== prevOuterWidgetsRef` is ALWAYS true — the identity half of the
 *     check could only ever fail;
 *   * assigning the list back is swallowed by the no-op setter, and refilling the array
 *     a read handed out mutates a throwaway — the restore was theatre;
 *   * therefore EVERY failed promoted write on a subgraph node reported
 *     `partialWrite: true` ("the graph may be in a partial state; re-set the widget or
 *     undo") even when the rollback had been perfect — and `partialWrite` is
 *     deliberately non-rewordable by callers (`set-widget.js` `refusalFrame`), so a
 *     clean refusal reached the user as a possibly-corrupt graph.
 *
 * The fix compares MEMBERSHIP/ORDER by value for a projected list and keeps the
 * identity compare for a stored one. These tests pin BOTH directions: the false alarm
 * is gone, and a list that is genuinely replaced, reordered, extended, or whose
 * property changes KIND mid-write is still reported.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { applyWidgetWrite, WidgetWriteError } from "../../web/js/lib/widget-write.js";

const ROOT_GRAPH_ID = "c4a254bb-935e-4013-b380-5e36954de4b0";
const PARTIAL_CLAUSE = /promotion host input \/ parent widget list \(node\.inputs\/widgets\)/;

/**
 * One reusable subgraph definition plus a factory for instances, in the frontend's own
 * shape: a shared inner node, a per-widgetId value store the rail is a VIEW of, and an
 * outer widget list that is either PROJECTED (the real SubgraphNode) or STORED (a plain
 * node, and what #477 P1 was written against).
 *
 * `extras` models `_extraWidgets` — real widgets that ride in the same list without
 * belonging to any promoted input. They give the tests a way to corrupt the LIST
 * without also disturbing `hostInput.widget`/`_widget`, which have their own checks;
 * that keeps each case a probe of one half of the list compare and nothing else.
 */
function makeSubgraph({ definitionValue = 512, widgetsMode = "projected" } = {}) {
  const inner = {
    id: 10,
    type: "EmptyLatentImage",
    widgets: [{ name: "width", type: "INT", value: definitionValue }],
  };
  const subgraph = {
    id: "sg-uuid",
    _nodes: [inner],
    getNodeById: (id) => (String(id) === "10" ? inner : null),
  };
  const store = new Map();

  function instance(id, { extras = [] } = {}) {
    const widgetId = `${ROOT_GRAPH_ID}:${encodeURIComponent(String(id))}:${encodeURIComponent("width")}`;
    if (!store.has(widgetId)) {
      store.set(widgetId, { name: "width", type: "INT", value: inner.widgets[0].value, options: {} });
    }
    const rail = {
      get name() {
        return store.get(widgetId)?.name ?? "width";
      },
      get type() {
        return store.get(widgetId)?.type ?? "INT";
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
    // `_projectPromotedWidget` caches the proxy here, which is why per-member identity
    // stays stable even though the containing array does not.
    const input = {
      name: "width",
      widgetId,
      _widget: rail,
      widget: { name: "width" },
      _subgraphSlot: { name: "width" },
    };
    const extraWidgets = extras.slice();
    const node = { id, type: "SubgraphNode", subgraph, inputs: [input] };
    const project = () => [...node.inputs.flatMap((i) => (i._widget ? [i._widget] : [])), ...extraWidgets];
    if (widgetsMode === "projected") {
      // Verbatim shape of the real constructor: fresh array per read, setter ignored.
      Object.defineProperty(node, "widgets", {
        get: project,
        set: () => {},
        configurable: true,
        enumerable: true,
      });
    } else if (widgetsMode === "accessor") {
      // An ACCESSOR that keeps ONE array. Descriptor-wise this is indistinguishable
      // from the projected shape; behaviourally it is a stored list, and its identity
      // is as meaningful as any data property's.
      let kept = project();
      Object.defineProperty(node, "widgets", {
        get: () => kept,
        set: (next) => {
          kept = next;
        },
        configurable: true,
        enumerable: true,
      });
    } else {
      node.widgets = project();
    }
    return { node, rail, input, widgetId, extraWidgets };
  }

  const queuedValue = (inst) => store.get(inst.widgetId)?.value;
  const definition = () => inner.widgets[0].value;
  return { inner, store, instance, queuedValue, definition };
}

const resolveSource = (_node, subgraphInput) =>
  subgraphInput?.name === "width" ? { sourceNodeId: "10", sourceWidgetName: "width" } : null;

/**
 * A store entry that silently swallows writes, so the write fails its read-back.
 *
 * The refusal is planted on the STORE, not on the rail proxy: in the real frontend the
 * rail's `set value` AND its `callback` both funnel into `store.setValue(widgetId, v)`,
 * so a rail that "does not take the value" is a store that does not take it. Overriding
 * the proxy's accessor instead would leave the callback writing the store behind a
 * getter that lies about it — a fixture that leaks the requested value into the very
 * place queue compilation reads.
 */
function makeStoreRefuse(sg, target) {
  const entry = sg.store.get(target.widgetId);
  const held = entry.value;
  Object.defineProperty(entry, "value", { get: () => held, set: () => {}, configurable: true });
  return held;
}

const extraWidget = (name) => ({ name, type: "INT", value: 1 });

/**
 * Run a failing promoted write, corrupting the outer widget list from an `afterChange`
 * hook on the chosen invocation. The hook fires TWICE: once closing the write envelope,
 * once closing the ROLLBACK envelope. Corrupting on 2 is the case #477 P1 names — a
 * stateful hook that re-adds a replacement AFTER the restore ran — and is the only way
 * to corrupt a STORED list durably, since the restore refills it.
 */
function failingWrite(target, { corrupt, corruptOn = 1 } = {}) {
  let calls = 0;
  return () =>
    applyWidgetWrite(target.node, "width", 1024, {
      resolveSource,
      afterChange() {
        calls += 1;
        if (corrupt && calls === corruptOn) corrupt();
      },
    });
}

// ---------------------------------------------- the false alarm this fixes

test("#477 P1 x subgraph projection: a failed promoted write on a getter-backed `widgets` refuses CLEANLY, not as a partial state", () => {
  const sg = makeSubgraph({ definitionValue: 512 });
  const target = sg.instance(293, { extras: [extraWidget("seed")] });
  // Two reads of the REAL shape are never the same array — the premise of the defect.
  assert.notEqual(target.node.widgets, target.node.widgets);
  assert.equal(target.node.widgets[0], target.node.widgets[0]);

  const before = makeStoreRefuse(sg, target);

  assert.throws(failingWrite(target), (err) => {
    assert.ok(err instanceof WidgetWriteError);
    assert.equal(err.partialWrite, false, `should not claim a partial state:\n${err.message}`);
    assert.doesNotMatch(err.message, PARTIAL_CLAUSE);
    assert.doesNotMatch(err.message, /may be in a partial state/);
    return true;
  });

  // ...and the rollback really WAS perfect, so the clean refusal is the honest report
  // and not a disarmed guard covering for a mess.
  assert.equal(sg.queuedValue(target), before);
  assert.equal(sg.definition(), 512);
  assert.deepEqual(
    target.node.widgets.map((w) => w.name),
    ["width", "seed"],
  );
});

// ---------------------------------------------- the guard still bites

test("#477 P1 x subgraph projection: an EXTRA widget left in the projected list is still a partial state", () => {
  const sg = makeSubgraph({ definitionValue: 512 });
  const target = sg.instance(293, { extras: [extraWidget("seed")] });
  makeStoreRefuse(sg, target);

  assert.throws(
    failingWrite(target, { corrupt: () => target.extraWidgets.push(extraWidget("decoy")) }),
    (err) => err instanceof WidgetWriteError && err.partialWrite === true && PARTIAL_CLAUSE.test(err.message),
  );
});

test("#477 P1 x subgraph projection: a REPLACED member of the projected list is still a partial state", () => {
  const sg = makeSubgraph({ definitionValue: 512 });
  const target = sg.instance(293, { extras: [extraWidget("seed")] });
  makeStoreRefuse(sg, target);

  assert.throws(
    // Same name, same length, same position — a DIFFERENT object. Membership is by
    // identity precisely because that is what authenticates a rail/proxy.
    failingWrite(target, { corrupt: () => (target.extraWidgets[0] = extraWidget("seed")) }),
    (err) => err instanceof WidgetWriteError && err.partialWrite === true && PARTIAL_CLAUSE.test(err.message),
  );
});

test("#477 P1 x subgraph projection: a REORDERED projected list is still a partial state", () => {
  const sg = makeSubgraph({ definitionValue: 512 });
  const target = sg.instance(293, { extras: [extraWidget("seed"), extraWidget("batch_size")] });
  makeStoreRefuse(sg, target);

  assert.throws(
    // Identical membership, different order — only the per-index compare can see this.
    failingWrite(target, { corrupt: () => target.extraWidgets.reverse() }),
    (err) => err instanceof WidgetWriteError && err.partialWrite === true && PARTIAL_CLAUSE.test(err.message),
  );
});

test("#477 P1 x subgraph projection: a DROPPED member of the projected list is still a partial state", () => {
  const sg = makeSubgraph({ definitionValue: 512 });
  const target = sg.instance(293, { extras: [extraWidget("seed")] });
  makeStoreRefuse(sg, target);

  assert.throws(
    // A SHORTER list is the one corruption the per-index compare cannot see on its own
    // — it walks the LIVE list, so a list missing its tail has nothing left to disagree
    // about. The length compare is what catches a detached rail/proxy.
    failingWrite(target, { corrupt: () => target.extraWidgets.pop() }),
    (err) => err instanceof WidgetWriteError && err.partialWrite === true && PARTIAL_CLAUSE.test(err.message),
  );
});

test("#477 P1 x subgraph projection: an UNREADABLE `widgets` is a partial state, and does not swallow the write's own error", () => {
  const sg = makeSubgraph({ definitionValue: 512 });
  const target = sg.instance(293, { extras: [extraWidget("seed")] });
  makeStoreRefuse(sg, target);

  assert.throws(
    failingWrite(target, {
      corrupt: () => {
        Object.defineProperty(target.node, "widgets", {
          get() {
            throw new TypeError("widgets is gone");
          },
          configurable: true,
        });
      },
      corruptOn: 2,
    }),
    // The partial state itself is reported either way (the live-input recheck cannot
    // resolve through a throwing getter either). What the guarded read buys is the
    // `instanceof`: unguarded, the getter's raw TypeError escapes `applyWidgetWrite`
    // and REPLACES the WidgetWriteError that says what failed and what was restored.
    (err) => err instanceof WidgetWriteError && err.partialWrite === true && PARTIAL_CLAUSE.test(err.message),
  );
});

// ---------------------------------------------- a STORED list is unchanged

test("#477 P1: a STORED `widgets` re-pointed after the rollback is still a partial state, on IDENTITY alone", () => {
  const sg = makeSubgraph({ definitionValue: 512, widgetsMode: "stored" });
  const target = sg.instance(293, { extras: [extraWidget("seed")] });
  makeStoreRefuse(sg, target);

  assert.throws(
    failingWrite(target, {
      // A NEW array holding the SAME members in the SAME order: membership/order say
      // nothing, identity is the only witness — and for a stored list it is a real one,
      // because a re-pointed array is what detaches a captured proxy.
      corrupt: () => {
        target.node.widgets = target.node.widgets.slice();
      },
      corruptOn: 2,
    }),
    (err) => err instanceof WidgetWriteError && err.partialWrite === true && PARTIAL_CLAUSE.test(err.message),
  );
});

test("#477 P1: a projected `widgets` FROZEN into a stored array mid-write is itself a partial state", () => {
  const sg = makeSubgraph({ definitionValue: 512 });
  const target = sg.instance(293, { extras: [extraWidget("seed")] });
  makeStoreRefuse(sg, target);

  assert.throws(
    failingWrite(target, {
      // The one direction nothing else sees. Going the other way — a stored array
      // swapped for a getter — is already caught by the identity compare, because the
      // snapshot was of a stored list and a getter can never hand that array back. But
      // a PROJECTION replaced by a plain array of the same members passes membership,
      // passes order, and is exempt from the identity compare by the very relaxation
      // this fix introduces. It is real corruption: the list no longer tracks
      // `node.inputs`, so it is a stale copy that outlives the next promotion change.
      // Only comparing the property's KIND across the write catches it.
      corrupt: () => {
        Object.defineProperty(target.node, "widgets", {
          value: target.node.widgets.slice(),
          writable: true,
          configurable: true,
          enumerable: true,
        });
      },
      corruptOn: 2,
    }),
    (err) => err instanceof WidgetWriteError && err.partialWrite === true && PARTIAL_CLAUSE.test(err.message),
  );
});

test("#477 P1: an ACCESSOR that keeps ONE array is a stored list, and its identity is still enforced", () => {
  const sg = makeSubgraph({ definitionValue: 512, widgetsMode: "accessor" });
  const target = sg.instance(293, { extras: [extraWidget("seed")] });
  makeStoreRefuse(sg, target);
  // Two reads agree — which is the whole difference from the projected shape, and it is
  // not visible in the property descriptor, only in what the property DOES.
  assert.equal(target.node.widgets, target.node.widgets);

  assert.throws(
    failingWrite(target, {
      // Equal membership, equal order, different array. Classifying every accessor as a
      // rebuilt list would exempt this from the identity compare and let a re-pointed
      // list through — so the classifier has to ASK the property, not read its shape.
      corrupt: () => {
        target.node.widgets = target.node.widgets.slice();
      },
      corruptOn: 2,
    }),
    (err) => err instanceof WidgetWriteError && err.partialWrite === true && PARTIAL_CLAUSE.test(err.message),
  );
});
