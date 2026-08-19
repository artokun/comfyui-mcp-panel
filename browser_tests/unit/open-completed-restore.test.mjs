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
 * exactly ONE reason a content difference might mean loss:
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
 * per load, by observation. That is the discriminator the comment says does not exist.
 *
 * WHAT THIS DOES NOT CLAIM, and the tests below hold the line: it never says the
 * differing values are the file's values. It says the restore did not stop early, so
 * nothing was dropped by a load that aborted — and it NAMES the fields on the reply
 * (`content_normalized`) rather than vouching for them.
 *
 * WHAT STILL REFUSES: a changed node set, any surface but `nodes` (an unaccounted
 * `definitions` block included — comfyui-mcp#1706 is a DIFFERENT mechanism and is
 * deliberately left failing here), a recorded throw, and a frontend that could not be
 * instrumented at all.
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
    ["nodes", "definitions"], // an UNACCOUNTED definitions block: comfyui-mcp#1706's shape
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

test("comfyui-mcp#1706 a definitions difference that is NOT renumbering still refuses", () => {
  // The reported case is two workflows sharing subgraph definition UUIDs, where the
  // frontend's root-graph configure DEDUPLICATES subgraph node ids against ids already
  // reserved by the definitions store. That is a different rewrite from #886's link
  // renumbering, it has no characterisation here, and this ground must not smuggle it
  // through: `definitions` is not `nodes`.
  const defs = (nodeId) => ({
    subgraphs: [{ id: "sg-1", name: "d", nodes: [{ id: nodeId, type: "VAEDecode" }], links: [], state: {} }],
  });
  const state = stateOf([node(1, "KSampler")], { definitions: defs(9) });
  const live = stateOf([node(1, "KSampler")], { definitions: defs(41) });
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
  assert.equal(loadRestoreCompleted({ nodeIsolation: { failures: [] }, graphWatch: { throws: [] } }), true);
  assert.equal(
    loadRestoreCompleted({ nodeIsolation: { failures: [{ id: 3 }] }, graphWatch: { throws: [] } }),
    false,
  );
  assert.equal(loadRestoreCompleted({ nodeIsolation: { failures: [] }, graphWatch: { throws: ["x"] } }), false);
});

test("panel#1283 both wraps compose: a node throw is contained, the graph throw is not", () => {
  const LG = fakeLG();
  LG.LGraphNode.prototype.configure = function () {
    throw new Error("FaceDetailer widgets not built");
  };
  const nodeIsolation = installNodeConfigureIsolation(LG);
  const graphWatch = installGraphConfigureWatch(LG);
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
  const guardAt = src.indexOf("if (contentProof.normalizedOnly) {");
  assert.notEqual(guardAt, -1);
  assert.ok(guardAt < src.indexOf("openContentNormalized = contentProof.normalizedFields;"));
});

test("panel#1283 wiring: a node the retry could not heal is still disclosed on the open path", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const openAt = src.indexOf("async workflow_open({");
  const repaintAt = src.indexOf("const targetUuid = workflowStableUuid", openAt);
  const repaint = src.slice(repaintAt, src.indexOf("} catch (err)", repaintAt));
  assert.match(repaint, /retryNodeRestores\(app\?\.graph, containedNodeFailureList\)/);
  assert.match(repaint, /openRestoreFailures = retry\.failed;/);
});
