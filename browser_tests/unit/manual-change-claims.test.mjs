import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  liveWidgetValue,
  reconcileWidgetClaims,
  supersededNote,
  SUPERSEDED_CAP,
} from "../../web/js/lib/manual-change-claims.js";
import { slotRenameLines } from "../../web/js/lib/slot-rename-diff.js";
import { canonicalNodeId } from "../../web/js/lib/node-id.js";

/**
 * #1498 — "Manual canvas change event disagrees with live graph widget state".
 *
 * The reporter's session was told by the MANUAL CANVAS CHANGES block that a combo
 * had moved to XFORMERS, then read the same node with panel_graph_outline and
 * panel_query_graph and got the OLD value from both. It filed that as inconsistent
 * state across panel surfaces.
 *
 * Measured against the shipped frontend (1.49.6): `widgets_values[i]` IS
 * `widgets[i].value` at the instant of the serialize the block is built from, for
 * plain nodes and for subgraph nodes alike. So the two surfaces cannot disagree at
 * one moment — they were two readings taken at DIFFERENT moments, and only the
 * ordering was missing. These tests pin the disclosure that supplies it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

const panelSource = () => readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");

function sliceBetween(src, startNeedle, endNeedle) {
  const start = src.indexOf(startNeedle);
  assert.notEqual(start, -1, `could not locate ${JSON.stringify(startNeedle)}`);
  const end = src.indexOf(endNeedle, start + 1);
  assert.ok(end > start, `could not locate ${JSON.stringify(endNeedle)} after it`);
  return src.slice(start, end);
}

/** The panel's REAL diff helpers, lifted out with only their two library imports
 *  injected — so what is exercised below is the shipped function, not a copy of it
 *  that could drift. */
function buildDiff() {
  const src = panelSource();
  const body = sliceBetween(src, 'const MODE_NAME = { 0: "active"', "function connectCommand(");
  const factory = new Function(
    "slotRenameLines",
    "canonicalNodeId",
    `${body}\nreturn { diffGraphsForAgent, resolvedWidgetName };`,
  );
  return factory(slotRenameLines, canonicalNodeId);
}

// A REAL KSampler as ComfyUI frontend 1.49.6 serializes it (captured from a live
// canvas: `control_after_generate` carries options.serialize:false and is STILL
// written, at its own index, so the array aligns with `node.widgets` one-for-one).
const KSAMPLER_WIDGETS = [
  "seed",
  "control_after_generate",
  "steps",
  "cfg",
  "sampler_name",
  "scheduler",
  "denoise",
];
const ksamplerValues = () => [0, "randomize", 20, 8, "euler", "simple", 1];
const serializedGraph = (widgets_values) => ({
  nodes: [{ id: 8, type: "KSampler", widgets_values }],
  links: [],
});
const liveKSampler = {
  getNodeById: (id) =>
    Number(id) === 8 ? { id: 8, widgets: KSAMPLER_WIDGETS.map((name) => ({ name })) } : null,
};

test("a widget-value line records the claim it just asserted", () => {
  const { diffGraphsForAgent } = buildDiff();
  const prev = serializedGraph(ksamplerValues());
  const next = ksamplerValues();
  next[4] = "dpmpp_2m";
  const claims = [];
  const lines = diffGraphsForAgent(prev, serializedGraph(next), liveKSampler, claims);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /sampler_name euler → dpmpp_2m/);
  assert.deepEqual(claims, [
    { node_id: 8, node_type: "KSampler", widget: "sampler_name", reported: "dpmpp_2m" },
  ]);
});

test("the claim carries the RAW value, not the line's clipped rendering", () => {
  // Load-bearing: the reconciliation compares against the live widget, and a value
  // the display truncated at 40 chars would never compare equal to it.
  const { diffGraphsForAgent } = buildDiff();
  const long = "a".repeat(120);
  const prev = serializedGraph(["short"]);
  const claims = [];
  const live = { getNodeById: () => ({ id: 8, widgets: [{ name: "text" }] }) };
  const lines = diffGraphsForAgent(prev, serializedGraph([long]), live, claims);
  assert.match(lines[0], /…/); // the LINE is clipped
  assert.equal(claims[0].reported, long); // the CLAIM is not
});

test("no claim is recorded when the widget's name cannot be resolved", () => {
  // The reconciliation looks the widget back up BY NAME; `#4` is not a name any
  // reader would find, so a claim under it could never be checked — and an
  // unverifiable claim that rides anyway is the fabrication this issue is about.
  const { diffGraphsForAgent } = buildDiff();
  const next = ksamplerValues();
  next[4] = "dpmpp_2m";
  const claims = [];
  const lines = diffGraphsForAgent(
    serializedGraph(ksamplerValues()),
    serializedGraph(next),
    { getNodeById: () => null },
    claims,
  );
  assert.match(lines[0], /#4 euler → dpmpp_2m/);
  assert.deepEqual(claims, []);
});

test("the diff still works for callers that want only the lines", () => {
  const { diffGraphsForAgent } = buildDiff();
  const next = ksamplerValues();
  next[2] = 30;
  const lines = diffGraphsForAgent(serializedGraph(ksamplerValues()), serializedGraph(next), liveKSampler);
  assert.equal(lines.length, 1);
});

// ---- reconciliation -------------------------------------------------------

const nodeWith = (widgets) => ({ id: 8, widgets });

test("a claim the live graph still agrees with says nothing", () => {
  const res = reconcileWidgetClaims(
    [{ node_id: 8, widget: "sampler_name", reported: "dpmpp_2m" }],
    () => nodeWith([{ name: "sampler_name", value: "dpmpp_2m" }]),
  );
  assert.deepEqual(res.rows, []);
  assert.equal(res.differing, 0);
});

test("a claim the canvas has moved past is reported with BOTH values", () => {
  const res = reconcileWidgetClaims(
    [{ node_id: 8, node_type: "RayInitializerAdvanced", widget: "XFuser_attention", reported: "XFORMERS" }],
    () => nodeWith([{ name: "XFuser_attention", value: "TORCH_EFFICIENT" }]),
  );
  assert.deepEqual(res.rows, [
    {
      node_id: 8,
      node_type: "RayInitializerAdvanced",
      widget: "XFuser_attention",
      reported: "XFORMERS",
      now: "TORCH_EFFICIENT",
    },
  ]);
  assert.equal(res.differing, 1);
});

test("a node that no longer resolves is NOT reported as a superseded value", () => {
  const res = reconcileWidgetClaims(
    [{ node_id: 8, widget: "seed", reported: 5 }],
    () => null,
  );
  assert.deepEqual(res.rows, []);
  assert.equal(res.checked, 0);
});

test("a REPEATED widget name is refused rather than guessed at", () => {
  // rgthree's Fast Groups rows all carry one name (panel#1402). Picking a row to
  // compare against is how a wrong-target claim gets made, so this says nothing.
  const res = reconcileWidgetClaims(
    [{ node_id: 8, widget: "RGTHREE_TOGGLE_AND_NAV", reported: true }],
    // The FIRST row deliberately DISAGREES with the claim: a guard that merely took
    // row[0] would report a supersession here, so this kills that mutation instead of
    // passing by luck.
    () =>
      nodeWith([
        { name: "RGTHREE_TOGGLE_AND_NAV", value: false },
        { name: "RGTHREE_TOGGLE_AND_NAV", value: true },
      ]),
  );
  assert.deepEqual(res.rows, []);
});

test("a widget that is gone is refused too", () => {
  const res = reconcileWidgetClaims(
    [{ node_id: 8, widget: "lora_3", reported: "x.safetensors" }],
    () => nodeWith([{ name: "lora_1", value: "y.safetensors" }]),
  );
  assert.deepEqual(res.rows, []);
});

test("a resolver that throws is survived, not propagated", () => {
  const res = reconcileWidgetClaims(
    [{ node_id: 8, widget: "seed", reported: 1 }],
    () => {
      throw new Error("graph torn down");
    },
  );
  assert.deepEqual(res.rows, []);
});

test("a string and a number of the same digits are DIFFERENT values", () => {
  // A combo that stores "1" and an INT that holds 1 are not the same state, and a
  // loose compare would silently swallow exactly the disagreement being reported.
  const res = reconcileWidgetClaims(
    [{ node_id: 8, widget: "steps", reported: "20" }],
    () => nodeWith([{ name: "steps", value: 20 }]),
  );
  assert.equal(res.differing, 1);
});

test("the rider is capped, and says how many it did not show", () => {
  const claims = Array.from({ length: SUPERSEDED_CAP + 4 }, (_, i) => ({
    node_id: i,
    widget: `w${i}`,
    reported: "old",
  }));
  const res = reconcileWidgetClaims(claims, (id) => nodeWith([{ name: `w${id}`, value: "new" }]));
  assert.equal(res.rows.length, SUPERSEDED_CAP);
  assert.equal(res.differing, SUPERSEDED_CAP + 4);
  assert.match(supersededNote(res), new RegExp(`showing ${SUPERSEDED_CAP} of ${SUPERSEDED_CAP + 4}`));
});

test("a long value is clipped so the rider cannot dominate the reply", () => {
  const res = reconcileWidgetClaims(
    [{ node_id: 8, widget: "text", reported: "a".repeat(500) }],
    () => nodeWith([{ name: "text", value: "b".repeat(500) }]),
  );
  assert.ok(res.rows[0].reported.length <= 60);
  assert.ok(res.rows[0].now.length <= 60);
});

test("the note states WHICH reading is newer, not merely that they differ", () => {
  // The whole finding is the ordering. Two values with no as-of is the contradiction
  // the reporter filed, restated.
  const note = supersededNote({
    rows: [{ node_id: 8, widget: "XFuser_attention", reported: "XFORMERS", now: "TORCH_EFFICIENT" }],
    differing: 1,
  });
  assert.match(note, /MANUAL CANVAS CHANGES/);
  assert.match(note, /THIS read is newer/);
  assert.match(note, /Do not re-apply the reported value/);
});

test("nothing to say produces no note at all", () => {
  assert.equal(supersededNote({ rows: [], differing: 0 }), "");
  assert.equal(supersededNote(), "");
});

test("liveWidgetValue reads by NAME, the same key the graph readers use", () => {
  assert.deepEqual(liveWidgetValue(nodeWith([{ name: "cfg", value: 8 }]), "cfg"), {
    resolved: true,
    value: 8,
  });
  assert.deepEqual(liveWidgetValue(nodeWith([]), "cfg"), { resolved: false });
  assert.deepEqual(liveWidgetValue(null, "cfg"), { resolved: false });
});

// ---- wiring ---------------------------------------------------------------
// A helper that nothing calls fixes nothing. These assert on the SOURCE, because
// the install is a one-line spread that no unit test of the lib can observe.

test("the banner arms the claims it is about to assert, and only for its own block", () => {
  const banner = sliceBetween(panelSource(), "function manualChangeBanner()", "\n/**");
  assert.match(banner, /diffGraphsForAgent\(lastAgentGraph, curr, live, claims\)/);
  assert.match(banner, /manualChangeClaims = claims;/);
  // Cleared with the baseline, so a previous turn's assertions can never be checked
  // against this turn's canvas.
  assert.match(banner, /manualChangeClaims = \[\];/);
});

test("the banner states its AS-OF and that a later live read wins", () => {
  const banner = sliceBetween(panelSource(), "function manualChangeBanner()", "\n/**");
  assert.match(banner, /AS OF THE MOMENT THIS MESSAGE WAS SENT/);
  assert.match(banner, /that read is NEWER and it wins/);
  // The old present-tense claim is what made a correct live read look like a broken
  // surface; it must not come back.
  assert.doesNotMatch(banner, /Treat the canvas as being in THIS state now/);
});

/** The panel's REAL manualChangeSupersededRider, with the module state it reads
 *  injected as parameters (it only ever reads them). Executed rather than
 *  regex-matched: the gate on this change killed 8 of 9 mutations off the source
 *  tests, and the survivor was deleting this function's workflow-key gate — a guard
 *  no regex assertion can watch fail. */
function buildRider({ claims, claimsKey, uuid }) {
  const body = sliceBetween(
    panelSource(),
    "function manualChangeSupersededRider(rootGraph) {",
    "/** #1498 — the PANEL just wrote",
  );
  const factory = new Function(
    "manualChangeClaims",
    "manualChangeClaimsKey",
    "workflowStableUuid",
    "reconcileWidgetClaims",
    "supersededNote",
    "canonicalNodeId",
    `${body}
return manualChangeSupersededRider;`,
  );
  return factory(
    claims,
    claimsKey,
    uuid,
    reconcileWidgetClaims,
    supersededNote,
    canonicalNodeId,
  );
}

const graphWith = (widgets) => ({ getNodeById: (id) => (Number(id) === 8 ? { id: 8, widgets } : null) });
const XFUSER_CLAIM = [
  { node_id: 8, node_type: "RayInitializerAdvanced", widget: "XFuser_attention", reported: "XFORMERS" },
];

test("the rider reports the reporter's own case end to end", () => {
  const rider = buildRider({ claims: XFUSER_CLAIM, claimsKey: "wf-A", uuid: () => "wf-A" });
  const out = rider(graphWith([{ name: "XFuser_attention", value: "TORCH_EFFICIENT" }]));
  assert.equal(out.manual_changes_superseded.length, 1);
  assert.equal(out.manual_changes_superseded[0].now, "TORCH_EFFICIENT");
  assert.match(out.manual_changes_superseded_note, /THIS read is newer/);
});

test("the rider REFUSES across a workflow switch", () => {
  // The claims are root-graph node ids. Checking them against a different workflow's
  // node of the same id is the wrong-target claim #348/#198 removed from the diff.
  const rider = buildRider({ claims: XFUSER_CLAIM, claimsKey: "wf-A", uuid: () => "wf-B" });
  assert.deepEqual(rider(graphWith([{ name: "XFuser_attention", value: "TORCH_EFFICIENT" }])), {});
});

test("an unreadable identity on either side is a refusal, never an inference", () => {
  const thrown = buildRider({
    claims: XFUSER_CLAIM,
    claimsKey: "wf-A",
    uuid: () => {
      throw new Error("no active workflow");
    },
  });
  assert.deepEqual(thrown(graphWith([{ name: "XFuser_attention", value: "TORCH_EFFICIENT" }])), {});
  const unkeyed = buildRider({ claims: XFUSER_CLAIM, claimsKey: null, uuid: () => "wf-A" });
  assert.deepEqual(unkeyed(graphWith([{ name: "XFuser_attention", value: "TORCH_EFFICIENT" }])), {});
});

test("an agreeing canvas, no claims, or no graph adds NO fields at all", () => {
  const agreeing = buildRider({ claims: XFUSER_CLAIM, claimsKey: "wf-A", uuid: () => "wf-A" });
  assert.deepEqual(agreeing(graphWith([{ name: "XFuser_attention", value: "XFORMERS" }])), {});
  assert.deepEqual(
    buildRider({ claims: [], claimsKey: "wf-A", uuid: () => "wf-A" })(graphWith([])),
    {},
  );
  assert.deepEqual(agreeing(null), {});
});

test("a graph that throws on lookup does not fail the read", () => {
  const rider = buildRider({ claims: XFUSER_CLAIM, claimsKey: "wf-A", uuid: () => "wf-A" });
  assert.deepEqual(
    rider({
      getNodeById: () => {
        throw new Error("graph torn down");
      },
    }),
    {},
  );
});

test("both graph reads carry the rider", () => {
  const src = panelSource();
  const outline = sliceBetween(src, "  graph_outline({ max_chars } = {}) {", "\n  graph_query(");
  assert.match(outline, /\.\.\.manualChangeSupersededRider\(rootGraph\)/);
  const query = sliceBetween(src, "  graph_query({ types, title, where", "\n  graph_find_nodes(");
  assert.match(query, /\.\.\.manualChangeSupersededRider\(rootGraph\)/);
});

test("a widget the panel itself writes retires its claim", () => {
  const src = panelSource();
  const setWidget = sliceBetween(src, "  async graph_set_widget({ node_id, widget", "\n  // artokun/comfyui-mcp#938");
  const run = setWidget.indexOf("const result = await runSetWidget(");
  const drop = setWidget.indexOf("dropManualChangeClaim(");
  assert.ok(run !== -1, "runSetWidget call not found");
  assert.ok(drop > run, "the claim must be retired AFTER the write that ran");
});

test("claims do not outlive the turn that made them", () => {
  const src = panelSource();
  const done = sliceBetween(src, '} else if (state === "done") {', "onLog(text)");
  assert.match(done, /manualChangeClaims = \[\];/);
});
