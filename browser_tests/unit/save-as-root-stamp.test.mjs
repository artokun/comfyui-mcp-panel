/**
 * #978 — after a Save-As, the next graph command was refused as a `workflow instance
 * mismatch` against the PREVIOUS instance, and neither `panel_open_workflow` nor
 * `panel_set_workflow_target({mode:"current"})` recovered it. A follow-up on the same
 * issue reports `panel_graph_outline` and `panel_get_errors` rejected the same way.
 *
 * TWO fences are involved and only one of them was addressed:
 *
 *   1. The COMMAND fence compares the stamp a command was issued with against the active
 *      workflow's uuid. A Save-As makes a different workflow active, so a command stamped
 *      for the pre-save one is correctly refused — and #747/#941 publish the produced
 *      identity in the save reply precisely so the caller has something to re-stamp from.
 *      That half shipped in 0.11.45.
 *
 *   2. The GRAPH fence compares the LIVE ROOT's identity tag against the active
 *      workflow's uuid. A save does not touch that tag, so the root keeps the pre-save
 *      one and every graph tool is refused for a root-workflow-uuid mismatch — no matter
 *      how correctly the caller re-stamped.
 *
 * The fence's own heal is a content proof that must be EXCLUSIVE, and a Save-As is the
 * one case where it cannot be: the ORIGINAL workflow is still open holding byte-identical
 * content, so the proof correctly declines and the stale tag stands. Waiting for the user
 * to close the source tab is not a remedy.
 *
 * So the save stamps the root itself. What licenses it is CAUSATION — this runs inside
 * the save that produced the record, and the root it stamps is the graph that save just
 * serialized — not a comparison that cannot tell two identical canvases apart.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { graphRootWorkflowUuidMismatches, rootContentProvesActiveWorkflow } from "../../web/js/lib/graph-binding.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

function namedFunctionSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) return null;
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

const PRE_SAVE = "11111111-2222-4333-8444-555555555555";
const PRODUCED = "99999999-8888-4777-8666-555555555555";

/** The shipped `stampRootForProducedSave`, with the panel globals it reads injected. */
function sandbox({ active, rootGraph, sameObject = (a, b) => a === b } = {}) {
  const src = readFileSync(PANEL_JS, "utf8");
  const parts = [namedFunctionSource(src, "stampRootForProducedSave"), namedFunctionSource(src, "stampGraphRootWorkflowUuid")];
  for (const [i, p] of parts.entries()) assert.ok(p, `panel source part ${i} not found`);
  const owners = new Map();
  const stamp = new Function(
    "activeWorkflowRef",
    "sameWorkflowObject",
    "app",
    "rememberWorkflowUuidOwner",
    "WORKFLOW_META_NAMESPACE",
    "WORKFLOW_UUID_FIELD",
    `${parts.join("; ")}; return stampRootForProducedSave;`,
  )(
    () => active,
    sameObject,
    { graph: rootGraph },
    (id, owner) => owners.set(id, owner),
    "comfyui_mcp",
    "workflow_uuid",
  );
  return { stamp, owners };
}

const rootWithTag = (tag) => ({ extra: { comfyui_mcp: { workflow_uuid: tag }, ds: { scale: 1 } } });

test("#978 the reported state: after a Save-As the root still names the PRE-SAVE workflow", () => {
  // Nothing in the save path touched this tag, so the graph fence refuses every tool.
  const root = rootWithTag(PRE_SAVE);
  assert.equal(
    graphRootWorkflowUuidMismatches({ rootGraph: root, activeWorkflowUuid: PRODUCED }),
    true,
    "this is the refusal the reporter hit",
  );
});

test("#978 the save stamps the produced identity onto the root it just serialized", () => {
  const produced = { path: "workflows/new-name.json", isPersisted: true };
  const root = rootWithTag(PRE_SAVE);
  const { stamp, owners } = sandbox({ active: produced, rootGraph: root });
  assert.equal(stamp(produced, { uuid: PRODUCED }), true);
  assert.equal(root.extra.comfyui_mcp.workflow_uuid, PRODUCED, "the stale tag is replaced");
  assert.equal(
    graphRootWorkflowUuidMismatches({ rootGraph: root, activeWorkflowUuid: PRODUCED }),
    false,
    "…so the graph fence stops refusing",
  );
  assert.equal(owners.get(PRODUCED), produced, "and the produced record is recorded as its owner");
  assert.deepEqual(root.extra.ds, { scale: 1 }, "nothing else in extra is disturbed");
});

test("#978 a tab switch DURING the save's awaits stops the stamp", () => {
  // The produced record is what the save activated; if something else is active now, the
  // canvas is not the one this save serialized and must never carry its identity.
  const produced = { path: "workflows/new-name.json" };
  const somethingElse = { path: "workflows/other.json" };
  const root = rootWithTag(PRE_SAVE);
  const { stamp } = sandbox({ active: somethingElse, rootGraph: root });
  assert.equal(stamp(produced, { uuid: PRODUCED }), false);
  assert.equal(root.extra.comfyui_mcp.workflow_uuid, PRE_SAVE, "the root is left exactly as it was");
});

test("#978 no identity, no produced record, no root — no stamp, and no throw", () => {
  const produced = { path: "workflows/new-name.json" };
  const root = rootWithTag(PRE_SAVE);
  for (const [record, identity] of [
    [produced, null],
    [produced, {}],
    [produced, { uuid: "" }],
    [null, { uuid: PRODUCED }],
    ["nope", { uuid: PRODUCED }],
  ]) {
    const { stamp } = sandbox({ active: produced, rootGraph: root });
    assert.equal(stamp(record, identity), false, `record=${String(record)} identity=${JSON.stringify(identity)}`);
  }
  const noRoot = sandbox({ active: produced, rootGraph: null });
  assert.equal(noRoot.stamp(produced, { uuid: PRODUCED }), false);
  assert.equal(root.extra.comfyui_mcp.workflow_uuid, PRE_SAVE);
});

test("#978 a hostile workflow object yields false rather than breaking a save that already wrote", () => {
  const produced = { path: "workflows/new-name.json" };
  const { stamp } = sandbox({
    active: produced,
    rootGraph: rootWithTag(PRE_SAVE),
    sameObject: () => {
      throw new Error("boom");
    },
  });
  assert.doesNotThrow(() => stamp(produced, { uuid: PRODUCED }));
  assert.equal(stamp(produced, { uuid: PRODUCED }), false);
});

test("#978 why the fence's own heal cannot serve a Save-As: the source tab is an identical twin", () => {
  // The content proof must be EXCLUSIVE, and right after a Save-As the ORIGINAL workflow
  // is still open holding byte-identical content — so the proof declines, correctly, and
  // the stale tag would stand forever. This is what makes the causal stamp necessary
  // rather than merely convenient.
  const state = { nodes: [{ id: 1, type: "KSampler", pos: [0, 0], size: [200, 100] }], links: [], groups: [], config: {}, extra: {} };
  const root = {
    ...rootWithTag(PRE_SAVE),
    serialize: () => ({ ...state, extra: { comfyui_mcp: { workflow_uuid: PRE_SAVE } } }),
  };
  const saved = { isModified: false, changeTracker: { activeState: state } };
  assert.equal(
    rootContentProvesActiveWorkflow({ rootGraph: root, activeWorkflow: saved, proofExclusive: false }),
    false,
    "a twin makes the content proof unavailable",
  );
});

test("#978 source guard: both save paths stamp, and an in-place save does not", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const saveHandler = src.slice(src.indexOf("async workflow_save({"), src.indexOf("async workflow_save_as({"));
  assert.match(
    saveHandler,
    /if \(outcome\.saved_as\) stampRootForProducedSave\(producedRecord, replyIdentity\);/,
    "workflow_save stamps ONLY for a Save-As — an in-place save does not change which workflow is active",
  );
  const saveAsHandler = src.slice(src.indexOf("async workflow_save_as({"));
  const body = saveAsHandler.slice(0, saveAsHandler.indexOf("\n  workflow_list()"));
  assert.match(body, /stampRootForProducedSave\(producedRecord, replyIdentity\);/, "save_as always stamps");
  assert.ok(!/if \(outcome\.saved_as\)/.test(body), "…unconditionally, because that path always changes the active workflow");
  // The stamp must be gated on the produced record being active NOW.
  const fn = namedFunctionSource(src, "stampRootForProducedSave");
  assert.match(fn, /if \(!active \|\| !sameWorkflowObject\(active, producedRecord\)\) return false;/);
});
