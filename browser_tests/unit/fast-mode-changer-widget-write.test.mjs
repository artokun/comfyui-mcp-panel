/**
 * #2151 — rgthree's NON-group `Fast Bypasser (rgthree)` / `Fast Muter (rgthree)` rows.
 *
 * These are not the `RGTHREE_TOGGLE_AND_NAV` group rows #2146 covers. They are plain `toggle`
 * widgets, one per node wired into the changer's inputs, named `Enable ${linkedNode.title}` —
 * which is why the reporter addressed one as "Enable LC Film Stock (B&W)".
 *
 * Every fixture below is transcribed from the SHIPPED pack file
 * `rgthree-comfy/web/comfyui/base_node_mode_changer.js` (unminified), `setWidget()`:
 *
 *     widget.doModeChange = (forceValue, skipOtherNodeCheck) => {
 *       let newValue = forceValue == null ? linkedNode.mode === this.modeOff : forceValue;
 *       if (skipOtherNodeCheck !== true) { ...toggleRestriction... }
 *       changeModeOfNodes(linkedNode, (newValue ? this.modeOn : this.modeOff));
 *       widget.value = newValue;
 *     };
 *     widget.callback = () => { widget.doModeChange(); };
 *
 * The callback takes NO arguments, so it always lands in the `forceValue == null` branch and
 * derives the new value from THE LINKED NODE'S CURRENT MODE. It is a toggle, not a setter, so
 * the ordinary assign-then-fire-the-callback path inverts the graph whenever the requested
 * value already agrees with the row: the caller asks to DISABLE an effect that is already
 * disabled and the effect is switched back ON, with only the row value rolled back.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { applyWidgetWrite, WidgetWriteError } from "../../web/js/lib/widget-write.js";

const FAST_BYPASSER = "Fast Bypasser (rgthree)";
const FAST_MUTER = "Fast Muter (rgthree)";
const REPEATER = "Mute / Bypass Repeater (rgthree)";

/**
 * A Fast Bypasser / Fast Muter with one row per linked node, wired the way
 * `BaseAnyInputConnectedNode` wires it: one connected input slot per linked node, then a
 * trailing empty "*" slot.
 */
function makeModeChanger({
  type = FAST_BYPASSER,
  modeOff = 4,
  linkedModes = [0],
  titles = ["LC Film Stock (B&W)", "LC Halation", "LC Grain"],
  toggleRestriction = "default",
  linkedTypes = [],
} = {}) {
  const node = {
    id: 143,
    type,
    title: "LC Bypasser",
    modeOn: 0,
    modeOff,
    properties: { toggleRestriction },
    widgets: [],
    inputs: [],
  };
  const nodes = new Map();
  const links = {};
  const graph = { links, getNodeById: (id) => nodes.get(id) ?? null };
  node.graph = graph;

  const linked = linkedModes.map((mode, i) => {
    const ln = { id: 77 + i, type: linkedTypes[i] ?? "LC_Effect", title: titles[i], mode, graph };
    nodes.set(ln.id, ln);
    links[101 + i] = { origin_id: ln.id, target_id: node.id };
    node.inputs.push({ name: ln.title, link: 101 + i });
    return ln;
  });
  node.inputs.push({ name: "", link: null });

  // Counted so a test can prove the toggling callback was NOT the thing that ran.
  let callbackCalls = 0;
  for (const ln of linked) {
    const widget = {
      name: `Enable ${ln.title}`,
      type: "toggle",
      options: { on: "yes", off: "no" },
      value: ln.mode === node.modeOn,
    };
    widget.doModeChange = (forceValue, skipOtherNodeCheck) => {
      let newValue = forceValue == null ? ln.mode === node.modeOff : forceValue;
      if (skipOtherNodeCheck !== true) {
        if (newValue && String(node.properties?.toggleRestriction || "").includes(" one")) {
          for (const w of node.widgets) w.doModeChange(false, true);
        } else if (!newValue && node.properties?.toggleRestriction === "always one") {
          newValue = node.widgets.every((w) => !w.value || w === widget);
        }
      }
      ln.mode = newValue ? node.modeOn : node.modeOff;
      widget.value = newValue;
    };
    widget.callback = () => {
      callbackCalls++;
      widget.doModeChange();
    };
    node.widgets.push(widget);
  }
  return { node, graph, nodes, linked, widgets: node.widgets, callbackCalls: () => callbackCalls };
}

test("#2151: disabling an already-bypassed row does not switch the effect back on", () => {
  // The reported harm. Before the fix this threw "wrote false but it became true" AND left the
  // linked node at mode 0 — the caller is told the write failed while the effect they asked to
  // disable is running, which is what produced the wrong render.
  const fixture = makeModeChanger({ linkedModes: [4] });
  const result = applyWidgetWrite(fixture.node, "Enable LC Film Stock (B&W)", false, {});
  assert.equal(fixture.linked[0].mode, 4, "the effect node stays bypassed");
  assert.equal(fixture.widgets[0].value, false);
  assert.deepEqual(result, {
    node_id: 143,
    widget: "Enable LC Film Stock (B&W)",
    previous: false,
    value: false,
  });
});

test("#2151: enabling an already-enabled row does not silently bypass the effect", () => {
  // The same inversion in the other direction: before the fix, writing `true` to a row whose
  // node was already ALWAYS bypassed that node.
  const fixture = makeModeChanger({ linkedModes: [0] });
  const result = applyWidgetWrite(fixture.node, "Enable LC Film Stock (B&W)", true, {});
  assert.equal(fixture.linked[0].mode, 0, "the effect node stays enabled");
  assert.equal(fixture.widgets[0].value, true);
  assert.equal(result.value, true);
});

test("#2151: the write drives doModeChange(value), never the toggling callback", () => {
  const fixture = makeModeChanger({ linkedModes: [0] });
  applyWidgetWrite(fixture.node, "Enable LC Film Stock (B&W)", false, {});
  assert.equal(fixture.linked[0].mode, 4);
  assert.equal(
    fixture.callbackCalls(),
    0,
    "widget.callback derives its value from the linked node's mode; firing it is the defect",
  );
});

test("#2151: a real disable still bypasses exactly the addressed row's node", () => {
  const fixture = makeModeChanger({ linkedModes: [0, 0, 0] });
  const result = applyWidgetWrite(fixture.node, "Enable LC Halation", false, {});
  assert.deepEqual(
    fixture.linked.map((n) => n.mode),
    [0, 4, 0],
    "siblings are untouched",
  );
  assert.equal(result.previous, true);
  assert.equal(result.value, false);
});

test("#2151: Fast Muter rows use the node's own modeOff (mute), not bypass", () => {
  const fixture = makeModeChanger({ type: FAST_MUTER, modeOff: 2, linkedModes: [2] });
  applyWidgetWrite(fixture.node, "Enable LC Film Stock (B&W)", false, {});
  assert.equal(fixture.linked[0].mode, 2, "an already-muted node stays muted rather than unmuting");

  const enable = makeModeChanger({ type: FAST_MUTER, modeOff: 2, linkedModes: [0] });
  applyWidgetWrite(enable.node, "Enable LC Film Stock (B&W)", false, {});
  assert.equal(enable.linked[0].mode, 2, "disabling mutes with mode 2, never 4");
});

test("#2151: a failed write rolls the linked node's mode back", () => {
  const fixture = makeModeChanger({ linkedModes: [0] });
  let afterChangeCalls = 0;
  let failure;
  assert.throws(
    () =>
      applyWidgetWrite(fixture.node, "Enable LC Film Stock (B&W)", false, {
        // Force the post-action verification to fail after the real row action ran and had
        // already moved the linked node's mode.
        afterChange() {
          if (afterChangeCalls++ === 0) fixture.widgets[0].value = true;
        },
      }),
    (error) => {
      failure = error;
      return error instanceof WidgetWriteError && /did not retain the requested value/.test(error.message);
    },
  );
  assert.equal(failure.partialWrite, false);
  assert.equal(fixture.linked[0].mode, 0, "the mode journal restored the effect node");
  assert.equal(fixture.widgets[0].value, true);
});

test("#2151: the journal follows a repeater's propagation and rolls that back too", () => {
  // A Mute / Bypass Repeater wired into the changer propagates its own mode to its inputs, so
  // the boundary the action can reach is wider than the one linked node.
  const fixture = makeModeChanger({ linkedModes: [0], linkedTypes: [REPEATER] });
  const repeater = fixture.linked[0];
  const downstream = { id: 200, type: "LC_Effect", mode: 0, graph: fixture.graph };
  fixture.nodes.set(downstream.id, downstream);
  fixture.graph.links[300] = { origin_id: downstream.id, target_id: repeater.id };
  repeater.inputs = [{ link: 300 }];
  let current = repeater.mode;
  Object.defineProperty(repeater, "mode", {
    configurable: true,
    enumerable: true,
    get: () => current,
    set(value) {
      current = value;
      downstream.mode = value;
    },
  });

  let afterChangeCalls = 0;
  assert.throws(
    () =>
      applyWidgetWrite(fixture.node, "Enable LC Film Stock (B&W)", false, {
        afterChange() {
          if (afterChangeCalls++ === 0) fixture.widgets[0].value = true;
        },
      }),
    WidgetWriteError,
  );
  assert.equal(repeater.mode, 0, "the repeater is restored");
  assert.equal(downstream.mode, 0, "and so is the node its propagation reached");
});

test("#2151: an unestablishable rollback boundary is refused before any mode moves", () => {
  const fixture = makeModeChanger({ linkedModes: [0] });
  Object.defineProperty(fixture.node, "inputs", {
    configurable: true,
    get() {
      throw new Error("inputs are hostile");
    },
  });
  assert.throws(
    () => applyWidgetWrite(fixture.node, "Enable LC Film Stock (B&W)", false, {}),
    (error) =>
      error instanceof WidgetWriteError && /mode rollback boundary/.test(error.message),
  );
  assert.equal(fixture.linked[0].mode, 0, "nothing was mutated before the refusal");
  assert.equal(fixture.widgets[0].value, true);
});

test("#2151: a row whose linked node cannot be found is refused, not written blind", () => {
  const fixture = makeModeChanger({ linkedModes: [0] });
  fixture.node.inputs = [{ name: "", link: null }];
  assert.throws(
    () => applyWidgetWrite(fixture.node, "Enable LC Film Stock (B&W)", false, {}),
    (error) => error instanceof WidgetWriteError && /no linked node was reachable/.test(error.message),
  );
  assert.equal(fixture.linked[0].mode, 0);
});

test("#2151: a non-row widget on the same node type keeps the ordinary write path", () => {
  const fixture = makeModeChanger({ linkedModes: [0] });
  const plain = { name: "some_other_widget", type: "text", value: "before" };
  fixture.node.widgets.push(plain);
  const result = applyWidgetWrite(fixture.node, "some_other_widget", "after", {});
  assert.equal(plain.value, "after");
  assert.equal(result.value, "after");
  assert.equal(fixture.linked[0].mode, 0, "an unrelated write touches no modes");
});

test("#2151: the toggleRestriction the node itself enforces is reported, not papered over", () => {
  // "always one" makes the node refuse to turn its last enabled row off. The panel must report
  // that as a failed write rather than claim the effect was disabled.
  const fixture = makeModeChanger({ linkedModes: [0, 4], toggleRestriction: "always one" });
  assert.throws(
    () => applyWidgetWrite(fixture.node, "Enable LC Film Stock (B&W)", false, {}),
    (error) =>
      error instanceof WidgetWriteError && /did not retain the requested value/.test(error.message),
  );
  assert.deepEqual(fixture.linked.map((n) => n.mode), [0, 4]);
});
