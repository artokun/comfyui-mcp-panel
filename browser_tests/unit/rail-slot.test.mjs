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
import { findExistingRailSlot, railSlotIndex } from "../../web/js/lib/rail-slot.js";

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

test("#1114 a slot genuinely NAMED '4' wins over the index", () => {
  // Renaming a rail input to a digit is legal, and a caller passing that name means
  // it. Index-first would have connected them to the wrong slot silently — worse
  // than the junk slot this fixes.
  const named = [{ name: "zero", slot: 0 }, { name: "4", slot: 1 }, { name: "two", slot: 2 }];
  assert.equal(findExistingRailSlot(named, "4")?.slot, 1);
  // And a real NUMBER 4 finds it too, because the wire cannot tell the two apart:
  // MCP coercion turns numbers into strings, so "the caller passed a number" is not
  // knowable here. Name-first is the safer rule either way — the alternative mints a
  // SECOND slot also named "4", which is the corruption this fixes, doubled.
  assert.equal(findExistingRailSlot(named, 4)?.slot, 1);
});

test("#1114 name matching stays case-insensitive", () => {
  assert.equal(findExistingRailSlot([{ name: "Prompt" }], "prompt")?.name, "Prompt");
  assert.equal(findExistingRailSlot([{ name: "prompt" }], "PROMPT")?.name, "prompt");
});

test("#1114 the index parse is STRICT — a mistyped name must not hit an index", () => {
  // A loose parse would turn a typo into a silent connection to an unrelated slot,
  // which is a worse failure than the visible junk slot: nothing would look wrong.
  for (const bad of [" 4 ", "4.0", "0x4", "+4", "4px", "-1", "", "  ", "1e1"]) {
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
    /import \{ findExistingRailSlot \} from "\.\/lib\/rail-slot\.js";/,
    "the panel imports the shared lookup",
  );
  assert.doesNotMatch(
    panel,
    /function findExistingRailSlot\s*\(/,
    "and keeps no local copy that would shadow it",
  );
  // Both rail branches must go through it: outputs (to_input) and inputs (from_output).
  const uses = panel.match(/findExistingRailSlot\(graph\.(inputs|outputs),/g) ?? [];
  assert.equal(uses.length, 2, "both rail branches resolve through it");
});
