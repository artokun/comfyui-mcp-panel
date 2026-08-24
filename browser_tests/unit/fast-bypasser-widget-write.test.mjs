/**
 * #2146 — Fast Groups Bypasser rows are actions whose callbacks can mutate node modes.
 * The generic widget writer must keep the valid write, but a failed verification must restore
 * the group repeater and every linked input mode without snapshotting unrelated graph state.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { applyWidgetWrite, WidgetWriteError } from "../../web/js/lib/widget-write.js";

const BYPASSER = "Fast Groups Bypasser (rgthree)";
const ROW = "RGTHREE_TOGGLE_AND_NAV";
const REPEATER = "Mute / Bypass Repeater (rgthree)";

function makeFixture(callback) {
  const loadAudio1 = { id: 11, type: "LoadAudio", mode: 0 };
  const loadAudio2 = { id: 12, type: "LoadAudio", mode: 2 };
  const repeater = {
    id: 13,
    type: REPEATER,
    mode: 2,
    inputs: [{ link: 101 }, { link: 102 }],
  };
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
  for (const n of nodes.values()) n.graph = graph;

  const group = {
    graph,
    _children: new Set([repeater]),
    recomputeInsideNodes() {},
  };
  const row = {
    name: ROW,
    value: { toggled: false },
    group,
    callback,
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

test("#2146: a failed Fast Bypasser verification restores the repeater and every linked mode", () => {
  const fixture = makeFixture(function (value) {
    // The action callback has already changed all of its reachable modes, but the widget value
    // itself did not retain the request, forcing the generic verification/refusal path.
    this.value = { toggled: false };
    fixture.repeater.mode = value.toggled ? 4 : 0;
    fixture.loadAudio1.mode = value.toggled ? 4 : 0;
    fixture.loadAudio2.mode = value.toggled ? 4 : 0;
  });

  assert.throws(
    () => applyWidgetWrite(fixture.bypasser, ROW, { toggled: true }),
    (error) => error instanceof WidgetWriteError && /did not retain the requested value/.test(error.message),
  );
  assert.equal(fixture.row.value.toggled, false);
  assert.equal(fixture.repeater.mode, 2, "the group repeater mode is restored");
  assert.equal(fixture.loadAudio1.mode, 0, "the first linked LoadAudio mode is restored");
  assert.equal(fixture.loadAudio2.mode, 2, "the second linked LoadAudio mode is restored");
  assert.equal(fixture.unrelated.mode, 0, "unrelated graph state is not part of the journal");
});

test("#2146: a valid Fast Bypasser toggle keeps the action and its linked mode changes", () => {
  const fixture = makeFixture(function (value) {
    fixture.repeater.mode = value.toggled ? 4 : 0;
    fixture.loadAudio1.mode = value.toggled ? 4 : 0;
    fixture.loadAudio2.mode = value.toggled ? 4 : 0;
  });

  const result = applyWidgetWrite(fixture.bypasser, ROW, { toggled: true });

  assert.deepEqual(result.value, { toggled: true });
  assert.deepEqual(fixture.row.value, { toggled: true });
  assert.equal(fixture.repeater.mode, 4);
  assert.equal(fixture.loadAudio1.mode, 4);
  assert.equal(fixture.loadAudio2.mode, 4);
});
