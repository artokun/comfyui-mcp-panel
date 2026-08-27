/**
 * #1938 — panel_unpack_subgraph crashed on duplicate boundary link ids.
 *
 * The bundled anima-inpaint subgraph serialises link id 1883 twice on one IMAGE output
 * rail. ComfyUI frontend's `unpackSubgraph` removes the link on its first visit and then
 * dereferences the now-missing record on the duplicate:
 *
 *     Cannot read properties of undefined (reading 'target_id')
 *
 * The #405 rollback caught it, so no graph was ever corrupted — the operation simply
 * could not run on that workflow at all.
 *
 * A link id resolves to ONE record with one origin and one target, so two entries
 * carrying the same id cannot be distinct edges. Deduping is therefore
 * semantics-preserving, and the panel never writes `linkIds` (only reads them), so this
 * normalises data that arrives malformed rather than masking our own mutation.
 *
 * Run with `node --test`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(
  new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

/** graph_unpack_subgraph's body only, so a match elsewhere cannot stand in for it. */
const BODY = (() => {
  const start = SRC.indexOf("async graph_unpack_subgraph({ node_id })");
  assert.ok(start > 0, "graph_unpack_subgraph not found — re-anchor this pin");
  const end = SRC.indexOf("\n  graph_", start + 10);
  assert.ok(end > start, "could not bound the handler body");
  return SRC.slice(start, end);
})();

test("#1938 the dedupe runs, and covers BOTH input and output rails", () => {
  assert.match(BODY, /\[node\.subgraph\?\.inputs, node\.subgraph\?\.outputs\]/);
  assert.match(BODY, /new Set\(slot\.linkIds\)/);
});

test("#1938 it runs BEFORE the #1665 external-link snapshot", () => {
  // A snapshot taken over the duplicates would expect a consumer count the unpack can
  // never produce, so the verification and the mutation must see the same state.
  const dedupeAt = BODY.indexOf("new Set(slot.linkIds)");
  const snapshotAt = BODY.indexOf("snapshotExternalLinks(graph, node)");
  assert.ok(dedupeAt > 0 && snapshotAt > 0, "both landmarks must exist");
  assert.ok(dedupeAt < snapshotAt, "dedupe must precede the snapshot");
});

test("#1938 and BEFORE the unpack itself", () => {
  const dedupeAt = BODY.indexOf("new Set(slot.linkIds)");
  const unpackAt = BODY.indexOf("graph.unpackSubgraph(node");
  assert.ok(unpackAt > 0, "the unpack call moved — re-anchor this pin");
  assert.ok(dedupeAt < unpackAt, "dedupe must precede the unpack");
});

test("#1938 a slot with fewer than two ids is left alone", () => {
  // Cheap guard against a rewrite that reassigns every slot: touching arrays that
  // cannot contain a duplicate is pure churn on a hot path.
  assert.match(BODY, /slot\.linkIds\.length < 2\) continue/);
});

test("#1938 the array is only reassigned when something actually changed", () => {
  // Assigning an identical copy would defeat any identity-based change detection the
  // frontend keeps on these arrays.
  assert.match(BODY, /deduped\.length !== slot\.linkIds\.length/);
});

test("#1938 the #405 rollback is still the outer safety net", () => {
  // The dedupe makes the crash not happen; it does not replace the guarantee that a
  // throw leaves the workflow exactly as it was.
  assert.match(BODY, /graph\.unpackSubgraph\(node[\s\S]{0,400}?\} catch \(err\)/);
});

// The semantic claim the fix rests on, stated as an executable check rather than prose:
// deduping a list of link ids cannot drop an edge, because an id identifies an edge.
test("#1938 dedupe preserves the SET of edges, only the multiplicity", () => {
  const withDup = [1883, 1884, 1883];
  const deduped = [...new Set(withDup)];
  assert.deepEqual(new Set(deduped), new Set(withDup), "no edge is lost");
  assert.equal(deduped.length, 2, "only the repeat is removed");
});
