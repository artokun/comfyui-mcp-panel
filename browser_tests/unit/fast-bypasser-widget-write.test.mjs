/**
 * #2146 — Fast Groups Bypasser rows are valid actions whose real row action can propagate a
 * mode through an rgthree repeater. Failed widget verification must restore every mode touched.
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

function makeFixture({ forceVerificationFailure = false } = {}) {
  const loadAudio1 = { id: 11, type: "LoadAudio" };
  const loadAudio2 = { id: 12, type: "LoadAudio" };
  const repeater = {
    id: 13,
    type: REPEATER,
    inputs: [{ link: 101 }, { link: 102 }],
  };

  defineMode(loadAudio1, 0);
  defineMode(loadAudio2, 2);
  defineMode(repeater, 2, (value) => {
    // This is the repeater's actual mode side effect: changing its mode propagates to each
    // connected input. The group order intentionally puts a linked node before the repeater,
    // which exposes restoration strategies that rely on incidental Set iteration order.
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

  const group = {
    graph,
    _children: new Set([loadAudio1, repeater, loadAudio2]),
    recomputeInsideNodes() {},
  };
  const row = {
    name: ROW,
    value: { toggled: false },
    group,
    // This models the real Fast Groups row action: the writer has already assigned the
    // requested composite value, then the row action applies its group mode change.
    doModeChange(force) {
      const newMode = force ? 4 : 2;
      for (const groupNode of group._children) groupNode.mode = newMode;
      group.rgthree_hasAnyActiveNode = !!force;
      this.value = { toggled: !!force };
    },
    callback(value) {
      this.doModeChange(value.toggled);
      if (forceVerificationFailure) this.value = { toggled: false };
    },
  };
  const unrelated = { id: 99, type: "KSampler", mode: 0 };
  const bypasser = {
    id: 10,
    type: BYPASSER,
    graph,
    widgets: [row],
  };

  return { bypasser, row, repeater, loadAudio1, loadAudio2, unrelated };
}

test("#2146: failed real row action restores propagation regardless of group order", () => {
  const fixture = makeFixture({ forceVerificationFailure: true });
  let failure;

  assert.throws(
    () => applyWidgetWrite(fixture.bypasser, "rgthree_toggle_and_nav.toggled", true),
    (error) => {
      failure = error;
      return error instanceof WidgetWriteError && /did not retain the requested value/.test(error.message);
    },
  );
  assert.equal(failure.partialWrite, false);
  assert.equal(fixture.row.value.toggled, false);
  assert.equal(fixture.repeater.mode, 2, "the repeater mode is restored");
  assert.equal(fixture.loadAudio1.mode, 0, "the first linked mode is restored after repeater propagation");
  assert.equal(fixture.loadAudio2.mode, 2, "the second linked mode is restored after repeater propagation");
  assert.equal(fixture.unrelated.mode, 0, "unrelated graph state is not part of the journal");
});

test("#2146: a valid Fast Bypasser row action keeps the toggle and propagated modes", () => {
  const fixture = makeFixture();

  const result = applyWidgetWrite(fixture.bypasser, ROW, { toggled: true });

  assert.deepEqual(result.value, { toggled: true });
  assert.deepEqual(fixture.row.value, { toggled: true });
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
  const row = {
    name: ROW,
    value: { toggled: false },
    group,
    callback() {
      this.value = { toggled: false };
      relay.mode = 4;
    },
  };
  const bypasser = { id: 20, type: BYPASSER, graph, widgets: [row] };

  assert.throws(
    () => applyWidgetWrite(bypasser, ROW, { toggled: true }),
    (error) => error instanceof WidgetWriteError && /did not retain the requested value/.test(error.message),
  );
  assert.equal(targetModeReads, 0, "a multi-input relay's output is outside the mode journal");
  assert.equal(relayTarget.mode, 0);
  assert.equal(relay.mode, 2);
});
