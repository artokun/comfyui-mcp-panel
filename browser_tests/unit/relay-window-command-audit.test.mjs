/**
 * #1418 §4 — the audit #1413 asked for, as a test rather than a sentence.
 *
 * Five commands are relayed in the orchestrator's 30,000 ms window
 * (OBJECT_INFO_REFRESH_ACK_TIMEOUT_MS). Three of them hold a command budget now
 * (graph_add_node #1192, graph_set_widget #1413/#1418, refresh_nodes #1404; nodes_install
 * has its own at a literal 30000). The remaining two — graph_get_object_info and
 * graph_remove_widget — were audited clean: each holds exactly ONE await, that await lands
 * on fetchWholeObjectInfo (which bounds itself at OBJECT_INFO_DEADLINE_MS, under the
 * window, with nothing to compose against), and neither reaches the refresh coalescer.
 *
 * "Audited clean" has a shelf life: the day either command grows a second wait or starts
 * joining node-def refresh runs, it becomes the fifth instance of the 30s-window defect.
 * So the audit is asserted here, against the shipped bodies, scoped per method — and it
 * goes red on exactly that change.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { PANEL_SRC } from "./_panel-constants.mjs";

/** One executor's body, delimited by the next sibling — never a slice into a neighbour. */
function executorBody(name) {
  const m = PANEL_SRC.match(new RegExp(`\\n {2}async ${name}\\([\\s\\S]*?\\n {2}\\},`));
  assert.ok(m, `could not locate ${name} in the panel source`);
  return m[0];
}

for (const name of ["graph_get_object_info", "graph_remove_widget"]) {
  test(`#1418 audit: ${name} has ONE await, on the bounded oracle, and never joins a refresh`, () => {
    const body = executorBody(name);

    const awaits = body.match(/\bawait\b/g) ?? [];
    assert.equal(
      awaits.length,
      1,
      `${name} grew a second wait — each wait in a 30s-relayed command must compose ` +
        "against the others, which is exactly what a command budget is for (#1192 family)",
    );

    // The one wait is the whole-schema oracle, which carries its own deadline
    // (OBJECT_INFO_DEADLINE_MS) — there is nothing else on the path to compose against,
    // so a command budget would buy nothing here.
    assert.match(
      body,
      /fetchWholeObjectInfo\(/,
      `${name}'s one await must land on the self-bounded oracle`,
    );

    // The defect this family keeps reproducing: a wait on the node-def refresh coalescer
    // relayed inside the window with no bound of its own.
    assert.ok(
      !body.includes("refreshComfyNodeDefs"),
      `${name} must never join a node-def refresh run — that wait needs a command budget`,
    );
  });
}
