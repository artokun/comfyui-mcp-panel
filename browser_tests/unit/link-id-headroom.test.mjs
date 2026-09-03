// #2108 — panel_connect reported success and moved wires it never named.
//
// Repairing two invalid links on a live canvas, each connect displaced a
// different bystander ("node 20 output 0 -> node 23 input 5 moved to the new
// link", then "node 21 output 0 -> node 23 input 3"), until SamplerCustom was
// receiving MASK/VAE/SAMPLER in the wrong inputs and the graph would not render.
//
// The mechanism is in the shipped frontend, not in our code. Every mint is:
//
//     let o = toLinkId(Number(graph.state.lastLinkId) + 1);
//     graph.state.lastLinkId = o;
//     graph._links.set(new LLink(o, ...).id, link);
//
// `_links` is a Map and `set` REPLACES, so a counter sitting below an id the
// graph already holds overwrites a bystander's record. That also explains the
// walk: each repair collides with the next already-taken id.
//
// These pin the counter repair. Whether it is CALLED is pinned separately, by
// the source-shape assertions at the bottom.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  collectLinkIds,
  highestLinkId,
  ensureLinkIdHeadroom,
} from "../../web/js/lib/link-id-headroom.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

/** A graph whose `last_link_id` forwards to nested state, as the frontend's does. */
function makeGraph(lastLinkId, links) {
  return {
    state: { lastLinkId },
    _links: links,
    get last_link_id() {
      return this.state.lastLinkId;
    },
    set last_link_id(v) {
      this.state.lastLinkId = v;
    },
  };
}

const asMap = (ids) => new Map(ids.map((id) => [id, { id }]));
const asObject = (ids) => Object.fromEntries(ids.map((id) => [String(id), { id }]));

test("collectLinkIds reads a Map store", () => {
  assert.deepEqual(collectLinkIds(asMap([3, 7])).sort((a, b) => a - b), [3, 7]);
});

test("collectLinkIds reads a plain-object store, whose keys are strings", () => {
  // The older shape still ships. String keys must come back as numbers, or the
  // comparison below silently becomes lexicographic and "9" > "10".
  assert.deepEqual(collectLinkIds(asObject([9, 10])).sort((a, b) => a - b), [9, 10]);
});

test("collectLinkIds is empty, not thrown, for a missing store", () => {
  assert.deepEqual(collectLinkIds(null), []);
  assert.deepEqual(collectLinkIds(undefined), []);
});

test("highestLinkId is null when the graph holds no links", () => {
  assert.equal(highestLinkId(makeGraph(0, new Map())), null);
  assert.equal(highestLinkId({}), null);
});

test("highestLinkId reads the record's own id, not only the store key", () => {
  // A record re-keyed without its `id` following leaves the higher number
  // reachable only through the record; allocating past the key alone still
  // collides with it.
  assert.equal(highestLinkId(makeGraph(0, new Map([[2, { id: 41 }]]))), 41);
});

test("a stale counter is raised above every id the graph holds", () => {
  // The reported state: an id exists that the counter has not reached.
  const graph = makeGraph(0, asMap([1, 2, 3]));
  assert.deepEqual(ensureLinkIdHeadroom(graph), { adjusted: true, from: 0, to: 3 });
  assert.equal(graph.last_link_id, 3);
});

test("a healthy graph is left alone", () => {
  const graph = makeGraph(9, asMap([1, 2, 3]));
  assert.deepEqual(ensureLinkIdHeadroom(graph), { adjusted: false });
  assert.equal(graph.last_link_id, 9);
});

test("the counter NEVER moves down", () => {
  // The direction that would CAUSE the bug rather than fix it: freeing an id for
  // reuse is exactly the overwrite this exists to prevent.
  const graph = makeGraph(100, asMap([1, 2]));
  ensureLinkIdHeadroom(graph);
  assert.equal(graph.last_link_id, 100);
});

test("a counter that is absent entirely is repaired", () => {
  // An API/prompt graph carries no last_link_id at all, and panel#2011 made that
  // shape loadable — so this is a reachable state, not a hypothetical.
  const graph = { _links: asMap([5, 6]) };
  assert.deepEqual(ensureLinkIdHeadroom(graph), { adjusted: true, from: null, to: 6 });
  assert.equal(graph.last_link_id, 6);
});

test("a graph with no links is untouched", () => {
  assert.deepEqual(ensureLinkIdHeadroom(makeGraph(0, new Map())), { adjusted: false });
});

test("null does not throw", () => {
  assert.deepEqual(ensureLinkIdHeadroom(null), { adjusted: false });
});

test("a swallowed write is reported as NOT adjusted", () => {
  // A getter-only graph cannot be repaired, and claiming it was would let the
  // caller believe a collision is no longer possible.
  const graph = {
    _links: asMap([7]),
    get last_link_id() {
      return 0;
    },
    set last_link_id(_v) {
      /* swallowed */
    },
  };
  assert.deepEqual(ensureLinkIdHeadroom(graph), { adjusted: false });
});

test("it is idempotent — a second call changes nothing", () => {
  const graph = makeGraph(0, asMap([4]));
  assert.equal(ensureLinkIdHeadroom(graph).adjusted, true);
  assert.equal(ensureLinkIdHeadroom(graph).adjusted, false);
});

// The helper being correct is worth nothing if nothing calls it. These read the
// shipped bundle, because that is the artefact the registry ships and the browser
// loads.
test("#2108 the bundle imports the helper", () => {
  const bundle = readFileSync(PANEL_JS, "utf8");
  assert.ok(bundle.includes('import { ensureLinkIdHeadroom } from "./lib/link-id-headroom.js";'));
});

test("#2108 all four minting paths raise the counter", () => {
  // graph_connect (its node-to-node and both rail branches), the two
  // expose_subgraph_* methods, and the widget-promotion loop — which allocates in
  // the SUBGRAPH's own store, so it passes a different graph. That one is guarded
  // at the CALL SITE because promote-widget-preview-store.test.mjs rebuilds
  // promoteWidgetByLink with `new Function`, where a module import is not in
  // scope. The import carries no paren, so this counts CALL sites only.
  const bundle = readFileSync(PANEL_JS, "utf8");
  // AT LEAST four, not exactly four. An equality here fails the moment someone
  // adds a FIFTH minting path and correctly guards it -- punishing the right
  // behaviour -- while still passing if a guard moves off a real path onto an
  // unrelated one, because the total is unchanged. A count is not an identity
  // check, so each path is asserted in its OWN region below.
  assert.ok((bundle.match(/ensureLinkIdHeadroom\(/g) ?? []).length >= 4);
  assert.ok(bundle.includes("ensureLinkIdHeadroom(p?.subgraph);"));

  // The two expose paths allocate in the parent graph and are textually identical
  // (`ensureLinkIdHeadroom(graph);`), so they can only be told apart by WHERE they
  // sit. Each must carry a guard inside its own method body.
  for (const method of ["graph_expose_subgraph_output({", "graph_expose_subgraph_input({"]) {
    const at = bundle.indexOf(method);
    assert.ok(at > -1, `${method} not found`);
    const guard = bundle.indexOf("ensureLinkIdHeadroom(graph);", at);
    assert.ok(guard > -1, `${method} has no headroom guard after it`);
    // Inside THIS method, not merely somewhere later in the file.
    assert.ok(guard - at < 2000, `${method}'s nearest guard is too far to be its own`);
  }
});

test("#2108 the counter is raised BEFORE graph_connect touches the graph", () => {
  // Ordering is the whole point: after the mutation is too late.
  const bundle = readFileSync(PANEL_JS, "utf8");
  const at = bundle.indexOf("graph_connect({ from_node_id");
  assert.ok(at > -1);
  const guard = bundle.indexOf("ensureLinkIdHeadroom(graph);", at);
  const mutate = bundle.indexOf('["connect"](', at);
  assert.ok(guard > -1);
  assert.ok(guard < mutate, "the headroom guard must precede the first connect mutation");
});
