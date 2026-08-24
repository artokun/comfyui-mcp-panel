/**
 * #2146 — Fast Groups Bypasser rows are valid actions whose production-shaped widget exposes
 * toggle()/doModeChange(), not widget.callback. Failed MCP writes must restore every mode touched.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { applyWidgetWrite, WidgetWriteError } from "../../web/js/lib/widget-write.js";

const BYPASSER = "Fast Groups Bypasser (rgthree)";
const ROW = "RGTHREE_TOGGLE_AND_NAV";
const REPEATER = "Mute / Bypass Repeater (rgthree)";
const RELAY = "Mute / Bypass Relay (rgthree)";

function defineMode(node, initial, onChange) {
  let current = initial;
  Object.defineProperty(node, "mode", {
    configurable: true,
    enumerable: true,
    get() {
      return current;
    },
    set(value) {
      current = value;
      onChange?.(value);
    },
  });
}

function makeFixture({
  initialToggled = false,
  initialModes = [4, 4],
  repeaterMode = 4,
  disableModeChange = false,
  rowName = ROW,
} = {}) {
  const loadAudio1 = { id: 11, type: "LoadAudio" };
  const loadAudio2 = { id: 12, type: "LoadAudio" };
  const repeater = {
    id: 13,
    type: REPEATER,
    inputs: [{ link: 101 }, { link: 102 }],
  };

  defineMode(loadAudio1, initialModes[0]);
  defineMode(loadAudio2, initialModes[1]);
  defineMode(repeater, repeaterMode, (value) => {
    // This is the repeater's actual mode side effect: changing its mode propagates to each
    // connected input. The group order intentionally puts a linked node before the repeater.
    loadAudio1.mode = value;
    loadAudio2.mode = value;
  });

  const nodes = new Map([
    [loadAudio1.id, loadAudio1],
    [loadAudio2.id, loadAudio2],
    [repeater.id, repeater],
  ]);
  const graph = {
    links: {
      101: { origin_id: loadAudio1.id },
      102: { origin_id: loadAudio2.id },
    },
    getNodeById(id) {
      return nodes.get(id) ?? null;
    },
  };
  for (const node of nodes.values()) node.graph = graph;

  const bypasser = {
    id: 10,
    type: BYPASSER,
    graph,
    modeOn: 0,
    modeOff: 4,
    properties: {},
    widgets: [],
  };
  const group = {
    graph,
    _children: new Set([loadAudio1, repeater, loadAudio2]),
    recomputeInsideNodes() {},
  };
  const row = {
    name: rowName,
    value: { toggled: initialToggled },
    group,
    node: bypasser,
    // These are the production row action methods: mouse handling calls toggle(), which
    // updates the row value and then invokes doModeChange(). There is intentionally no callback.
    doModeChange() {
      if (disableModeChange) return;
      group.recomputeInsideNodes();
      const hasAnyActiveNodes = [...group._children].some((node) => node.mode === 0);
      const newValue = !hasAnyActiveNodes;
      for (const groupNode of group._children) {
        groupNode.mode = newValue ? this.node.modeOn : this.node.modeOff;
      }
      group.rgthree_hasAnyActiveNode = newValue;
      this.value.toggled = newValue;
    },
    toggle(value) {
      value = value == null ? !this.value.toggled : value;
      if (value !== this.value.toggled) {
        this.value.toggled = value;
        this.doModeChange();
      }
    },
  };
  bypasser.widgets.push(row);

  const unrelated = { id: 99, type: "KSampler", mode: 0 };
  return { bypasser, row, repeater, loadAudio1, loadAudio2, unrelated };
}

test("#2146: a no-callback row action rolls back propagation regardless of group order", () => {
  const fixture = makeFixture({ initialToggled: true, initialModes: [0, 2], repeaterMode: 0 });
  fixture.row.value.label = "production-row";
  let afterChangeCalls = 0;
  let failure;

  assert.equal(fixture.row.callback, undefined);
  assert.throws(
    () =>
      applyWidgetWrite(fixture.bypasser, "rgthree_toggle_and_nav.toggled", false, {
        // Force the normal post-action verification failure after the real row action ran.
        afterChange() {
          if (afterChangeCalls++ === 0) fixture.row.value = { toggled: true };
        },
      }),
    (error) => {
      failure = error;
      return error instanceof WidgetWriteError && /did not retain the requested value/.test(error.message);
    },
  );
  assert.equal(failure.partialWrite, false);
  assert.deepEqual(fixture.row.value, { toggled: true, label: "production-row" });
  assert.equal(fixture.repeater.mode, 0, "the repeater mode is restored");
  assert.equal(fixture.loadAudio1.mode, 0, "the first linked mode is restored after propagation");
  assert.equal(fixture.loadAudio2.mode, 2, "the second linked mode is restored after propagation");
  assert.equal(fixture.unrelated.mode, 0, "unrelated graph state is not part of the journal");
});

test("#2146: a no-callback row action performs a valid toggle and propagates its mode", () => {
  const fixture = makeFixture();

  const result = applyWidgetWrite(fixture.bypasser, ROW, { toggled: true });

  assert.equal(fixture.row.callback, undefined);
  assert.deepEqual(result.value, { toggled: true });
  assert.deepEqual(fixture.row.value, { toggled: true });
  assert.equal(fixture.repeater.mode, 0);
  assert.equal(fixture.loadAudio1.mode, 0);
  assert.equal(fixture.loadAudio2.mode, 0);
});

test("#2146: a case-insensitive row lookup still journals the canonical action", () => {
  const fixture = makeFixture({ initialToggled: true, initialModes: [0, 2], repeaterMode: 0, rowName: ROW.toLowerCase() });

  assert.throws(
    () =>
      applyWidgetWrite(fixture.bypasser, ROW.toUpperCase() + ".toggled", false, {
        afterChange() {
          fixture.row.value = { toggled: true };
        },
      }),
    (error) => error instanceof WidgetWriteError && /did not retain the requested value/.test(error.message),
  );
  assert.equal(fixture.repeater.mode, 0);
  assert.equal(fixture.loadAudio1.mode, 0);
  assert.equal(fixture.loadAudio2.mode, 2);
});

test("#2146: a no-op canonical action cannot report a toggle without a mode change", () => {
  const fixture = makeFixture({ disableModeChange: true });
  let failure;

  assert.throws(
    () => applyWidgetWrite(fixture.bypasser, ROW, { toggled: true }),
    (error) => {
      failure = error;
      return error instanceof WidgetWriteError && /did not change any linked node modes/.test(error.message);
    },
  );
  assert.equal(failure.partialWrite, false);
  assert.deepEqual(fixture.row.value, { toggled: false });
  assert.equal(fixture.repeater.mode, 4);
  assert.equal(fixture.loadAudio1.mode, 4);
  assert.equal(fixture.loadAudio2.mode, 4);
});

test("#2146: a multi-input relay is not treated as an input-less dispatcher", () => {
  const relayTarget = { id: 21, type: "LoadAudio" };
  let targetModeReads = 0;
  defineMode(relayTarget, 0);
  const relay = {
    id: 22,
    type: RELAY,
    mode: 2,
    inputs: [{ link: null }, { link: null }],
    outputs: [{ links: [201] }],
    isInputConnected(index) {
      return this.inputs[index]?.link != null;
    },
    isAnyOutputConnected() {
      return true;
    },
  };
  const originalTargetMode = Object.getOwnPropertyDescriptor(relayTarget, "mode");
  Object.defineProperty(relayTarget, "mode", {
    configurable: true,
    enumerable: true,
    get() {
      targetModeReads++;
      return originalTargetMode.get();
    },
    set(value) {
      originalTargetMode.set(value);
    },
  });
  const nodes = new Map([
    [relay.id, relay],
    [relayTarget.id, relayTarget],
  ]);
  const graph = {
    links: { 201: { target_id: relayTarget.id } },
    getNodeById(id) {
      return nodes.get(id) ?? null;
    },
  };
  relay.graph = graph;
  relayTarget.graph = graph;
  const group = { graph, _children: new Set([relay]), recomputeInsideNodes() {} };
  const bypasser = {
    id: 20,
    type: BYPASSER,
    graph,
    widgets: [],
  };
  const row = {
    name: ROW,
    value: { toggled: false },
    group,
    doModeChange() {
      relay.mode = 4;
    },
    toggle(value) {
      this.value = { toggled: value };
      this.doModeChange();
    },
  };
  bypasser.widgets.push(row);

  assert.throws(
    () =>
      applyWidgetWrite(bypasser, ROW, { toggled: true }, {
        afterChange() {
          row.value = { toggled: false };
        },
      }),
    (error) => error instanceof WidgetWriteError && /did not retain the requested value/.test(error.message),
  );
  assert.equal(targetModeReads, 0, "a multi-input relay's output is outside the mode journal");
  assert.equal(relayTarget.mode, 0);
  assert.equal(relay.mode, 2);
});
