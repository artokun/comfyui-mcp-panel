/**
 * #1618 — `panel_open_workflow` rewrote node size/order on a faithful load and
 * marked the tab modified. Saving then persisted hydration the user did not author.
 *
 * THE MECHANISM. `loadGraphData` / `configure` recomputes box height and
 * execution `order`. The open already treated those as presentation-only for
 * pass/fail (#1001 / #1623) and disclosed them, but left the live graph rewritten
 * and the change tracker dirty.
 *
 * THE FIX is the shipped `applySavedNodePresentation`: after the load, write the
 * payload's size/order back onto matching id+type nodes so the canvas — and a
 * later save — keep the authored presentation. Widget values, title, flags and
 * mode are never touched.
 *
 * These tests drive that function, then the same content proof `workflow_open`
 * uses, rather than re-deriving the comparison.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  applySavedNodePresentation,
  graphRootReproducesStateContent,
  classifyNodeDifference,
} from "../../web/js/lib/graph-binding.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const PANEL = readFileSync(PANEL_JS, "utf8");

const node = (id, type, extra = {}) => ({
  id,
  type,
  pos: [0, 0],
  size: [200, 100],
  order: 0,
  widgets_values: ["a"],
  ...extra,
});
const stateOf = (nodes) => ({ nodes, links: [], groups: [], config: {}, extra: {} });

function liveRootFrom(nodes) {
  return {
    _nodes: nodes,
    serialize: () => stateOf(nodes),
  };
}

test("#1618 restoring saved size/order makes the open content proof exact", () => {
  const saved = stateOf([
    node(1, "SaveVideo", { size: [1030, 358], order: 2 }),
    node(2, "LoadImage", { size: [225, 0], order: 0 }),
  ]);
  const liveNodes = [
    node(1, "SaveVideo", { size: [1030, 126], order: 0 }),
    node(2, "LoadImage", { size: [225, 22], order: 1 }),
  ];
  const live = liveRootFrom(liveNodes);
  const before = graphRootReproducesStateContent({ rootGraph: live, state: saved });
  assert.equal(before.exact, false, "the frontend rewrite is a real difference before restore");
  assert.equal(before.proven || before.presentationOnly, true, "it is still a faithful load");

  const applied = applySavedNodePresentation(live, saved);
  assert.equal(applied.restored, saved.nodes.length);

  const after = graphRootReproducesStateContent({ rootGraph: live, state: saved });
  assert.equal(after.proven, true);
  assert.equal(after.exact, true);
  assert.deepEqual(liveNodes[0].size, saved.nodes[0].size);
  assert.equal(liveNodes[0].order, saved.nodes[0].order);
  assert.deepEqual(liveNodes[1].size, saved.nodes[1].size);
  assert.equal(liveNodes[1].order, saved.nodes[1].order);
});

test("#1618 widget values are never overwritten — a partial load still fails the proof", () => {
  const liveWidgets = ["a", 7];
  const saved = stateOf([node(1, "KSampler", { size: [210, 90], order: 3, widgets_values: ["a", 42] })]);
  const liveNodes = [node(1, "KSampler", { size: [210, 40], order: 0, widgets_values: liveWidgets })];
  const live = liveRootFrom(liveNodes);
  applySavedNodePresentation(live, saved);
  assert.deepEqual(liveNodes[0].size, saved.nodes[0].size);
  assert.equal(liveNodes[0].order, saved.nodes[0].order);
  assert.deepEqual(liveNodes[0].widgets_values, liveWidgets, "authored widget values stay as the live graph had them");
  const proof = graphRootReproducesStateContent({ rootGraph: live, state: saved });
  assert.equal(proof.proven, false);
  assert.equal(proof.presentationOnly, false);
});

test("#1618 a type mismatch is skipped — id reuse is a different node", () => {
  const saved = stateOf([node(1, "KSampler", { size: [210, 90], order: 3 })]);
  const liveSize = [180, 40];
  const liveOrder = 0;
  const liveNodes = [node(1, "VAEDecode", { size: liveSize, order: liveOrder, widgets_values: ["a"] })];
  const applied = applySavedNodePresentation(liveRootFrom(liveNodes), saved);
  assert.equal(applied.restored, 0);
  assert.deepEqual(liveNodes[0].size, liveSize);
  assert.equal(liveNodes[0].order, liveOrder);
});

test("#1618 missing or unreadable inputs are a no-op, not a throw", () => {
  const saved = stateOf([node(1, "KSampler")]);
  const live = liveRootFrom([node(1, "KSampler")]);
  assert.deepEqual(applySavedNodePresentation(null, saved), { restored: 0, skipped: 0 });
  assert.deepEqual(applySavedNodePresentation(live, null), { restored: 0, skipped: 0 });
  assert.deepEqual(applySavedNodePresentation({ _nodes: "nope" }, saved), { restored: 0, skipped: 0 });
});

test("#1618 in-place size write keeps the live array object LiteGraph holds", () => {
  const saved = stateOf([node(1, "SaveVideo", { size: [1030, 358], order: 1 })]);
  const size = [1030, 126];
  const liveNodes = [node(1, "SaveVideo", { size, order: 0 })];
  applySavedNodePresentation(liveRootFrom(liveNodes), saved);
  assert.equal(liveNodes[0].size, size, "the same array instance is mutated");
  assert.deepEqual(size, saved.nodes[0].size);
});

test("#1618 after restore, classifyNodeDifference names no size/order drift", () => {
  const savedNodes = [node(1, "SaveVideo", { size: [400, 200], order: 5 })];
  const liveNodes = [node(1, "SaveVideo", { size: [400, 80], order: 1 })];
  applySavedNodePresentation(liveRootFrom(liveNodes), { nodes: savedNodes });
  const diff = classifyNodeDifference({ expectedNodes: savedNodes, actualNodes: liveNodes });
  assert.equal(diff.comparable, true);
  assert.equal(diff.sameNodeSet, true);
  assert.deepEqual(diff.fields, []);
});

test("#1618 wiring: workflow_open restores presentation before the content proof", () => {
  const openAt = PANEL.indexOf("async workflow_open({");
  assert.notEqual(openAt, -1);
  const open = PANEL.slice(openAt, PANEL.indexOf("\n  async workflow_live_sync", openAt));
  const restoreAt = open.indexOf("applySavedNodePresentation(rootGraph, repaintState)");
  const proofAt = open.indexOf("graphRootReproducesStateContent({");
  assert.notEqual(restoreAt, -1, "the repaint path must restore from the payload it just loaded");
  assert.notEqual(proofAt, -1);
  assert.ok(restoreAt < proofAt, "restore must run before the proof, or the proof still sees hydration");
});

test("#1618 wiring: first-time open restores FILE presentation before re-baseline", () => {
  const openAt = PANEL.indexOf("async workflow_open({");
  const open = PANEL.slice(openAt, PANEL.indexOf("\n  async workflow_live_sync", openAt));
  const fileRestoreAt = open.indexOf("applySavedNodePresentation(app?.graph, saved)");
  const rebaselineAt = open.indexOf("await clearSpuriousOpenModified(target, {");
  assert.notEqual(fileRestoreAt, -1, "a cold open must restore from originalContent, not only from already-rewritten activeState");
  assert.notEqual(rebaselineAt, -1);
  assert.ok(
    fileRestoreAt < rebaselineAt,
    "restoring after re-baseline would dirty the tab we just marked clean",
  );
  const wasOpenGuardAt = open.lastIndexOf("if (!wasOpen)", fileRestoreAt);
  assert.ok(wasOpenGuardAt > 0 && wasOpenGuardAt < fileRestoreAt, "already-open tabs keep their in-memory presentation");
});

test("#1618 wiring: the disk-reload path restores presentation after loadGraphData", () => {
  assert.match(
    PANEL,
    /applySavedSubgraphHostWidgets\(app\?\.graph, diskGraph\);\s*\n\s*applySavedNodePresentation\(app\?\.graph, diskGraph\);/,
    "an on-disk reload must put file size/order back after configure",
  );
});

test("#1618 wiring: first-time opens freeze so the clean re-baseline is safe", () => {
  const openAt = PANEL.indexOf("async workflow_open({");
  const open = PANEL.slice(openAt, PANEL.indexOf("\n  async workflow_live_sync", openAt));
  assert.match(open, /const priorInteraction = acquireCanvasInteractionLock\(canvasView\);/);
  assert.doesNotMatch(open, /wasOpen \? acquireCanvasInteractionLock/);
});
