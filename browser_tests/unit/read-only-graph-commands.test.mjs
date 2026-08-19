// comfyui-mcp#1478 (second defect) — `panel_get_errors`, a documented read-only
// tool, was refused on a dirty tab as `dirty-mutation-binding-unproven`: a
// message that calls a read "this mutation" and prescribes reloading the browser
// tab or re-opening the workflow.
//
// Cause is one omission. `graphCommandMayMutateWorkflow` is
// `!READ_ONLY_GRAPH_COMMANDS.has(command)` — an allowlist where anything
// unlisted is a mutation — and `graph_get_errors` was not in it.
//
// The asymmetry that makes reads' lower bar correct, and that these tests are
// really about: a read aimed at the wrong canvas returns wrong DATA; a mutation
// aimed there CORRUPTS a graph. So this list may only ever grow one verified
// command at a time, and every mutation must stay outside it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  graphCommandBindingBar,
  graphCommandMayMutateWorkflow,
} from "../../web/js/lib/graph-binding.js";

test("#1478 graph_get_errors is classified as a READ", () => {
  assert.equal(graphCommandMayMutateWorkflow("graph_get_errors"), false);
});

test("#1478 it therefore draws the READ bar, not the mutation bar", () => {
  // The classification is only useful if it reaches the bar the dispatcher
  // applies — this is the step that decides whether the dirty fence fires.
  const bar = graphCommandBindingBar("graph_get_errors");
  assert.equal(
    bar.requireDirtyMutationBinding,
    false,
    "a read must not require the dirty-mutation binding proof",
  );
  // …and it must match what every other read gets, rather than being a
  // one-off shape that happens to pass today.
  assert.deepEqual(bar, graphCommandBindingBar("graph_outline"));
});

test("every command already treated as a read still is", () => {
  // A regression fence for the list itself: widening it is the risky direction,
  // and quietly NARROWING it would re-break tools that work today.
  for (const cmd of [
    "graph_serialize",
    "graph_get_state",
    "graph_view_selected",
    "graph_view_nodes_in_viewport",
    "graph_outline",
    "graph_query",
    "graph_find_nodes",
    "graph_get_subgraph",
    "graph_list_subgraphs",
    "graph_screenshot",
  ]) {
    assert.equal(graphCommandMayMutateWorkflow(cmd), false, cmd);
  }
});

test("MUTATIONS are still mutations — the guard is not weakened for writes", () => {
  // The direction that matters. Every one of these can change the user's graph,
  // and the dirty fence exists so they cannot land on a canvas that was never
  // proven to be this workflow's.
  for (const cmd of [
    "graph_add_node",
    "graph_set_widget",
    "graph_remove_widget",
    "graph_update_node",
    "graph_load",
    "graph_run",
    "graph_save_subgraph",
    "graph_unpack_subgraph",
    "graph_enter_subgraph",
    "graph_exit_subgraph",
    "graph_configure_app_mode",
  ]) {
    assert.equal(graphCommandMayMutateWorkflow(cmd), true, cmd);
    assert.equal(graphCommandBindingBar(cmd).requireDirtyMutationBinding, true, cmd);
  }
});

test("an UNKNOWN command is a mutation — the list fails closed", () => {
  // The property that makes an allowlist the right shape here: a command nobody
  // classified gets the strict bar, so forgetting to add a new WRITE cannot
  // silently let it through. The cost is that forgetting a new READ produces
  // exactly this issue — an over-refusal, which is the recoverable direction.
  assert.equal(graphCommandMayMutateWorkflow("graph_some_future_command"), true);
  assert.equal(graphCommandMayMutateWorkflow(""), true);
  assert.equal(graphCommandMayMutateWorkflow(undefined), true);
});

test("the two other unlisted reads are deliberately still refused", () => {
  // Recorded rather than assumed. `graph_get_object_info` and
  // `graph_prompt_director_audit` also look like reads, but "looks like" is not
  // the standard for lowering a guard's bar, so they stay out until someone
  // establishes it. If a later change admits one, this test fails and asks for
  // the evidence to be written down with it.
  assert.equal(graphCommandMayMutateWorkflow("graph_get_object_info"), true);
  assert.equal(graphCommandMayMutateWorkflow("graph_prompt_director_audit"), true);
});

// ── The claim the classification RESTS ON ───────────────────────────────────
//
// Review: the tests above only assert what the allowlist RETURNS. Two further
// claims are load-bearing, and only one of them is testable here.
//
// TESTED below: the dispatcher derives its bar from this list. That is where the
// reporter's refusal came from, and it is a whole-file search, so it is exact.
//
// NOT TESTED, verified by reading: `graph_get_errors`'s executor writes nothing —
// it re-asserts the fence on this command's own read bar plus the baseline guard
// (`graphCommandBindingBar("graph_get_errors")` with `includeBaselineReadGuard`,
// since #1233 — bare defaults had silently dropped the #995 stale-tag bypass) and
// otherwise only reads `graph._nodes` and builds a report.
//
// A source-scanning version of that check was written and REMOVED. Bounding a
// method body by counting braces needs real tokenization: masking comments first
// breaks on `//` inside a string, and masking strings first breaks on an
// apostrophe inside a comment — which is what happened here, mis-bounding the
// slice so every "must not write" assertion passed against the wrong text. A
// vacuous test asserting a safety property is worse than an honest note.

const panelSource = () =>
  readFileSync(fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)), "utf8");

test("#1478 the DISPATCH-time bar is derived from this list", () => {
  // The second claim: a correct classification is useless if the dispatch site
  // does not use it — and the dispatch site is where the reporter's refusal came
  // from. Asserted on the call, not on the file merely mentioning it.
  const src = panelSource();
  assert.match(
    src,
    /assertGraphBoundToActiveWorkflow\(graph, rootGraph, graphCommandBindingBar\(msg\.cmd\)\)/,
    "the bar must come from graphCommandBindingBar(msg.cmd), not a local guess",
  );
});
