import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// #852 — `panel_add_node` refuses correctly when a class's required inputs drifted
// since the page loaded its schema (a model file moved between folders changes a
// loader's combo, and creating the node now would build the OLD shape). The
// refusal was right; the recovery it named was not.
//
// It said to reload the ComfyUI tab. `panel_refresh_nodes` clears the same
// condition in place — it re-fetches /object_info and calls
// `registerNodesFromDefs`, which is precisely what updates the `nodeData` this
// check reads — and the reporter verified that. Telling a user to throw away
// their canvas state for something the panel can fix without it is the same
// class of defect as #663: a refusal that sends the caller to the wrong recovery
// costs more than the refusal.

const PANEL = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");

/** The refusal text, read from the source it is built in. */
const refusal = (() => {
  const at = PANEL.indexOf("added or retyped since this page loaded its node schema");
  assert.ok(at > 0, "the schema-drift refusal must exist");
  return PANEL.slice(at, PANEL.indexOf("      );", at));
})();

test("the refusal names panel_refresh_nodes", () => {
  assert.ok(refusal.includes("panel_refresh_nodes"), "the working recovery must be named");
});

test("panel_refresh_nodes comes FIRST, before the tab reload", () => {
  // Order is the whole point. Both work; only one keeps the user's canvas, and a
  // reader takes the first remedy offered.
  const refreshAt = refusal.indexOf("panel_refresh_nodes");
  const reloadAt = refusal.indexOf("Reloading the ComfyUI tab");
  assert.ok(refreshAt > 0 && reloadAt > 0, "both remedies must be present");
  assert.ok(refreshAt < reloadAt, "the non-destructive remedy must be offered first");
});

test("the tab reload survives as the FALLBACK, not as the only answer", () => {
  // refresh_nodes can report that it did not complete (it returns
  // `refreshed:false` with a reason), and a refusal that had removed the reload
  // would then leave the caller with nothing.
  assert.ok(refusal.includes("fallback"), "the reload must remain as a fallback");
});

test("it says what the refresh does NOT fix", () => {
  // registerNodesFromDefs mints new classes; node INSTANCES already on the canvas
  // keep the shape they were created with. A recovery that oversells itself sends
  // someone hunting for why an existing node still looks wrong.
  assert.ok(refusal.includes("ALREADY on the canvas"), "the limit must be stated");
});

test("it no longer tells the user to reload as the primary remedy", () => {
  assert.ok(
    !refusal.includes("Reload the ComfyUI tab so"),
    "the old reload-first wording must be gone",
  );
});

// ── the claim the message makes has to be true ─────────────────────────────

test("refresh_nodes really does re-register the class this check reads", () => {
  // The message asserts refresh_nodes re-fetches /object_info and re-registers
  // the class. If that stopped being true the refusal would be lying, so pin the
  // chain: refresh_nodes -> refreshComfyNodeDefs(force) -> getNodeDefs +
  // registerNodesFromDefs.
  const fn = PANEL.slice(PANEL.indexOf("async refresh_nodes() {"), PANEL.indexOf("graph_serialize() {"));
  assert.ok(fn.includes("refreshComfyNodeDefs(undefined, { force: true })"));
  const register = PANEL.slice(
    PANEL.indexOf("async function registerComfyNodeDefs"),
    PANEL.indexOf("const refreshComfyNodeDefs = makeRefreshCoalescer"),
  );
  assert.ok(register.includes("api.getNodeDefs()"), "it must re-fetch the schema");
  assert.ok(register.includes("registerNodesFromDefs(defs)"), "it must re-register the classes");
});

test("the drift check reads the registry nodeData the refresh updates", () => {
  // The two halves have to be about the same thing, or the named recovery is a
  // coincidence rather than a fix.
  const site = PANEL.slice(
    PANEL.indexOf("const drifted = driftedRequiredInputNames"),
    PANEL.indexOf("added or retyped since this page loaded its node schema"),
  );
  assert.ok(site.includes("driftedRequiredInputNames(currentDef, nodeData)"));
  assert.ok(
    PANEL.includes("const nodeData = LG?.registered_node_types?.[class_type]?.nodeData;"),
    "nodeData must come from the LiteGraph registry that registerNodesFromDefs writes",
  );
});
