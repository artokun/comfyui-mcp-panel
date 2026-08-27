// #1114 — a numeric from_output minted a junk rail slot instead of reusing one.
//
//   panel_connect({ from_node_id: -10, from_output: 4, to_node_id: 217, to_input: "prompt" })
//     -> { "exposed": { "name": "4", "type": "STRING", "slot": 12, ... } }
//
// `exposed`, not `connected`: the lookup returned null, so graph_connect's
// input-rail branch fell through to graph_expose_subgraph_input and created a rail
// input literally named "4". Permanent, and visible as a junk slot on the parent
// subgraph node too.
//
// The index branch was gated on `typeof ref === "number"` while MCP argument
// coercion delivers `from_output: 4` as the string "4". A lookup that failed closed
// would have been a refusal; this one edited the user's subgraph.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  findExistingRailSlot,
  railSlotIndex,
  refuseConnectToRawRail,
  resolveRailSlotForRemoval,
  reindexHostRailLinks,
} from "../../web/js/lib/rail-slot.js";

/** A rail with twelve slots, none of them named with digits — the reported shape. */
const RAIL = Array.from({ length: 12 }, (_, i) => ({ name: `in_${i}`, type: "STRING", slot: i }));

test("#1114 a numeric STRING index resolves the existing slot", () => {
  // The exact reported call: from_output arrives as "4".
  assert.equal(findExistingRailSlot(RAIL, "4")?.name, "in_4");
  assert.equal(findExistingRailSlot(RAIL, "0")?.name, "in_0");
  assert.equal(findExistingRailSlot(RAIL, "11")?.name, "in_11");
});

test("#1114 a real number still resolves, as it always did", () => {
  assert.equal(findExistingRailSlot(RAIL, 4)?.name, "in_4");
  assert.equal(findExistingRailSlot(RAIL, 0)?.name, "in_0");
});

test("#1114 an out-of-range index is null — never a new slot's worth of null", () => {
  // Null is what the caller turns into "expose a new one", so the boundary matters:
  // 12 slots means 11 is the last valid index.
  assert.equal(findExistingRailSlot(RAIL, "12"), null);
  assert.equal(findExistingRailSlot(RAIL, 12), null);
  assert.equal(findExistingRailSlot([], "0"), null);
});

test("#1114 a slot genuinely NAMED '4' resolves when no index competes", () => {
  // Renaming a rail input to a digit is legal. There is no name-vs-index precedence
  // here — a mutation swapping the two changed nothing, because a genuine conflict
  // now refuses (below) and anything else has only one match to return.
  const named = [{ name: "zero", slot: 0 }, { name: "4", slot: 1 }, { name: "two", slot: 2 }];
  assert.equal(findExistingRailSlot(named, "4")?.slot, 1);
  // And a real NUMBER 4 finds it too, because the wire cannot tell the two apart:
  // MCP coercion turns numbers into strings, so "the caller passed a number" is not
  // knowable here. Name-first is the safer rule either way — the alternative mints a
  // SECOND slot also named "4", which is the corruption this fixes, doubled.
  assert.equal(findExistingRailSlot(named, 4)?.slot, 1);
});

test("#1114 a leading-zero name resolves by NAME when the slot exists", () => {
  // "007" is a legal slot name. It must match that slot — and must NOT fall through
  // to index 7 when no such slot exists.
  const named = [{ name: "a", slot: 0 }, { name: "007", slot: 1 }];
  assert.equal(findExistingRailSlot(named, "007")?.slot, 1);
  assert.equal(findExistingRailSlot(RAIL, "007"), null); // no slot named "007" here
});

test("#1114 name matching stays case-insensitive", () => {
  assert.equal(findExistingRailSlot([{ name: "Prompt" }], "prompt")?.name, "Prompt");
  assert.equal(findExistingRailSlot([{ name: "prompt" }], "PROMPT")?.name, "prompt");
});

test("#1114 the index parse is STRICT — a mistyped name must not hit an index", () => {
  // A loose parse would turn a typo into a silent connection to an unrelated slot,
  // which is a worse failure than the visible junk slot: nothing would look wrong.
  // codex review, P1: "04"/"007" were accepted by /^\d+$/ — so a name-shaped "007"
  // with no matching slot connected silently to index 7. My own list had exotic
  // cases and missed the obvious one.
  for (const bad of [" 4 ", "4.0", "0x4", "+4", "4px", "-1", "", "  ", "1e1", "04", "007", "00"]) {
    assert.equal(railSlotIndex(bad), null, JSON.stringify(bad));
    assert.equal(findExistingRailSlot(RAIL, bad), null, JSON.stringify(bad));
  }
});

test("#1114 negative and non-integer numbers are not indices", () => {
  assert.equal(railSlotIndex(-1), null);
  assert.equal(railSlotIndex(1.5), null);
  assert.equal(railSlotIndex(Number.NaN), null);
  assert.equal(railSlotIndex(Number.MAX_SAFE_INTEGER + 2), null);
});

test("#1114 null/undefined refs resolve to null rather than throwing", () => {
  assert.equal(findExistingRailSlot(RAIL, null), null);
  assert.equal(findExistingRailSlot(RAIL, undefined), null);
  assert.equal(findExistingRailSlot(null, "4"), null);
  assert.equal(findExistingRailSlot(undefined, 4), null);
});

test("#1114 slots without names do not break the name pass", () => {
  const ragged = [{ slot: 0 }, { name: null, slot: 1 }, { name: "in_2", slot: 2 }];
  assert.equal(findExistingRailSlot(ragged, "2")?.slot, 2); // falls through to index
  assert.equal(findExistingRailSlot(ragged, "in_2")?.slot, 2);
});

test("#1114 WIRING: the panel uses the shared lookup and keeps no copy", () => {
  // Removing the import leaves the panel referencing an undefined identifier, which
  // typecheck did NOT catch — and the behavioural tests above cannot see the call
  // site at all, so a mutation dropping it survived until this existed.
  const panel = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../web/js/comfyui-mcp-panel.js"),
    "utf8",
  );
  assert.match(
    panel,
    /import \{\s*findExistingRailSlot,\s*resolveRailSlotForRemoval,\s*countHostRailLinks,\s*reindexHostRailLinks,\s*refuseConnectToRawRail,\s*\} from "\.\/lib\/rail-slot\.js";/,
    "the panel imports the shared lookups",
  );
  assert.doesNotMatch(
    panel,
    /function findExistingRailSlot\s*\(/,
    "and keeps no local copy that would shadow it",
  );
  assert.doesNotMatch(
    panel,
    /function resolveRailSlotForRemoval\s*\(/,
    "and keeps no local copy of the removal resolver either",
  );
  assert.doesNotMatch(
    panel,
    /function countHostRailLinks\s*\(/,
    "and keeps no local copy of the host-wire counter either",
  );
  assert.doesNotMatch(
    panel,
    /function reindexHostRailLinks\s*\(/,
    "and keeps no local copy of the host-link reindexer either",
  );
  assert.doesNotMatch(
    panel,
    /function refuseConnectToRawRail\s*\(/,
    "and keeps no local copy of the raw-rail connect refusal either",
  );
  // Both rail branches must go through it: outputs (to_input) and inputs (from_output).
  const uses = panel.match(/findExistingRailSlot\(graph\.(inputs|outputs),/g) ?? [];
  assert.equal(uses.length, 2, "both rail branches resolve through it");
  // And both unexpose executors resolve through the removal resolver.
  const removals = panel.match(/resolveRailSlotForRemoval\(subgraph\.(inputs|outputs),/g) ?? [];
  assert.equal(removals.length, 2, "both unexpose executors resolve through it");
  const reindexes = panel.match(/reindexHostRailLinks\(rootGraph, subgraph, "(input|output)", slotIndex\)/g) ?? [];
  assert.equal(reindexes.length, 2, "both unexpose executors reindex remaining host links");
  // Both connect-to-rail auto-expose fallthroughs refuse through the shared helper.
  const refusals = panel.match(/refuseConnectToRawRail\((?:to_node_id|from_node_id),/g) ?? [];
  assert.equal(refusals.length, 2, "both raw-rail connect fallthroughs refuse through it");
});

test("#1953 a raw output rail id uses the documented connect refusal wording", () => {
  assert.throws(
    () => refuseConnectToRawRail(-20, "output"),
    (err) => {
      assert.match(err.message, /do NOT panel_connect to a guessed rail node id/);
      assert.match(err.message, /panel_connect REFUSES it/);
      assert.match(err.message, /panel_expose_subgraph_output/);
      assert.match(err.message, /rail_node_id/);
      assert.match(err.message, /Nothing was exposed/);
      assert.doesNotMatch(err.message, /graph_expose_subgraph_output/);
      return true;
    },
  );
});

test("#1953 a raw input rail id names panel_expose_subgraph_input, not the output twin", () => {
  assert.throws(
    () => refuseConnectToRawRail(-10, "input"),
    (err) => {
      assert.match(err.message, /do NOT panel_connect to a guessed rail node id/);
      assert.match(err.message, /panel_expose_subgraph_input/);
      assert.doesNotMatch(err.message, /panel_expose_subgraph_output/);
      return true;
    },
  );
});

test("#1294 removal resolves a slot by name or index, like a connect", () => {
  const rail = [{ name: "model", slot: 0 }, { name: "prompt", slot: 1 }];
  assert.equal(resolveRailSlotForRemoval(rail, "prompt", "input")?.slot, 1);
  assert.equal(resolveRailSlotForRemoval(rail, "PROMPT", "input")?.slot, 1); // case-insensitive
  assert.equal(resolveRailSlotForRemoval(rail, 0, "input")?.slot, 0);
  assert.equal(resolveRailSlotForRemoval(rail, "1", "input")?.slot, 1);
});

test("#1294 removal of an UNKNOWN slot refuses and names what IS on the rail", () => {
  // The pre-#930 failure shape was reporting a miss as something else; a removal
  // that no-ops or guesses silently is the destructive version of the same bug.
  const rail = [{ name: "model", slot: 0 }, { name: "prompt", slot: 1 }];
  assert.throws(() => resolveRailSlotForRemoval(rail, "pixels", "input"), /No input boundary slot "pixels"/);
  assert.throws(() => resolveRailSlotForRemoval(rail, "5", "input"), /No input boundary slot "5"/);
  try {
    resolveRailSlotForRemoval(rail, "pixels", "input");
    assert.fail("must throw");
  } catch (e) {
    assert.match(e.message, /nothing was removed/);
    assert.match(e.message, /Available input slots: model, prompt/);
    assert.match(e.message, /rails\.input/);
  }
});

test("#1294 a rail_node_id is rejected BY NAME, never used as an index", () => {
  // -20 is the synthetic id of the WHOLE output rail (panel_query_graph's
  // rails.output.rail_node_id), not of a slot on it. Silently indexing with it
  // would remove an unrelated slot — worse than the refusal the issue asks for.
  const rail = [{ name: "images", slot: 0 }, { name: "latent", slot: 1 }];
  assert.throws(() => resolveRailSlotForRemoval(rail, -20, "output"), /rail_node_id/);
  try {
    resolveRailSlotForRemoval(rail, -20, "output");
    assert.fail("must throw");
  } catch (e) {
    assert.match(e.message, /WHOLE output RAIL, not of a slot on it/);
    assert.match(e.message, /Nothing was removed/);
  }
  // And the ambiguous digit-name refusal still fires on the removal path.
  const crossed = [{ name: "1", slot: 0 }, { name: "0", slot: 1 }];
  assert.throws(() => resolveRailSlotForRemoval(crossed, "1", "input"), /ambiguous on this boundary rail/);
});

test("#1114 an AMBIGUOUS ref refuses instead of guessing (codex round 2)", () => {
  // Digit-named slots out of index order: `from_output: 1` means either the slot
  // NAMED "1" (index 0) or index 1 (named "0"). The wire cannot tell — coercion
  // flattens 1 and "1" — so name-first would have connected to the wrong input
  // silently, which is the failure this whole fix removes.
  const crossed = [{ name: "1", slot: 0 }, { name: "0", slot: 1 }];
  assert.throws(() => findExistingRailSlot(crossed, "1"), /ambiguous on this boundary rail/);
  assert.throws(() => findExistingRailSlot(crossed, 1), /ambiguous on this boundary rail/);
  // It names BOTH candidates and what to do about it.
  try {
    findExistingRailSlot(crossed, "1");
    assert.fail("must throw");
  } catch (e) {
    assert.match(e.message, /NAMED "1" \(at index 0\)/);
    assert.match(e.message, /index 1 is a different slot \(named "0"\)/);
    assert.match(e.message, /Rename the digit-named slot/);
  }
});

test("#1114 a digit-named slot AT its own index is not ambiguous", () => {
  // name and index agree — one slot, no conflict, no refusal.
  const aligned = [{ name: "0", slot: 0 }, { name: "1", slot: 1 }];
  assert.equal(findExistingRailSlot(aligned, "1")?.slot, 1);
  assert.equal(findExistingRailSlot(aligned, 1)?.slot, 1);
});

test("#1114 a digit name with NO matching index still resolves by name", () => {
  const named = [{ name: "a", slot: 0 }, { name: "7", slot: 1 }];
  assert.equal(findExistingRailSlot(named, "7")?.slot, 1); // index 7 does not exist
});

test("#1969 reindexHostRailLinks writes the live index onto object-form and array-form links", () => {
  const objectLink = { id: 1, origin_id: 2, origin_slot: 0, target_id: 7, target_slot: 2 };
  const arrayLink = [2, 3, 0, 7, 3, "IMAGE"];
  const subgraph = {};
  const host = {
    id: 7,
    subgraph,
    inputs: [{ name: "keep", link: 1 }, { name: "shifted", link: 2 }],
  };
  const root = { _nodes: [host], links: { 1: objectLink, 2: arrayLink } };
  host.graph = root;
  reindexHostRailLinks(root, subgraph, "input", 1);
  assert.equal(objectLink.target_slot, 2, "slots before the removed index are left alone");
  assert.equal(arrayLink[4], 1);

  const objectAgain = { id: 1, origin_id: 2, origin_slot: 0, target_id: 7, target_slot: 2 };
  const arrayAgain = [2, 3, 0, 7, 3, "IMAGE"];
  host.inputs = [
    { name: "shifted-object", link: 1 },
    { name: "shifted-array", link: 2 },
  ];
  root.links = { 1: objectAgain, 2: arrayAgain };
  reindexHostRailLinks(root, subgraph, "input", 0);
  assert.equal(objectAgain.target_slot, 0);
  assert.equal(arrayAgain[4], 1);
});

test("#1969 reindexHostRailLinks walks nested hosts and skips foreign links", () => {
  const subgraph = {};
  const nestedLink = { id: 4, origin_id: 1, origin_slot: 0, target_id: 15, target_slot: 2 };
  const foreign = { id: 5, origin_id: 1, origin_slot: 0, target_id: 99, target_slot: 2 };
  const nestedHost = {
    id: 15,
    subgraph,
    inputs: [{ name: "a", link: null }, { name: "b", link: 4 }],
  };
  const parentSub = { _nodes: [nestedHost], links: { 4: nestedLink } };
  nestedHost.graph = parentSub;
  const decoy = {
    id: 8,
    subgraph,
    inputs: [{ name: "a", link: null }, { name: "b", link: 5 }],
    graph: { links: { 5: foreign } },
  };
  const root = { _nodes: [{ subgraph: parentSub }, decoy] };
  decoy.graph.links = { 5: foreign };
  reindexHostRailLinks(root, subgraph, "input", 1);
  assert.equal(nestedLink.target_slot, 1);
  assert.equal(foreign.target_slot, 2, "a link that does not target this host is left alone");
});
