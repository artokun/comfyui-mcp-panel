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
// wired to nothing — reported to the caller as a bare exception.
//
// Clearing the back-reference on a SELECTED node instead throws at `disconnectInput`,
// which the shipped `_convertToSubgraphImpl` runs AFTER `createSubgraph`. Measured
// through `LGraph.prototype.convertToSubgraph`, bypassing the wrapper this install has:
//
//     nodes 1,2,3,4 → 1,2,3,4   but   subgraph defs 0 → 1
//
// So the two failures are not "destroyed" versus "untouched": one loses nodes, the other
// quietly registers a definition, and both print the same sentence.
//
// ## The claim that may NOT be made (gate P1 on the first version of this)
//
// The first version answered "the graph is UNCHANGED … nothing to undo" from node
// presence and the definition count alone. `convertToSubgraph` is instance-assignable
// and extensions replace it — cg-use-everywhere sets `app.graph.convertToSubgraph` to a
// wrapper that rewires links, delegates, and calls its restorer OUTSIDE a `finally`, so
// a throw from the delegate leaves injected links behind with every node and definition
// exactly where it was. The old code said nothing; that version said something confidently
// wrong, which is worse. The confident verdict is now gated on the link table too, and on
// nothing having replaced `convertToSubgraph` on the graph object.
//
// ## What is pinned here
//
// 1. The pre-flight names the one condition that provably causes this, on the SELECTION
//    and on its boundary NEIGHBOURS, and refuses before anything is mutated.
// 2. It refuses ONLY on a nullish back-reference — never on graph identity, which on a
//    reactive frontend would read a Vue proxy of the live root as a foreign graph and
//    refuse every conversion (the #558 proxy/raw duality).
// 3. A throw is reported with a measured verdict; "unchanged" requires every surface
//    readable, still, and unwrapped; and the frontend's message survives verbatim in all
//    three verdicts so that existing searches for it still hit.
// 4. Both tool entry points route through it, and the runner makes the selection itself
//    rather than converting whatever happened to be selected. A helper nobody calls fixes
//    nothing, and #1463 reported BOTH paths failing identically.

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

/** A fully readable, unwrapped snapshot — the only shape that may yield "unchanged". */
const snap = (over = {}) => ({
  present: [2, 3],
  readable: true,
  definitions: 0,
  links: 3,
  wrapped: false,
  ...over,
});

test("nodes gone → the report says the graph CHANGED and names them", () => {
  const msg = conversionThrowReport({
    what: "panel_create_subgraph",
    message: RAW,
    before: snap(),
    after: snap({ present: [], definitions: 1 }),
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
    before: snap(),
    after: snap({ definitions: 1 }),
  });
  assert.match(msg, /HAS CHANGED/);
  assert.match(msg, /1 subgraph definition\(s\) were registered/);
  assert.doesNotMatch(msg, /already off the canvas/);
});

test("LINK-level mutation alone counts as CHANGED — the gate P1", () => {
  // cg-use-everywhere's wrapper injects links, delegates, and restores OUTSIDE a
  // `finally`. On a throw the links stay while every node and definition is where it
  // was, and the first version of this reported "UNCHANGED … nothing to undo".
  const msg = conversionThrowReport({
    what: "panel_create_subgraph",
    message: RAW,
    before: snap({ links: 3, wrapped: true }),
    after: snap({ links: 4, wrapped: true }),
  });
  assert.match(msg, /HAS CHANGED/);
  assert.match(msg, /the link table went from 3 to 4 entries/);
  assert.doesNotMatch(msg, /nothing to undo/);
  // Nothing was removed, so it must not invent a half-built wrapper on the canvas.
  assert.doesNotMatch(msg, /wired to nothing/);
});

test("a link table that SHRANK is a change too", () => {
  const msg = conversionThrowReport({
    what: "panel_create_subgraph",
    message: RAW,
    before: snap({ links: 4 }),
    after: snap({ links: 3 }),
  });
  assert.match(msg, /HAS CHANGED/);
});

test("nothing moved → the report says so, and that there is nothing to undo", () => {
  const msg = conversionThrowReport({
    what: "panel_create_subgraph",
    message: RAW,
    before: snap(),
    after: snap(),
  });
  assert.match(msg, /nothing the panel can read moved/);
  assert.match(msg, /nothing to undo/);
  assert.match(msg, /link table is unchanged at 3 entries/);
  assert.doesNotMatch(msg, /HAS CHANGED/);
  assert.ok(msg.includes(RAW));
  // `wrapped` is an own-property test, so it cannot see a patch on LGraph.prototype.
  // The sentence must therefore claim only what was measured — this graph OBJECT.
  assert.match(msg, /nothing on this graph object overrides/);
  assert.doesNotMatch(
    msg,
    /nothing has replaced convertToSubgraph/,
    "a prototype-level patch would make that wider claim false",
  );
});

test("a WRAPPED convertToSubgraph withdraws the confident verdict — the gate P1", () => {
  // Every observed surface is still, but something is in the call path that can move a
  // surface this cannot see. "Nothing to undo" is then a claim, not a measurement.
  const msg = conversionThrowReport({
    what: "panel_create_subgraph",
    message: RAW,
    before: snap({ wrapped: true }),
    after: snap({ wrapped: true }),
  });
  assert.match(msg, /could NOT establish whether the graph changed/);
  assert.match(msg, /replaced convertToSubgraph on this graph/);
  assert.doesNotMatch(msg, /nothing to undo/);
  assert.doesNotMatch(msg, /nothing the panel can read moved/);
  // It still reports what it DID measure.
  assert.match(msg, /All 2 node\(s\) you selected are still on the canvas/);
});

test("an uncountable link table withdraws the confident verdict", () => {
  const msg = conversionThrowReport({
    what: "panel_create_subgraph",
    message: RAW,
    before: snap({ links: null }),
    after: snap({ links: null }),
  });
  assert.match(msg, /could NOT establish/);
  assert.match(msg, /link table could not be counted/);
  assert.doesNotMatch(msg, /nothing to undo/);
});

test("an uncountable definition table withdraws the confident verdict", () => {
  const msg = conversionThrowReport({
    what: "panel_create_subgraph",
    message: RAW,
    before: snap({ definitions: null }),
    after: snap({ definitions: null }),
  });
  assert.match(msg, /could NOT establish/);
  assert.match(msg, /subgraph definitions could not be counted/);
});

test("an unreadable snapshot is reported as UNKNOWN, never as untouched", () => {
  const msg = conversionThrowReport({
    what: "panel_create_subgraph",
    message: RAW,
    before: { present: [], readable: false, definitions: null, links: null, wrapped: false },
    after: { present: [], readable: false, definitions: null, links: null, wrapped: false },
  });
  assert.match(msg, /could NOT establish whether the graph changed/);
  assert.match(msg, /unknown rather than untouched/);
  assert.match(msg, /does not expose the node lookup/);
  assert.doesNotMatch(msg, /nothing the panel can read moved/);
  assert.ok(msg.includes(RAW));
});

test("a definition COUNT that only fell is not reported as a change", () => {
  // Defensive: a shrinking count is not evidence this conversion created anything.
  const msg = conversionThrowReport({
    what: "panel_create_subgraph",
    message: RAW,
    before: snap({ present: [2], definitions: 3 }),
    after: snap({ present: [2], definitions: 2 }),
  });
  assert.match(msg, /nothing the panel can read moved/);
});

test("every verdict names the tool and attributes the throw to the frontend", () => {
  const cases = [
    { before: snap(), after: snap({ present: [], definitions: 1 }) },
    { before: snap(), after: snap() },
    { before: snap({ wrapped: true }), after: snap({ wrapped: true }) },
    {
      before: { present: [], readable: false, definitions: null, links: null, wrapped: false },
      after: { present: [], readable: false, definitions: null, links: null, wrapped: false },
    },
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
  const taken = conversionSnapshot({}, [n2, n3]);
  assert.equal(taken.readable, false);
  assert.deepEqual(taken.present, [2, 3]);
  assert.equal(taken.definitions, null);
  assert.equal(taken.links, null);
});

test("the link table is counted in every shape, and reported null when it is not there", () => {
  for (const [linksAs, expected] of [["map", 3], ["tuples", 3], ["object", 3]]) {
    const { graph, n2, n3 } = chain({ linksAs });
    assert.equal(conversionSnapshot(graph, [n2, n3]).links, expected, `shape: ${linksAs}`);
  }
  assert.equal(conversionSnapshot({ getNodeById: () => null }, []).links, null);
});

test("a wrapper on convertToSubgraph is detected, and the stock prototype method is not", () => {
  // Measured on this install: the method exists on LGraph.prototype AND cg-use-everywhere
  // assigns an own property over it. Only the own property means an extension is in the
  // call path, so only that may withdraw the confident verdict.
  const proto = { convertToSubgraph() {} };
  const stock = Object.create(proto);
  stock.getNodeById = () => null;
  assert.equal(conversionSnapshot(stock, []).wrapped, false, "an inherited method is not a wrapper");

  const wrapped = Object.create(proto);
  wrapped.getNodeById = () => null;
  wrapped.convertToSubgraph = function () {};
  assert.equal(conversionSnapshot(wrapped, []).wrapped, true, "an own property is a wrapper");
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

test("the two conversion tools no longer select for themselves — the runner does", () => {
  // Both had the same hole: with neither selection API present they fell through and
  // converted `canvas.selectedItems` as they found it, which is a set the caller never
  // named. Selection belongs to the runner now, where it can refuse instead.
  const body = code();
  for (const marker of ['what: "panel_create_subgraph"', 'what: "panel_subgraph_group"']) {
    const at = body.indexOf(marker);
    assert.ok(at > 0, `${marker} must be present`);
    const before = body.slice(Math.max(0, at - 700), at);
    assert.doesNotMatch(
      before,
      /canvas\.select(Items|Nodes)\(ns\)/,
      `${marker}: the executor must not make the selection itself`,
    );
  }
  const runner = body.slice(body.indexOf("function convertSelectionToSubgraph("));
  const fn = runner.slice(0, runner.indexOf("\nfunction "));
  assert.ok(fn.includes("canvas?.selectItems"), "the runner must make the selection");
  assert.ok(fn.includes("canvas?.selectNodes"), "including the deprecated fallback");
  // `indexOf` alone has no teeth here: deleting the refusal makes it -1, which is
  // "before" everything. Require it to be PRESENT first.
  const refusalAt = fn.indexOf("selection API");
  assert.ok(refusalAt > -1, "a frontend with neither selection API must be refused, not fallen through");
  assert.ok(
    refusalAt < fn.indexOf("graph.convertToSubgraph"),
    "and refused before the conversion, not after it",
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
