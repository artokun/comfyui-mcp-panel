import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  classifyNodeDifference,
  describeGraphStateDifference,
  describeOpenRebindOutcome,
  resolveOpenRebindVerdict,
  OPEN_REBIND_STATUS,
} from "../../web/js/lib/graph-binding.js";
import {
  activeWorkflowFenceApplies,
  commandIsCanvasTargetless,
  commandTargetsActiveWorkflow,
} from "../../web/js/lib/workflow-chat-identity.js";

// #825 ask 3 — "the graph on the canvas differs from what was loaded on: nodes"
// was emitted identically for a node that VANISHED and for a node whose box the
// ComfyUI frontend re-measured on load. A reporter read it after a perfectly good
// open and was pushed toward redoing work that was never lost.
//
// The verdict is deliberately NOT softened (see resolveOpenRebindVerdict): these
// pin that the DISCLOSURE now separates the two, and that it still refuses to
// reassure when the node set actually changed.

const node = (id, type, extra = {}) => ({ id, type, pos: [0, 0], size: [100, 50], ...extra });
const rootOf = (nodes, rest = {}) => ({ serialize: () => ({ nodes, ...rest }) });

// ── classifyNodeDifference ─────────────────────────────────────────────────

test("a re-measured box is the same node set, and cosmetic", () => {
  const expectedNodes = [node(1, "KSampler"), node(2, "VAEDecode")];
  const actualNodes = [node(1, "KSampler", { size: [140, 74] }), node(2, "VAEDecode", { size: [90, 40] })];
  const d = classifyNodeDifference({ expectedNodes, actualNodes });
  assert.equal(d.comparable, true);
  assert.equal(d.sameNodeSet, true);
  assert.equal(d.cosmeticOnly, true);
  assert.deepEqual(d.fields, ["size"]);
});

test("a MISSING node is not the same set — and never reported as cosmetic", () => {
  const d = classifyNodeDifference({
    expectedNodes: [node(1, "KSampler"), node(2, "VAEDecode")],
    actualNodes: [node(1, "KSampler")],
  });
  assert.equal(d.comparable, true);
  assert.equal(d.sameNodeSet, false);
  assert.equal(d.cosmeticOnly, false);
});

test("an EXTRA node is not the same set", () => {
  const d = classifyNodeDifference({
    expectedNodes: [node(1, "KSampler")],
    actualNodes: [node(1, "KSampler"), node(9, "SaveImage")],
  });
  assert.equal(d.sameNodeSet, false);
});

test("an id reused for a DIFFERENT type is a different node, however the count reads", () => {
  const d = classifyNodeDifference({
    expectedNodes: [node(1, "KSampler")],
    actualNodes: [node(1, "SaveImage")],
  });
  assert.equal(d.comparable, true);
  assert.equal(d.sameNodeSet, false);
});

test("a changed WIDGET VALUE is same-set but NOT cosmetic — it is real content", () => {
  const d = classifyNodeDifference({
    expectedNodes: [node(1, "KSampler", { widgets_values: [42, "euler"] })],
    actualNodes: [node(1, "KSampler", { widgets_values: [43, "euler"] })],
  });
  assert.equal(d.sameNodeSet, true);
  assert.equal(d.cosmeticOnly, false, "a widget value must never be called cosmetic");
  assert.deepEqual(d.fields, ["widgets_values"]);
});

// ── codex round 1: four ways this could have reassured over real loss ───────

test("a field ABSENT on one side is not equal to one explicitly null", () => {
  // The `?? null` collapse erased exactly the field that would have blocked the
  // all-clear: a node whose widgets_values vanished, alongside a resize, was
  // reported as a pure resize.
  const d = classifyNodeDifference({
    expectedNodes: [node(1, "KSampler", { widgets_values: null })],
    actualNodes: [node(1, "KSampler", { size: [9, 9] })], // widgets_values GONE
  });
  assert.equal(d.sameNodeSet, true);
  assert.ok(d.fields.includes("widgets_values"), "the lost field must be named");
  assert.equal(d.cosmeticOnly, false, "losing a field is not a resize");
});

test("a reset TITLE is not cosmetic — the panel's own diff calls it a real edit", () => {
  // graph_edit_node persists user titles, and diffGraphsForAgent reports a title
  // change while ignoring moves/resizes/recolors. A load that reset a custom
  // title HAS lost something.
  const d = classifyNodeDifference({
    expectedNodes: [node(1, "KSampler", { title: "Base pass" })],
    actualNodes: [node(1, "KSampler", { title: "KSampler", size: [9, 9] })],
  });
  assert.equal(d.sameNodeSet, true);
  assert.equal(d.cosmeticOnly, false);
  assert.ok(d.fields.includes("title"));
});

test("flags are not cosmetic — graph_edit_node persists `pinned` there too", () => {
  const d = classifyNodeDifference({
    expectedNodes: [node(1, "KSampler", { flags: { pinned: true } })],
    actualNodes: [node(1, "KSampler", { flags: {}, size: [9, 9] })],
  });
  assert.equal(d.cosmeticOnly, false);
  assert.ok(d.fields.includes("flags"));
});

test("mode (bypass/mute) is execution semantics, not presentation", () => {
  const d = classifyNodeDifference({
    expectedNodes: [node(1, "KSampler", { mode: 0 })],
    actualNodes: [node(1, "KSampler", { mode: 4, size: [9, 9] })],
  });
  assert.equal(d.cosmeticOnly, false);
  assert.ok(d.fields.includes("mode"));
});

test("node `shape` is not cosmetic — it is not one of the ignored recolors", () => {
  const d = classifyNodeDifference({
    expectedNodes: [node(1, "KSampler", { shape: 2 })],
    actualNodes: [node(1, "KSampler", { shape: 1, size: [9, 9] })],
  });
  assert.equal(d.sameNodeSet, true);
  assert.equal(d.cosmeticOnly, false);
  assert.ok(d.fields.includes("shape"));
});

test("color and bgcolor ARE cosmetic — a deliberate policy, pinned here", () => {
  // The panel's own diff ignores "pure moves/resizes/recolors", and this set is
  // borrowed from it so the two cannot disagree. If user colour-coding should
  // ever count as work the all-clear must not cover, THIS is the decision to
  // change — and the sentence in COSMETIC_NODE_FIELDS with it.
  const d = classifyNodeDifference({
    expectedNodes: [node(1, "KSampler", { color: "#333", bgcolor: "#444" })],
    actualNodes: [node(1, "KSampler", { color: "#a00", bgcolor: "#b00" })],
  });
  assert.equal(d.sameNodeSet, true);
  assert.equal(d.cosmeticOnly, true);
  assert.deepEqual(d.fields, ["bgcolor", "color"]);
});

test("the identity key is injective — a delimiter collision is not a matched node", () => {
  // With `id + "|" + type`, these two pair up as the same node.
  const d = classifyNodeDifference({
    expectedNodes: [node("a|b", "c")],
    actualNodes: [node("a", "b|c")],
  });
  assert.equal(d.comparable, true);
  assert.equal(d.sameNodeSet, false, "different nodes must not read as one set");
});

test("cosmetic requires EVERY differing field to be cosmetic", () => {
  const d = classifyNodeDifference({
    expectedNodes: [node(1, "KSampler", { widgets_values: [1] })],
    actualNodes: [node(1, "KSampler", { size: [9, 9], widgets_values: [2] })],
  });
  assert.equal(d.sameNodeSet, true);
  assert.equal(d.cosmeticOnly, false);
  assert.deepEqual(d.fields, ["size", "widgets_values"]);
});

test("an identical set with no differing field is not 'cosmeticOnly'", () => {
  // Nothing differed, so there is no cosmetic explanation to offer either.
  const nodes = [node(1, "KSampler")];
  const d = classifyNodeDifference({ expectedNodes: nodes, actualNodes: [{ ...nodes[0] }] });
  assert.equal(d.sameNodeSet, true);
  assert.equal(d.cosmeticOnly, false);
  assert.deepEqual(d.fields, []);
});

test("node order does not make a set differ", () => {
  const d = classifyNodeDifference({
    expectedNodes: [node(1, "A"), node(2, "B")],
    actualNodes: [node(2, "B"), node(1, "A")],
  });
  assert.equal(d.sameNodeSet, true);
  assert.deepEqual(d.fields, []);
});

test("unreadable input asserts nothing", () => {
  for (const args of [
    {},
    { expectedNodes: null, actualNodes: [] },
    { expectedNodes: [], actualNodes: "nope" },
    { expectedNodes: [null], actualNodes: [node(1, "A")] },
    { expectedNodes: [7], actualNodes: [node(1, "A")] },
  ]) {
    const d = classifyNodeDifference(args);
    assert.equal(d.comparable, false, JSON.stringify(args));
    assert.equal(d.sameNodeSet, false);
    assert.equal(d.cosmeticOnly, false);
  }
});

test("duplicate node identities make the set unreadable rather than mispaired", () => {
  const d = classifyNodeDifference({
    expectedNodes: [node(1, "A"), node(1, "A")],
    actualNodes: [node(1, "A"), node(1, "A")],
  });
  assert.equal(d.comparable, false);
});

// ── describeGraphStateDifference plumbing ──────────────────────────────────

test("the node classification rides along ONLY when `nodes` actually differs", () => {
  const state = { nodes: [node(1, "KSampler")], groups: [{ title: "g" }] };
  // groups differ, nodes identical -> no node explanation to give
  const onlyGroups = describeGraphStateDifference({
    rootGraph: rootOf([node(1, "KSampler")], { groups: [{ title: "OTHER" }] }),
    state,
  });
  assert.equal(onlyGroups.comparable, true);
  assert.ok(onlyGroups.surfaces.includes("groups"));
  assert.equal(onlyGroups.surfaces.includes("nodes"), false);
  assert.equal(onlyGroups.nodeDifference, null, "an all-clear here would read as one about groups");

  const nodesToo = describeGraphStateDifference({
    rootGraph: rootOf([node(1, "KSampler", { size: [1, 1] })], { groups: [{ title: "g" }] }),
    state,
  });
  assert.ok(nodesToo.surfaces.includes("nodes"));
  assert.equal(nodesToo.nodeDifference?.cosmeticOnly, true);
});

test("an uncomparable state carries a null classification, never a false all-clear", () => {
  const d = describeGraphStateDifference({ rootGraph: { serialize: () => null }, state: { nodes: [] } });
  assert.equal(d.comparable, false);
  assert.equal(d.nodeDifference, null);
});

// ── The sentence the reporter actually reads ───────────────────────────────

const CONTENT_ONLY = resolveOpenRebindVerdict({
  instanceStillTarget: true,
  markerMatches: true,
  identityMatches: true,
  contentMatches: false,
});

test("the verdict is NOT softened — only the wording is", () => {
  assert.equal(CONTENT_ONLY.status, OPEN_REBIND_STATUS.CONTENT_UNVERIFIED);
  assert.equal(CONTENT_ONLY.bindingProven, true);
});

test("a re-measured graph says nothing was lost, and drops the data-loss framing", () => {
  const msg = describeOpenRebindOutcome(CONTENT_ONLY, {
    targetLabel: "origami.json",
    contentComparable: true,
    contentSurfaces: ["nodes"],
    contentNodeDifference: { comparable: true, sameNodeSet: true, cosmeticOnly: true, fields: ["size"] },
  });
  // #696 (codex) — the claim is narrower than it was, and the assertion follows it.
  // The old wording promised "the only difference is presentation, which the ComfyUI
  // frontend recomputes on load"; the frontend does NOT recompute a node's colour,
  // and colour is in the cosmetic set, so that was false whenever one differed. What
  // the comparison actually proves is same nodes, same values, same links.
  assert.match(msg, /no node and no value is missing/i);
  assert.match(msg, /same widget values and links/i);
  assert.match(msg, /no missing work to redo/i);
  assert.match(msg, /size/, "the differing fields are named so a reader can judge for themselves");
  assert.doesNotMatch(
    msg,
    /frontend recomputes on load/i,
    "the panel must not claim a recompute it cannot know happened",
  );
  assert.doesNotMatch(
    msg,
    /the load only\s+partly applied/i,
    "the panel CAN tell in this case, so it must not say it cannot",
  );
});

test("a MISSING node keeps the full warning and says the set itself differs", () => {
  const msg = describeOpenRebindOutcome(CONTENT_ONLY, {
    targetLabel: "origami.json",
    contentComparable: true,
    contentSurfaces: ["nodes"],
    contentNodeDifference: { comparable: true, sameNodeSet: false, cosmeticOnly: false, fields: [] },
  });
  assert.match(msg, /the node SET itself differs/);
  assert.match(msg, /partly applied/i, "a real content loss must keep the unresolved wording");
  // Pin the CURRENT reassurance, not a phrase the code no longer uses — a negative
  // assertion against dead wording passes for free and guards nothing.
  assert.doesNotMatch(msg, /no node and no value is missing/i);
  assert.doesNotMatch(msg, /no missing work to redo/i);
});

test("a widget-value difference is same-set but gets no reassurance", () => {
  const msg = describeOpenRebindOutcome(CONTENT_ONLY, {
    targetLabel: "origami.json",
    contentComparable: true,
    contentSurfaces: ["nodes"],
    contentNodeDifference: {
      comparable: true,
      sameNodeSet: true,
      cosmeticOnly: false,
      fields: ["widgets_values"],
    },
  });
  assert.match(msg, /no node was lost/i);
  assert.match(msg, /widget value is real\s+content/i);
  assert.doesNotMatch(msg, /no missing work to redo/i);
});

test("a SECOND differing surface blocks the reassurance — nodes explain only nodes", () => {
  const msg = describeOpenRebindOutcome(CONTENT_ONLY, {
    targetLabel: "origami.json",
    contentComparable: true,
    contentSurfaces: ["nodes", "groups"],
    contentNodeDifference: { comparable: true, sameNodeSet: true, cosmeticOnly: true, fields: ["size"] },
  });
  assert.doesNotMatch(msg, /no missing work to redo/i);
  assert.match(msg, /partly applied/i);
});

test("an unreadable node classification changes nothing about the old wording", () => {
  const msg = describeOpenRebindOutcome(CONTENT_ONLY, {
    targetLabel: "origami.json",
    contentComparable: true,
    contentSurfaces: ["nodes"],
    contentNodeDifference: { comparable: false, sameNodeSet: false, cosmeticOnly: false, fields: [] },
  });
  assert.match(msg, /partly applied/i);
  assert.doesNotMatch(msg, /nothing was lost/i);
});

test("a canvas the panel could not read is still never called a mismatch", () => {
  const msg = describeOpenRebindOutcome(CONTENT_ONLY, {
    targetLabel: "origami.json",
    contentComparable: false,
    contentSurfaces: [],
    contentNodeDifference: null,
  });
  assert.match(msg, /could not READ the graph/);
  assert.doesNotMatch(msg, /does not match/);
});

// ── #825 ask 2 — regression pin, NOT a new fix ─────────────────────────────
// The recovery probe was exempted from both target guards by #759 (first shipped
// in 0.11.45; the reporter was on 0.11.44). The wedge those reports describe is
// circular — a stale stamp refusing the only read that could refresh it — so if
// this exemption is ever removed the whole class comes back with no in-protocol
// exit. Pinned here because #825 asked for it and the answer is "already true".

test("the recovery probe workflow_list is exempt from the uuid fence", () => {
  assert.equal(commandIsCanvasTargetless("workflow_list"), true);
  assert.equal(activeWorkflowFenceApplies({ cmd: "workflow_list" }), false);
  // Even with a stale stamp that mismatches the live canvas, it must still run.
  assert.equal(
    commandTargetsActiveWorkflow({
      cmd: "workflow_list",
      commandUuid: "stale-uuid",
      activeUuid: "live-uuid",
    }),
    true,
  );
  // And with NO stamp at all, which is the other way a rebind arrives.
  assert.equal(
    commandTargetsActiveWorkflow({ cmd: "workflow_list", commandUuid: "", activeUuid: "live-uuid" }),
    true,
  );
});

test("the pin guard also skips the recovery probe, or the wedge just moves", () => {
  const PANEL = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  assert.match(
    PANEL,
    /pinnedPath\.trim\(\) && !commandIsCanvasTargetless\(msg\.cmd\)/,
    "both guards must consult the same predicate",
  );
});

test("an ordinary graph read stays fenced — the exemption is not a hole", () => {
  assert.equal(activeWorkflowFenceApplies({ cmd: "graph_get_state" }), true);
  assert.equal(
    commandTargetsActiveWorkflow({
      cmd: "graph_get_state",
      commandUuid: "stale-uuid",
      activeUuid: "live-uuid",
    }),
    false,
  );
});

// ── Shipped-source hygiene ─────────────────────────────────────────────────

test("no shipped web/js source carries a stray control character", () => {
  // Authoring tooling has twice now written a NUL (and once a U+0001) into a
  // string literal in this repo — inside `${a} ${b}` template interpolations
  // both times. They parse, they mostly behave, and one made git treat a module
  // as binary so it had no reviewable diff. Cheap to check across the whole
  // shipped tree; impossible to spot by eye in review.
  const root = new URL("../../web/js/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== "vendor") walk(full); // vendor is third-party, not ours to police
        continue;
      }
      if (!entry.endsWith(".js")) continue;
      const s = readFileSync(full, "utf8");
      for (let i = 0; i < s.length; i += 1) {
        const c = s.charCodeAt(i);
        if (c < 9 || (c > 10 && c < 13) || (c > 13 && c < 32)) {
          offenders.push(`${full} @${i} = 0x${c.toString(16)}`);
          break;
        }
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});

// ── layout-engine edge dedup: the same injectivity bug, one file over ───

test("layout edge keys are injective — a delimiter collision cannot drop an edge", async () => {
  const { computeLayout } = await import("../../web/js/lib/layout-engine.js");
  // ("a|b" -> "c") and ("a" -> "b|c") are DIFFERENT edges that a "|" join folds
  // into ONE key, so the second is discarded as a duplicate and its target loses
  // its only input — which in a flow layout means it stops being placed downstream.
  const box = (id) => ({ id, pos: [0, 0], size: [10, 10] });
  const out = computeLayout({
    nodes: [box("a|b"), box("c"), box("a"), box("b|c")],
    edges: [
      { from: "a|b", to: "c" },
      { from: "a", to: "b|c" },
    ],
  });
  // Both sinks have exactly one input, so both must sit in a LATER column than
  // their source. A folded key leaves one sink sourceless and it lands in column 0
  // alongside the roots.
  const col = out.columnOf;
  assert.ok(col instanceof Map, "computeLayout must expose columnOf");
  assert.ok(col.get("c") > col.get("a|b"), "edge a|b -> c must order them");
  assert.ok(col.get("b|c") > col.get("a"), "edge a -> b|c must survive dedup");
});

// ── #696: a display-only flag is not lost content ──────────────────────────

test("the reporter's trio — order + size + showAdvanced — is cosmetic", () => {
  // The 0.11.50 regression on #696: `panel_open_workflow` reported a mismatch on a
  // flat workflow that differed only in these three, with every node id and type
  // present. Two were already cosmetic; `showAdvanced` alone was enough to send a
  // healthy open down the "the panel cannot tell whether the load only partly
  // applied" path, which reads as possible data loss.
  const node = (over) => ({
    id: 1, type: "ImpactWildcardEncode", pos: [10, 20], size: [300, 100],
    flags: {}, order: 0, mode: 0, inputs: [], outputs: [],
    properties: {}, widgets_values: ["a", "b"], showAdvanced: false, ...over,
  });
  const out = classifyNodeDifference({
    expectedNodes: [node({})],
    actualNodes: [node({ order: 2, size: [310, 120], showAdvanced: true })],
  });
  assert.equal(out.comparable, true);
  assert.equal(out.sameNodeSet, true);
  assert.deepEqual(out.fields, ["order", "showAdvanced", "size"]);
  assert.equal(out.cosmeticOnly, true, "a display toggle cannot mean a node or a value was lost");
});

test("the rule's boundary: fields that CAN mean lost content stay non-cosmetic", () => {
  // The point of stating a rule rather than keeping a list. Each of these fails the
  // test "a difference here is compatible with 'nothing was lost'".
  const node = (over) => ({
    id: 1, type: "T", pos: [0, 0], size: [10, 10], flags: {}, order: 0, mode: 0,
    inputs: [], outputs: [], properties: {}, widgets_values: ["a"], title: "mine", ...over,
  });
  for (const [field, changed] of [
    ["widgets_values", { widgets_values: ["CHANGED"] }],
    ["mode", { mode: 4 }],                    // bypass — changes what executes
    ["title", { title: "renamed" }],          // authored, and losing it IS loss
    ["properties", { properties: { k: 1 } }], // pack-specific; unknowable from here
    ["inputs", { inputs: [{ name: "x" }] }],  // links
  ]) {
    const out = classifyNodeDifference({ expectedNodes: [node({})], actualNodes: [node(changed)] });
    assert.deepEqual(out.fields, [field], `expected only ${field} to differ`);
    assert.equal(out.cosmeticOnly, false, `${field} must not be treated as cosmetic`);
  }
});

test("an UNKNOWN field is not cosmetic — the set stays a denylist", () => {
  // A pack the panel has never seen makes the disclosure cautious rather than
  // confidently wrong. Inverting to an allowlist would make every unfamiliar field
  // cosmetic, i.e. claim "nothing was lost" about a surface never heard of.
  const node = (over) => ({ id: 1, type: "T", widgets_values: ["a"], ...over });
  const out = classifyNodeDifference({
    expectedNodes: [node({ someFuturePackFlag: 1 })],
    actualNodes: [node({ someFuturePackFlag: 2 })],
  });
  assert.equal(out.cosmeticOnly, false);
});

test("showAdvanced alongside a REAL change is still not cosmetic", () => {
  // Widening the set must not let a genuine difference ride along with a display
  // toggle — the all-clear is per-difference-set, not per-field.
  const node = (over) => ({
    id: 1, type: "T", widgets_values: ["a"], showAdvanced: false, ...over,
  });
  const out = classifyNodeDifference({
    expectedNodes: [node({})],
    actualNodes: [node({ showAdvanced: true, widgets_values: ["CHANGED"] })],
  });
  assert.deepEqual(out.fields, ["showAdvanced", "widgets_values"]);
  assert.equal(out.cosmeticOnly, false);
});

test("showAdvanced is trusted only when it is a BOOLEAN", () => {
  // codex — a field NAME is not a contract. `showAdvanced` is a boolean display
  // toggle in the packs that prompted this, but the classifier sees every node type
  // there will ever be, and a pack storing real state under that name would
  // otherwise collect an all-clear it never earned. A boolean cannot carry a lost
  // widget value; anything richer is unknown and fails closed.
  const node = (v) => ({ id: 1, type: "T", widgets_values: ["a"], showAdvanced: v });
  const classify = (a, b) =>
    classifyNodeDifference({ expectedNodes: [node(a)], actualNodes: [node(b)] });

  assert.equal(classify(false, true).cosmeticOnly, true, "boolean toggle is cosmetic");

  for (const [a, b, why] of [
    [{ lora_1: "x" }, { lora_1: "y" }, "an object could be real state"],
    [["a"], ["b"], "so could an array"],
    ["basic", "advanced", "and a string"],
    [0, 1, "numbers are not the toggle this trusts"],
    [false, { on: true }, "a mixed pair is still unknown on one side"],
  ]) {
    const out = classify(a, b);
    assert.deepEqual(out.fields, ["showAdvanced"], why);
    assert.equal(out.cosmeticOnly, false, why);
  }
});

test("a guard failure still REPORTS the field, it just refuses the all-clear", () => {
  // The caller needs to know what differed either way; the guard decides only
  // whether the reassuring sentence may be used.
  const node = (v) => ({ id: 1, type: "T", widgets_values: ["a"], showAdvanced: v });
  const out = classifyNodeDifference({
    expectedNodes: [node({ deep: 1 })],
    actualNodes: [node({ deep: 2 })],
  });
  assert.deepEqual(out.fields, ["showAdvanced"]);
  assert.equal(out.sameNodeSet, true);
  assert.equal(out.cosmeticOnly, false);
});

test("the reassuring sentence claims only what was compared", () => {
  // #696 (codex) — `color`/`bgcolor` are cosmetic AND user-authored, and the
  // frontend does not recompute them, so the old "which the ComfyUI frontend
  // recomputes on load" was false whenever a colour differed. What the comparison
  // establishes is same nodes, same values, same links.
  const msg = describeOpenRebindOutcome(CONTENT_ONLY, {
    targetLabel: "origami.json",
    contentComparable: true,
    contentSurfaces: ["nodes"],
    contentNodeDifference: { comparable: true, sameNodeSet: true, cosmeticOnly: true, fields: ["color"] },
  });
  assert.match(msg, /no node and no value is missing/i);
  assert.match(msg, /color/, "the field is named rather than described as 'presentation'");
  assert.doesNotMatch(msg, /recomputes on load/i);
});
