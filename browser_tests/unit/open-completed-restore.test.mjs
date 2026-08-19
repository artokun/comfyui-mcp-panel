/**
 * panel#1283 / #1285 / #1307 / #1330 and comfyui-mcp#1705 — `panel_open_workflow`
 * reported an ERROR / `applied: unknown` on opens that had in fact applied cleanly.
 *
 * WHAT THE FIVE REPORTERS GOT. Every one of them: the canvas bound to the requested
 * workflow, every node present with the same id and type, nothing extra, a
 * `panel_graph_outline` afterwards showing the intended graph — and `isError: true`,
 * no `workflow_uuid`, and a multi-step recovery through `panel_list_workflows`.
 * The per-node fields that differed were, verbatim from the reports:
 *
 *   #1283  order, size, widgets_values          #1330  outputs, size
 *   #1285  order, size, widgets_values          #1705  inputs, outputs, properties,
 *   #1307  size, widgets_values                        widgets_values, widgets_values_named
 *
 * WHY THE TWO EXISTING GROUNDS CANNOT REACH THEM. Both are FIELD-LEVEL, and both are
 * right to be:
 *
 *   RECOMPUTED_NODE_FIELDS  {size (height-only), inputs}  "is a difference in this
 *                                                          NAME a rewrite the panel
 *                                                          has MEASURED?"
 *   COSMETIC_NODE_FIELDS    {size, pos, order,            "could a difference in this
 *                            color, bgcolor}               NAME mean lost authoring?"
 *
 * `widgets_values` is deliberately outside both — it is the field a genuine partial
 * load drops, which is what #1111/#1089 are about. `outputs`, `properties` and
 * `widgets_values_named` are outside both because nobody has characterised them.
 * Adding them one at a time is a treadmill: the next pack invents the next field.
 *
 * THE MECHANISM, AND WHY IT IS ANSWERABLE NOW. `resolveOpenRebindVerdict` names
 * exactly ONE reason a content difference might mean loss (quoted as that comment read
 * before this landed — it now points at the discriminator instead):
 *
 *   "`loadGraphData` catches a `configure()` failure and returns. A throw in that
 *    second pass leaves the complete node id/type set, the links, and the panel's
 *    marker over nodes that silently LOST their widget values and properties. That
 *    is byte-for-byte the same observation as 'the loader normalized the widget
 *    values', and no discriminator available to the panel separates them."
 *
 * MEASURED against the frontend source (`LGraph.prototype.configure`, the build
 * #1260 was measured on): the node pass is a bare loop, `node?.configure(nodeData)`,
 * with no try/catch of its own and none between it and `loadGraphData`'s. So a THROW
 * is the only way that partial load can present — out of a node's configure, or out
 * of the graph restore itself.
 *
 * Both are observable, and the panel already owned half of it:
 * `installNodeConfigureIsolation` records per-node throws (#1260, on `graph_load`),
 * and `installGraphConfigureWatch` (added here) records a throw out of the restore.
 * `workflow_open` now installs both, so `loadRanToCompletion` REFUTES that hypothesis
 * per load, by observation. That is the discriminator the comment said did not exist.
 *
 * WHAT THIS DOES NOT CLAIM, and the tests below hold the line: it never says the
 * differing values are the file's values. It says the restore did not stop early, so
 * nothing was dropped by a load that aborted — and it NAMES the fields on the reply
 * (`content_normalized`) rather than vouching for them.
 *
 * WHAT STILL REFUSES: a changed node set, any surface but `nodes` (an unaccounted
 * `definitions` block included), a recorded throw, and a frontend that could not be
 * instrumented at all.
 *
 * comfyui-mcp#1706 was a DIFFERENT mechanism and was deliberately left failing here.
 * It has since been characterised — the frontend also renumbers subgraph NODE ids on
 * load — so the caller now ACCOUNTS for that difference before this predicate sees the
 * surface list, and only an unaccounted `definitions` block reaches it. This file's
 * refusal is unchanged; what changed is which differences arrive as unaccounted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  openContentDifferenceIsCompletedLoadNormalization,
  graphRootReproducesStateContent,
  describeOpenRebindOutcome,
  resolveOpenRebindVerdict,
  OPEN_REBIND_STATUS,
} from "../../web/js/lib/graph-binding.js";
import {
  installGraphConfigureWatch,
  installNodeConfigureIsolation,
  loadRestoreCompleted,
} from "../../web/js/lib/load-restore-isolation.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));

const node = (id, type, extra = {}) => ({
  id,
  type,
  pos: [0, 0],
  size: [200, 100],
  order: 0,
  widgets_values: ["a"],
  ...extra,
});
const rootOf = (state) => ({ serialize: () => JSON.parse(JSON.stringify(state)) });
const stateOf = (nodes, extra = {}) => ({ nodes, links: [], groups: [], config: {}, extra: {}, ...extra });
const differing = (fields) => ({ comparable: true, sameNodeSet: true, cosmeticOnly: false, fields });

// ── the predicate ────────────────────────────────────────────────────────────

test("panel#1283 a watched, completed restore whose only surface is `nodes` is normalization", () => {
  for (const fields of [
    ["order", "size", "widgets_values"], // #1283, #1285
    ["size", "widgets_values"], // #1307
    ["outputs", "size"], // #1330
    ["inputs", "outputs", "properties", "widgets_values", "widgets_values_named"], // #1705
  ]) {
    assert.equal(
      openContentDifferenceIsCompletedLoadNormalization({
        comparable: true,
        surfaces: ["nodes"],
        nodeDifference: differing(fields),
        loadRanToCompletion: true,
      }),
      true,
      `${fields.join(", ")} — every reported field set must pass`,
    );
  }
});

test("panel#1283 a load that was NOT watched is UNKNOWN, and unknown is not a yes", () => {
  // `null` is what `loadRestoreCompleted` answers when either wrap could not be
  // installed. Reading it as truthy would license the open on a frontend whose restore
  // the panel cannot see at all — the exact two-states-one-answer fold this predicate
  // exists to undo.
  for (const observation of [null, undefined, false, "true", 1, {}]) {
    assert.equal(
      openContentDifferenceIsCompletedLoadNormalization({
        comparable: true,
        surfaces: ["nodes"],
        nodeDifference: differing(["widgets_values"]),
        loadRanToCompletion: observation,
      }),
      false,
      `${JSON.stringify(observation)} must not license the open`,
    );
  }
});

test("panel#1283 a recorded throw still refuses — that IS the partial load", () => {
  assert.equal(
    openContentDifferenceIsCompletedLoadNormalization({
      comparable: true,
      surfaces: ["nodes"],
      nodeDifference: differing(["widgets_values"]),
      loadRanToCompletion: false,
    }),
    false,
  );
});

test("panel#1283 a changed node SET refuses however complete the restore was", () => {
  // A node that vanished, appeared or was retyped is the shape real loss takes, and a
  // restore that ran to the end does not produce it. `sameNodeSet:false` arrives with an
  // EMPTY field list, so both checks below matter.
  for (const diff of [
    { comparable: true, sameNodeSet: false, cosmeticOnly: false, fields: [] },
    { comparable: false, sameNodeSet: false, cosmeticOnly: false, fields: [] },
    { comparable: true, sameNodeSet: true, cosmeticOnly: false, fields: [] },
    null,
  ]) {
    assert.equal(
      openContentDifferenceIsCompletedLoadNormalization({
        comparable: true,
        surfaces: ["nodes"],
        nodeDifference: diff,
        loadRanToCompletion: true,
      }),
      false,
      `${JSON.stringify(diff)} must refuse`,
    );
  }
});

test("panel#1283 the SET check is not redundant with the field list — this predicate is exported", () => {
  // MEASURED by mutation: deleting the `sameNodeSet`/`comparable` line above killed no
  // test, because `classifyNodeDifference` only computes `fields` once the sets match, so
  // everything IT produces arrives with an empty list and the field check catches it.
  // This function is EXPORTED, though, so it must refuse an INCONSISTENT shape rather
  // than let a set difference through on a field list somebody else built — the same
  // lesson #1623's own predicate had to learn.
  for (const diff of [
    { comparable: true, sameNodeSet: false, cosmeticOnly: false, fields: ["widgets_values"] },
    { comparable: false, sameNodeSet: true, cosmeticOnly: false, fields: ["widgets_values"] },
    { comparable: false, sameNodeSet: false, cosmeticOnly: false, fields: ["size", "outputs"] },
  ]) {
    assert.equal(
      openContentDifferenceIsCompletedLoadNormalization({
        comparable: true,
        surfaces: ["nodes"],
        nodeDifference: diff,
        loadRanToCompletion: true,
      }),
      false,
      `${JSON.stringify(diff)} is inconsistent and must refuse`,
    );
  }
});

test("panel#1283 any surface but `nodes` refuses — a completed node pass explains nothing else", () => {
  for (const surfaces of [
    ["links"],
    ["groups"],
    ["nodes", "links"],
    ["nodes", "definitions"], // an UNACCOUNTED definitions block (the caller filters accounted ones out)
    ["definitions"],
    ["reroutes"],
    ["extra"],
    [],
  ]) {
    assert.equal(
      openContentDifferenceIsCompletedLoadNormalization({
        comparable: true,
        surfaces,
        nodeDifference: differing(["widgets_values"]),
        loadRanToCompletion: true,
      }),
      false,
      `${surfaces.join("+") || "(empty)"} must refuse`,
    );
  }
});

test("panel#1283 a comparison that never happened proves nothing", () => {
  assert.equal(
    openContentDifferenceIsCompletedLoadNormalization({
      comparable: false,
      surfaces: ["nodes"],
      nodeDifference: differing(["widgets_values"]),
      loadRanToCompletion: true,
    }),
    false,
  );
  assert.equal(openContentDifferenceIsCompletedLoadNormalization(), false);
});

// ── the content proof ────────────────────────────────────────────────────────

test("panel#1307 the reporter's own case: size + widgets_values, restore watched and complete", () => {
  const state = stateOf([node(1, "KSampler"), node(2, "CLIPTextEncode")]);
  const live = stateOf([
    { ...node(1, "KSampler"), size: [200, 130], widgets_values: ["a", "fixed"] },
    node(2, "CLIPTextEncode"),
  ]);
  const proof = graphRootReproducesStateContent({
    rootGraph: rootOf(live),
    state,
    loadRanToCompletion: true,
  });
  // NOT `proven`: nothing here characterised the widget rewrite, and this ground does
  // not pretend it did.
  assert.equal(proof.proven, false);
  assert.equal(proof.presentationOnly, false, "widgets_values is not cosmetic and must not become so");
  assert.equal(proof.normalizedOnly, true);
  assert.deepEqual(proof.normalizedFields, ["size", "widgets_values"]);
});

test("panel#1330 outputs + size — the field `inputs` got characterised for and `outputs` never did", () => {
  const state = stateOf([node(1, "KSampler", { outputs: [{ name: "LATENT", type: "LATENT", links: [4] }] })]);
  const live = stateOf([
    {
      ...node(1, "KSampler"),
      size: [220, 100],
      outputs: [{ name: "LATENT", type: "LATENT", links: [4], slot_index: 0 }],
    },
  ]);
  const proof = graphRootReproducesStateContent({
    rootGraph: rootOf(live),
    state,
    loadRanToCompletion: true,
  });
  assert.equal(proof.normalizedOnly, true);
  assert.deepEqual(proof.normalizedFields, ["outputs", "size"]);
});

test("comfyui-mcp#1705 `nodes` PLUS a definitions block that is only link renumbering", () => {
  // The reporter's surfaces were `nodes, definitions`. #886 measured that loading any
  // workflow containing subgraphs regenerates link ids inside `definitions.subgraphs`,
  // and `describeGraphStateDifference` already runs the fail-closed predicate that says
  // so. A surface already accounted for must not count as a second unexplained one —
  // #1588's own rule, applied to this ground too.
  const sub = (lastLinkId, links) => ({
    subgraphs: [
      {
        id: "sg-1",
        name: "detailer",
        nodes: [{ id: 9, type: "VAEDecode", inputs: [], outputs: [] }],
        links,
        state: { lastLinkId, lastNodeId: 9 },
      },
    ],
  });
  const state = stateOf([node(1, "KSampler")], { definitions: sub(2092, [[2092, 9, 0, 9, 0, "IMAGE"]]) });
  const live = stateOf([{ ...node(1, "KSampler"), widgets_values: ["a", "fixed"], properties: { ver: "2" } }], {
    definitions: sub(2106, [[2106, 9, 0, 9, 0, "IMAGE"]]),
  });
  const proof = graphRootReproducesStateContent({
    rootGraph: rootOf(live),
    state,
    loadRanToCompletion: true,
  });
  assert.equal(proof.normalizedOnly, true, "an accounted definitions surface is not a second difference");
  assert.deepEqual(proof.normalizedFields, ["properties", "widgets_values"]);
});

// RE-ARMED, not relaxed (comfyui-mcp#1706). When this test was written the node-id
// rewrite had no characterisation, so the honest answer was to refuse it and say so.
// It has one now — measured on the rig, see `definitions-renumber.js` — and the two
// halves of that are pinned separately: the renumber IS accounted, and a definitions
// difference that is NOT one still refuses. The second half is what the original
// assertion was protecting, and it is unchanged.
test("comfyui-mcp#1706 the subgraph NODE-id renumber is accounted, on a definitions-only diff", () => {
  // The frontend renumbers a definition's node ids and patches that definition's links
  // through the same map (`deduplicateSubgraphNodeIds`). Root nodes come back identical,
  // which is exactly the reported shape: identity confirmed, nodes matching, only
  // `definitions` differing.
  const defs = (a, b) => ({
    subgraphs: [
      {
        id: "sg-1",
        name: "d",
        nodes: [
          { id: a, type: "VAEDecode", widgets_values: [] },
          { id: b, type: "PreviewImage", widgets_values: [] },
        ],
        links: [[11, a, 0, b, 0, "IMAGE"]],
        state: { lastNodeId: a },
      },
    ],
  });
  const state = stateOf([node(1, "KSampler")], { definitions: defs(9, 10) });
  const live = stateOf([node(1, "KSampler")], { definitions: defs(41, 42) });
  const proof = graphRootReproducesStateContent({
    rootGraph: rootOf(live),
    state,
    loadRanToCompletion: true,
  });
  assert.equal(proof.proven, true, "a definitions-only relabeling is the whole difference");
});

test("comfyui-mcp#1706 a definitions difference that is NOT renumbering still refuses", () => {
  // Same relabeling, and one node ALSO retyped. A relabeling never changes what a node
  // is, so this is not one — and `definitions` is not `nodes`, so no other ground here
  // may smuggle it through.
  const defs = (a, b, secondType) => ({
    subgraphs: [
      {
        id: "sg-1",
        name: "d",
        nodes: [
          { id: a, type: "VAEDecode", widgets_values: [] },
          { id: b, type: secondType, widgets_values: [] },
        ],
        links: [[11, a, 0, b, 0, "IMAGE"]],
        state: { lastNodeId: a },
      },
    ],
  });
  const state = stateOf([node(1, "KSampler")], { definitions: defs(9, 10, "PreviewImage") });
  const live = stateOf([node(1, "KSampler")], { definitions: defs(41, 42, "SaveImage") });
  const proof = graphRootReproducesStateContent({
    rootGraph: rootOf(live),
    state,
    loadRanToCompletion: true,
  });
  assert.equal(proof.proven, false);
  assert.equal(proof.normalizedOnly, false);
});

test("panel#1283 a LOST node is refused even with the restore watched and complete", () => {
  const state = stateOf([node(1, "KSampler"), node(2, "CLIPTextEncode")]);
  const live = stateOf([node(1, "KSampler")]);
  const proof = graphRootReproducesStateContent({
    rootGraph: rootOf(live),
    state,
    loadRanToCompletion: true,
  });
  assert.equal(proof.proven, false);
  assert.equal(proof.normalizedOnly, false);
});

test("panel#1283 a lost LINK is refused — the node pass says nothing about links", () => {
  const state = stateOf([node(1, "KSampler")], { links: [[1, 1, 0, 2, 0, "LATENT"]] });
  const live = stateOf([{ ...node(1, "KSampler"), widgets_values: ["b"] }], { links: [] });
  const proof = graphRootReproducesStateContent({
    rootGraph: rootOf(live),
    state,
    loadRanToCompletion: true,
  });
  assert.equal(proof.normalizedOnly, false);
});

test("panel#1283 without the observation the old refusal is unchanged", () => {
  // The whole reported family, on a caller that does not pass `loadRanToCompletion`:
  // byte-for-byte the pre-fix answer. Nothing widened by default.
  const state = stateOf([node(1, "KSampler")]);
  const live = stateOf([{ ...node(1, "KSampler"), widgets_values: ["CHANGED"] }]);
  const proof = graphRootReproducesStateContent({ rootGraph: rootOf(live), state });
  assert.equal(proof.proven, false);
  assert.equal(proof.presentationOnly, false);
  assert.equal(proof.normalizedOnly, false);
  assert.deepEqual(proof.normalizedFields, []);
});

// ── the observation itself ───────────────────────────────────────────────────

const fakeLG = () => ({
  LGraph: { prototype: { configure() { return "graph-ok"; } } },
  LGraphNode: { prototype: { configure() { return "node-ok"; } } },
});

test("panel#1283 the graph watch OBSERVES and re-throws — it never changes control flow", () => {
  const LG = fakeLG();
  const boom = new Error("groups blew up");
  LG.LGraph.prototype.configure = function () {
    throw boom;
  };
  const watch = installGraphConfigureWatch(LG);
  assert.throws(() => LG.LGraph.prototype.configure({}), /groups blew up/, "the throw must still reach the caller");
  assert.deepEqual(watch.throws, ["groups blew up"]);
  watch.restore();
  assert.throws(() => LG.LGraph.prototype.configure({}), /groups blew up/);
  assert.equal(watch.throws.length, 1, "a restored watch records nothing further");
});

test("panel#1283 the graph watch passes a normal call straight through", () => {
  const LG = fakeLG();
  const watch = installGraphConfigureWatch(LG);
  assert.equal(LG.LGraph.prototype.configure({ nodes: [] }), "graph-ok");
  assert.deepEqual(watch.throws, []);
  watch.restore();
  assert.equal(typeof LG.LGraph.prototype.configure, "function");
});

test("panel#1283 an uninstrumentable frontend answers null, never false", () => {
  for (const LG of [null, undefined, {}, { LGraph: {} }, { LGraph: { prototype: {} } }]) {
    assert.equal(installGraphConfigureWatch(LG), null, `${JSON.stringify(LG)}`);
  }
  // …and the fold reports UNKNOWN when either half is missing. "Nobody looked" must not
  // read as "nothing threw".
  assert.equal(loadRestoreCompleted({ nodeIsolation: null, graphWatch: { throws: [] } }), null);
  assert.equal(loadRestoreCompleted({ nodeIsolation: { failures: [] }, graphWatch: null }), null);
  assert.equal(loadRestoreCompleted({}), null);
  assert.equal(loadRestoreCompleted(), null);
  // A malformed record is unknown too, not a clean bill.
  assert.equal(loadRestoreCompleted({ nodeIsolation: { failures: "none" }, graphWatch: { throws: [] } }), null);
});

test("panel#1283 the fold is true only when BOTH halves looked and neither saw a throw", () => {
  // `entered: 1` is part of "looked" — see the F1 section at the foot of this file.
  const watched = (throws) => ({ throws, entered: 1 });
  assert.equal(loadRestoreCompleted({ nodeIsolation: { failures: [] }, graphWatch: watched([]) }), true);
  assert.equal(
    loadRestoreCompleted({ nodeIsolation: { failures: [{ id: 3 }] }, graphWatch: watched([]) }),
    false,
  );
  assert.equal(loadRestoreCompleted({ nodeIsolation: { failures: [] }, graphWatch: watched(["x"]) }), false);
});

test("panel#1283 both wraps compose: a node throw is contained, the graph throw is not", () => {
  const LG = fakeLG();
  LG.LGraphNode.prototype.configure = function () {
    throw new Error("FaceDetailer widgets not built");
  };
  const nodeIsolation = installNodeConfigureIsolation(LG);
  const graphWatch = installGraphConfigureWatch(LG);
  // The graph restore runs — so the watch is ENTERED and this is not the un-watched
  // case the F1 section below is about.
  assert.equal(LG.LGraph.prototype.configure({ nodes: [] }), "graph-ok");
  assert.equal(graphWatch.entered, 1);
  // The node throw is swallowed and RECORDED (#1260's contract, unchanged)…
  assert.equal(LG.LGraphNode.prototype.configure({ id: 7, type: "FaceDetailer" }), undefined);
  assert.equal(nodeIsolation.failures.length, 1);
  // …so it never reaches the graph watch, which stays clean and independent.
  assert.deepEqual(graphWatch.throws, []);
  assert.equal(loadRestoreCompleted({ nodeIsolation, graphWatch }), false);
  graphWatch.restore();
  nodeIsolation.restore();
});

// ── the disclosure ───────────────────────────────────────────────────────────

test("panel#1283 a refusal on an ABORTED restore names what aborted it", () => {
  const msg = describeOpenRebindOutcome(
    resolveOpenRebindVerdict({
      instanceStillTarget: true,
      markerMatches: true,
      identityMatches: true,
      contentMatches: false,
    }),
    {
      targetLabel: "detailer.json",
      contentComparable: true,
      contentSurfaces: ["nodes"],
      contentNodeDifference: differing(["widgets_values"]),
      contentLoadRanToCompletion: false,
      contentRestoreFailures: [{ id: 7, type: "FaceDetailer", error: "widgets not built" }],
    },
  );
  assert.match(msg, /DID NOT RUN TO COMPLETION/);
  assert.match(msg, /FaceDetailer \(id 7\): widgets not built/);
  assert.match(msg, /part of what was loaded never landed/);
  // …and the HEADLINE must not contradict it. Both pre-existing headlines were written
  // for a load that completed: one says there is no missing work to redo, the other says
  // the panel cannot tell normalization from a partial load. The panel CAN tell here, and
  // the answer is the partial load.
  assert.doesNotMatch(msg, /no missing work to redo/i);
  assert.doesNotMatch(msg, /cannot tell from here whether/i);
  assert.doesNotMatch(msg, /cannot tell whether the ComfyUI frontend merely normalized/i);
  assert.match(msg, /RESTORE ITSELF DID NOT FINISH/);
  assert.match(msg, /Do NOT save from here/);
  assert.match(msg, /carries NO fence refresh/, "the recovery #702 added must still ride along");
});

test("panel#1283 an aborted restore whose difference is only COSMETIC still refuses, and says so", () => {
  // The dangerous combination: `pos` moved (cosmetic) AND a node threw. #1623's reassurance
  // would have fired — "you are on the right workflow and there is no missing work to redo" —
  // over a node sitting at construction defaults. The proof vetoes the ground; this asserts
  // the SENTENCE is vetoed too, on the same observation.
  const msg = describeOpenRebindOutcome(
    resolveOpenRebindVerdict({
      instanceStillTarget: true,
      markerMatches: true,
      identityMatches: true,
      contentMatches: false,
    }),
    {
      targetLabel: "detailer.json",
      contentComparable: true,
      contentSurfaces: ["nodes"],
      contentNodeDifference: { comparable: true, sameNodeSet: true, cosmeticOnly: true, fields: ["pos"] },
      contentLoadRanToCompletion: false,
      contentRestoreFailures: [{ id: 7, type: "FaceDetailer", error: "widgets not built" }],
    },
  );
  assert.doesNotMatch(msg, /no missing work to redo/i);
  assert.match(msg, /RESTORE ITSELF DID NOT FINISH/);
});

test("panel#1283 a restore that aborted but left nothing unrestored may NOT claim values are missing", () => {
  const msg = describeOpenRebindOutcome(
    resolveOpenRebindVerdict({
      instanceStillTarget: true,
      markerMatches: true,
      identityMatches: true,
      contentMatches: false,
    }),
    {
      targetLabel: "detailer.json",
      contentComparable: true,
      contentSurfaces: ["nodes"],
      contentNodeDifference: differing(["widgets_values"]),
      contentLoadRanToCompletion: false,
      contentRestoreFailures: [],
    },
  );
  assert.match(msg, /DID NOT RUN TO COMPLETION/i);
  assert.doesNotMatch(msg, /part of what was loaded never landed/, "nothing observed supports that claim");
  assert.match(msg, /No node is still reported\s+unrestored/);
});

test("panel#1283 an UNWATCHED load gets no sentence about completion at all", () => {
  // `null` is the pre-existing state of knowledge. Narrating it in either direction
  // would state a reading nobody took.
  for (const observation of [null, undefined]) {
    const msg = describeOpenRebindOutcome(
      resolveOpenRebindVerdict({
        instanceStillTarget: true,
        markerMatches: true,
        identityMatches: true,
        contentMatches: false,
      }),
      {
        targetLabel: "detailer.json",
        contentComparable: true,
        contentSurfaces: ["nodes"],
        contentNodeDifference: differing(["widgets_values"]),
        contentLoadRanToCompletion: observation,
      },
    );
    assert.equal(
      resolveOpenRebindVerdict({
        instanceStillTarget: true,
        markerMatches: true,
        identityMatches: true,
        contentMatches: false,
      }).status,
      OPEN_REBIND_STATUS.CONTENT_UNVERIFIED,
    );
    assert.doesNotMatch(msg, /RUN TO COMPLETION/i, `${observation} must produce no completion claim`);
  }
});

// ── wiring: production must actually reach all of this ───────────────────────

test("panel#1283 wiring: workflow_open installs BOTH wraps around its own load", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const openAt = src.indexOf("async workflow_open({");
  assert.notEqual(openAt, -1);
  const repaintAt = src.indexOf("const targetUuid = workflowStableUuid", openAt);
  const repaint = src.slice(repaintAt, src.indexOf("} catch (err)", repaintAt));
  // The wraps must be installed BEFORE the load — a wrapper installed afterwards
  // observes nothing, and the whole ground rests on this ordering.
  const nodeWrapAt = repaint.indexOf("installNodeConfigureIsolation(LGForOpen)");
  const graphWrapAt = repaint.indexOf("installGraphConfigureWatch(LGForOpen)");
  const loadAt = repaint.indexOf("await app.loadGraphData(repaintState, true, true, target);");
  assert.notEqual(nodeWrapAt, -1, "the node-configure isolation must be installed on the open path");
  assert.notEqual(graphWrapAt, -1, "the graph-configure watch must be installed on the open path");
  assert.notEqual(loadAt, -1);
  assert.ok(nodeWrapAt < loadAt, "a wrap installed after the load observes nothing");
  assert.ok(graphWrapAt < loadAt, "a wrap installed after the load observes nothing");
  // …and removed again, in a finally, before anything reads the graph. A wrapper left
  // live would keep swallowing throws from unrelated later edits.
  assert.match(
    repaint,
    /} finally \{[\s\S]{0,400}?nodeIsolation\?\.restore\(\);[\s\S]{0,80}?graphWatch\?\.restore\(\);/,
  );
});

test("panel#1283 wiring: the observation is FOLDED and reaches the proof and the message", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const openAt = src.indexOf("async workflow_open({");
  const repaintAt = src.indexOf("const targetUuid = workflowStableUuid", openAt);
  const repaint = src.slice(repaintAt, src.indexOf("} catch (err)", repaintAt));
  assert.match(
    repaint,
    /const loadRanToCompletion = loadRestoreCompleted\(\{ nodeIsolation, graphWatch \}\);/,
    "the two observations must be folded by the helper that keeps `unknown` representable",
  );
  // It must reach the PROOF — this is the one line whose deletion silently restores the
  // whole reported bug while every predicate test above stays green.
  assert.match(
    repaint,
    /graphRootReproducesStateContent\(\{[\s\S]{0,600}?loadRanToCompletion,[\s\S]{0,80}?\}\);/,
    "the proof must be asked with the observation",
  );
  // …and the MESSAGE, so an aborted restore is named rather than left to guesswork.
  assert.match(repaint, /contentLoadRanToCompletion: loadRanToCompletion,/);
  assert.match(repaint, /contentRestoreFailures: openRestoreFailures,/);
});

test("panel#1283 wiring: the third ground gets its OWN reply key and its own note", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  // Borrowing `geometry_rewritten_note` would assert a characterised height-only
  // rewrite, and borrowing `presentation_rewritten_note` would assert that every
  // content-bearing field matched. Neither is established here.
  assert.match(src, /content_normalized: openContentNormalized,/);
  assert.match(src, /content_normalized_note:/);
  const noteAt = src.indexOf("content_normalized_note:");
  const note = src.slice(noteAt, src.indexOf("}", src.indexOf("`,", noteAt)));
  assert.doesNotMatch(note, /width unchanged/i, "no height-only claim was established here");
  assert.doesNotMatch(note, /no missing work to redo/i, "nothing here vouches for the values");
  assert.match(note, /read it with panel_graph_outline/, "a widget value is content — say how to check it");
  // Assigned from the ground that earned it, and from nothing else.
  const assignments = [...src.matchAll(/(?<!let )openContentNormalized = ([^;\n]+);/g)].map((m) => m[1]);
  assert.deepEqual(assignments, ["contentProof.normalizedFields"]);
  // Gated on the ground that earned it, AND on the stronger one not having earned it
  // first: a cosmetic difference on a completed restore satisfies both, and two keys for
  // one observation would make the reply say two different-sized things about the same
  // fields.
  const guardAt = src.indexOf("if (contentProof.normalizedOnly && !contentProof.presentationOnly) {");
  assert.notEqual(guardAt, -1);
  assert.ok(guardAt < src.indexOf("openContentNormalized = contentProof.normalizedFields;"));
});

test("panel#1283 a cosmetic difference keeps #1623's stronger disclosure, not this weaker one", () => {
  // `pos`/`order` on a watched, completed restore: BOTH grounds are true. The reply must
  // carry `presentation_rewritten` (every content-bearing field matched) and NOT also
  // `content_normalized` (the panel observed the difference and not its cause).
  const state = stateOf([node(1, "KSampler")]);
  const live = stateOf([{ ...node(1, "KSampler"), pos: [40, 40], order: 3 }]);
  const proof = graphRootReproducesStateContent({
    rootGraph: rootOf(live),
    state,
    loadRanToCompletion: true,
  });
  assert.equal(proof.presentationOnly, true, "#1623's ground still fires");
  assert.equal(proof.normalizedOnly, true, "and so does this one — which is why the call site picks");
  assert.deepEqual(proof.fields, ["order", "pos"]);
});

test("panel#1283 a RECORDED THROW vetoes #1623's cosmetic ground too — the hole the wrap opens", () => {
  // Before this change `workflow_open` did not contain a per-node configure throw, so a
  // throwing node aborted the restore and links/groups never landed — refused on the
  // surface list. Containing it means the rest of the graph restores and the throwing node
  // sits at CONSTRUCTION DEFAULTS, `pos: [10, 10]` among them — and `pos` is cosmetic. A
  // node whose saved state differed from its defaults only in position would otherwise be
  // waved through as "nothing authored was lost" with the user's layout for it gone.
  const state = stateOf([node(1, "KSampler", { pos: [900, 640] })]);
  const live = stateOf([{ ...node(1, "KSampler"), pos: [10, 10] }]);
  const asked = { rootGraph: rootOf(live), state };
  assert.equal(
    graphRootReproducesStateContent({ ...asked, loadRanToCompletion: true }).presentationOnly,
    true,
    "a completed restore keeps #1623's answer",
  );
  assert.equal(
    graphRootReproducesStateContent({ ...asked, loadRanToCompletion: false }).presentationOnly,
    false,
    "a recorded throw must veto it",
  );
  // …and a caller that never asked the question is unaffected — every caller but the open.
  assert.equal(graphRootReproducesStateContent(asked).presentationOnly, true);
  // `proven` is deliberately NOT vetoed: byte equality means nothing was lost, whatever threw.
  const exact = graphRootReproducesStateContent({
    rootGraph: rootOf(state),
    state,
    loadRanToCompletion: false,
  });
  assert.equal(exact.proven, true);
  assert.equal(exact.exact, true);
});

test("panel#1283 wiring: a node the retry HEALED is disclosed on the success reply", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(src, /nodes_restored_on_retry: openRestoreRetried,/);
  assert.match(src, /nodes_restored_on_retry_note:/);
  const assignments = [...src.matchAll(/(?<!let )openRestoreRetried = ([^;\n]+);/g)].map((m) => m[1]);
  assert.deepEqual(assignments, ["retry.restored"]);
});

test("panel#1283 wiring: a node the retry could not heal is still disclosed on the open path", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const openAt = src.indexOf("async workflow_open({");
  const repaintAt = src.indexOf("const targetUuid = workflowStableUuid", openAt);
  const repaint = src.slice(repaintAt, src.indexOf("} catch (err)", repaintAt));
  assert.match(repaint, /retryNodeRestores\(app\?\.graph, containedNodeFailureList\)/);
  assert.match(repaint, /openRestoreFailures = retry\.failed;/);
});

// ── F1: INSTALLED IS NOT ENTERED (post-merge review of #1358) ────────────────

/**
 * #1358's own two-states-one-answer fold, one level down from the one it fixed.
 *
 * The fold licensed "the restore ran to completion" off two EMPTY records. Empty
 * means "nothing threw" — or "the wrapper was installed on a method nothing called".
 * Wrapping a prototype proves the method EXISTS; it proves nothing about whether
 * this frontend's restore went THROUGH it.
 *
 * No test written against the wrappers can see that, because a test that drives a
 * wrapper always enters it. This fixture deliberately does not: the root graph
 * carries its OWN `configure` and never calls `super`, which is a frontend
 * restructure the panel does not control. The abort then happens where nothing is
 * watching, both records stay empty, and a genuinely partial load is waved through
 * as "normalization" — precisely the harm #1358 exists to prevent.
 */
function frontendWhoseRootBypassesLGraphPrototype() {
  class LGraphNode {
    constructor(id, type) {
      this.id = id;
      this.type = type;
      this.widgets_values = ["construction-default"];
    }
    configure(info) {
      this.widgets_values = info.widgets_values;
      return "node-ok";
    }
  }
  class LGraph {
    // The prototype method `installGraphConfigureWatch` wraps. Present and wrappable —
    // and never reached by the root graph's restore on this frontend.
    configure() {
      throw new Error("LGraph.prototype.configure was reached — the fixture is wrong");
    }
  }
  class RootGraph extends LGraph {
    constructor(nodes) {
      super();
      this.nodes = nodes;
    }
    // Its OWN restore, with no `super.configure`. The node loop still dispatches
    // through `LGraphNode.prototype`, so the NODE wrapper is entered — which is why
    // a node-level counter would not have caught this.
    configure(state) {
      for (const info of state.nodes) {
        // The abort. Node 2 and everything after it keep construction defaults.
        // `loadGraphData`'s own catch swallows this, exactly as production does.
        if (info.id === 2) throw new Error("reroute validation blew up mid-restore");
        this.nodes.find((n) => n.id === info.id)?.configure(info);
      }
    }
    serialize() {
      return stateOf(
        this.nodes.map((n) => node(n.id, n.type, { widgets_values: n.widgets_values })),
      );
    }
  }
  return { LG: { LGraph, LGraphNode }, RootGraph };
}

/** Run one load on that frontend, exactly as `workflow_open` runs it. */
function runBypassedLoad() {
  const { LG, RootGraph } = frontendWhoseRootBypassesLGraphPrototype();
  const root = new RootGraph([new LG.LGraphNode(1, "KSampler"), new LG.LGraphNode(2, "FaceDetailer")]);
  const payload = stateOf([
    node(1, "KSampler", { widgets_values: ["authored-1"] }),
    node(2, "FaceDetailer", { widgets_values: ["authored-2"] }),
  ]);
  const nodeIsolation = installNodeConfigureIsolation(LG);
  const graphWatch = installGraphConfigureWatch(LG);
  try {
    try {
      root.configure(payload);
    } catch {
      // `loadGraphData`'s own catch. The restore aborted; nothing propagates.
    }
  } finally {
    nodeIsolation.restore();
    graphWatch.restore();
  }
  return { root, payload, nodeIsolation, graphWatch };
}

test("panel#1283 F1: a watch installed on a method the restore never calls is UNKNOWN, not completed", () => {
  const { root, nodeIsolation, graphWatch } = runBypassedLoad();
  assert.ok(nodeIsolation && graphWatch, "both wraps INSTALL on this frontend — that is the trap");

  // Everything #1358 looked at reads "clean".
  assert.deepEqual(nodeIsolation.failures, [], "no node throw was contained…");
  assert.deepEqual(graphWatch.throws, [], "…and no graph throw was seen");
  // …because nothing watched. The NODE wrapper was entered — gating on it would not
  // have caught this — and the graph watch was not.
  assert.equal(nodeIsolation.entered, 1, "the node wrapper ran for the one node that restored");
  assert.equal(graphWatch.entered, 0, "the graph watch was installed and NEVER entered");
  // And the load really was partial: node 2 sits at construction defaults.
  assert.deepEqual(root.serialize().nodes[1].widgets_values, ["construction-default"]);

  // The fold must therefore say UNKNOWN. #1358 as shipped said `true` here.
  assert.equal(loadRestoreCompleted({ nodeIsolation, graphWatch }), null);
});

test("panel#1283 F1: the consuming ground does not fire, and `null` degrades to pre-#1358 behaviour", () => {
  const { root, payload, nodeIsolation, graphWatch } = runBypassedLoad();
  const observed = loadRestoreCompleted({ nodeIsolation, graphWatch });
  assert.equal(observed, null);

  const proof = graphRootReproducesStateContent({ rootGraph: root, state: payload, loadRanToCompletion: observed });
  assert.equal(proof.proven, false);
  assert.equal(proof.normalizedOnly, false, "a load nobody watched may not be called normalization");
  assert.deepEqual(proof.normalizedFields, []);

  // THE REFUTATION, in the same test. The ONLY input that differs is the observation:
  // with the answer #1358 shipped, the lost widget value is waved through.
  const asShipped = graphRootReproducesStateContent({ rootGraph: root, state: payload, loadRanToCompletion: true });
  assert.equal(asShipped.normalizedOnly, true, "…which is exactly what the shipped fold answered");
  assert.deepEqual(asShipped.normalizedFields, ["widgets_values"]);

  // `null`, not `false`: the consumer's ground is licensed on `=== true`, and #1623's
  // WEAKER ground is vetoed on `=== false`. So unknown must degrade to the pre-#1358
  // path — identical to a caller that never asked the question — and not to a new
  // refusal that #1358 was never entitled to introduce.
  const neverAsked = graphRootReproducesStateContent({ rootGraph: root, state: payload });
  assert.equal(proof.presentationOnly, neverAsked.presentationOnly);
  assert.deepEqual(proof.fields, neverAsked.fields);
  assert.equal(
    graphRootReproducesStateContent({ rootGraph: root, state: payload, loadRanToCompletion: false })
      .presentationOnly,
    false,
    "…and `false` still vetoes it, which is the behaviour `null` must NOT borrow",
  );
});

test("panel#1283 F1: gating on the NODE count would manufacture a false unknown", () => {
  // This is why the veto is `graphWatch.entered` alone. An empty workflow restores
  // through the graph watch and configures NO nodes: `nodeIsolation.entered === 0` is
  // the correct reading there, and the load demonstrably ran to the end.
  const LG = fakeLG();
  const nodeIsolation = installNodeConfigureIsolation(LG);
  const graphWatch = installGraphConfigureWatch(LG);
  assert.equal(LG.LGraph.prototype.configure({ nodes: [] }), "graph-ok");
  nodeIsolation.restore();
  graphWatch.restore();
  assert.equal(nodeIsolation.entered, 0, "no node configured — an empty workflow");
  assert.equal(graphWatch.entered, 1);
  assert.equal(loadRestoreCompleted({ nodeIsolation, graphWatch }), true, "…and that IS a completed restore");
});

test("panel#1283 F1: a deactivated wrapper counts nothing — a pass-through is not an observation", () => {
  const LG = fakeLG();
  const inner = installGraphConfigureWatch(LG);
  const outer = installGraphConfigureWatch(LG);
  // Out of order, so the deactivated inner stays in the chain as a pass-through.
  inner.restore();
  assert.equal(LG.LGraph.prototype.configure({ nodes: [] }), "graph-ok");
  assert.equal(outer.entered, 1, "the active wrapper counted its entry");
  assert.equal(inner.entered, 0, "the deactivated one is a pass-through and counts nothing");
  outer.restore();
});

test("panel#1283 F1: a handle that cannot say whether it ran is UNKNOWN, not a pass", () => {
  const clean = { failures: [] };
  for (const graphWatch of [
    { throws: [] }, // no counter at all — a hand-rolled or stale handle
    { throws: [], entered: 0 },
    { throws: [], entered: -1 },
    { throws: [], entered: "1" },
    { throws: [], entered: null },
    { throws: [], entered: true },
    { throws: [], entered: Number.NaN }, // `< 1` would have let this through
  ]) {
    assert.equal(
      loadRestoreCompleted({ nodeIsolation: clean, graphWatch }),
      null,
      `entered=${String(graphWatch.entered)} must not license a completion`,
    );
  }
  assert.equal(loadRestoreCompleted({ nodeIsolation: clean, graphWatch: { throws: [], entered: 1 } }), true);
  assert.equal(loadRestoreCompleted({ nodeIsolation: clean, graphWatch: { throws: [], entered: 12 } }), true);
});

test("panel#1283 F1: the real handles expose `entered` as a live count, and a throw still counts", () => {
  const LG = fakeLG();
  LG.LGraph.prototype.configure = function () {
    throw new Error("groups blew up");
  };
  const watch = installGraphConfigureWatch(LG);
  assert.equal(watch.entered, 0, "installed, not yet entered");
  assert.throws(() => LG.LGraph.prototype.configure({}));
  // Counted on ENTRY: an aborted restore is the case the watch exists for, and a
  // counter bumped on the way out would read 0 for exactly it.
  assert.equal(watch.entered, 1);
  assert.equal(loadRestoreCompleted({ nodeIsolation: { failures: [] }, graphWatch: watch }), false);
  watch.restore();
});
