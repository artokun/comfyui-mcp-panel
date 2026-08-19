// panel#1411 — a node added via `panel_add_node` could carry
// `properties.aux_id = "work"`: the frontend/Manager (3.x legacy) metadata chain
// stamps a malformed install-hint on nodes created via LG.createNode. ComfyUI's
// workflow zod schema requires aux_id to be `github-user/repo-name` (or absent),
// so from that add on, EVERY save/load of the workflow failed validation —
// one added node poisoned the whole workflow file.
//
// The load path already sanitized invalid aux_id values; the add and paste paths
// did not. All three now share the helpers in web/js/lib/aux-id-sanitize.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { AUX_ID_RE, sanitizeNodeAuxId, sanitizeNodesAuxId } from "../../web/js/lib/aux-id-sanitize.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL = readFileSync(join(HERE, "../../web/js/comfyui-mcp-panel.js"), "utf8");

// ── the helper's behaviour ──────────────────────────────────────────────────

test("#1411 the observed garbage value 'work' is dropped", () => {
  const node = { properties: { aux_id: "work", "Node name for S&R": "X" } };
  assert.equal(sanitizeNodeAuxId(node), true, "an invalid hint must be reported as removed");
  assert.deepEqual(node.properties, { "Node name for S&R": "X" }, "only aux_id is removed");
});

test("#1411 a valid 'github-user/repo-name' hint is KEPT", () => {
  const node = { properties: { aux_id: "NikoDemon80/ComfyUI-H3-Motion-Context" } };
  assert.equal(sanitizeNodeAuxId(node), false);
  assert.equal(node.properties.aux_id, "NikoDemon80/ComfyUI-H3-Motion-Context");
});

test("#1411 absent aux_id is untouched, and non-string values are dropped", () => {
  assert.equal(sanitizeNodeAuxId({ properties: {} }), false);
  assert.equal(sanitizeNodeAuxId({}), false);
  assert.equal(sanitizeNodeAuxId(null), false);
  for (const bad of ["GetNode", "SetNode", "a/b/c", "/repo", "user/", "has space/x", 42]) {
    const node = { properties: { aux_id: bad } };
    assert.equal(sanitizeNodeAuxId(node), true, `${JSON.stringify(bad)} must be dropped`);
    assert.ok(!("aux_id" in node.properties));
  }
});

test("#1411 sanitizeNodesAuxId counts drops across a node list", () => {
  const nodes = [
    { properties: { aux_id: "work" } },
    { properties: { aux_id: "user/repo" } },
    { properties: {} },
    { properties: { aux_id: "GetNode" } },
  ];
  assert.equal(sanitizeNodesAuxId(nodes), 2);
  assert.equal(nodes[1].properties.aux_id, "user/repo");
  assert.equal(sanitizeNodesAuxId(null), 0);
  assert.equal(sanitizeNodesAuxId([]), 0);
});

test("#1411 the regex matches the zod rule: 'github-user/repo-name' only", () => {
  assert.ok(AUX_ID_RE.test("comfyanonymous/ComfyUI"));
  assert.ok(!AUX_ID_RE.test("work"));
  assert.ok(!AUX_ID_RE.test("no/slash allowed/extra"));
});

// ── every node-creating path uses it ────────────────────────────────────────

test("#1411 graph_add_node sanitizes the freshly created node after graph.add", () => {
  const addAt = PANEL.indexOf("async graph_add_node(");
  const removeAt = PANEL.indexOf("graph_remove_node(", addAt);
  assert.ok(addAt > 0 && removeAt > addAt, "graph_add_node must exist");
  const body = PANEL.slice(addAt, removeAt);
  const graphAddAt = body.indexOf("graph.add(node)");
  const sanitizeAt = body.indexOf("sanitizeNodeAuxId(node)");
  assert.ok(graphAddAt > 0, "the node must be added to the graph");
  assert.ok(sanitizeAt > graphAddAt, "the aux_id sanitize must run AFTER graph.add(node)");
  assert.ok(
    body.includes("aux_id_sanitized"),
    "the add result must disclose when a hint was dropped",
  );
});

test("#1411 graph_paste_nodes sanitizes pasted nodes and discloses the count", () => {
  const pasteAt = PANEL.indexOf("graph_paste_nodes(");
  assert.ok(pasteAt > 0, "graph_paste_nodes must exist");
  const body = PANEL.slice(pasteAt, PANEL.indexOf("\n  },", pasteAt));
  const pasteCallAt = body.indexOf("pasteFromClipboard(options)");
  const sanitizeAt = body.indexOf("sanitizeNodesAuxId(pastedNodes)");
  assert.ok(pasteCallAt > 0 && sanitizeAt > pasteCallAt, "sanitize must run after the paste lands");
  assert.ok(body.includes("aux_id_sanitized"), "the paste result must disclose the drop count");
});

test("#1411 graph_load_workflow uses the SHARED sanitizer (no private regex copy)", () => {
  const loadAt = PANEL.indexOf("async graph_load(");
  assert.ok(loadAt > 0, "graph_load must exist");
  const body = PANEL.slice(loadAt, PANEL.indexOf("captureGraphSnapshot(null, \"before graph_load\")", loadAt));
  assert.ok(body.includes("sanitizeNodesAuxId(nodes)"), "the load path must use the shared helper");
  assert.ok(
    !body.includes("const AUX_ID_RE"),
    "the load path must not keep a private copy of the regex",
  );
  // Both paths must come from the one lib module.
  const importLine = 'from "./lib/aux-id-sanitize.js"';
  assert.ok(PANEL.includes(importLine), "the panel must import the shared helper");
});
