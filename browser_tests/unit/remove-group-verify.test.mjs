import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * PROACTIVE (same audit that found the set_node_mode echo): `graph_remove_group`
 * reported `{removed: <summary>}` unconditionally.
 *
 * The summary was captured BEFORE the removal, and nothing looked afterwards. The
 * removal chain was `else if`:
 *
 *     if (typeof graph.removeGroup === "function") graph.removeGroup(g);
 *     else if (typeof graph.remove === "function") graph.remove(g);
 *     else  <manual splice>
 *
 * LiteGraph defines `graph.remove` for NODES. On any frontend build without
 * `removeGroup` — but with the standard `remove` — the middle branch ran, the splice
 * fallback was never reached, and the tool reported a group removed that was still on
 * the user's canvas. A caller then builds a layout against a group that still exists.
 *
 * The handler needs a live graph, so the guarantee is pinned at source like the other
 * module-private handlers.
 */

const src = () =>
  readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");

function removeGroupBody() {
  const s = src();
  const start = s.indexOf("graph_remove_group({ group_id }) {");
  assert.ok(start > -1, "graph_remove_group must exist");
  return s.slice(start, s.indexOf("graph_set_node_mode(", start));
}

test("every removal path is TRIED, not just the first available one", () => {
  // The `else if` is the defect. Each fallback must run when the previous one left
  // the group in place.
  const body = removeGroupBody();
  assert.ok(!/else if \(typeof graph\.remove === "function"\)/.test(body),
    "the removal chain must not short-circuit on the first available API");
  assert.ok(body.includes("groupStillPresent(graph, g) && typeof graph.remove === \"function\""),
    "the node-oriented remove must only run if the group is still there");
});

test("the manual splice is reachable even when graph.remove exists", () => {
  const body = removeGroupBody();
  const removeCall = body.indexOf("graph.remove(g)");
  const splice = body.indexOf("list.splice(i, 1)");
  assert.ok(removeCall > -1 && splice > removeCall,
    "the splice must follow the remove attempt, not be an alternative to it");
  // …and be guarded by a fresh presence check rather than an else.
  assert.ok(body.slice(removeCall, splice).includes("groupStillPresent(graph, g)"),
    "the splice must be gated on the group still being present");
});

test("a group that survives every path is REFUSED, never reported as removed", () => {
  const body = removeGroupBody();
  // Assert the GUARD, not just the text: neutering the condition leaves the message
  // in place, so a text-only assertion passes while the refusal never fires.
  // Tie the guard to the THROW. `if (groupStillPresent(graph, g)) {` alone also
  // matches the splice guard above, so neutering only the refusal condition still
  // satisfied it — the assertion has to span both lines.
  assert.match(body, /if \(groupStillPresent\(graph, g\)\) \{\s*throw new Error\(/,
    "the refusal must be gated on the group actually still being present");
  assert.match(body, /STILL on the canvas after every/);
  assert.match(body, /Nothing is being reported as removed/);
  // The refusal must come BEFORE the success return.
  const refusal = body.indexOf("STILL on the canvas");
  const ret = body.indexOf("return { removed: summary };");
  assert.ok(refusal > -1 && ret > refusal, "the verification must gate the success return");
});

test("the summary is still captured BEFORE removal", () => {
  // It describes a group that is about to stop existing, so it cannot be read after.
  const body = removeGroupBody();
  const summary = body.indexOf("const summary = summarizeGroup(graph, g);");
  const change = body.indexOf("graph.beforeChange();");
  assert.ok(summary > -1 && change > summary, "the summary must precede the mutation");
});

test("presence is decided by IDENTITY, not by id or title", () => {
  const s = src();
  const fn = s.slice(s.indexOf("function groupStillPresent(graph, g) {"));
  const body = fn.slice(0, fn.indexOf("function summarizeGroup"));
  assert.ok(body.includes("list.includes(g)"), "must compare the group object itself");
  // Two groups can share a title, and a stale id resolves to whatever took its place.
  assert.ok(!/\.title/.test(body) && !/\.id\b/.test(body),
    "must not match on title or id");
  // An unreadable group list must not read as 'removed'.
  assert.ok(body.includes("Array.isArray(list) ? list.includes(g) : false"),
    "a missing list must not be treated as absence");
});
