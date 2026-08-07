import { test } from "node:test";
import assert from "node:assert/strict";
import { describeRenameFailure } from "../../web/js/lib/workflow-rename-error.js";

/**
 * #690(6) — panel_rename_workflow onto an existing name surfaced the frontend's
 * raw transport error: `Failed to rename file 'workflows/X.json': 409 Conflict`.
 *
 * The refusal is correct; the message is a status, not a reason. An agent reading
 * "409 Conflict" cannot tell a name collision (retry with a different name) from a
 * permissions or path failure (retrying with any name fails identically).
 */

test("a 409 becomes a reason, and names the collision", () => {
  const out = describeRenameFailure(
    new Error("Failed to rename file 'workflows/PANEL-TEST-B.json': 409 Conflict"),
    "PANEL-TEST",
  );
  assert.match(out, /a workflow named "PANEL-TEST" already exists/);
  assert.match(out, /Nothing was changed/, "must say no partial rename happened");
  // The original is preserved, not discarded — the status is still diagnostic.
  assert.match(out, /409 Conflict/);
});

test("the word Conflict alone is enough (status text without the number)", () => {
  assert.match(describeRenameFailure(new Error("Conflict"), "X"), /already exists/);
});

test("any OTHER failure keeps its original text verbatim", () => {
  // The load-bearing negative. Inventing a friendly explanation for a status this
  // cannot interpret replaces a true-but-terse message with a confident wrong one.
  for (const msg of [
    "Failed to rename file 'workflows/X.json': 403 Forbidden",
    "Failed to rename file 'workflows/X.json': 500 Internal Server Error",
    "NetworkError when attempting to fetch resource.",
  ]) {
    assert.equal(describeRenameFailure(new Error(msg), "X"), msg);
  }
});

test("a non-Error throw still yields usable text", () => {
  assert.equal(describeRenameFailure("boom", "X"), "boom");
  assert.match(describeRenameFailure("409 Conflict", "X"), /already exists/);
  assert.equal(describeRenameFailure(null, "X"), "the rename failed");
  assert.equal(describeRenameFailure(undefined, "X"), "the rename failed");
});

test("a missing destination name degrades gracefully", () => {
  const out = describeRenameFailure(new Error("409 Conflict"), "");
  assert.match(out, /a workflow named that name already exists/);
});

// ── WIRING ────────────────────────────────────────────────────────────────
// Both fixes live inside module-private handlers on the monolith's command map
// (workflow_rename / graph_set_node_property), which need a live app + frontend
// service to drive — so the wiring is pinned at source. Without these, both
// regressions return with every test above still green.

test("WIRING: workflow_rename routes its failure through describeRenameFailure", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  assert.match(src, /import \{ describeRenameFailure \} from "\.\/lib\/workflow-rename-error\.js";/);
  const fn = src.slice(src.indexOf("async workflow_rename("));
  const body = fn.slice(0, fn.indexOf("async workflow_close("));
  assert.ok(body.includes("throw new Error(describeRenameFailure(err, clean));"),
    "the rename failure must be described, not rethrown raw");
});

test("WIRING: graph_set_node_property reports a CREATED property (#690(2))", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("graph_set_node_property({ node_id, name, value })"));
  const body = fn.slice(0, fn.indexOf("graph_edit_node("));
  // Absence, not falsiness: `from === undefined` cannot distinguish "absent" from
  // "present and undefined", and JSON drops the undefined field either way.
  assert.ok(body.includes("Object.prototype.hasOwnProperty.call(node.properties, name)"),
    "existence must be tested with hasOwnProperty, before the write");
  assert.ok(body.includes("set.created = true;"),
    "a created property must be reported — otherwise a typo reads as a successful edit");
  // Sampled BEFORE the assignment, or it always reports existing.
  const existsIdx = body.indexOf("hasOwnProperty.call(node.properties, name)");
  const writeIdx = body.indexOf("node.properties[name] = value;");
  assert.ok(existsIdx > -1 && writeIdx > -1 && existsIdx < writeIdx,
    "existence must be sampled BEFORE the write");
});
