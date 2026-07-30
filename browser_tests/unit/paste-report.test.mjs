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
  getVerifiedSnapshot,
  parseClipboardNodes,
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
  const fp = "clipboard-A";
  recordCopiedNodes(copied, fp);
  const pasted = [pastedNode(100, "LoadAudio"), pastedNode(101, "MultiTalkWav2VecEmbeds")];
  // Clipboard unchanged since copy → snapshot verified.
  const { dropped, dropped_count } = diffCopiedVsPasted(getVerifiedSnapshot(fp), pasted);
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
  const fp = "clipboard-wan-multitalk";
  recordCopiedNodes(copied, fp);

  // pasteFromClipboard skipped the two unknown types (fresh ids on the rest).
  const pasted = [
    pastedNode(200, "LoadAudio"),
    pastedNode(201, "MultiTalkWav2VecEmbeds"),
    pastedNode(202, "VHS_VideoCombine"),
  ];

  const { dropped, dropped_count, dropped_types } = diffCopiedVsPasted(
    getVerifiedSnapshot(fp),
    pasted,
  );
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

test("genuine drops require an UNREGISTERED type when the registry predicate is supplied", () => {
  // Only LoadAudio/MultiTalk are registered on the target; the two audio nodes
  // are not — so exactly those two are reported as dropped.
  const registered = new Set(["LoadAudio", "MultiTalkWav2VecEmbeds", "VHS_VideoCombine"]);
  const isRegistered = (t) => registered.has(t);
  const copied = [
    liveNode(1, "LoadAudio"),
    liveNode(2, "AudioCrop"),
    liveNode(3, "AudioSeparation"),
    liveNode(4, "MultiTalkWav2VecEmbeds"),
  ];
  const pasted = [pastedNode(9, "LoadAudio"), pastedNode(10, "MultiTalkWav2VecEmbeds")];
  const { dropped_count, dropped_types } = diffCopiedVsPasted(copied, pasted, isRegistered);
  assert.equal(dropped_count, 2);
  assert.deepEqual(dropped_types.sort(), ["AudioCrop", "AudioSeparation"]);
});

test("parseClipboardNodes reads litegraph's serialized clipboard shape", () => {
  // The real litegraph clipboard payload copyToClipboard writes to localStorage.
  const raw = JSON.stringify({
    nodes: [
      { id: 1, type: "LoadAudio", pos: [0, 0] },
      { id: 2, type: "AudioCrop", pos: [10, 0] },
    ],
    links: [],
  });
  assert.deepEqual(parseClipboardNodes(raw), [
    { id: 1, type: "LoadAudio" },
    { id: 2, type: "AudioCrop" },
  ]);
  // Bare array and pre-parsed object shapes also work; junk yields [].
  assert.deepEqual(parseClipboardNodes([{ id: 5, type: "KSampler" }]), [{ id: 5, type: "KSampler" }]);
  assert.deepEqual(parseClipboardNodes("not json"), []);
  assert.deepEqual(parseClipboardNodes(null), []);
});

test("AUTHORITATIVE clipboard: reading the real clipboard makes a native overwrite self-correct", () => {
  // Tool-copied AudioCrop earlier (stale snapshot), but the user then native-
  // copied KSampler. The HANDLER diffs against the PARSED CLIPBOARD (KSampler),
  // not the stale snapshot — so pasting KSampler reports zero drops even though
  // the snapshot's AudioCrop is unregistered. This is the fix's core invariant.
  const registered = new Set(["KSampler"]);
  const isRegistered = (t) => registered.has(t);
  const clipboardNow = parseClipboardNodes(
    JSON.stringify({ nodes: [{ id: 9, type: "KSampler" }] }),
  );
  const pasted = [pastedNode(40, "KSampler")];
  const { dropped_count } = diffCopiedVsPasted(clipboardNow, pasted, isRegistered);
  assert.equal(dropped_count, 0);
});

test("CODEX counterexample: stale UNREGISTERED snapshot + native copy yields ZERO drops via fingerprint guard", () => {
  // Round-3 finding: tool-copy AudioCrop (unregistered), then a native Ctrl+C
  // replaces the clipboard with KSampler, then paste lands KSampler. The
  // clipboard fingerprint at paste ("clipboard-KSampler") differs from the one
  // recorded at copy ("clipboard-AudioCrop"), so getVerifiedSnapshot returns []
  // — the stale AudioCrop can never leak into the drop report.
  recordCopiedNodes([liveNode(1, "AudioCrop")], "clipboard-AudioCrop");
  const verified = getVerifiedSnapshot("clipboard-KSampler"); // clipboard changed
  assert.deepEqual(verified, []);
  const registered = new Set(["KSampler"]);
  const { dropped_count } = diffCopiedVsPasted(verified, [pastedNode(9, "KSampler")], (t) =>
    registered.has(t),
  );
  assert.equal(dropped_count, 0);
});

test("getVerifiedSnapshot only trusts the snapshot when the fingerprint matches and is non-null", () => {
  recordCopiedNodes([liveNode(1, "AudioCrop")], "fp-1");
  // Matching fingerprint → snapshot returned.
  assert.deepEqual(getVerifiedSnapshot("fp-1"), [{ id: 1, type: "AudioCrop" }]);
  // Changed fingerprint → empty.
  assert.deepEqual(getVerifiedSnapshot("fp-2"), []);
  // Null current fingerprint (clipboard unreadable at paste) → empty.
  assert.deepEqual(getVerifiedSnapshot(null), []);
  // Null recorded fingerprint (clipboard unreadable at copy) → never matches.
  recordCopiedNodes([liveNode(2, "AudioCrop")], null);
  assert.deepEqual(getVerifiedSnapshot(null), []);
  assert.deepEqual(getVerifiedSnapshot("anything"), []);
});

test("stale snapshot + native copy of a DIFFERENT selection does NOT fabricate drops", () => {
  // User tool-copied selection A (all registered), then native-copied selection
  // B and pasted B. Snapshot is stale (still A). Because A's leftover types are
  // all REGISTERED, the registry predicate discards them — no false warning.
  const registered = new Set(["KSampler", "VAEDecode", "SaveImage", "CLIPTextEncode"]);
  const isRegistered = (t) => registered.has(t);
  const staleSnapshotA = [liveNode(1, "KSampler"), liveNode(2, "VAEDecode")];
  const pastedB = [pastedNode(50, "SaveImage"), pastedNode(51, "CLIPTextEncode")];
  const { dropped_count } = diffCopiedVsPasted(staleSnapshotA, pastedB, isRegistered);
  assert.equal(dropped_count, 0);
});
