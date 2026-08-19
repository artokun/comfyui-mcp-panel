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
//
// #1242 — and sending the caller to run that recovery BY HAND was the same
// defect one level down: the retried identical add succeeded, so the panel was
// refusing a condition it could clear itself. The add now runs the forced
// refresh once, re-checks the drift against the registry the refresh rewrote,
// and only refuses when the drift survives — which is when this message, and
// its reload fallback, are still the truth.

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
  // #1404 gave the call a `joinMs`, so it no longer fits on one line. Matched as the chain
  // this test is about — a FORCED call into the coalescer — rather than as a formatting.
  assert.match(fn, /refreshComfyNodeDefs\(undefined, \{[\s\S]*?force: true,?[\s\S]*?\}\)/);
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
    PANEL.indexOf("let drifted = driftedRequiredInputNames"),
    PANEL.indexOf("added or retyped since this page loaded its node schema"),
  );
  assert.ok(site.includes("driftedRequiredInputNames(currentDef, nodeData)"));
  assert.ok(
    PANEL.includes("let nodeData = LG?.registered_node_types?.[class_type]?.nodeData;"),
    "nodeData must come from the LiteGraph registry that registerNodesFromDefs writes",
  );
});

test("#1242: the add runs the refresh itself, then re-checks, BEFORE the refusal", () => {
  // The whole point of the fix: the refusal is what remains AFTER the panel has
  // already run the panel_refresh_nodes recovery once. Order is the claim, so
  // pin it — refresh, re-read nodeData, re-check drift, and only then the throw.
  const checkAt = PANEL.indexOf("let drifted = driftedRequiredInputNames");
  const refusalAt = PANEL.indexOf("added or retyped since this page loaded its node schema");
  assert.ok(checkAt > 0 && refusalAt > checkAt, "the drift check must precede the refusal");
  const between = PANEL.slice(checkAt, refusalAt);
  // #1192 — the call now spans lines because it carries a bound, so this matches the SHAPE
  // rather than one spelling of it. STRONGER than the literal it replaces: it pins that the
  // drift recovery is forced AND that its wait draws from the command budget, which is the
  // property #1192 needs and the literal could not express.
  const forced = between.match(
    /refreshComfyNodeDefs\(undefined, \{\s*force: true,\s*joinMs: budget\.remaining\(\) - ADD_NODE_POST_REFRESH_RESERVE_MS,\s*\}\)/,
  );
  assert.ok(
    forced,
    "the drift branch must run the forced refresh itself, bounded by the command budget",
  );
  const refreshAt = forced.index;
  assert.ok(refreshAt > 0, "the drift branch must run the forced refresh itself");
  const recheckAt = between.indexOf("drifted = driftedRequiredInputNames(currentDef, nodeData)", refreshAt);
  assert.ok(recheckAt > refreshAt, "the drift must be re-checked AFTER the refresh");
  assert.ok(
    between.indexOf("nodeData = LG?.registered_node_types?.[class_type]?.nodeData;") > refreshAt,
    "nodeData must be re-read from the registry the refresh rewrote",
  );
});

test("#1242: a drift the refresh clears is NOT refused", () => {
  // The refusal is gated on the POST-refresh drift, not the pre-refresh one — a
  // refusal that fired on the stale reading would make the auto-refresh
  // pointless.
  const refusalAt = PANEL.indexOf("added or retyped since this page loaded its node schema");
  const gate = PANEL.slice(PANEL.lastIndexOf("if (drifted.length) {", refusalAt), refusalAt);
  assert.ok(gate.startsWith("if (drifted.length) {"), "the refusal must be gated on the re-checked drift");
});
