import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PANEL_SRC = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");

test("graph_set_widget enforces expected_node_type at the synchronous write boundary", () => {
  const start = PANEL_SRC.indexOf("async graph_set_widget({");
  const end = PANEL_SRC.indexOf("\n  // artokun/comfyui-mcp#938", start);
  assert.ok(start >= 0, "graph_set_widget handler not found");
  assert.ok(end > start, "graph_set_widget handler boundary not found");
  const handler = PANEL_SRC.slice(start, end);

  const expectedArg = handler.indexOf("expected_node_type");
  const targetCheck = handler.indexOf("liveTarget.type !== expected_node_type");
  const identityCheck = handler.indexOf("liveTarget !== node");
  const runSet = handler.indexOf("runSetWidget(node, widget, value, setWidgetOpts)");
  assert.ok(expectedArg >= 0, "handler does not accept expected_node_type");
  assert.ok(targetCheck >= 0, "handler does not verify the live target type");
  assert.ok(identityCheck >= 0, "handler does not reject a same-type replacement object");
  assert.ok(runSet > targetCheck, "target type must be checked before runSetWidget");
  assert.ok(runSet > identityCheck, "target identity must be checked before runSetWidget");
});

test("the shipped target fence rejects replacement objects and preserves qualified ids", () => {
  const start = PANEL_SRC.indexOf("async graph_set_widget({");
  const end = PANEL_SRC.indexOf("\n  // artokun/comfyui-mcp#938", start);
  const handler = PANEL_SRC.slice(start, end);
  const fenceStart = handler.indexOf("assertTargetStillCurrent: () => {");
  const fenceTail = handler.slice(fenceStart).match(/\r?\n      \},\r?\n      \/\/ Stale-combo retry/);
  const fenceEnd = fenceTail?.index == null ? -1 : fenceStart + fenceTail.index;
  assert.ok(fenceStart >= 0, "production target fence not found");
  assert.ok(fenceEnd > fenceStart, "production target fence boundary not found");
  const fenceProperty = handler.slice(fenceStart, fenceEnd) + "\n      }";

  const original = { id: 7, type: "OtherLoraLoader" };
  let liveTarget = original;
  let resolvedId;
  const factorySource = `return function (node_id, expected_node_type, workflow_uuid, node) {
      return ({ ${fenceProperty} }).assertTargetStillCurrent;
    };`;
  let makeFence;
  try {
    makeFence = new Function(
    "getGraphCtx",
    "resolveNode",
    "assertActiveWorkflowCommandTarget",
    "WORKFLOW_UUID_FIELD",
    factorySource,
    );
  } catch (err) {
    throw new Error(`${err}\n${factorySource}`);
  }
  const fence = makeFence(
    () => ({ graph: {} }),
    (_graph, id) => {
      resolvedId = id;
      return liveTarget;
    },
    () => {},
    "workflow_uuid",
  )("7:subgraph", "OtherLoraLoader", undefined, original);

  fence();
  assert.equal(resolvedId, "7:subgraph");

  liveTarget = { id: 7, type: "OtherLoraLoader" };
  assert.throws(() => fence(), /target changed before dispatch/);

  liveTarget = { id: 7, type: "KSampler" };
  assert.throws(() => fence(), /target changed before dispatch/);
});
