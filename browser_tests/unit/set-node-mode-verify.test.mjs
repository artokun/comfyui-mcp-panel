import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * PROACTIVE (found while auditing for the class behind #232 / #635 / #708 / #710):
 * `graph_set_node_mode` reported the mode it was ASKED for, not the one the node
 * ended up holding.
 *
 * `node.mode = target` is a plain assignment on a stock LGraphNode, so it normally
 * sticks — but a pack may define a `mode` accessor that clamps, ignores or rewrites
 * it, and nothing read the value back. This is not a cosmetic field: bypass and mute
 * decide whether a node EXECUTES, so echoing the request would tell an agent it had
 * disabled a node that is still running, and the graph would then render with an
 * input the agent believes is switched off.
 *
 * The #690 shakedown is corroborating evidence: its author recorded verifying mode
 * changes "by re-read, not by return value" — i.e. they had already learned not to
 * trust this reply.
 *
 * The handler needs a live LiteGraph canvas to drive, so the guarantee is pinned at
 * source, the same way the other module-private handlers are.
 */

const src = () =>
  readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");

function setNodeModeBody() {
  const s = src();
  const start = s.indexOf("graph_set_node_mode({ node_id, mode, force }) {");
  assert.ok(start > -1, "graph_set_node_mode must exist");
  return s.slice(start, s.indexOf("graph_screenshot(", start));
}

test("the mode is READ BACK after the write", () => {
  const body = setNodeModeBody();
  const write = body.indexOf("node.mode = target;");
  const readBack = body.indexOf("const actualNum =");
  assert.ok(write > -1, "the write must still be there");
  assert.ok(readBack > write, "the read-back must come AFTER the write, or it proves nothing");
});

test("a node that did not accept the mode is REFUSED, not reported as changed", () => {
  const body = setNodeModeBody();
  assert.ok(body.includes("if (actualNum !== target) {"), "a mismatch must be detected");
  assert.match(body, /did not accept mode/);
  // Fail closed and say so — the rule the widget write and the restart/media reports
  // already follow.
  assert.match(body, /Nothing is being reported as changed/);
});

test("the reported mode comes from the NODE, never from the request", () => {
  // The actual defect. `NUM_TO_MODE[target]` in the reply is the request echoed back;
  // it must be the observed value.
  const body = setNodeModeBody();
  const ret = body.slice(body.indexOf("return {"));
  assert.ok(ret.includes("mode: NUM_TO_MODE[actualNum],"), "must report the observed mode");
  assert.ok(!ret.includes("mode: NUM_TO_MODE[target],"), "must NOT echo the requested mode");
});

test("previous_mode is still sampled BEFORE the write", () => {
  // Sampling it after would report the new value as the old one — the same class of
  // error in the other direction.
  const body = setNodeModeBody();
  const prev = body.indexOf("const previous_mode =");
  const write = body.indexOf("node.mode = target;");
  assert.ok(prev > -1 && write > -1 && prev < write, "previous_mode must be read before the write");
});

test("the existing bypass safety refusal is untouched", () => {
  // #409: bypassing a subgraph whose boundary slots are ordered unsafely must still
  // refuse unless force:true. This audit must not have widened or narrowed it.
  const body = setNodeModeBody();
  assert.match(body, /Refusing to bypass subgraph node/);
  assert.match(body, /Pass force:true/);
});
