// comfyui-mcp#1571 — `panel_subgraph_group` reported a clean conversion and the workflow
// could not be run afterwards.
//
//   panel_subgraph_group { group: "…T2I…" }  → { subgraph: { node_id: 302, … } }   ← "success"
//   panel_run {}                             → "No link found in parent graph for id
//                                               [302:192] slot [0] conditioning"
//   panel_run { to_node_id: 183 }            → "the prompt could not be fingerprinted
//                                               (graphToPrompt failed)"
//
// Three answers to one broken graph, and the only one that named anything named a
// flattened id the caller had never seen. The reporter concluded that run-to-node "cannot
// fingerprint nested output targets" — a theory about NESTING, which had nothing to do
// with it — repaired the graph by hand, and filed both halves as one issue.
//
// ## The fixture is not invented
//
// Node 192 / `RBG_Smart_Seed_Variance` / `mode: 4` / input `conditioning` / `link: 505`,
// feeding KSamplers 265 and 273, with SaveImage 183 downstream, are read verbatim out of
// `packs/krea2-combo/workflow.json` in the mcp repo — the workflow the report names. The
// corruption shape (an input whose link id is absent from its own graph's link table) is
// read out of ComfyUI_frontend 1.48.7's `ExecutableNodeDTO.resolveInput`, which throws
// `InvalidLinkError` on precisely that and nothing else.
//
// ## Two claims, deliberately different in strength
//
// "These links are gone" is measured. "Therefore the workflow cannot run" is NOT, unless
// the node is one `graphToPrompt` resolves unconditionally — muted, bypassed and virtual
// nodes are skipped and reached only through a consumer chain that only ComfyUI's own
// resolver can walk. Three review rounds killed three attempts to walk it from here, so
// the module stopped claiming it. Both tiers are pinned below, including the direction
// that matters most: an unproven finding must never refuse.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  readLinkIds,
  danglingInputLinks,
  fatalDanglingInputLinks,
  disconnectedBoundaryInputs,
  brokenConversionRefusal,
  brokenConversionWarning,
  detachedConversionNodes,
  detachedConversionRefusal,
  conversionSnapshot,
  conversionThrowReport,
} from "../../web/js/lib/subgraph-conversion-integrity.js";

const src = () =>
  readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");

/** The reported node, as it appears in packs/krea2-combo/workflow.json. */
const rbg = (link, mode = 4) => ({
  id: 192,
  type: "RBG_Smart_Seed_Variance",
  mode,
  inputs: [{ name: "conditioning", type: "CONDITIONING", link }],
  outputs: [{ name: "conditioning", type: "CONDITIONING", links: [473, 474] }],
});

const ksampler = (id, condLink) => ({
  id,
  type: "KSampler",
  mode: 0,
  inputs: [
    { name: "model", type: "MODEL", link: 491 },
    { name: "positive", type: "CONDITIONING", link: condLink },
  ],
});

/** The subgraph as convertToSubgraph left it: link 505 was never written into it. */
const brokenSubgraph = () => ({
  name: "New Subgraph",
  _nodes: [rbg(505), ksampler(265, 473), ksampler(273, 474)],
  links: new Map([
    // The MODEL rail crossed the same boundary and survived — which is why the conversion
    // looked fine. Only the bypassed node's CONDITIONING link (505) went missing.
    [491, { id: 491, origin_id: -10, origin_slot: 0, target_id: 265, target_slot: 0 }],
    [473, { id: 473, origin_id: 192, origin_slot: 0, target_id: 265, target_slot: 1 }],
    [474, { id: 474, origin_id: 192, origin_slot: 0, target_id: 273, target_slot: 1 }],
  ]),
});

/** The same conversion, done right: 505 exists, re-origined onto the input rail. */
const healthySubgraph = () => {
  const g = brokenSubgraph();
  g.links.set(505, { id: 505, origin_id: -10, origin_slot: 0, target_id: 192, target_slot: 0 });
  return g;
};

/** A dangling input on an ORDINARY node — the provable tier. */
const certainlyBrokenSubgraph = () => {
  const g = healthySubgraph();
  g._nodes = [ksampler(265, 997)]; // 997 is in no link table
  return g;
};

// ── Detection ───────────────────────────────────────────────────────────────────────

test("#1571 the reported corruption is detected, and names the node the run error hid", () => {
  const found = danglingInputLinks(brokenSubgraph());
  assert.equal(found.length, 1, "exactly the one broken input");
  assert.deepEqual(found[0], {
    node_id: 192,
    node_type: "RBG_Smart_Seed_Variance",
    slot: 0,
    name: "conditioning",
    link_id: 505,
    bypassed: true,
    muted: false,
    virtual: false,
    // Bypassed ⇒ reached only through a consumer chain ⇒ not ours to call fatal.
    certainly_reached: false,
  });
});

test("#1571 a correctly converted subgraph yields nothing", () => {
  // The direction that would break every conversion. Same nodes, same link ids — the only
  // difference is that 505 is present, which is what a healthy conversion produces.
  assert.deepEqual(danglingInputLinks(healthySubgraph()), []);
});

test("#1571 an unconnected input is not a dangling one", () => {
  // `resolveInput` returns early on `linkId == null`. A node with nothing plugged in is
  // ordinary, and flagging it would refuse conversions of any graph with a spare socket.
  const g = brokenSubgraph();
  g._nodes = [rbg(null), { id: 7, type: "Note", inputs: [{ name: "x", link: undefined }] }];
  assert.deepEqual(danglingInputLinks(g), []);
});

test("#1571 link ids are compared by VALUE, not by type", () => {
  // Serialized graphs carry numeric ids; some frontend paths stringify them. A `1 !== "1"`
  // mismatch here would report every input in the graph as dangling and refuse every
  // conversion — the worst possible failure direction for this guard.
  const g = brokenSubgraph();
  g.links = new Map([["505", {}], ["491", {}], ["473", {}], ["474", {}]]);
  assert.deepEqual(danglingInputLinks(g), []);
});

test("#1571 an unreadable link table produces NO findings", () => {
  // The safety property. This gates the report of a mutation that already happened, so a
  // graph shape we do not recognise must be silent, never a graph-wide accusation.
  for (const links of [undefined, null, 42, "links", () => {}]) {
    const g = brokenSubgraph();
    g.links = links;
    assert.deepEqual(danglingInputLinks(g), [], String(links));
  }
  assert.equal(readLinkIds({ links: null }), null);
  assert.equal(readLinkIds(undefined), null);
});

test("#1571 every link-table shape a frontend ships is read", () => {
  // Live litegraph uses a Map; the serialized form is tuples or objects; some builds hand
  // back a plain id-keyed object. Reading only one of them turns the others into a
  // false accusation.
  assert.deepEqual([...readLinkIds({ links: new Map([[505, {}]]) })], ["505"]);
  assert.deepEqual([...readLinkIds({ links: [[505, 274, 2, 192, 0, "CONDITIONING"]] })], ["505"]);
  assert.deepEqual([...readLinkIds({ links: [{ id: 505 }] })], ["505"]);
  assert.deepEqual([...readLinkIds({ links: { 505: {} } })], ["505"]);
  // An EMPTY table is readable and means what it says — a conversion with no links at all.
  assert.deepEqual([...readLinkIds({ links: new Map() })], []);
});

test("#1571 an unreadable node list produces no findings", () => {
  for (const nodes of [undefined, null, 5, "nodes"]) {
    assert.deepEqual(danglingInputLinks({ links: new Map(), _nodes: nodes }), [], String(nodes));
  }
  // …and a serialized graph exposing `nodes` instead of `_nodes` is still read.
  assert.equal(
    danglingInputLinks({ links: [], nodes: [rbg(505)] }).length,
    1,
    "the serialized shape must be read too",
  );
});

test("#1571 junk nodes cannot throw while a failure is being explained", () => {
  const g = { links: new Map(), _nodes: [null, 7, {}, { inputs: null }, { inputs: [null, 3] }] };
  assert.deepEqual(danglingInputLinks(g), []);
});

test("#1571 the walk stays at ONE level", () => {
  // A nested subgraph NODE that moved inside brings a definition shared with every other
  // instance of it. Descending would blame this conversion for something it never touched.
  const inner = { _nodes: [rbg(505)], links: new Map() };
  const g = { _nodes: [{ id: 300, type: "SubgraphNode", inputs: [], subgraph: inner }], links: new Map() };
  assert.deepEqual(danglingInputLinks(g), []);
});

// ── WHICH findings may refuse (codex gate rounds 1–3) ───────────────────────────────
//
// `graphToPrompt` skips whole nodes before touching their inputs:
//   if (node.isVirtualNode || node.mode === NEVER || node.mode === BYPASS) continue
//   for (const [i, input] of node.inputs.entries()) node.resolveInput(i)   // ALL of them
//
// So a node it does NOT skip has every input resolved unconditionally — no type matching,
// no consumer analysis, nothing to model. That, and only that, may refuse.

test("#1571 an ORDINARY node's dangling input is provably reached", () => {
  const g = certainlyBrokenSubgraph();
  const [entry] = danglingInputLinks(g);
  assert.equal(entry.certainly_reached, true);
  assert.equal(fatalDanglingInputLinks(g).length, 1, "and it is what the refusal acts on");
  // …and a node with no `mode` at all is an ordinary node: an unrecognised shape must err
  // toward reporting a real break, not toward hiding one.
  g._nodes = [{ id: 9, type: "KSampler", inputs: [{ name: "positive", link: 997 }] }];
  assert.equal(danglingInputLinks(g)[0].certainly_reached, true);
});

test("#1571 a MUTED node's dangling input is reported but never refuses", () => {
  // `resolveOutput` returns immediately for NEVER ("Muted nodes produce no output"), so
  // neither the node nor its consumers reach the input. Refusing would un-ship the tool
  // for a graph that queues perfectly well.
  const g = brokenSubgraph();
  g._nodes = [rbg(505, 2)];
  const [entry] = danglingInputLinks(g);
  assert.equal(entry.muted, true);
  assert.equal(entry.certainly_reached, false);
  assert.deepEqual(fatalDanglingInputLinks(g), [], "it must not reach the refusal");
});

test("#1571 a VIRTUAL node's dangling input is reported but never refuses", () => {
  const g = brokenSubgraph();
  g._nodes = [{ id: 5, type: "Reroute", mode: 0, isVirtualNode: true, inputs: [{ name: "", link: 505 }] }];
  const [entry] = danglingInputLinks(g);
  assert.equal(entry.virtual, true);
  assert.equal(entry.certainly_reached, false);
});

test("#1571 a BYPASSED node's dangling input is reported but never refuses", () => {
  // The reported case, and the whole point of round 3. Bypass reachability depends on the
  // CONSUMER's type (`resolveOutput(link.origin_slot, type ?? input.type)`), on whether
  // that consumer is itself skipped, and on LiteGraph's union-type matching. This module
  // does not attempt to decide it, so it reports and does not refuse.
  const g = brokenSubgraph();
  assert.equal(danglingInputLinks(g)[0].bypassed, true);
  assert.deepEqual(fatalDanglingInputLinks(g), []);
});

test("#1571 the refusal tier is decided by the SKIP LIST alone", () => {
  // Pinned as a table so a future 'improvement' that reintroduces type or consumer
  // reasoning has to change this test and explain itself.
  const probe = (node) => {
    const g = { links: new Map(), _nodes: [{ id: 1, inputs: [{ name: "in", link: 9 }], ...node }] };
    return danglingInputLinks(g)[0].certainly_reached;
  };
  assert.equal(probe({ mode: 0 }), true, "ALWAYS");
  assert.equal(probe({ mode: 1 }), true, "ON_EVENT");
  assert.equal(probe({ mode: 3 }), true, "ON_TRIGGER");
  assert.equal(probe({}), true, "no mode at all");
  assert.equal(probe({ mode: 2 }), false, "NEVER");
  assert.equal(probe({ mode: 4 }), false, "BYPASS");
  assert.equal(probe({ mode: 0, isVirtualNode: true }), false, "virtual");
  // Type and connectivity must make NO difference — the moment they do, the module is
  // modelling the resolver again.
  assert.equal(probe({ mode: 4, outputs: [{ type: "IMAGE", links: [1] }] }), false);
  assert.equal(probe({ mode: 4, outputs: [] }), false);
  assert.equal(probe({ mode: 0, outputs: [] }), true);
});

// ── The boundary signal ─────────────────────────────────────────────────────────────

test("#1571 an unfed boundary input on the new node is reported", () => {
  // The reporter's own words: "avoid exposing a disconnected boundary input". Every slot
  // on a fresh subgraph node exists because an external link fed it.
  const node = {
    id: 302,
    inputs: [
      { name: "conditioning", type: "CONDITIONING", link: null },
      { name: "model", type: "MODEL", link: 491 },
    ],
  };
  assert.deepEqual(disconnectedBoundaryInputs(node), [
    { slot: 0, name: "conditioning", type: "CONDITIONING" },
  ]);
});

test("#1571 a fully fed subgraph node reports nothing, and junk is silent", () => {
  assert.deepEqual(disconnectedBoundaryInputs({ inputs: [{ name: "a", link: 1 }] }), []);
  for (const junk of [undefined, null, {}, { inputs: null }, { inputs: 3 }]) {
    assert.deepEqual(disconnectedBoundaryInputs(junk), [], String(junk));
  }
});

// ── The two messages ────────────────────────────────────────────────────────────────

const refusal = () =>
  brokenConversionRefusal({
    what: "panel_subgraph_group",
    subgraphNodeId: 302,
    dangling: danglingInputLinks(certainlyBrokenSubgraph()),
    disconnected: [{ slot: 0, name: "conditioning", type: "CONDITIONING" }],
  });

const warning = () =>
  brokenConversionWarning({
    what: "panel_subgraph_group",
    subgraphNodeId: 302,
    dangling: danglingInputLinks(brokenSubgraph()),
    disconnected: [{ slot: 0, name: "conditioning", type: "CONDITIONING" }],
  });

test("#1571 both messages say the subgraph EXISTS — the opposite of their sibling", () => {
  // assertSubgraphNodeLanded's message says "nothing is being reported as created". Reusing
  // that wording here would send the caller to retry and wrap the same nodes a second time,
  // leaving two subgraph nodes on the canvas.
  for (const msg of [refusal(), warning()]) {
    assert.match(msg, /subgraph node 302/);
    assert.match(msg, /Nothing has been undone/);
    assert.doesNotMatch(msg, /Nothing is being reported as created/);
  }
});

test("#1571 both messages name the node, the slot and the link", () => {
  assert.match(refusal(), /KSampler node 265 input 1 "positive" → link 997/);
  const w = warning();
  assert.match(w, /RBG_Smart_Seed_Variance node 192 \(bypassed\) input 0 "conditioning" → link 505/);
  assert.match(w, /bypassed/, "the mode matters — it is why the verdict is withheld");
});

test("#1571 both messages connect themselves to the error the run would show", () => {
  // The whole cost of the bug: `[302:192]` appeared for the first time at run time, with
  // nothing tying it to the conversion. Printing it here is what closes that gap.
  assert.match(refusal(), /No link found in parent graph for id \[302:265\] slot \[1\]/);
  assert.match(warning(), /No link found in parent graph for id \[302:192\] slot \[0\]/);
});

test("#1571 the REFUSAL asserts the workflow cannot run; the WARNING does not", () => {
  // The distinction the third gate round was about. Overstating the warning is exactly the
  // failure the refusal tier was narrowed to avoid.
  assert.match(refusal(), /UNSERIALIZABLE/);
  assert.match(refusal(), /cannot be run or queued/);
  assert.match(refusal(), /resolves unconditionally/);

  const w = warning();
  assert.doesNotMatch(w, /cannot be run or queued/);
  assert.doesNotMatch(w, /UNSERIALIZABLE/);
  assert.match(w, /not something the panel can decide/);
  assert.match(w, /a warning, not a refusal/);
  assert.match(w, /reported as created/);
  // And it names who CAN decide, plus the fact that answer is now visible (#1571's other
  // half) rather than being swallowed.
  assert.match(w, /Run the workflow to get the authoritative answer/);
  assert.match(w, /passes that through verbatim/);
});

test("#1571 both messages offer the recoveries and claim no repair", () => {
  for (const msg of [refusal(), warning()]) {
    assert.match(msg, /Ctrl\+Z|undo/i);
    assert.match(msg, /panel_enter_subgraph/);
    assert.match(msg, /panel_expose_subgraph_input/);
    assert.doesNotMatch(msg, /has been (repaired|fixed|reconnected)/i);
    assert.match(msg, /convertToSubgraph produced this/);
    assert.match(msg, /comfyui-mcp#1571/);
  }
});

test("#1571 the unfed boundary slots ride along in both messages", () => {
  for (const msg of [refusal(), warning()]) {
    assert.match(msg, /input slot\(s\) that nothing in the parent graph feeds/);
  }
  // …and are omitted entirely when there are none, rather than printed as "0".
  const none = brokenConversionRefusal({
    what: "panel_create_subgraph",
    subgraphNodeId: 9,
    dangling: danglingInputLinks(certainlyBrokenSubgraph()),
    disconnected: [],
  });
  assert.doesNotMatch(none, /input slot\(s\) that nothing/);
});

test("#1571 a long list of broken inputs stays readable", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    node_id: i,
    node_type: `Node${i}`,
    slot: 0,
    name: "in",
    link_id: 1000 + i,
    certainly_reached: true,
  }));
  for (const compose of [brokenConversionRefusal, brokenConversionWarning]) {
    const msg = compose({
      what: "panel_subgraph_group",
      subgraphNodeId: 302,
      dangling: many,
      disconnected: [],
    });
    assert.ok(msg.length < 2200, `message must stay readable, was ${msg.length} chars`);
    assert.match(msg, /and 32 more/);
  }
});

test("#1571 the messages survive entries they cannot fully describe", () => {
  // They are composed while explaining a failure; throwing here would replace a useful
  // report with a second, unrelated error.
  for (const compose of [brokenConversionRefusal, brokenConversionWarning]) {
    const msg = compose({
      what: "panel_subgraph_group",
      subgraphNodeId: undefined,
      dangling: [{ node_id: null, node_type: null, slot: 2, name: null, link_id: 9 }],
      disconnected: null,
    });
    assert.match(msg, /link 9/);
    assert.match(msg, /input 2/);
  }
});

// ── WIRING. The helpers above are inert unless both conversion tools consult them, and
//    that is a few lines inside a 30k-line file. Deleting any of them leaves every test
//    above green — which is exactly how #1571 shipped in the first place.

test("#1571 BOTH conversion paths assert serializability, AFTER the node landed", () => {
  const s = src();
  for (const tool of ["panel_create_subgraph", "panel_subgraph_group"]) {
    const landed = s.indexOf(`assertSubgraphNodeLanded(res, graph, "${tool}")`);
    assert.ok(landed > 0, `${tool} must still assert the node landed`);
    const call = new RegExp(`assertSubgraphConversionSerializable\\(res, \\w+, "${tool}"\\)`);
    assert.match(s, call, `${tool} must assert the conversion is serializable`);
    // ORDER: the serializability check reads the node the landing check returned, so a
    // conversion that produced nothing must fail with the sibling's clearer message.
    assert.ok(s.search(call) > landed, `${tool} must check it landed BEFORE checking it serializes`);
  }
});

test("#1571 only the PROVABLE tier refuses, and the rest becomes a warning", () => {
  const s = src();
  assert.match(s, /const certain = dangling\.filter\(\(entry\) => entry\.certainly_reached\);/);
  assert.match(s, /const unproven = dangling\.filter\(\(entry\) => !entry\.certainly_reached\);/);
  assert.match(s, /if \(certain\.length\) \{/);
  assert.match(s, /brokenConversionWarning\(\{ what, subgraphNodeId: node\?\.id, dangling: unproven/);
});

test("#1571 the advisory findings reach the reported payload on both paths", () => {
  // A finding computed and then dropped on the floor is the same as no finding. This is a
  // one-line spread that no helper test can see.
  const occurrences = src().match(/\.\.\.subgraphConversionAdvisories\(advisories\)/g) ?? [];
  assert.equal(occurrences.length, 2, "both conversion tools must report the advisories");
});

test("#1571 the guard is imported, not shadowed by a local stub", () => {
  // Name-by-name rather than as one frozen block: #1463 added four more exports to the
  // same import, and an exact-block match would have failed on that without any of these
  // four guards having changed. What must not drift is that each one comes from the lib
  // and is not re-declared in the monolith.
  const s = src();
  const imported = s.match(
    /import \{([\s\S]*?)\} from "\.\/lib\/subgraph-conversion-integrity\.js";/,
  );
  assert.ok(imported, "the integrity guards must be imported from the lib");
  for (const name of [
    "danglingInputLinks",
    "disconnectedBoundaryInputs",
    "brokenConversionRefusal",
    "brokenConversionWarning",
  ]) {
    assert.ok(imported[1].includes(name), `${name} must be imported from the lib`);
    assert.doesNotMatch(
      s,
      new RegExp(`\\r?\\nfunction ${name}\\(`),
      `${name} must not be shadowed by a local stub`,
    );
  }
});

// ── BEHAVIOUR, through the REAL shipped executor. The wiring tests above prove the calls
//    are written down; they cannot prove the tool actually refuses. This extracts
//    `graph_subgraph_group` from the monolith and drives it with a convertToSubgraph that
//    returns exactly what the reporter's did — the same real-source extraction pattern
//    subgraph-stale-outline.test.mjs uses on these two executors.

/** Build the shipped executor with injected deps, exactly as the panel wires them. */
function realExecutor(name, args, convertToSubgraph, wrapper) {
  const s = src();
  const body = s.match(new RegExp(`${name}\\(${args}\\) \\{[\\s\\S]*?\\n  \\},`));
  assert.ok(body, `could not locate ${name} in panel source`);
  const landed = s.match(/function assertSubgraphNodeLanded\(res, graph, what\) \{[\s\S]*?\r?\n\}/);
  const serializable = s.match(
    /function assertSubgraphConversionSerializable\(res, node, what\) \{[\s\S]*?\r?\n\}/,
  );
  const advisories = s.match(
    /function subgraphConversionAdvisories\(\{ disconnected, dangling, warning \}\) \{[\s\S]*?\r?\n\}/,
  );
  assert.ok(landed && serializable && advisories, "the conversion guards must be locatable");
  // #1463 — the executors reach convertToSubgraph through this runner now. Injected from
  // the REAL source for the same reason as the guards above: a stub would let a
  // regression in it pass every test in this file.
  const runner = s.match(
    /function convertSelectionToSubgraph\(\{ graph, canvas, nodes, what \}\) \{[\s\S]*?\r?\n\}/,
  );
  assert.ok(runner, "could not locate convertSelectionToSubgraph in panel source");
  const graph = {
    _nodes: [wrapper],
    getNodeById: (id) => ({ id: Number(id) }),
    beforeChange() {},
    afterChange() {},
    convertToSubgraph,
    setDirtyCanvas() {},
  };
  const canvas = { selectedItems: [], selectItems(items) { canvas.selectedItems = items; } };
  return new Function(
    "getGraphCtx",
    "resolveGroupRef",
    "syncGraphNodeAreas",
    "groupMemberNodes",
    "clearStaleRedFlagsAfterSubgraphConversion",
    "convertSelectionToSubgraph",
    "assertSubgraphNodeLanded",
    "assertSubgraphConversionSerializable",
    "subgraphConversionAdvisories",
    `const executors = { ${body[0]} }; return executors.${name.replace(/^async /, "")};`,
  )(
    () => ({ app: {}, graph, canvas, rootGraph: graph }),
    () => ({ id: 22, title: "COMBOS VARIANCE" }),
    () => {},
    () => [{ id: 192 }, { id: 265 }, { id: 273 }],
    () => {},
    new Function(
      "detachedConversionNodes",
      "detachedConversionRefusal",
      "conversionSnapshot",
      "conversionThrowReport",
      `return ${runner[0]};`,
    )(detachedConversionNodes, detachedConversionRefusal, conversionSnapshot, conversionThrowReport),
    new Function(`return ${landed[0]};`)(),
    new Function(
      "danglingInputLinks",
      "disconnectedBoundaryInputs",
      "brokenConversionRefusal",
      "brokenConversionWarning",
      `return ${serializable[0]};`,
    )(danglingInputLinks, disconnectedBoundaryInputs, brokenConversionRefusal, brokenConversionWarning),
    new Function(`return ${advisories[0]};`)(),
  );
}

/** The subgraph node convertToSubgraph put on the canvas, boundary input unfed. */
const wrapperNode = (link) => ({
  id: 302,
  type: "3be9b3b8-5e79-4bd1-acc6-015115c03be5",
  inputs: [{ name: "conditioning", type: "CONDITIONING", link }],
});

const runGroup = (subgraph, wrapper) =>
  realExecutor("graph_subgraph_group", "\\{ group \\}", () => ({ node: wrapper, subgraph }), wrapper)({
    group: "COMBOS VARIANCE",
  });

test("#1571 BEHAVIOUR: the reported conversion succeeds, carrying the finding it used to hide", () => {
  // The reported node is bypassed, so the honest answer is a warning, not a refusal — and
  // the caller learns the node, slot and link at the moment of the conversion, which is
  // precisely what they lacked.
  const wrapper = wrapperNode(null);
  const out = runGroup(brokenSubgraph(), wrapper);
  assert.equal(out.subgraph.node_id, 302);
  assert.deepEqual(out.subgraph.from_nodes, [192, 265, 273]);
  assert.equal(out.subgraph.dangling_inputs.length, 1);
  assert.equal(out.subgraph.dangling_inputs[0].node_id, 192);
  assert.equal(out.subgraph.dangling_inputs[0].link_id, 505);
  assert.match(out.subgraph.warning, /RBG_Smart_Seed_Variance node 192/);
  assert.deepEqual(out.subgraph.unfed_boundary_inputs, [
    { slot: 0, name: "conditioning", type: "CONDITIONING" },
  ]);
});

test("#1571 BEHAVIOUR: a PROVABLY broken conversion is refused", () => {
  const wrapper = wrapperNode(null);
  assert.throws(
    () => runGroup(certainlyBrokenSubgraph(), wrapper),
    (err) => {
      assert.match(err.message, /panel_subgraph_group created subgraph node 302/);
      assert.match(err.message, /UNSERIALIZABLE/);
      assert.match(err.message, /KSampler node 265 input 1 "positive" → link 997/);
      return true;
    },
  );
});

test("#1571 BEHAVIOUR: a healthy conversion carries no advisory key at all", () => {
  // The direction that would break the tool for everyone. An `unfed_boundary_inputs: []`
  // or a `warning: null` on every clean conversion reads as a finding.
  const out = runGroup(healthySubgraph(), wrapperNode(505));
  assert.equal(out.subgraph.node_id, 302);
  for (const key of ["unfed_boundary_inputs", "dangling_inputs", "warning"]) {
    assert.ok(!(key in out.subgraph), `a clean conversion must not report ${key}`);
  }
});

test("#1571 BEHAVIOUR: panel_create_subgraph refuses the same provable corruption", () => {
  const wrapper = wrapperNode(null);
  const create = realExecutor(
    "graph_create_subgraph",
    "\\{ node_ids \\}",
    () => ({ node: wrapper, subgraph: certainlyBrokenSubgraph() }),
    wrapper,
  );
  assert.throws(
    () => create({ node_ids: [192, 265, 273] }),
    /panel_create_subgraph created subgraph node 302/,
  );
});
