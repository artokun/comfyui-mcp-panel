// comfyui-mcp#1657 / #1648 / panel#1284 — "absent from /object_info" is not "missing".
//
// Three surfaces collapsed two states into one answer:
//   A. a node the FRONTEND registers as virtual, which never reaches the backend and is
//      absent from /object_info BY DESIGN; and
//   B. a node whose class this page never registered, so litegraph left a placeholder.
//
// The discriminator is `node.isVirtualNode === true` — the flag ComfyUI's own serializer
// reads to skip a node (frontend 1.48.7: `if (e.isVirtualNode || …) continue`), set in
// their own source by KJNodes' SetNode/GetNode and by rgthree's RgthreeBaseVirtualNode
// (Label, Fast Groups Bypasser/Muter, Fast Bypasser/Muter, Node Collector, Reroute).
//
// EVERY behavioural test below is paired with its case-B twin, because that is the pair a
// name allowlist gets wrong: panel#1284 and comfyui-mcp#1648 come from the same rig, where
// GetNode/SetNode were REAL placeholders (the tab had never loaded KJNodes' JS) and an
// allowlist naming "GetNode"/"SetNode" would have declared a broken run fine.
//
// Each of the three call sites is asserted separately. A helper-only suite here is blind
// by construction — it would leave two of the three unwired and stay green.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  isFrontendVirtualNode,
  frontendVirtualTypesAmong,
  withoutFrontendVirtualTypes,
} from "../../web/js/lib/frontend-virtual-nodes.js";
import { scanComboAvailability } from "../../web/js/lib/live-combo-availability.js";
import {
  describeUnrunnable,
  missingNodeRunRefusal,
} from "../../web/js/lib/missing-node-preflight.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PANEL = readFileSync(join(ROOT, "web/js/comfyui-mcp-panel.js"), "utf8");

/** A live KJNodes/rgthree-style virtual node: its class set the flag. */
const virtualNode = (id, type) => ({ id, type, isVirtualNode: true, widgets: [{ name: "Constant", value: "MODEL" }] });
/** The SAME type as a defless placeholder — the pack's JS never loaded in this tab. */
const placeholderNode = (id, type) => ({ id, type, widgets: [{ name: "Constant", value: "MODEL" }] });

// ── the predicate ───────────────────────────────────────────────────────────────

test("#1657 only an explicit isVirtualNode===true is proof; everything else stays reported", () => {
  assert.equal(isFrontendVirtualNode({ isVirtualNode: true }), true);
  // The whole point is that a placeholder cannot forge this by accident. Truthy-but-not-true
  // shapes are the ones a loose check would swallow.
  for (const bad of [
    {},
    { isVirtualNode: false },
    { isVirtualNode: undefined },
    { isVirtualNode: "true" },
    { isVirtualNode: 1 },
    null,
    undefined,
    "GetNode",
    42,
  ]) {
    assert.equal(isFrontendVirtualNode(bad), false, JSON.stringify(bad));
  }
});

test("#1657 a type is virtual only when EVERY live instance says so", () => {
  const nodes = [
    virtualNode(1, "GetNode"),
    virtualNode(2, "GetNode"),
    virtualNode(3, "Label (rgthree)"),
    { id: 4, type: "KSampler" },
  ];
  assert.deepEqual([...frontendVirtualTypesAmong(nodes)].sort(), ["GetNode", "Label (rgthree)"]);
  // One placeholder of the same type refutes the whole type: that type has a real problem.
  assert.deepEqual(
    [...frontendVirtualTypesAmong([...nodes, placeholderNode(5, "GetNode")])],
    ["Label (rgthree)"],
  );
});

test("#1657 a type with no live instance is never cleared, and junk exempts nothing", () => {
  // The load-time store outlives its nodes; an entry with nothing on canvas stays reported.
  assert.deepEqual(withoutFrontendVirtualTypes(["GetNode"], []), ["GetNode"]);
  for (const junk of [null, undefined, "nodes", 7, [null, undefined, {}]]) {
    assert.deepEqual(withoutFrontendVirtualTypes(["GetNode", "Foo"], junk), ["GetNode", "Foo"]);
  }
  assert.deepEqual(withoutFrontendVirtualTypes(null, []), []);
});

test("#1657 the reported list is filtered in order, and genuine misses survive", () => {
  const nodes = [
    virtualNode(1, "GetNode"),
    virtualNode(2, "SetNode"),
    virtualNode(3, "MarkdownNote"),
    virtualNode(4, "Label (rgthree)"),
    placeholderNode(5, "ImpactWildcardEncode"),
  ];
  assert.deepEqual(
    withoutFrontendVirtualTypes(
      ["GetNode", "SetNode", "MarkdownNote", "Label (rgthree)", "ImpactWildcardEncode"],
      nodes,
    ),
    ["ImpactWildcardEncode"],
  );
});

// ── CALL SITE 1: panel_get_errors' live combo scan (#1657, panel#1284) ───────────

const noClass = async () => ({}); // /object_info/<class> answers {} with HTTP 200 for an absent class

test("#1657 CALL SITE 1: a virtual node is not reported as unchecked, and is never looked up", async () => {
  const asked = [];
  const fetchClassInfo = async (cls) => {
    asked.push(cls);
    return cls === "KSampler" ? { KSampler: { input: { required: {} } } } : {};
  };
  const r = await scanComboAvailability(
    [
      virtualNode(1, "GetNode"),
      virtualNode(2, "SetNode"),
      virtualNode(3, "MarkdownNote"),
      virtualNode(4, "Label (rgthree)"),
      { id: 5, type: "KSampler", widgets: [{ name: "sampler_name", value: "euler" }] },
    ],
    fetchClassInfo,
  );
  assert.deepEqual(r.unknown, []);
  assert.deepEqual(r.unavailable, []);
  // Skipped BEFORE the lookup: no wasted round trip, no slot in the class cap.
  assert.deepEqual(asked, ["KSampler"]);
});

test("#1657 CALL SITE 1: the SAME types as placeholders are still reported unchecked", async () => {
  // panel#1284's rig: the tab never loaded KJNodes' JS. A name allowlist clears these.
  const r = await scanComboAvailability(
    [placeholderNode(1, "GetNode"), placeholderNode(2, "SetNode")],
    noClass,
  );
  assert.deepEqual(
    r.unknown.map((u) => `${u.type}:${u.reason}`),
    ["GetNode:node type not found in /object_info", "SetNode:node type not found in /object_info"],
  );
});

test("#1657 CALL SITE 1: a genuinely uninstalled pack is untouched", async () => {
  const r = await scanComboAvailability([placeholderNode(9, "ImpactWildcardEncode")], noClass);
  assert.equal(r.unknown.length, 1);
  assert.equal(r.unknown[0].type, "ImpactWildcardEncode");
});

test("#1657 CALL SITE 1: the skip does not hide a REAL unavailable widget value", async () => {
  // Widening the exemption must not suppress the finding this scan exists for.
  const r = await scanComboAvailability(
    [{ id: 1, type: "LoraLoader", widgets: [{ name: "lora_name", value: "gone.safetensors" }] }],
    async () => ({ LoraLoader: { input: { required: { lora_name: [["kept.safetensors"], {}] } } } }),
  );
  assert.equal(r.unavailable.length, 1);
  assert.equal(r.unavailable[0].value, "gone.safetensors");
});

test("#1657 CALL SITE 1 WIRING: the scan itself consults the predicate", () => {
  const src = readFileSync(join(ROOT, "web/js/lib/live-combo-availability.js"), "utf8");
  assert.match(src, /import \{ isFrontendVirtualNode \} from "\.\/frontend-virtual-nodes\.js";/);
  const at = src.indexOf("export async function scanComboAvailability");
  assert.ok(at > 0, "the scan must still be recognisable");
  const body = src.slice(at);
  const skip = body.indexOf("if (isFrontendVirtualNode(node)) continue;");
  const lookup = body.indexOf("const entry = await comboMapFor(className);");
  assert.ok(skip > 0, "the scan must skip frontend virtual nodes");
  assert.ok(lookup > skip, "the skip must run BEFORE the per-class lookup spends a fetch");
});

// ── CALL SITE 2: collectMissingAssets, the shared missing-node-types collector ───

test("#1657 CALL SITE 2 WIRING: the shared collector filters its node-type list", () => {
  assert.match(PANEL, /import \{ withoutFrontendVirtualTypes \} from "\.\/lib\/frontend-virtual-nodes\.js";/);
  const at = PANEL.indexOf("function collectMissingAssets(trustComboOverride) {");
  assert.ok(at > 0, "the shared collector must still be recognisable");
  // Bounded by the collector's own return, so this stays scoped to that function.
  const end = PANEL.indexOf("return { models, media, nodeTypes, nodeCount", at);
  assert.ok(end > at, "the collector's return must still be recognisable");
  const body = PANEL.slice(at, end);
  assert.match(body, /nodeTypes = withoutFrontendVirtualTypes\(/);
  // Filtered against the WHOLE workflow, not just the graph the user happens to be inside:
  // a virtual node in an un-entered subgraph must not be re-reported by scope alone.
  assert.match(body, /collectAllGraphs\(getGraphCtx\(\)\.rootGraph\)\.flatMap\(\(g\) => g\?\._nodes \?\? \[\]\)/);
});

test("#1657 CALL SITE 2 WIRING: every consumer of the collector inherits the filter", () => {
  // graph_get_errors, the turn-start validation banner and the stale-red-flag adjudication
  // all read this ONE collector. Filtering anywhere else would have fixed one of them —
  // which is exactly how this family reached three call sites.
  assert.ok(
    (PANEL.match(/collectMissingAssets\(/g) ?? []).length >= 4,
    "the collector must remain the single source these surfaces share",
  );
  assert.equal((PANEL.match(/nodeTypes = withoutFrontendVirtualTypes\(/g) ?? []).length, 1);
});

// ── CALL SITE 3: panel_run's pre-flight refusal (#1648) ──────────────────────────

test("#1648 CALL SITE 3: an unobserved registry claims nothing — the message is unchanged", () => {
  // Pinned verbatim: a future edit must not drift the no-evidence branch into a claim.
  assert.deepEqual(describeUnrunnable(["7"], [{ id: 7, type: "Foo" }]), [{ id: "7", type: "Foo" }]);
  assert.equal(
    missingNodeRunRefusal([{ id: "7", type: "Foo" }]),
    "NOT queued: 1 node in this workflow cannot be executed by the server — Foo (node 7). " +
      "Their node types are not registered on this ComfyUI, so the prompt was built with no " +
      "class_type for them and would have failed validation after being queued " +
      "(comfyui-mcp#1460). Nothing was sent and the queue is untouched. This usually means a " +
      "custom-node pack is missing or failed to load: install the pack that provides these " +
      "types (list_packs / install_custom_node), restart ComfyUI so the frontend registers " +
      "them, then run again. If you expected these nodes to be optional, delete or bypass " +
      "them first — a bypassed node is dropped during serialization and will not trip this " +
      "check.",
  );
  // An empty registry is a page that registered NOTHING — still no observation.
  assert.deepEqual(describeUnrunnable(["7"], [{ id: 7, type: "Foo" }], {}), [{ id: "7", type: "Foo" }]);
});

test("#1648 CALL SITE 3: the page's registry is read, and an unnamed node stays unknown", () => {
  const registry = { KSampler: {}, LoadImage: {} };
  assert.deepEqual(describeUnrunnable(["7"], [{ id: 7, type: "SetNode" }], registry), [
    { id: "7", type: "SetNode", registered: false },
  ]);
  assert.deepEqual(describeUnrunnable(["8"], [{ id: 8, type: "KSampler" }], registry), [
    { id: "8", type: "KSampler", registered: true },
  ]);
  // A node the graph could not name tells us nothing about registration.
  assert.deepEqual(describeUnrunnable(["9"], [], registry), [{ id: "9", type: null, registered: null }]);
});

test("#1648 CALL SITE 3: an unregistered type prescribes a TAB RELOAD, not another restart", () => {
  // The reporter had installed the pack and restarted ComfyUI, and was told to install the
  // pack and restart ComfyUI. The remedy they were missing is the one the old text lacked.
  const msg = missingNodeRunRefusal([
    { id: "7", type: "SetNode", registered: false },
    { id: "8", type: "GetNode", registered: false },
  ]);
  assert.match(msg, /^NOT queued: 2 nodes/);
  assert.match(msg, /This page has no node class registered for SetNode, GetNode/);
  assert.match(msg, /RELOAD the ComfyUI tab/);
  assert.match(msg, /restarting the server does NOT add its node classes to a tab\s+that was already open/);
  assert.match(msg, /already installed the\s+pack and restarted ComfyUI, do that first/);
  assert.match(msg, /FRONTEND-ONLY node type/);
  assert.match(msg, /bypass/); // the escape hatch survives every branch
  // It must still be unmistakable that nothing reached the queue.
  assert.match(msg, /Nothing was sent and the queue is\s+untouched/);
});

test("#1648 CALL SITE 3: a REGISTERED type is not sent to reload the tab", () => {
  // Fixing the wrong remedy must not install a new wrong one. Nothing is missing from this
  // page, so "reload" would send the user round the same loop from the other side.
  const msg = missingNodeRunRefusal([{ id: "7", type: "SomeDisplayNode", registered: true }]);
  assert.match(msg, /DOES have a node class registered for SomeDisplayNode/);
  assert.match(msg, /reloading\s+will not change those/);
  assert.doesNotMatch(msg, /RELOAD the ComfyUI tab/);
  assert.doesNotMatch(msg, /install the pack that provides these types/);
  // Nothing was left unnamed, so no leftover clause.
  assert.doesNotMatch(msg, /could not be named from the/);
});

test("#1648 CALL SITE 3: an offender the canvas could not name is never swept into the claim", () => {
  // `registered: null` is a node whose type the graph could not read. The "registered here"
  // sentence must stay scoped to what was actually looked at — otherwise it asserts
  // "nothing is missing" off a node nobody examined.
  const msg = missingNodeRunRefusal([
    { id: "7", type: "SomeDisplayNode", registered: true },
    { id: "8", type: null, registered: null },
  ]);
  assert.match(msg, /DOES have a node class registered for SomeDisplayNode/);
  assert.doesNotMatch(msg, /nothing is missing here/);
  assert.match(msg, /The other 1 node could not be named from the canvas, so nothing is established about it/);
});

test("#1648 CALL SITE 3: one unregistered offender in a mixed set still gets the reload remedy", () => {
  const msg = missingNodeRunRefusal([
    { id: "7", type: "SomeDisplayNode", registered: true },
    { id: "8", type: "SetNode", registered: false },
  ]);
  assert.match(msg, /RELOAD the ComfyUI tab/);
  // Only the type the claim is true of is named in it.
  assert.match(msg, /no node class registered for SetNode\b/);
  assert.doesNotMatch(msg, /no node class registered for SomeDisplayNode/);
});

test("#1648 CALL SITE 3: the bounded list still says how many were withheld", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: String(i), type: `T${i}`, registered: false }));
  const msg = missingNodeRunRefusal(many);
  assert.match(msg, /30 nodes/);
  assert.match(msg, /and 18 more/);
});

test("#1648 CALL SITE 3 WIRING: graph_run hands the refusal this page's registry", () => {
  const at = PANEL.indexOf("const badIds = unrunnableNodeIds(built);");
  assert.ok(at > 0, "the pre-flight must still be recognisable");
  const end = PANEL.indexOf("} catch (err) {", at);
  assert.ok(end > at, "the pre-flight's try block must still be recognisable");
  const block = PANEL.slice(at, end);
  assert.match(block, /describeUnrunnable\(\s*badIds,\s*liveNodes,\s*\(window\.LiteGraph \?\? globalThis\.LiteGraph\)\?\.registered_node_types,?\s*\)/);
  // NOT `?? {}` — an absent LiteGraph must stay UNKNOWN rather than assert "not registered"
  // for every type, which would prescribe a tab reload off no evidence at all.
  assert.doesNotMatch(block, /registered_node_types \?\? \{\}/);
});

test("#1648 CALL SITE 3 WIRING: the registry is diagnosis only — the refusal is still the prompt", () => {
  const at = PANEL.indexOf("const badIds = unrunnableNodeIds(built);");
  const end = PANEL.indexOf("} catch (err) {", at);
  const block = PANEL.slice(at, end);
  // The go/no-go remains `unrunnableNodeIds(built)`; the registry appears only inside the
  // message construction. A guard keyed on the registry would refuse runs that succeed.
  assert.match(block, /if \(badIds\.length\) \{/);
  assert.equal((block.match(/registered_node_types/g) ?? []).length, 1);
});
