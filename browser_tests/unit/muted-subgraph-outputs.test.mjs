/**
 * #985 — a whole-graph panel_run executed SaveVideo/SaveText nodes inside nested
 * subgraphs whose wrappers were MUTED. One active source subgraph and two muted;
 * all three rendered. Wan, LTXV and MiniMax H3 loaded in sequence, three videos
 * saved, 18m44s — and the run reported success.
 *
 * MEASURED on ComfyUI 0.31.1 / frontend 1.48.7 (the reporter's exact versions),
 * building a two-level nesting whose innermost subgraph held a PreviewImage and
 * reading `app.graphToPrompt()` — no execution, so the repro costs nothing:
 *
 *   root-level wrapper MUTE(2)   -> nested output EXCLUDED from the prompt   (correct)
 *   nested wrapper     MUTE(2)   -> nested output PRESENT in the prompt      (the bug)
 *   nested wrapper     BYPASS(4) -> nested output PRESENT in the prompt      (same)
 *
 * So ComfyUI applies a wrapper's mode only at the TOP level. A whole-graph run hands
 * prompt construction to ComfyUI, so this is not the panel's prompt to fix — but the
 * silence was the panel's, and that is what these pin.
 *
 * The observed prompt keys are colon paths: the nested PreviewImage was "5:4:3"
 * (root wrapper 5 → nested wrapper 4 → node 3). The fixtures use that shape.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  MODE_MUTE,
  MODE_BYPASS,
  disabledModeName,
  collectDisabledAncestorOutputs,
  disabledOutputsInPrompt,
  disabledOutputsNote,
} from "../../web/js/lib/muted-subgraph-outputs.js";

/** ComfyUI's own output test: node.constructor.nodeData.output_node. */
const IS_OUTPUT = (n) => !!n?.constructor?.nodeData?.output_node;
const outputNode = (id, type) => ({
  id,
  type,
  constructor: { nodeData: { output_node: true } },
});
const plainNode = (id, type) => ({ id, type, constructor: { nodeData: {} } });
const graphOf = (nodes) => ({ _nodes: nodes });
const wrapper = (id, mode, inner) => ({ id, type: "SubgraphNode", mode, subgraph: graphOf(inner) });

/** The measured shape: root wrapper 5 (active) → nested wrapper 4 → PreviewImage 3. */
const nesting = (nestedMode, rootMode = 0) =>
  graphOf([
    plainNode(1, "EmptyLatentImage"),
    plainNode(2, "VAEDecode"),
    wrapper(5, rootMode, [wrapper(4, nestedMode, [outputNode(3, "PreviewImage")])]),
  ]);

test("#985 an output under a MUTED nested wrapper is found, with the exec id ComfyUI keys it by", () => {
  const found = collectDisabledAncestorOutputs(nesting(MODE_MUTE), IS_OUTPUT);
  assert.equal(found.length, 1);
  assert.equal(found[0].exec_id, "5:4:3", "the colon path ComfyUI's flattened prompt uses");
  assert.equal(found[0].type, "PreviewImage");
  assert.equal(found[0].disabled_ancestor, "4", "the NEAREST disabled wrapper — the switch the user flipped");
  assert.equal(found[0].disabled_ancestor_state, "muted");
});

test("#985 BYPASS is reported too — measured as equally ignored at nesting depth", () => {
  const found = collectDisabledAncestorOutputs(nesting(MODE_BYPASS), IS_OUTPUT);
  assert.equal(found.length, 1);
  assert.equal(found[0].disabled_ancestor_state, "bypassed");
});

test("#985 an ACTIVE chain yields nothing — this must not fire on a healthy graph", () => {
  assert.deepEqual(collectDisabledAncestorOutputs(nesting(0), IS_OUTPUT), []);
});

test("#985 only OUTPUT nodes count — a muted subgraph full of ordinary nodes is not a finding", () => {
  const g = graphOf([wrapper(5, 0, [wrapper(4, MODE_MUTE, [plainNode(3, "KSampler"), plainNode(9, "VAEDecode")])])]);
  assert.deepEqual(collectDisabledAncestorOutputs(g, IS_OUTPUT), []);
});

test("#985 the MEASUREMENT decides, not the rule: a correctly-excluded output is not reported", () => {
  // The root-level mute case, which ComfyUI already handles. The collector still
  // finds it structurally — the prompt intersection is what keeps it quiet, so a
  // frontend that fixes nested wrappers silences this with no change here.
  const found = collectDisabledAncestorOutputs(nesting(MODE_MUTE, MODE_MUTE), IS_OUTPUT);
  assert.equal(found.length, 1, "structurally under a disabled ancestor");
  const compiled = { 1: { class_type: "EmptyLatentImage" }, 2: { class_type: "VAEDecode" } };
  assert.deepEqual(disabledOutputsInPrompt(compiled, found), [], "ComfyUI excluded it ⇒ nothing to warn about");
});

test("#985 the reported case: present in the compiled prompt ⇒ reported", () => {
  const found = collectDisabledAncestorOutputs(nesting(MODE_MUTE), IS_OUTPUT);
  const compiled = {
    1: { class_type: "EmptyLatentImage" },
    2: { class_type: "VAEDecode" },
    "5:4:3": { class_type: "PreviewImage" },
  };
  const offenders = disabledOutputsInPrompt(compiled, found);
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].exec_id, "5:4:3");
});

test("#985 the reporter's shape: one active source and two muted, all three queued", () => {
  const g = graphOf([
    wrapper(10, 0, [
      wrapper(11, 0, [outputNode(101, "SaveVideo")]), // source A — active
      wrapper(12, MODE_MUTE, [outputNode(102, "SaveVideo")]), // source B — muted
      wrapper(13, MODE_MUTE, [outputNode(103, "SaveText")]), // source C — muted
    ]),
  ]);
  const found = collectDisabledAncestorOutputs(g, IS_OUTPUT);
  assert.deepEqual(
    found.map((f) => f.exec_id).sort(),
    ["10:12:102", "10:13:103"],
    "only the muted sources — the active one is not a finding",
  );
  const compiled = {
    "10:11:101": { class_type: "SaveVideo" },
    "10:12:102": { class_type: "SaveVideo" },
    "10:13:103": { class_type: "SaveText" },
  };
  assert.equal(disabledOutputsInPrompt(compiled, found).length, 2);
});

test("#985 a disabled wrapper ANY number of levels up still blames the nearest one", () => {
  const g = graphOf([wrapper(5, 0, [wrapper(4, MODE_MUTE, [wrapper(7, 0, [outputNode(3, "SaveImage")])])])]);
  const found = collectDisabledAncestorOutputs(g, IS_OUTPUT);
  assert.equal(found.length, 1);
  assert.equal(found[0].exec_id, "5:4:7:3");
  assert.equal(found[0].disabled_ancestor, "4");
  assert.equal(found[0].disabled_ancestor_depth, 1);
});

test("#985 two disabled ancestors: the NEAREST is named, and the depth counts both", () => {
  const g = graphOf([wrapper(5, MODE_BYPASS, [wrapper(4, MODE_MUTE, [outputNode(3, "SaveImage")])])]);
  const found = collectDisabledAncestorOutputs(g, IS_OUTPUT);
  assert.equal(found[0].disabled_ancestor, "4");
  assert.equal(found[0].disabled_ancestor_state, "muted");
  assert.equal(found[0].disabled_ancestor_depth, 2);
});

test("#985 the collector is total — malformed input yields fewer findings, never a throw", () => {
  for (const bad of [null, undefined, {}, { _nodes: "nope" }, { _nodes: [null, {}, { id: null }] }]) {
    assert.deepEqual(collectDisabledAncestorOutputs(bad, IS_OUTPUT), []);
  }
  assert.deepEqual(collectDisabledAncestorOutputs(nesting(MODE_MUTE), null), [], "no predicate ⇒ no claims");
  // A predicate that throws must not take down the run this is only describing.
  assert.deepEqual(
    collectDisabledAncestorOutputs(nesting(MODE_MUTE), () => {
      throw new Error("boom");
    }),
    [],
  );
});

test("#985 a subgraph CYCLE terminates instead of spinning", () => {
  const inner = graphOf([]);
  const w = { id: 4, mode: MODE_MUTE, subgraph: inner };
  inner._nodes = [w]; // the wrapper contains itself
  const g = graphOf([wrapper(5, 0, [w])]);
  assert.doesNotThrow(() => collectDisabledAncestorOutputs(g, IS_OUTPUT));
});

test("#985 disabledOutputsInPrompt is total and never invents findings", () => {
  assert.deepEqual(disabledOutputsInPrompt(null, [{ exec_id: "1" }]), []);
  assert.deepEqual(disabledOutputsInPrompt({ 1: {} }, null), []);
  assert.deepEqual(disabledOutputsInPrompt({ 1: {} }, [null]), []);
});

test("#985 disabledModeName classifies exactly the two disabled modes", () => {
  assert.equal(disabledModeName(MODE_MUTE), "muted");
  assert.equal(disabledModeName(MODE_BYPASS), "bypassed");
  for (const m of [0, 1, 3, undefined, null, "2"]) assert.equal(disabledModeName(m), null);
});

test("#985 the note leads with the outcome, names the remedy, and never blames the panel's own run", () => {
  const found = collectDisabledAncestorOutputs(nesting(MODE_MUTE), IS_OUTPUT);
  const note = disabledOutputsNote(found);
  assert.match(note, /^WILL RUN ANYWAY/, "the consequence first — this exists to be read in time to interrupt");
  assert.match(note, /5:4:3/, "names the offending output");
  assert.match(note, /to_node_id/, "the workaround the reporter verified");
  assert.match(note, /Interrupt now/, "actionable while it still costs nothing");
  assert.equal(disabledOutputsNote([]), "", "silent when there is nothing to say");
  assert.equal(disabledOutputsNote(null), "");
});

test("#985 the note caps its list but says how many it left out", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({
    exec_id: `10:12:${i}`,
    type: "SaveVideo",
    disabled_ancestor: "12",
    disabled_ancestor_state: "muted",
  }));
  const note = disabledOutputsNote(many);
  assert.match(note, /9 output nodes/);
  assert.match(note, /and 4 more/, "a truncated list must not read as the whole list");
});
