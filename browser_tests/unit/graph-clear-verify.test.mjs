import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * PROACTIVE — third find from the audit behind #232 / #635 / #708 / #710 and the two
 * fixes that came out of it (set_node_mode #739, remove_group #740).
 *
 * `graph_clear` returned `{cleared: nodes.length}` — the number of nodes present when
 * the sweep STARTED, not the number that actually left. `safeRemoveNode` reports
 * success when `graph.remove` did not throw, which is not the same as the node being
 * gone; that is precisely the gap that let `panel_remove_group` report a group still
 * sitting on the canvas.
 *
 * A survivor here is worse than in the group case: the caller believes the canvas is
 * empty and starts building, wiring new nodes alongside leftovers it cannot see.
 */

const src = () =>
  readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");

function clearBody() {
  const s = src();
  const start = s.indexOf("graph_clear() {");
  assert.ok(start > -1, "graph_clear must exist");
  return s.slice(start, s.indexOf("async graph_load(", start));
}

test("the graph is re-read AFTER the sweep", () => {
  const body = clearBody();
  const sweep = body.indexOf("safeRemoveNode(graph, node)");
  const readBack = body.indexOf("const remaining =");
  assert.ok(sweep > -1, "the sweep must still be there");
  assert.ok(readBack > sweep, "the re-read must follow the sweep, or it proves nothing");
});

test("`cleared` is DERIVED from what remains, not from the starting count", () => {
  // The defect: `cleared: nodes.length` reports the attempt.
  const body = clearBody();
  assert.ok(body.includes("const cleared = nodes.length - remaining;"),
    "cleared must be computed from the observed remainder");
  assert.ok(!/return \{ cleared: nodes\.length \}/.test(body),
    "must not report the starting count as the cleared count");
});

test("survivors are reported, and the caller is told the canvas is NOT empty", () => {
  // Tie the guard to the payload: a text-only assertion passes while the condition is
  // neutered (the lesson from #738 and #740).
  const body = clearBody();
  assert.match(body, /if \(remaining > 0\) \{\s*return \{/,
    "the warning must be gated on an observed remainder");
  assert.match(body, /STILL on the canvas/);
  assert.match(body, /NOT empty/);
  assert.match(body, /panel_graph_outline/, "must name how to re-read");
});

test("a fully cleared graph returns the plain shape — no phantom warning", () => {
  // The other direction: warning on every clear would train callers to ignore it.
  const body = clearBody();
  const plain = body.lastIndexOf("return { cleared };");
  const warned = body.indexOf("remaining,");
  assert.ok(plain > -1 && warned > -1 && plain > warned,
    "the clean path must return cleared alone, after the warned path");
});

test("an unreadable node list counts as ZERO remaining, not as failure", () => {
  // A frontend whose `_nodes` is not an array would otherwise turn every successful
  // clear into a warning — a false alarm is its own defect.
  const body = clearBody();
  assert.ok(body.includes("Array.isArray(graph._nodes) ? graph._nodes.length : 0"),
    "an unreadable list must not manufacture survivors");
});
