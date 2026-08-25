/**
 * #1750 — `panel_disconnect` and ORPHANED input link ids.
 *
 * REPORT: four optional inputs on the bundled krea2-identity-edit workflow
 * (node 79 `source_latent_b`/`source_image_b`, nodes 84/85 `image_b`) ended up
 * naming link ids 21/20/18/19 that `graph.links` no longer held. Every later
 * `panel_run` died in the frontend's serializer with
 *
 *     No link found in parent graph for id [79] slot [2] source_latent_b
 *
 * and `panel_graph_outline` showed those inputs as cleanly DISCONNECTED, because
 * it resolves through the link store and a slot naming a link the store does not
 * have resolves to nothing.
 *
 * MECHANISM, read from ComfyUI_frontend 1.48.7 (the version installed here),
 * not inferred:
 *
 *   ExecutableNodeDTO.resolveInput  — `if (input.linkId == null) return`, then
 *     `const link = this.graph.getLink(input.linkId)` and
 *     `if (!link) throw new InvalidLinkError('No link found in parent graph …')`.
 *
 * So the serializer refuses on `slot.link != null && store has no record` — the
 * exact shape both tests below build. It is checked for EVERY input of a node the
 * serializer does not skip, so one such slot makes the whole workflow unqueueable.
 *
 * TWO defects, and they are separate:
 *
 *  1. THE GRAPH COULD NOT BE REPAIRED. `describeInputLink` returns null both for
 *     an unconnected slot and for an orphaned one, so `graph_disconnect` answered
 *     the #668 refusal — "is not connected … no retry is needed" — about the one
 *     reference that was breaking every run. The only tool that can clear a
 *     slot's link declined to clear it, and nothing else in the panel showed it.
 *     This is reachable from any saved workflow already in that state, which is
 *     where #1750's reporter was left.
 *
 *  2. THE POST-CONDITION WAS ASSUMED. litegraph's `disconnectInput` nulls the
 *     slot BEFORE it touches the store, so the two normally cannot disagree — but
 *     the graph #1750 saved held exactly that disagreement, so the panel now
 *     ASSERTS the post-condition after its own mutation instead of trusting it,
 *     and repairs (and discloses) what the assertion catches.
 *
 * These tests run the REAL shipped `graph_disconnect`, extracted from
 * web/js/comfyui-mcp-panel.js and given litegraph-shaped doubles, with the REAL
 * verification helpers injected — so deleting the fix from the panel source (not
 * merely from the helper module) fails them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  snapshotGraphState,
  describeInputLink,
  orphanedInputLinkId,
  clearOrphanedInputLink,
  clearStrandedInputLinks,
  verifyDisconnect,
} from "../../web/js/lib/disconnect-verify.js";
import { danglingInputLinks } from "../../web/js/lib/subgraph-conversion-integrity.js";

const panelSrc = readFileSync(
  fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

/** The method source between its signature line and the first `  },` line. */
function sliceMethod(signature) {
  const lines = panelSrc.split("\n");
  const start = lines.findIndex((l) => l === signature);
  assert.ok(start >= 0, `could not locate "${signature}" in the panel source`);
  const end = lines.findIndex((l, i) => i > start && l === "  },");
  assert.ok(end > start, `could not locate the end of "${signature}"`);
  return lines.slice(start, end + 1).join("\n");
}

const disconnectSrc = sliceMethod("  graph_disconnect({ node_id, input }) {");

function resolveNode(graph, id) {
  const n = graph.getNodeById(id);
  if (!n) throw new Error(`No node with id ${id}`);
  return n;
}

function resolveSlot(slots, ref, kind) {
  const list = slots ?? [];
  if (typeof ref === "number") {
    if (ref < 0 || ref >= list.length) throw new Error(`no ${kind} slot ${ref}`);
    return ref;
  }
  const i = list.findIndex((s) => s?.name === ref);
  if (i === -1) throw new Error(`no ${kind} named ${ref}`);
  return i;
}

/** Build the REAL shipped executor over a graph double. Every helper it calls is
 *  the real module — a stub there would let the extracted method pass against a
 *  checker that always agreed with it. */
function buildDisconnect(graph) {
  const factory = new Function(
    "getGraphCtx",
    "resolveNode",
    "resolveSlot",
    "snapshotGraphState",
    "describeInputLink",
    "orphanedInputLinkId",
    "clearOrphanedInputLink",
    "clearStrandedInputLinks",
    "verifyDisconnect",
    "danglingInputLinks",
    `return ({
${disconnectSrc}
}).graph_disconnect;`,
  );
  return factory(
    () => ({ graph, canvas: {}, app: {}, rootGraph: graph, LG: {} }),
    resolveNode,
    resolveSlot,
    snapshotGraphState,
    describeInputLink,
    orphanedInputLinkId,
    clearOrphanedInputLink,
    clearStrandedInputLinks,
    verifyDisconnect,
    danglingInputLinks,
  );
}

/**
 * `LGraph` holds `_links: Map<LinkId, LLink>` keyed by NUMBER and exposes `links`
 * as a proxy over it whose methods are bound straight through. Modelled faithfully
 * so a string/number key confusion in the helpers cannot pass here and fail on a
 * real graph.
 */
function mkGraph() {
  const map = new Map();
  const isIndex = (prop) => typeof prop === "string" && /^(?:0|[1-9]\d*)$/.test(prop);
  const proxy = new Proxy(map, {
    get(target, prop) {
      if (isIndex(prop)) return target.get(Number(prop));
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
    has: (target, prop) => (isIndex(prop) ? target.has(Number(prop)) : Reflect.has(target, prop)),
    ownKeys: (target) => [...target.keys()].map(String),
    getOwnPropertyDescriptor(target, prop) {
      if (isIndex(prop) && target.has(Number(prop))) {
        return { value: target.get(Number(prop)), enumerable: true, configurable: true };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
  const graph = {
    _links: map,
    links: proxy,
    _nodes: [],
    envelopes: 0,
    closedEnvelopes: 0,
    dirty: 0,
    getNodeById: (id) => graph._nodes.find((n) => String(n.id) === String(id)) ?? null,
    getLink: (id) => map.get(id) ?? null,
    beforeChange() {
      graph.envelopes += 1;
    },
    afterChange() {
      graph.closedEnvelopes += 1;
    },
    setDirtyCanvas() {
      graph.dirty += 1;
    },
  };
  return graph;
}

function addNode(graph, id, inputs, outputs = []) {
  const node = { id, inputs, outputs, graph };
  graph._nodes.push(node);
  return node;
}

function addLink(graph, id, origin, originSlot, target, targetSlot) {
  graph._links.set(id, {
    id,
    origin_id: origin,
    origin_slot: originSlot,
    target_id: target,
    target_slot: targetSlot,
  });
}

/**
 * The #1750 shape, reduced from the bundled krea2-identity-edit workflow: node 79
 * Krea2EditModelPatch with `source_latent` (link 15, live) and `source_latent_b`
 * (link 21) — where 21 is the id the store no longer holds. Slot indices and
 * names are the workflow's own, so the fixture and the report describe the same
 * input.
 */
function orphanedGraph() {
  const graph = mkGraph();
  const producer = addNode(graph, 78, [], [{ name: "LATENT", links: [15] }]);
  addNode(graph, 79, [
    { name: "model", link: null },
    { name: "source_latent", link: 15 },
    { name: "source_latent_b", link: 21 },
  ]);
  addLink(graph, 15, 78, 0, 79, 1);
  return { graph, producer };
}

test("#1750 orphaned slot: panel_disconnect CLEARS the reference instead of refusing", () => {
  const { graph } = orphanedGraph();
  const disconnect = buildDisconnect(graph);
  const node = graph.getNodeById(79);

  const res = disconnect({ node_id: 79, input: "source_latent_b" });

  // The reference the frontend serializer refuses is gone.
  assert.equal(node.inputs[2].link, null);
  assert.equal(orphanedInputLinkId(graph, node, 2), null);
  // Reported as what it was — an orphan cleared, NOT a wire removed.
  assert.deepEqual(res.cleared_orphan_link, {
    node_id: 79,
    input: "source_latent_b",
    link_id: 21,
  });
  assert.equal(res.disconnected, undefined);
  assert.equal(res.removed_link, undefined);
  assert.match(res.warning, /nothing was disconnected/i);
  assert.match(res.warning, /No link found in parent graph/);
  // The ONLY orphan in this graph was the one cleared, so say exactly that.
  assert.equal(res.remaining_orphan_links, undefined);
  assert.match(res.warning, /No other input in this graph carries an orphaned link id/);
  // Repaired inside ONE undo envelope, so the "Undoable with Ctrl+Z" contract holds.
  assert.equal(graph.envelopes, 1);
  assert.equal(graph.closedEnvelopes, 1);
  assert.ok(graph.dirty >= 1);
  // Untouched: the live wire on the neighbouring slot, and the link store.
  assert.equal(node.inputs[1].link, 15);
  assert.ok(graph._links.has(15));
});

test("#1750: a genuinely unconnected input is still REFUSED, not silently 'repaired'", () => {
  const { graph } = orphanedGraph();
  const disconnect = buildDisconnect(graph);

  assert.throws(
    () => disconnect({ node_id: 79, input: "model" }),
    /is not connected/,
    "an input with link == null has nothing to clear — #668's refusal must stand",
  );
  // The refusal is a refusal: no envelope was opened, nothing was written.
  assert.equal(graph.envelopes, 0);
  assert.equal(graph.getNodeById(79).inputs[2].link, 21, "the unrelated orphan is left alone");
});

test("#1750: a LIVE link is never cleared by the orphan path", () => {
  const { graph } = orphanedGraph();
  const disconnect = buildDisconnect(graph);
  const node = graph.getNodeById(79);
  // Model litegraph faithfully: null the slot, THEN drop the record.
  node.disconnectInput = (slot) => {
    const id = node.inputs[slot].link;
    node.inputs[slot].link = null;
    graph._links.delete(id);
    const out = graph.getNodeById(78).outputs[0];
    out.links = out.links.filter((l) => l !== id);
    return true;
  };

  const res = disconnect({ node_id: 79, input: "source_latent" });

  assert.deepEqual(res.disconnected, { node_id: 79, input: "source_latent" });
  assert.deepEqual(res.removed_link, { node_id: 78, output: "LATENT" });
  assert.equal(res.cleared_orphan_link, undefined, "no orphan existed on this slot");
  assert.equal(res.warning, undefined);
  assert.equal(node.inputs[1].link, null);
});

/**
 * The end state #1750 SAVED: the link is out of the store and the slot still names
 * it. This is not litegraph's own ordering (it nulls the slot first) — it is the
 * disagreement the report observed on four optional inputs, reproduced here so the
 * panel's post-condition is exercised by the same shape the workflow was in.
 */
function strandingGraph() {
  const graph = mkGraph();
  addNode(graph, 78, [], [{ name: "LATENT", links: [15] }]);
  const target = addNode(graph, 79, [
    { name: "model", link: null },
    { name: "source_latent", link: 15 },
  ]);
  addLink(graph, 15, 78, 0, 79, 1);
  target.disconnectInput = (slot) => {
    const id = target.inputs[slot].link;
    graph._links.delete(id);
    const out = graph.getNodeById(78).outputs[0];
    out.links = out.links.filter((l) => l !== id);
    // …and the slot is NOT nulled. Exactly what the saved workflow held.
    return true;
  };
  return graph;
}

test("#1750 post-condition: a slot left naming the removed link is cleared and disclosed", () => {
  const graph = strandingGraph();
  const disconnect = buildDisconnect(graph);
  const node = graph.getNodeById(79);

  const res = disconnect({ node_id: 79, input: "source_latent" });

  // Without the repair this call THROWS: verifyDisconnect sees the slot still
  // naming link 15 and reports the disconnect as not clean.
  assert.equal(node.inputs[1].link, null, "the stranded reference is gone");
  assert.deepEqual(res.disconnected, { node_id: 79, input: "source_latent" });
  assert.deepEqual(res.cleared_orphan_link, {
    node_id: 79,
    link_id: 15,
    inputs: ["source_latent"],
  });
  // Repaired, but never silently: the caller is told the graph needed fixing.
  assert.match(res.warning, /still named it/);
  assert.match(res.warning, /No link found in parent/);
});

test("#1750 post-condition never covers for a disconnect that did NOT land", () => {
  const graph = strandingGraph();
  const node = graph.getNodeById(79);
  // The record survives AND the slot still names it — the wire is simply still
  // there. Repairing the slot here would convert #668's loud disclosure into a
  // false success, so the repair must decline.
  node.disconnectInput = () => true;
  const disconnect = buildDisconnect(graph);

  assert.throws(
    () => disconnect({ node_id: 79, input: "source_latent" }),
    /did not complete cleanly/,
    "#668's disclosure must still fire when the link is untouched",
  );
  assert.equal(node.inputs[1].link, 15, "the live wire was left alone");
  assert.ok(graph._links.has(15));
});

// ---------------------------------------------------------------------------
// codex gate round 1, both P1
// ---------------------------------------------------------------------------

/**
 * P1: clearing ONE orphan does not make a graph queueable. #1750's own workflow
 * carried four (79 source_latent_b/source_image_b, 84/85 image_b), and a reply
 * that says "queueable again" after the first sends the caller straight back
 * into the same serializer refusal, with the same message, on a different slot.
 */
test("#1750 the reply reports what is STILL orphaned, and never claims queueable", () => {
  const graph = mkGraph();
  addNode(graph, 90, [], [{ name: "IMAGE", links: [] }]);
  addNode(graph, 79, [
    { name: "source_latent_b", link: 21 },
    { name: "source_image_b", link: 20 },
  ]);
  addNode(graph, 84, [{ name: "image_b", link: 18 }]);
  addNode(graph, 85, [{ name: "image_b", link: 19 }]);
  const disconnect = buildDisconnect(graph);

  const res = disconnect({ node_id: 79, input: "source_latent_b" });

  assert.deepEqual(res.cleared_orphan_link, {
    node_id: 79,
    input: "source_latent_b",
    link_id: 21,
  });
  assert.deepEqual(res.remaining_orphan_links, [
    { node_id: 79, input: "source_image_b", link_id: 20, certainly_reached: true },
    { node_id: 84, input: "image_b", link_id: 18, certainly_reached: true },
    { node_id: 85, input: "image_b", link_id: 19, certainly_reached: true },
  ]);
  assert.equal(res.remaining_orphan_link_count, 3);
  assert.match(res.warning, /3 other input\(s\) in this graph still carry an orphaned link id/);
  assert.match(res.warning, /STILL refused/);
  assert.doesNotMatch(res.warning, /queueable/);

  // …and clearing the last one says so, rather than staying silent about it.
  disconnect({ node_id: 79, input: "source_image_b" });
  disconnect({ node_id: 84, input: "image_b" });
  const last = disconnect({ node_id: 85, input: "image_b" });
  assert.equal(last.remaining_orphan_links, undefined);
  assert.match(last.warning, /No other input in this graph carries an orphaned link id/);
});

/**
 * P1: `afterChange()` closes the undo transaction. If it throws, the slot write
 * still landed but the undo step may never have been recorded — so the reply may
 * report the repair and may NOT promise Ctrl+Z.
 */
test("#1750 a throwing afterChange costs the Ctrl+Z promise, not the repair", () => {
  const { graph } = orphanedGraph();
  graph.afterChange = () => {
    graph.closedEnvelopes += 1;
    throw new Error("change tracker exploded");
  };
  const disconnect = buildDisconnect(graph);
  const node = graph.getNodeById(79);

  const res = disconnect({ node_id: 79, input: "source_latent_b" });

  assert.equal(node.inputs[2].link, null, "the repair itself landed");
  assert.deepEqual(res.cleared_orphan_link, {
    node_id: 79,
    input: "source_latent_b",
    link_id: 21,
  });
  assert.match(res.warning, /undo envelope did not close cleanly/);
  assert.match(res.warning, /change tracker exploded/);
  assert.doesNotMatch(res.warning, /Undoable with Ctrl\+Z/);
});

test("#1750 a throwing clear is a REFUSAL, not a disclosed success", () => {
  const { graph } = orphanedGraph();
  const node = graph.getNodeById(79);
  // A frozen/proxied slot: the write itself fails, so the orphan is still there.
  Object.defineProperty(node.inputs[2], "link", {
    get: () => 21,
    set: () => {
      throw new Error("slot is read-only");
    },
  });
  const disconnect = buildDisconnect(graph);

  assert.throws(
    () => disconnect({ node_id: 79, input: "source_latent_b" }),
    /could not clear it \(slot is read-only\)/,
  );
});

/**
 * The same overclaim one step down: an orphan on a node the serializer may SKIP
 * (bypassed / muted / virtual) is real corruption, but this module does not model
 * whether it is reached — so it may not be narrated as "the graph is refused".
 * `danglingInputLinks` already draws that line with `certainly_reached`; the reply
 * has to respect it.
 */
test("#1750 an orphan on a BYPASSED node is reported without claiming the graph is refused", () => {
  const graph = mkGraph();
  addNode(graph, 79, [{ name: "source_latent_b", link: 21 }]);
  const bypassed = addNode(graph, 84, [{ name: "image_b", link: 18 }]);
  bypassed.mode = 4; // LGraphEventMode.BYPASS
  const disconnect = buildDisconnect(graph);

  const res = disconnect({ node_id: 79, input: "source_latent_b" });

  assert.deepEqual(res.remaining_orphan_links, [
    { node_id: 84, input: "image_b", link_id: 18, certainly_reached: false },
  ]);
  assert.match(res.warning, /only on node\(s\) the serializer may skip/);
  assert.doesNotMatch(res.warning, /STILL refused/);
  assert.doesNotMatch(res.warning, /No other input in this graph/);
});

test("#1750 the remaining-orphan list is capped, but the COUNT never is", () => {
  const graph = mkGraph();
  // 1 target + 25 more orphans. A ten-entry array with no total reads as "that
  // is all of them" — a silent cap is the same overclaim in a structured field.
  addNode(graph, 79, [{ name: "source_latent_b", link: 21 }]);
  for (let i = 0; i < 25; i += 1) {
    addNode(graph, 100 + i, [{ name: `in_${i}`, link: 500 + i }]);
  }
  const disconnect = buildDisconnect(graph);

  const res = disconnect({ node_id: 79, input: "source_latent_b" });

  assert.equal(res.remaining_orphan_links.length, 10);
  assert.equal(res.remaining_orphan_link_count, 25);
  assert.match(res.warning, /25 other input\(s\)/);
  assert.match(res.warning, /, … —/, "the truncated roll says it was truncated");
});
