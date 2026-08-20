// comfyui-mcp-panel#1463 — `panel_create_subgraph` / `panel_subgraph_group` both failed
// with nothing but the frontend's own exception text:
//
//     Error: Attempted to access LGraph reference that was null or undefined.
//
// The reporter concluded "no other side effects", retried three times, then tried the
// group entry point, then a two-node native-only selection, and got the identical string
// every time. Six failures, no information.
//
// ## What was measured (real browser, the ComfyUI on this machine)
//
// Root graph `1→2→3→4` wired in a chain, node 1's `graph` back-reference cleared,
// converting the middle pair `[2, 3]`:
//
//     nodes before: 1,2,3,4        subgraph definitions: 0
//     → throws "Attempted to access LGraph reference that was null or undefined."
//     nodes after:  1,4,5          subgraph definitions: 1
//     node 5 is the new subgraph node; its input link is `null`
//
// The selected nodes were REMOVED, a definition was registered, and the wrapper was left
// wired to nothing — reported to the caller as a bare exception. Clearing the back
// reference on a SELECTED node instead throws with the canvas untouched, and an extension
// that wraps `convertToSubgraph` (cg-use-everywhere replaces `app.graph.convertToSubgraph`
// with a whole-graph pre-pass; its frames are in the reproduction's stack) throws before
// the frontend's own code runs at all.
//
// One message, two opposite states of the canvas. The caller's correct next move — retry,
// or undo and re-read — differs completely between them, and it had no way to tell.
//
// ## What is pinned here
//
// 1. The pre-flight names the one condition that provably causes this, on the SELECTION
//    and on its boundary NEIGHBOURS, and refuses before anything is mutated.
// 2. It refuses ONLY on a nullish back-reference — never on graph identity, which on a
//    reactive frontend would read a Vue proxy of the live root as a foreign graph and
//    refuse every conversion (the #558 proxy/raw duality).
// 3. A throw is reported with a measured verdict, and the frontend's message survives
//    verbatim in all three verdicts so that existing searches for it still hit.
// 4. Both tool entry points route through it. A helper nobody calls fixes nothing, and
//    #1463 reported BOTH paths failing identically.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  detachedConversionNodes,
  detachedConversionRefusal,
  conversionSnapshot,
  conversionThrowReport,
} from "../../web/js/lib/subgraph-conversion-integrity.js";

const src = () =>
  readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");

/** Source with comment lines stripped — the guard's own doc comment quotes the code it
 *  replaced, and matching that would pass on a reverted tree. */
const code = () =>
  src()
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\*|\/\/)/.test(line))
    .join("\n");

/** The chain measured in the browser: 1→2→3→4, links 10/11/12, live-litegraph `Map`
 *  link table. Selecting [2, 3] makes 1 and 4 the boundary neighbours. */
function chain({ linksAs = "map" } = {}) {
  const n1 = { id: 1, inputs: [], outputs: [{ links: [10] }] };
  const n2 = { id: 2, inputs: [{ link: 10 }], outputs: [{ links: [11] }] };
  const n3 = { id: 3, inputs: [{ link: 11 }], outputs: [{ links: [12] }] };
  const n4 = { id: 4, inputs: [{ link: 12 }], outputs: [{ links: [] }] };
  const nodes = [n1, n2, n3, n4];
  const rawLinks = [
    { id: 10, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0 },
    { id: 11, origin_id: 2, origin_slot: 0, target_id: 3, target_slot: 0 },
    { id: 12, origin_id: 3, origin_slot: 0, target_id: 4, target_slot: 0 },
  ];
  const links =
    linksAs === "map"
      ? new Map(rawLinks.map((l) => [l.id, l]))
      : linksAs === "tuples"
        ? rawLinks.map((l) => [l.id, l.origin_id, l.origin_slot, l.target_id, l.target_slot])
        : Object.fromEntries(rawLinks.map((l) => [l.id, l]));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const graph = {
    getNodeById: (id) => byId.get(id) ?? null,
    links,
    subgraphs: new Map(),
  };
  for (const n of nodes) n.graph = graph;
  return { graph, n1, n2, n3, n4 };
}

/* -------------------------------------------------------------------------- */
/* 1. the pre-flight finds the condition that throws                           */
/* -------------------------------------------------------------------------- */

test("a detached boundary NEIGHBOUR is found — that is the destructive case", () => {
  const { graph, n1, n2, n3 } = chain();
  n1.graph = null; // node 1 is outside the selection; the reconnect loop touches it
  assert.deepEqual(detachedConversionNodes(graph, [n2, n3]), [1]);
});

test("a detached SELECTED node is found too", () => {
  const { graph, n2, n3 } = chain();
  n2.graph = null;
  assert.deepEqual(detachedConversionNodes(graph, [n2, n3]), [2]);
});

test("a healthy chain produces no finding", () => {
  const { graph, n2, n3 } = chain();
  assert.deepEqual(detachedConversionNodes(graph, [n2, n3]), []);
});

test("neighbours are found through a serialized link table as well as a live Map", () => {
  for (const linksAs of ["map", "tuples", "object"]) {
    const { graph, n1, n2, n3 } = chain({ linksAs });
    n1.graph = null;
    assert.deepEqual(detachedConversionNodes(graph, [n2, n3]), [1], `link table: ${linksAs}`);
  }
});

/* -------------------------------------------------------------------------- */
/* 2. it refuses on nothing else                                               */
/* -------------------------------------------------------------------------- */

test("a node whose graph is a DIFFERENT object is never reported", () => {
  // On a reactive frontend `node.graph` and the graph handed to a command can be a Vue
  // proxy and its raw target. Comparing graph identity would refuse every conversion.
  const { graph, n1, n2, n3 } = chain();
  n1.graph = { notTheSameObject: true };
  assert.deepEqual(detachedConversionNodes(graph, [n2, n3]), []);
});

test("a node the graph does not own is never reported, however detached", () => {
  const { graph, n2, n3 } = chain();
  const impostor = { id: 2, graph: null, inputs: [], outputs: [] }; // same id, other object
  assert.deepEqual(detachedConversionNodes(graph, [impostor, n2, n3]), []);
});

test("an unreadable graph falls through to the conversion instead of refusing it", () => {
  const { n2, n3 } = chain();
  n2.graph = null;
  assert.deepEqual(detachedConversionNodes({ links: null }, [n2, n3]), []);
  assert.deepEqual(detachedConversionNodes(null, [n2, n3]), []);
});

test("an empty selection produces no finding", () => {
  const { graph } = chain();
  assert.deepEqual(detachedConversionNodes(graph, []), []);
  assert.deepEqual(detachedConversionNodes(graph, undefined), []);
});

test("the refusal states the graph was not touched, and names the nodes", () => {
  const msg = detachedConversionRefusal({ what: "panel_create_subgraph", detached: [1] });
  assert.match(msg, /was NOT run and the graph is unchanged/);
  assert.match(msg, /Node 1 /);
  // It must carry the string the reporter would search for.
  assert.match(msg, /Attempted to access LGraph reference that was null or undefined\./);
});

/* -------------------------------------------------------------------------- */
/* 3. a throw is reported with a MEASURED verdict                              */
/* -------------------------------------------------------------------------- */

const RAW = "Attempted to access LGraph reference that was null or undefined.";

test("nodes gone → the report says the graph CHANGED and names them", () => {
  const msg = conversionThrowReport({
    what: "panel_create_subgraph",
    message: RAW,
    before: { present: [2, 3], readable: true, definitions: 0 },
    after: { present: [], readable: true, definitions: 1 },
  });
  assert.match(msg, /FAILED PART WAY THROUGH and the graph HAS CHANGED/);
  assert.match(msg, /2 of the 2 node\(s\) you selected \(2, 3\)/);
  assert.match(msg, /1 subgraph definition\(s\) were registered/);
  assert.match(msg, /do not retry blindly/);
  assert.ok(msg.includes(RAW), "the frontend's own message must survive verbatim");
});

test("a definition registered with every node still present also counts as CHANGED", () => {
  const msg = conversionThrowReport({
    what: "panel_subgraph_group",
    message: RAW,
    before: { present: [2, 3], readable: true, definitions: 0 },
    after: { present: [2, 3], readable: true, definitions: 1 },
  });
  assert.match(msg, /HAS CHANGED/);
  assert.match(msg, /every node you selected is still on the canvas/);
});

test("nothing moved → the report says UNCHANGED and that there is nothing to undo", () => {
  const msg = conversionThrowReport({
    what: "panel_create_subgraph",
    message: RAW,
    before: { present: [2, 3], readable: true, definitions: 0 },
    after: { present: [2, 3], readable: true, definitions: 0 },
  });
  assert.match(msg, /the graph is UNCHANGED/);
  assert.match(msg, /nothing to undo/);
  assert.doesNotMatch(msg, /HAS CHANGED/);
  assert.ok(msg.includes(RAW));
});

test("an unreadable snapshot is reported as UNKNOWN, never as untouched", () => {
  const msg = conversionThrowReport({
    what: "panel_create_subgraph",
    message: RAW,
    before: { present: [], readable: false, definitions: null },
    after: { present: [], readable: false, definitions: null },
  });
  assert.match(msg, /could NOT establish whether the graph changed/);
  assert.match(msg, /unknown rather than untouched/);
  assert.doesNotMatch(msg, /the graph is UNCHANGED/);
  assert.ok(msg.includes(RAW));
});

test("a definition COUNT that only fell is not reported as a change", () => {
  // Defensive: a shrinking count is not evidence this conversion created anything.
  const msg = conversionThrowReport({
    what: "panel_create_subgraph",
    message: RAW,
    before: { present: [2], readable: true, definitions: 3 },
    after: { present: [2], readable: true, definitions: 2 },
  });
  assert.match(msg, /the graph is UNCHANGED/);
});

test("every verdict names the tool and attributes the throw to the frontend", () => {
  const cases = [
    { before: { present: [2], readable: true, definitions: 0 }, after: { present: [], readable: true, definitions: 1 } },
    { before: { present: [2], readable: true, definitions: 0 }, after: { present: [2], readable: true, definitions: 0 } },
    { before: { present: [], readable: false, definitions: null }, after: { present: [], readable: false, definitions: null } },
  ];
  for (const c of cases) {
    const msg = conversionThrowReport({ what: "panel_subgraph_group", message: RAW, ...c });
    assert.match(msg, /panel_subgraph_group/);
    assert.match(msg, /ComfyUI's (own )?convertToSubgraph/);
    assert.ok(msg.includes(RAW));
  }
});

test("a throw with no message still produces a usable report", () => {
  const msg = conversionThrowReport({
    what: "panel_create_subgraph",
    message: "",
    before: { present: [2], readable: true, definitions: 0 },
    after: { present: [2], readable: true, definitions: 0 },
  });
  assert.match(msg, /\(no message\)/);
});

/* -------------------------------------------------------------------------- */
/* 4. the snapshot compares node IDENTITY                                      */
/* -------------------------------------------------------------------------- */

test("a re-issued id does not read as the original node surviving", () => {
  const { graph, n2, n3 } = chain();
  const before = conversionSnapshot(graph, [n2, n3]);
  assert.deepEqual(before.present, [2, 3]);
  assert.equal(before.definitions, 0);
  assert.equal(before.readable, true);

  // The frontend removed 2 and 3 and handed id 2 to something else.
  const replacement = { id: 2, inputs: [], outputs: [], graph };
  const after = conversionSnapshot(
    { getNodeById: (id) => (id === 2 ? replacement : null), links: null, subgraphs: new Map([["a", {}]]) },
    [n2, n3],
  );
  assert.deepEqual(after.present, []);
  assert.equal(after.definitions, 1);
});

test("a frontend with no node lookup reports itself unreadable rather than empty", () => {
  const { n2, n3 } = chain();
  const snap = conversionSnapshot({}, [n2, n3]);
  assert.equal(snap.readable, false);
  assert.deepEqual(snap.present, [2, 3]);
  assert.equal(snap.definitions, null);
});

/* -------------------------------------------------------------------------- */
/* 5. both tools actually go through it                                        */
/* -------------------------------------------------------------------------- */

test("neither conversion tool calls convertToSubgraph bare any more", () => {
  const body = code();
  const bare = body.match(/graph\.convertToSubgraph\(canvas\.selectedItems\)/g) ?? [];
  assert.equal(
    bare.length,
    1,
    "exactly one call site may remain — the shared runner inside convertSelectionToSubgraph",
  );
  const runner = body.slice(body.indexOf("function convertSelectionToSubgraph("));
  assert.ok(
    runner.slice(0, runner.indexOf("\nfunction ")).includes("graph.convertToSubgraph(canvas.selectedItems)"),
    "the surviving call site must be the runner's",
  );
});

test("both entry points route through the runner, naming themselves", () => {
  const body = code();
  assert.match(body, /convertSelectionToSubgraph\(\{[\s\S]{0,200}?what: "panel_create_subgraph",/);
  assert.match(body, /convertSelectionToSubgraph\(\{[\s\S]{0,200}?what: "panel_subgraph_group",/);
});

test("the runner refuses BEFORE the conversion and keeps beforeChange/afterChange paired", () => {
  const body = code();
  const runner = body.slice(body.indexOf("function convertSelectionToSubgraph("));
  const fn = runner.slice(0, runner.indexOf("\nfunction "));
  const refuseAt = fn.indexOf("detachedConversionRefusal");
  const convertAt = fn.indexOf("graph.convertToSubgraph");
  assert.ok(refuseAt > -1 && convertAt > -1, "both the refusal and the call must be present");
  assert.ok(refuseAt < convertAt, "the refusal must come before the conversion, or it repairs nothing");
  assert.ok(fn.includes("graph.beforeChange?.()"), "beforeChange must still be called");
  assert.ok(fn.includes("graph.afterChange?.()"), "afterChange must still be called");
  assert.ok(fn.includes("finally"), "afterChange must stay in a finally");
  assert.ok(fn.includes("{ cause: err }"), "the frontend's own error must be kept as the cause");
});
