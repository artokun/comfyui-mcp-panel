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
  assert.doesNotMatch(msg, /same widget values and links/i);
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

// ── #696: an unrecognised field must not read as lost work ────────────────

test("the reporter's trio still reassures, WITHOUT the panel guessing what a field means", () => {
  // The 0.11.50 regression: `panel_open_workflow` reported a mismatch on a flat
  // workflow differing only in `order`, `showAdvanced`, and `size`, every node id
  // and type present. `showAdvanced` is not on the cosmetic allowlist and — per
  // codex — must not be: a field NAME is not a contract, a boolean IS a value, and
  // this classifier sees every node type there will ever be.
  //
  // So the fix is not to bless the name. The node SET is what was actually proven,
  // and that is what the headline rests on now.
  const msg = describeOpenRebindOutcome(CONTENT_ONLY, {
    targetLabel: "origami.json",
    contentComparable: true,
    contentSurfaces: ["nodes"],
    contentNodeDifference: {
      comparable: true,
      sameNodeSet: true,
      cosmeticOnly: false,
      fields: ["order", "showAdvanced", "size"],
    },
  });
  assert.match(msg, /no node was lost/i, "the set was compared; say so");
  assert.match(msg, /showAdvanced/, "and name what differed so the reader can judge");
  assert.doesNotMatch(
    msg,
    /the load only\s+partly applied/i,
    "an intact node set must not read as possible data loss",
  );
});

test("an unrecognised field does NOT earn the values claim", () => {
  // The reassurance is tiered. An intact set gets "no node was lost"; only a
  // cosmetic-only difference additionally gets "same widget values and links",
  // because those fields are off the allowlist and therefore known to have matched.
  const msg = describeOpenRebindOutcome(CONTENT_ONLY, {
    targetLabel: "origami.json",
    contentComparable: true,
    contentSurfaces: ["nodes"],
    contentNodeDifference: {
      comparable: true, sameNodeSet: true, cosmeticOnly: false, fields: ["showAdvanced"],
    },
  });
  assert.doesNotMatch(msg, /same widget values and links/i);
  assert.doesNotMatch(msg, /no missing work to redo/i, "unknown fields cannot promise that");
});

test("showAdvanced is NOT on the cosmetic allowlist", () => {
  // Pinned as a decision, not an oversight: adding it would have the panel assert a
  // meaning it cannot know for an arbitrary node pack.
  const node = (v) => ({ id: 1, type: "T", widgets_values: ["a"], showAdvanced: v });
  const out = classifyNodeDifference({ expectedNodes: [node(false)], actualNodes: [node(true)] });
  assert.deepEqual(out.fields, ["showAdvanced"]);
  assert.equal(out.sameNodeSet, true, "the set is still intact, which is what carries the reassurance");
  assert.equal(out.cosmeticOnly, false, "a field name is not a contract");
});

test("the rule's boundary: fields that CAN mean lost content stay non-cosmetic", () => {
  const node = (over) => ({
    id: 1, type: "T", pos: [0, 0], size: [10, 10], flags: {}, order: 0, mode: 0,
    inputs: [], outputs: [], properties: {}, widgets_values: ["a"], title: "mine", ...over,
  });
  for (const [field, changed] of [
    ["widgets_values", { widgets_values: ["CHANGED"] }],
    ["mode", { mode: 4 }],
    ["title", { title: "renamed" }],
    ["properties", { properties: { k: 1 } }],
    ["inputs", { inputs: [{ name: "x" }] }],
  ]) {
    const out = classifyNodeDifference({ expectedNodes: [node({})], actualNodes: [node(changed)] });
    assert.deepEqual(out.fields, [field], `expected only ${field} to differ`);
    assert.equal(out.cosmeticOnly, false, `${field} must not be treated as cosmetic`);
  }
});

test("a cosmetic-only difference still earns the stronger, narrower claim", () => {
  // And it claims only what the comparison establishes. `color`/`bgcolor` are
  // cosmetic AND user-authored, so "no value is missing" would overclaim; "same
  // widget values and links" is what the allowlist actually proves.
  const msg = describeOpenRebindOutcome(CONTENT_ONLY, {
    targetLabel: "origami.json",
    contentComparable: true,
    contentSurfaces: ["nodes"],
    contentNodeDifference: { comparable: true, sameNodeSet: true, cosmeticOnly: true, fields: ["color"] },
  });
  assert.match(msg, /same widget values and links/i);
  assert.match(msg, /color/, "the field is named rather than described only as 'presentation'");
  assert.doesNotMatch(msg, /recomputes on load/i, "the frontend does not recompute a colour");
  assert.doesNotMatch(msg, /no value is missing/i, "colour IS a value, and it differed");
});

test("codex r3's duplicate-identity case fails closed, so the set claim holds", () => {
  // The reassurance now rests on `sameNodeSet` alone, so it matters that the set
  // comparison cannot be fooled by repeated identities. Codex's exact example:
  //
  //   expected: [1,A] [1,A] [2,B]      actual: [1,A] [2,B] [2,B]
  //
  // Both SETS are {[1,A],[2,B]} while an A was lost and a B appeared. Comparing
  // sets rather than multiplicities would call that intact.
  //
  // It does not, and the guard predates this change: `byKey` refuses a duplicate
  // identity outright ("cannot pair them up honestly"), which yields
  // `comparable: false` — and `nodeSetIntact` requires `comparable === true`, so
  // the cautious message stands.
  const n = (id, type) => ({ id, type, widgets_values: ["v"] });
  const out = classifyNodeDifference({
    expectedNodes: [n(1, "A"), n(1, "A"), n(2, "B")],
    actualNodes: [n(1, "A"), n(2, "B"), n(2, "B")],
  });
  assert.equal(out.comparable, false, "duplicate identities are not comparable");
  assert.equal(out.sameNodeSet, false, "…so no set claim is made either");

  // And the message that consumes it stays on the cautious path.
  const msg = describeOpenRebindOutcome(CONTENT_ONLY, {
    targetLabel: "origami.json",
    contentComparable: true,
    contentSurfaces: ["nodes"],
    contentNodeDifference: out,
  });
  assert.doesNotMatch(msg, /no node was lost/i);
  assert.match(msg, /partly applied/i);
});

test("a duplicate on EITHER side alone is enough to refuse the comparison", () => {
  const n = (id, type) => ({ id, type });
  for (const [expectedNodes, actualNodes] of [
    [[n(1, "A"), n(1, "A")], [n(1, "A")]],
    [[n(1, "A")], [n(1, "A"), n(1, "A")]],
  ]) {
    const out = classifyNodeDifference({ expectedNodes, actualNodes });
    assert.equal(out.comparable, false);
    assert.equal(out.sameNodeSet, false);
  }
});

// ── #886: a `properties` difference names the KEYS that moved ─────────────
//
// The last recurrences of #886 report opens refused on per-node `properties`
// (and `widgets_values`) differences with the node set intact. `properties` is
// one field name standing in for a whole bag of keys — a pack-version stamp the
// frontend rewrote and an extension's stored settings read identically at the
// field level, and the maintainer's per-key account of the rewrite cannot be
// written until a report says WHICH keys moved. The verdict is deliberately
// untouched; these pin that the disclosure now carries the keys.

test("a properties difference names the differing keys inside it", () => {
  const d = classifyNodeDifference({
    expectedNodes: [node(1, "KSampler", { properties: { ver: "v0.3.64", cnr_id: "comfy-core" } })],
    actualNodes: [node(1, "KSampler", { properties: { ver: "0.3.64", cnr_id: "comfy-core" } })],
  });
  assert.equal(d.sameNodeSet, true);
  assert.equal(d.cosmeticOnly, false, "properties is not cosmetic — the verdict is untouched");
  assert.deepEqual(d.fields, ["properties"]);
  assert.deepEqual(d.propertyFields, ["ver"], "the KEY that moved is named, not just the field");
});

test("property keys union across nodes, sorted, and a matched properties bag names none", () => {
  const d = classifyNodeDifference({
    expectedNodes: [
      node(1, "A", { properties: { ver: "v1", models: [{ name: "m", extra: 1 }] } }),
      node(2, "B", { properties: { ver: "1" } }),
    ],
    actualNodes: [
      node(1, "A", { properties: { ver: "1", models: [{ name: "m" }] } }),
      node(2, "B", { properties: { ver: "1" } }),
    ],
  });
  assert.deepEqual(d.fields, ["properties"], "node 2's properties matched — only node 1 differs");
  assert.deepEqual(d.propertyFields, ["models", "ver"]);
});

test("a key present-as-undefined inside properties reads as ABSENT, same as a field", () => {
  // JSON.stringify drops undefined values, so no saved file can carry one — a live
  // in-memory properties bag holds keys no disk state can reproduce (#1001's rule,
  // one level down).
  const d = classifyNodeDifference({
    expectedNodes: [node(1, "A", { properties: { ver: "1" } })],
    actualNodes: [node(1, "A", { properties: { ver: "1", showAdvanced: undefined } })],
  });
  assert.deepEqual(d.fields, []);
  assert.deepEqual(d.propertyFields, []);
});

test("an unreadable properties shape names the FIELD but no keys", () => {
  // Fail closed in the direction that costs: a properties value the classifier
  // cannot read keys out of must not invent a key list — and must not lose the
  // field-level difference either.
  for (const bad of [null, [1, 2], "string"]) {
    const d = classifyNodeDifference({
      expectedNodes: [node(1, "A", { properties: { ver: "1" } })],
      actualNodes: [node(1, "A", { properties: bad })],
    });
    assert.deepEqual(d.fields, ["properties"], JSON.stringify(bad));
    assert.deepEqual(d.propertyFields, [], "no keys are guessed at");
  }
});

test("a wholly absent properties bag names no keys — absence is already the field difference", () => {
  const d = classifyNodeDifference({
    expectedNodes: [node(1, "A", { properties: { ver: "1" } })],
    actualNodes: [node(1, "A")],
  });
  assert.deepEqual(d.fields, ["properties"]);
  assert.deepEqual(d.propertyFields, []);
});

test("the open refusal names the differing property keys, so the report carries them", () => {
  const msg = describeOpenRebindOutcome(CONTENT_ONLY, {
    targetLabel: "origami.json",
    contentComparable: true,
    contentSurfaces: ["nodes"],
    contentNodeDifference: {
      comparable: true,
      sameNodeSet: true,
      cosmeticOnly: false,
      fields: ["order", "properties", "size"],
      propertyFields: ["ver"],
    },
  });
  assert.match(msg, /no node was lost/i);
  assert.match(msg, /order, properties, size/, "the fields are still named");
  assert.match(msg, /within properties, the keys that differ are: ver/, "and now the keys are too");
  assert.doesNotMatch(msg, /no missing work to redo/i, "the reassurance is NOT widened");
});

test("the key list is capped, and says how many were trimmed", () => {
  const propertyFields = Array.from({ length: 14 }, (_, i) => `k${String(i).padStart(2, "0")}`);
  const msg = describeOpenRebindOutcome(CONTENT_ONLY, {
    targetLabel: "origami.json",
    contentComparable: true,
    contentSurfaces: ["nodes"],
    contentNodeDifference: {
      comparable: true,
      sameNodeSet: true,
      cosmeticOnly: false,
      fields: ["properties"],
      propertyFields,
    },
  });
  assert.match(msg, /k00/, "the first keys are named");
  assert.match(msg, /and 4 more/, "the trim is disclosed, not silent");
  assert.doesNotMatch(msg, /k13/, "a hostile properties bag cannot grow the clause without bound");
});

test("an empty key list adds no empty clause — an unreadable shape reads exactly as before", () => {
  const msg = describeOpenRebindOutcome(CONTENT_ONLY, {
    targetLabel: "origami.json",
    contentComparable: true,
    contentSurfaces: ["nodes"],
    contentNodeDifference: {
      comparable: true,
      sameNodeSet: true,
      cosmeticOnly: false,
      fields: ["properties"],
      propertyFields: [],
    },
  });
  assert.match(msg, /what differs is per-node \(properties\)\. A widget value/);
  assert.doesNotMatch(msg, /keys that differ/, "no keys were read, so none are claimed");
});

test("the key detail rides the real pipeline, not a hand-built shape", () => {
  // describeGraphStateDifference -> contentNodeDifference -> the clause, with the
  // classifier producing propertyFields itself.
  const state = {
    nodes: [node(1, "KSampler", { properties: { ver: "v0.3.64" }, widgets_values: [1] })],
  };
  const diff = describeGraphStateDifference({
    rootGraph: rootOf([node(1, "KSampler", { properties: { ver: "0.3.64" }, widgets_values: [1] })]),
    state,
  });
  assert.deepEqual(diff.nodeDifference?.propertyFields, ["ver"]);
  const msg = describeOpenRebindOutcome(CONTENT_ONLY, {
    targetLabel: "origami.json",
    contentComparable: diff.comparable,
    contentSurfaces: diff.surfaces,
    contentAccountedSurfaces: diff.accountedSurfaces,
    contentNodeDifference: diff.nodeDifference,
  });
  assert.match(msg, /the keys that differ are: ver/);
});
