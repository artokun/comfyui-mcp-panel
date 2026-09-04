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
  linkCounterRepairWarning,
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
  const { warning, ...moved } = ensureLinkIdHeadroom(graph);
  assert.deepEqual(moved, { adjusted: true, from: 0, to: 3 });
  // #2196 — the sentence travels ON the result, because graph_connect is rebuilt by
  // `new Function` harnesses where a second module import is not in scope.
  assert.equal(warning, linkCounterRepairWarning(moved));
  assert.ok(warning.length > 0);
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
  const { warning, ...moved } = ensureLinkIdHeadroom(graph);
  assert.deepEqual(moved, { adjusted: true, from: null, to: 6 });
  assert.match(warning, /was not set/);
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

// #2196 — the repair is disclosed rather than silent.
//
// `ensureLinkIdHeadroom` documents that it "returns what happened so a caller can
// disclose it", because raising the counter protects the NEXT connect and can do
// nothing about the ones already made: a graph that needed raising had been
// minting colliding ids all along, each one replacing a bystander in `_links`.
// Every call site discarded that return, so the contract had no implementations
// and the user whose graph was already damaged was told nothing.

test("#2196 no sentence when the counter did not move", () => {
  // The ordinary connect. Emitting anything here would put a warning on every
  // well-formed graph, which is how a disclosure stops being read.
  assert.equal(linkCounterRepairWarning({ adjusted: false }), "");
  assert.equal(linkCounterRepairWarning(undefined), "");
  assert.equal(linkCounterRepairWarning(null), "");
});

test("#2196 the sentence names both counters and does not claim a full repair", () => {
  const w = linkCounterRepairWarning({ adjusted: true, from: 2, to: 9 });
  assert.match(w, /was 2/);
  assert.match(w, /9/);
  // The honesty requirement: it must not read as "your graph is fixed".
  assert.match(w, /cannot undo an earlier one/);
  assert.match(w, /#2108/);
});

test("#2196 an absent counter is described, not printed as NaN", () => {
  // `from` is null when last_link_id was missing or non-numeric — the API-workflow
  // case that panel#2011 made loadable, which is how #2108's reporter got here.
  const w = linkCounterRepairWarning({ adjusted: true, from: null, to: 4 });
  assert.match(w, /was not set/);
  assert.ok(!w.includes("NaN"), w);
  assert.ok(!w.includes("null"), w);
});

test("#2196 EVERY graph_connect success exit carries the disclosure", () => {
  // The wiring, not the helper. graph_connect has four success exits (two rail
  // branches, the landed-after-throw path, and the clean path) and each builds its
  // own `warning`. A disclosure added to one of them is a disclosure the other
  // three drop, so this pins the count inside graph_connect's own region.
  const bundle = readFileSync(PANEL_JS, "utf8");
  const at = bundle.indexOf("graph_connect({ from_node_id");
  const end = bundle.indexOf("graph_disconnect({", at);
  assert.ok(at > -1 && end > at);
  const region = bundle.slice(at, end);

  assert.equal((region.match(/\.\.\.headroomRider,/g) ?? []).length, 4);
  // No exit may still hand-roll the join: that is the shape that silently omits
  // the new sentence.
  assert.equal((region.match(/warning: \[/g) ?? []).length, 0);
  assert.ok(region.includes('const headroomWarning = headroom.warning ?? "";'));

  // The composition itself. All four exits route through `withHeadroom`, so if it
  // stops appending the sentence they go quiet TOGETHER and every other assertion
  // in this file still passes -- the riders are all still there, the helper still
  // returns the right string, and nothing reaches the user. Pinned as source
  // because the bundle is a browser module this suite cannot import, the same
  // reason the #2108 call-site checks above are source-shape assertions.
  assert.ok(
    region.includes(
      'const withHeadroom = (...sentences) => [...sentences, headroomWarning].filter(Boolean).join(" ");',
    ),
    "graph_connect no longer folds headroomWarning into its warning composition",
  );
});

test("#2196 both subgraph expose twins put the repair on their reply", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  // INLINED on purpose: these handlers are rebuilt by `new Function` harnesses that
  // inject dependencies BY NAME, so a shared module-scope helper is not in scope and
  // throws ReferenceError the moment the line runs. A first attempt did exactly that
  // and connect-throw-verdict caught it, which is why this pins the inline shape.
  const spreads = src.split("...(headroom?.warning || exposeConnectErr").length - 1;
  assert.equal(spreads, 2, "expected both expose twins to surface the repair");
  assert.equal(
    src.includes("warningField("),
    false,
    "a shared helper is not reachable inside the new Function harnesses",
  );
  // The join must keep BOTH warnings, never replace one with the other.
  // COUNTED, not merely present: landedAfterThrowWarning(exposeConnectErr) also
  // appears in the graph_connect region, so an includes() check survives the twins
  // dropping it entirely. A mutation proved that — it passed until this counted.
  const joined = src.split(
    'exposeConnectErr ? landedAfterThrowWarning(exposeConnectErr) : ""'
  ).length - 1;
  assert.equal(joined, 2, "an expose twin stopped joining the landed-after-throw warning");
});

// #2196 — the DISCLOSURE must survive at EVERY call site, not just graph_connect.
//
// This is the exact defect these pin: three of the four sites captured nothing.
// The two expose twins take the SAME graph graph_connect does, and the counter only
// ever moves UP, so whichever runs first CONSUMES the condition — repair silently in
// panel_expose_subgraph_input and the next panel_connect gets `adjusted: false` and
// says nothing, on a graph whose earlier connects may already have overwritten a
// bystander. The disclosure was not merely missing there; it was lost for good.
//
// Structural, because the failure is "a caller dropped the return value" — no amount
// of exercising ensureLinkIdHeadroom itself can surface that.
test("#2196 no ensureLinkIdHeadroom call site DISCARDS the repair", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const calls = src
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.includes("ensureLinkIdHeadroom(") && !l.startsWith("//") && !l.startsWith("*"))
    .filter((l) => !l.startsWith("import") && !l.includes("} from"));
  assert.ok(calls.length >= 4, `expected the known call sites, found ${calls.length}`);
  const discarded = calls.filter((l) => !l.includes("= ensureLinkIdHeadroom("));
  assert.deepEqual(discarded, [], "a call site dropped the return value, so it cannot disclose");
});

test("#2196 the promotion loop accumulates repairs and surfaces them once", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  assert.ok(src.includes("const headroomWarnings = [];"), "no accumulator");
  assert.ok(
    src.includes("if (h?.warning) headroomWarnings.push(h.warning);"),
    "the promotion loop stopped collecting repairs",
  );
  assert.ok(
    src.includes('headroomWarnings.length ? { warning: headroomWarnings.join(" ") }'),
    "the promotion reply stopped surfacing collected repairs",
  );
});

// #2108 — EXECUTION, not source text. The wiring tests above read the bundle; they
// prove the call exists, not that a stale counter stops overwriting a live link.
// These drive the real helper against both store shapes and assert the outcome.
describe_legacy();
function describe_legacy() {
  /** A graph on an OLDER LiteGraph: the plain record lives on `links`, not `_links`. */
  function makeLegacyGraph(lastLinkId, links) {
    return {
      state: { lastLinkId },
      links,
      get last_link_id() {
        return this.state.lastLinkId;
      },
      set last_link_id(v) {
        this.state.lastLinkId = v;
      },
    };
  }

  test("#2108 a LEGACY `links` store is read, so the counter is still repaired", () => {
    // Reading only `_links` returned null here, so `adjusted` was false and the very
    // next allocation re-used id 4 and overwrote the existing link.
    const graph = makeLegacyGraph(1, { 4: { id: 4 } });
    const res = ensureLinkIdHeadroom(graph);
    assert.equal(res.adjusted, true, "the legacy store must be read");
    assert.equal(res.to, 4);
    assert.equal(graph.last_link_id, 4);
  });

  test("#2108 the repair actually prevents the collision it exists for", () => {
    // Allocate the way the frontend does — ++counter — and prove the id it yields is
    // free. Without the repair this returns 2, which already exists.
    const links = { 4: { id: 4 } };
    const graph = makeLegacyGraph(1, links);
    ensureLinkIdHeadroom(graph);
    const minted = ++graph.state.lastLinkId;
    assert.equal(minted, 5);
    assert.ok(!(minted in links), "the minted id must not already be in the store");
  });

  test("#2108 the modern `_links` Map still wins when both are present", () => {
    const graph = makeGraph(1, asMap([7]));
    graph.links = { 99: { id: 99 } };
    assert.equal(ensureLinkIdHeadroom(graph).to, 7, "the modern store is authoritative");
  });
}
