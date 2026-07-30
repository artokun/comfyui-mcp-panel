/**
 * Unit tests for web/js/lib/paste-report.js — run with `node --test`.
 *
 * Models the REAL bug from #261: copying all 21 nodes of the wan-multitalk pack
 * and pasting into another workflow silently landed only 19 because AudioCrop
 * and AudioSeparation aren't registered node types on the target frontend, so
 * LiteGraph's pasteFromClipboard dropped them with no signal.
 *
 * These drive the SAME functions the graph_copy_nodes / graph_paste_nodes
 * handlers delegate to (recordCopiedNodes on copy → getCopiedSnapshot +
 * diffCopiedVsPasted on paste), against the real serialized node shape
 * ({id, type, ...}) so the diff catches the actual drop mechanism.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeCopiedItems,
  recordCopiedNodes,
  getCopiedSnapshot,
  diffCopiedVsPasted,
  formatDroppedWarning,
} from "../../web/js/lib/paste-report.js";

// A trimmed but realistic slice of the wan-multitalk clipboard: live LiteGraph
// node objects carry many fields; copy only needs {id, type}.
function liveNode(id, type) {
  return { id, type, pos: [0, 0], size: [200, 100], widgets: [], inputs: [], outputs: [] };
}

// summarizeNode()-shaped pasted node (what graph_paste_nodes hands the diff).
function pastedNode(id, type) {
  return { id, type, title: type, pos: [0, 0], size: [200, 100], widgets: {}, inputs: [], outputs: [] };
}

test("normalizeCopiedItems keeps real nodes, drops groups/typeless selection items", () => {
  const items = new Set([
    liveNode(1, "LoadAudio"),
    { id: null, title: "a group" }, // group: no id
    { bounding: [0, 0, 10, 10] }, // group rect: no id/type
    { id: 7 }, // reroute-ish: no string type
    liveNode(2, "AudioCrop"),
  ]);
  assert.deepEqual(normalizeCopiedItems(items), [
    { id: 1, type: "LoadAudio" },
    { id: 2, type: "AudioCrop" },
  ]);
});

test("no drop: every copied type is registered and pasted back", () => {
  const copied = [liveNode(1, "LoadAudio"), liveNode(2, "MultiTalkWav2VecEmbeds")];
  recordCopiedNodes(copied);
  const pasted = [pastedNode(100, "LoadAudio"), pastedNode(101, "MultiTalkWav2VecEmbeds")];
  const { dropped, dropped_count } = diffCopiedVsPasted(getCopiedSnapshot(), pasted);
  assert.equal(dropped_count, 0);
  assert.deepEqual(dropped, []);
});

test("the #261 bug: AudioCrop + AudioSeparation are reported as dropped, not silently lost", () => {
  // 21 copied, only 19 registered on the target → paste lands 19.
  const copied = [
    liveNode(1, "LoadAudio"),
    liveNode(2, "AudioCrop"), // unregistered on target
    liveNode(3, "AudioSeparation"), // unregistered on target
    liveNode(4, "MultiTalkWav2VecEmbeds"),
    liveNode(5, "VHS_VideoCombine"),
  ];
  recordCopiedNodes(copied);

  // pasteFromClipboard skipped the two unknown types (fresh ids on the rest).
  const pasted = [
    pastedNode(200, "LoadAudio"),
    pastedNode(201, "MultiTalkWav2VecEmbeds"),
    pastedNode(202, "VHS_VideoCombine"),
  ];

  const { dropped, dropped_count, dropped_types } = diffCopiedVsPasted(getCopiedSnapshot(), pasted);
  assert.equal(dropped_count, 2);
  assert.deepEqual(dropped_types.sort(), ["AudioCrop", "AudioSeparation"]);
  // Dropped records carry the ORIGINAL source ids so the agent can locate them.
  assert.deepEqual(
    dropped.sort((a, b) => a.id - b.id),
    [
      { id: 2, type: "AudioCrop" },
      { id: 3, type: "AudioSeparation" },
    ],
  );

  const warning = formatDroppedWarning(dropped);
  assert.match(warning, /AudioCrop/);
  assert.match(warning, /AudioSeparation/);
  assert.match(warning, /not registered/);
});

test("multiset semantics: two copies of one dropped type both reported", () => {
  const copied = [liveNode(1, "AudioCrop"), liveNode(2, "AudioCrop"), liveNode(3, "LoadAudio")];
  const pasted = [pastedNode(9, "LoadAudio")];
  const { dropped_count, dropped } = diffCopiedVsPasted(copied, pasted);
  assert.equal(dropped_count, 2);
  assert.deepEqual(dropped, [
    { id: 1, type: "AudioCrop" },
    { id: 2, type: "AudioCrop" },
  ]);
});

test("partial registration: one of two same-type copies pastes, the other is dropped", () => {
  const copied = [liveNode(1, "AudioCrop"), liveNode(2, "AudioCrop")];
  const pasted = [pastedNode(9, "AudioCrop")]; // only one landed
  const { dropped_count, dropped } = diffCopiedVsPasted(copied, pasted);
  assert.equal(dropped_count, 1);
  assert.deepEqual(dropped, [{ id: 2, type: "AudioCrop" }]);
});

test("formatDroppedWarning returns null when nothing was dropped", () => {
  assert.equal(formatDroppedWarning([]), null);
  assert.equal(formatDroppedWarning(null), null);
});

test("empty clipboard snapshot never fabricates drops", () => {
  const { dropped_count } = diffCopiedVsPasted([], [pastedNode(1, "LoadAudio")]);
  assert.equal(dropped_count, 0);
});
