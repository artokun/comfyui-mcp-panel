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
import { readFileSync } from "node:fs";

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
  const found = collectDisabledAncestorOutputs(nesting(MODE_MUTE));
  assert.equal(found.length, 1);
  assert.equal(found[0].exec_id, "5:4:3", "the colon path ComfyUI's flattened prompt uses");
  assert.equal(found[0].type, "PreviewImage");
  assert.equal(found[0].disabled_ancestor, "4", "the NEAREST disabled wrapper — the switch the user flipped");
  assert.equal(found[0].disabled_ancestor_state, "muted");
});

test("#985 BYPASS is reported too — measured as equally ignored at nesting depth", () => {
  const found = collectDisabledAncestorOutputs(nesting(MODE_BYPASS));
  assert.equal(found.length, 1);
  assert.equal(found[0].disabled_ancestor_state, "bypassed");
});

test("#985 an ACTIVE chain yields nothing — this must not fire on a healthy graph", () => {
  assert.deepEqual(collectDisabledAncestorOutputs(nesting(0)), []);
});

test("#985 (codex r2): prompt membership is NOT execution — only OUTPUT nodes are claimed", () => {
  // Presence in the submitted body does not mean a node runs: the backend picks
  // execution ROOTS from output nodes and runs what those depend on. An unconnected
  // KSampler inside a muted wrapper is serialized into the body and never executes,
  // so reporting it as "will run" would be a false claim — this issue's own failure
  // mode, pointed the other way.
  const g = graphOf([
    wrapper(5, 0, [
      wrapper(4, MODE_MUTE, [plainNode(3, "KSampler"), plainNode(9, "VAEDecode"), outputNode(8, "SaveImage")]),
    ]),
  ]);
  const found = collectDisabledAncestorOutputs(g);
  assert.deepEqual(found.map((f) => f.exec_id), ["5:4:8"], "the output node, and only it");
  // Even with every node in the body, the two non-outputs are never reported.
  const body = {
    "5:4:3": { class_type: "KSampler" },
    "5:4:9": { class_type: "VAEDecode" },
    "5:4:8": { class_type: "SaveImage" },
  };
  assert.deepEqual(disabledOutputsInPrompt(body, found).map((o) => o.exec_id), ["5:4:8"]);
});

test("#985 (codex): one subgraph DEFINITION instanced twice is walked per INSTANCE", () => {
  // A global visited set consumed the definition on its first visit, so the muted
  // instance's offenders vanished — a false negative in precisely this incident
  // class (one active source and one muted, sharing a definition). Visited must be
  // path-local, exactly as ComfyUI's own traversal is.
  const shared = graphOf([outputNode(3, "SaveVideo")]);
  const g = graphOf([
    wrapper(9, 0, [
      { id: 10, type: "SubgraphNode", mode: 0, subgraph: shared }, // active instance, visited FIRST
      { id: 11, type: "SubgraphNode", mode: MODE_MUTE, subgraph: shared }, // muted instance
    ]),
  ]);
  const found = collectDisabledAncestorOutputs(g);
  assert.deepEqual(found.map((f) => f.exec_id), ["9:11:3"], "the muted instance is still reported");
});

test("#985 (codex): deep nesting is diagnosed — no arbitrary depth cap silently stops the walk", () => {
  // A cap made the "every output" claim false past its limit while reporting nothing.
  const DEPTH = 40;
  let level = graphOf([outputNode(999, "SaveImage")]);
  const ids = [];
  for (let i = DEPTH; i >= 1; i--) {
    ids.unshift(String(i));
    level = graphOf([{ id: i, type: "SubgraphNode", mode: i === DEPTH ? MODE_MUTE : 0, subgraph: level }]);
  }
  const found = collectDisabledAncestorOutputs(level);
  assert.equal(found.length, 1, "still found past 32 levels");
  assert.equal(found[0].exec_id, [...ids, "999"].join(":"));
});

test("#985 a disabled TOP-LEVEL wrapper is NOT reported — ComfyUI honours that one", () => {
  // Measured: the top-level wrapper’s mode IS applied, and muting a top-level
  // subgraph is the ordinary way to switch a branch off. Warning about it would fire
  // on healthy everyday workflows, which is how a warning gets ignored.
  assert.deepEqual(collectDisabledAncestorOutputs(nesting(0, MODE_MUTE)), []);
  assert.deepEqual(collectDisabledAncestorOutputs(nesting(MODE_MUTE, MODE_MUTE)), [], "even with a nested one too");
  // But the nested-only case — the actual defect — is still reported.
  assert.equal(collectDisabledAncestorOutputs(nesting(MODE_MUTE)).length, 1);
});

test("#985 the reported case: present in the compiled prompt ⇒ reported", () => {
  const found = collectDisabledAncestorOutputs(nesting(MODE_MUTE));
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
  const found = collectDisabledAncestorOutputs(g);
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
  const found = collectDisabledAncestorOutputs(g);
  assert.equal(found.length, 1);
  assert.equal(found[0].exec_id, "5:4:7:3");
  assert.equal(found[0].disabled_ancestor, "4");
  assert.equal(found[0].disabled_ancestor_depth, 1);
});

test("#985 two disabled ancestors: the NEAREST is named, and the depth counts both", () => {
  const g = graphOf([wrapper(9, 0, [wrapper(5, MODE_BYPASS, [wrapper(4, MODE_MUTE, [outputNode(3, "SaveImage")])])])]);
  const found = collectDisabledAncestorOutputs(g);
  assert.equal(found[0].disabled_ancestor, "4");
  assert.equal(found[0].disabled_ancestor_state, "muted");
  assert.equal(found[0].disabled_ancestor_depth, 2);
});

test("#985 the collector is total — malformed input yields fewer findings, never a throw", () => {
  for (const bad of [null, undefined, {}, { _nodes: "nope" }, { _nodes: [null, {}, { id: null }] }]) {
    assert.deepEqual(collectDisabledAncestorOutputs(bad), []);
  }
  // A graph whose `_nodes` getter throws must not take down the run being described.
  const hostile = {
    get _nodes() {
      throw new Error("boom");
    },
  };
  assert.deepEqual(collectDisabledAncestorOutputs(hostile), []);
});

test("#985 a subgraph CYCLE terminates instead of spinning", () => {
  const inner = graphOf([]);
  const w = { id: 4, mode: MODE_MUTE, subgraph: inner };
  inner._nodes = [w]; // the wrapper contains itself
  const g = graphOf([wrapper(5, 0, [w])]);
  assert.doesNotThrow(() => collectDisabledAncestorOutputs(g));
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

test("#985 the note states the trade it makes, and claims nothing about a queued prompt", () => {
  const found = collectDisabledAncestorOutputs(nesting(MODE_MUTE));
  const note = disabledOutputsNote(found);
  assert.match(note, /5:4:3/, "names the offending output");
  assert.match(note, /to_node_id/, "the workaround the reporter verified");
  assert.match(note, /interrupt if this is not what you intended/, "the remedy that still saves GPU time");
  // codex rounds 2-5: this is derived from the GRAPH. It must not describe itself as a
  // fact about the prompt that was queued — no prompt available to an unscoped run can
  // be attributed to that run, and claiming otherwise can describe a FOREIGN workflow.
  assert.match(note, /read from the GRAPH, not from the prompt that was queued/);
  assert.doesNotMatch(note, /ALREADY QUEUED|this run submitted|accepted prompt/i);
  // And it must own the cost of that choice rather than hide it.
  assert.match(note, /warns about a run that was fine/, "states the over-warning it can do");
  assert.match(note, /0.31.1|1.48.7/, "attributes the behaviour to the build measured");
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
  assert.match(note, /9 OUTPUT nodes/);
  assert.match(note, /and 4 more/, "a truncated list must not read as the whole list");
});

test("#985 (codex final): a nested wrapper SHARING the root wrapper's id is still reported", () => {
  // Node ids are graph-LOCAL, so an inner wrapper can legitimately carry the same id
  // as the root-level one. Suppressing the top-level case by comparing bare ids
  // therefore silenced a genuine nested offender — the exact defect this issue is
  // about. Path POSITION is the only unambiguous test.
  const g = graphOf([wrapper(7, 0, [wrapper(7, MODE_MUTE, [outputNode(9, "SaveVideo")])])]);
  const found = collectDisabledAncestorOutputs(g);
  assert.deepEqual(found.map((f) => f.exec_id), ["7:7:9"], "the inner 7 is not the top-level 7");
  assert.equal(found[0].disabled_ancestor_state, "muted");
});

test("#985 (codex final): the top-level suppression still holds when ids collide the other way", () => {
  // Root-level wrapper 7 MUTED, containing an active wrapper also numbered 7. ComfyUI
  // honours the top-level mute, so nothing is reported — the depth test must not be
  // fooled by the matching ids either.
  const g = graphOf([wrapper(7, MODE_MUTE, [wrapper(7, 0, [outputNode(9, "SaveVideo")])])]);
  assert.deepEqual(collectDisabledAncestorOutputs(g), []);
});

test("#985 (codex final): the summary label attributes the behaviour to the MEASURED build", () => {
  // The label is the part most people read. Saying "this ComfyUI build does not exclude
  // them" asserts something about the user's CURRENT build, which a graph walk never
  // inspected — and which is false on a fixed one. Asserted against the shipped source
  // because the summariser lives inside the monolith's switch.
  const panelSrc = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  assert.match(panelSrc, /the measured ComfyUI build did not exclude them/, "past tense, about the measurement");
  assert.ok(
    !/which this ComfyUI build does not exclude/.test(panelSrc),
    "must not claim anything about the build actually running",
  );
  assert.ok(
    !/are execution roots in this workflow/.test(panelSrc),
    "and must not claim roots of the accepted run — the walk cannot establish that",
  );
});
