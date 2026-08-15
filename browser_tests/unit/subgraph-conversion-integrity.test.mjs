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

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  readLinkIds,
  danglingInputLinks,
  fatalDanglingInputLinks,
  bypassResolvedInputSlots,
  disconnectedBoundaryInputs,
  brokenConversionRefusal,
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

// ── The fatal signal ────────────────────────────────────────────────────────────────

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
    fatal: true,
  });
});

// ── WHICH dangling inputs the serializer actually reaches (codex gate, P1) ──────────
//
// `graphToPrompt` skips a node entirely before touching its inputs:
//   if (node.isVirtualNode || node.mode === NEVER || node.mode === BYPASS) continue
// and `resolveOutput` returns immediately for NEVER ("Muted nodes produce no output").
// Refusing on an input nothing resolves would un-ship the tool for graphs that run.

test("#1571 P1 a MUTED node's dangling input is reported but never fatal", () => {
  const g = brokenSubgraph();
  g._nodes = [rbg(505, 2)];
  const [entry] = danglingInputLinks(g);
  assert.equal(entry.muted, true);
  assert.equal(entry.fatal, false, "a muted node is never asked for its inputs, so it still queues");
  assert.deepEqual(fatalDanglingInputLinks(g), [], "and it must not reach the refusal");
});

test("#1571 P1 a VIRTUAL node's dangling input is reported but never fatal", () => {
  const g = brokenSubgraph();
  g._nodes = [{ id: 5, type: "Reroute", mode: 0, isVirtualNode: true, inputs: [{ name: "", link: 505 }] }];
  const [entry] = danglingInputLinks(g);
  assert.equal(entry.fatal, false);
});

test("#1571 P1 an ORDINARY node's dangling input is always fatal", () => {
  // The mode the reported graph did NOT have, and the one with the widest blast radius:
  // every input of a live node is resolved.
  const g = brokenSubgraph();
  g._nodes = [{ id: 9, type: "KSampler", mode: 0, inputs: [{ name: "positive", type: "CONDITIONING", link: 999 }] }];
  assert.equal(danglingInputLinks(g)[0].fatal, true);
  // …and a node with no `mode` at all is an ordinary node.
  g._nodes = [{ id: 9, type: "KSampler", inputs: [{ name: "positive", link: 999 }] }];
  assert.equal(danglingInputLinks(g)[0].fatal, true);
});

test("#1571 P1 a bypassed node's UNSELECTED input is not fatal", () => {
  // `_getBypassSlotIndex` picks ONE input per output slot. A MASK input on a node whose
  // only output is IMAGE is never resolved, so its dangling link cannot throw.
  const g = brokenSubgraph();
  g._nodes = [
    {
      id: 42,
      type: "ImageBlend",
      mode: 4,
      inputs: [
        { name: "image", type: "IMAGE", link: 473 },
        { name: "mask", type: "MASK", link: 998 },
      ],
      outputs: [{ name: "IMAGE", type: "IMAGE", links: [474] }],
    },
  ];
  const [entry] = danglingInputLinks(g);
  assert.equal(entry.name, "mask");
  assert.equal(entry.fatal, false, "no output type selects the MASK input");
});

test("#1571 P1 a bypassed node with NO connected output reaches nothing", () => {
  // Bypass is only ever entered THROUGH a consumer. Nothing consumes an unlinked output.
  const g = brokenSubgraph();
  const node = rbg(505);
  node.outputs = [{ name: "conditioning", type: "CONDITIONING", links: [] }];
  g._nodes = [node];
  assert.equal(danglingInputLinks(g)[0].fatal, false);
});

test("#1571 P1 the bypass slot selection mirrors _getBypassSlotIndex", () => {
  const sel = (node) => [...bypassResolvedInputSlots(node)].sort((a, b) => a - b);
  // Same-index input, compatible type → that slot.
  assert.deepEqual(
    sel({
      inputs: [{ type: "IMAGE" }, { type: "MASK" }],
      outputs: [{ type: "IMAGE", links: [1] }],
    }),
    [0],
  );
  // Same index incompatible → first exact type match.
  assert.deepEqual(
    sel({
      inputs: [{ type: "MASK" }, { type: "IMAGE" }],
      outputs: [{ type: "IMAGE", links: [1] }],
    }),
    [1],
  );
  // The same-slot preference BEATS the first exact match, and only a graph with two
  // equally-typed inputs can tell the two rules apart. Getting this backwards marks the
  // wrong input fatal in both directions — a false refusal on input 0 and silence on the
  // one that actually breaks.
  assert.deepEqual(
    sel({
      inputs: [{ type: "IMAGE" }, { type: "IMAGE" }],
      outputs: [{ type: "LATENT", links: [] }, { type: "IMAGE", links: [1] }],
    }),
    [1],
  );
  // A wildcard output matches the same index, falling back to slot 0.
  assert.deepEqual(sel({ inputs: [{ type: "MASK" }], outputs: [{ type: "*", links: [1] }] }), [0]);
  // A wildcard INPUT is compatible with anything.
  assert.deepEqual(sel({ inputs: [{ type: "*" }], outputs: [{ type: "LATENT", links: [1] }] }), [0]);
  // Types are compared case-insensitively, as strings.
  assert.deepEqual(sel({ inputs: [{ type: "image" }], outputs: [{ type: "IMAGE", links: [1] }] }), [0]);
  // Unconnected outputs select nothing at all.
  assert.deepEqual(sel({ inputs: [{ type: "IMAGE" }], outputs: [{ type: "IMAGE", links: [] }] }), []);
  // Every connected output contributes its own selection.
  assert.deepEqual(
    sel({
      inputs: [{ type: "IMAGE" }, { type: "MASK" }],
      outputs: [{ type: "IMAGE", links: [1] }, { type: "MASK", links: [2] }],
    }),
    [0, 1],
  );
  // Junk is silent rather than throwing.
  assert.deepEqual(sel({}), []);
  assert.deepEqual(sel({ inputs: null, outputs: "nope" }), []);
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

// ── The advisory signal ─────────────────────────────────────────────────────────────

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

// ── The refusal ─────────────────────────────────────────────────────────────────────

const refusal = () =>
  brokenConversionRefusal({
    what: "panel_subgraph_group",
    subgraphNodeId: 302,
    dangling: danglingInputLinks(brokenSubgraph()),
    disconnected: [{ slot: 0, name: "conditioning", type: "CONDITIONING" }],
  });

test("#1571 the refusal says the subgraph EXISTS — the opposite of its sibling", () => {
  // assertSubgraphNodeLanded's message says "nothing is being reported as created". Reusing
  // that wording here would send the caller to retry and wrap the same nodes a second time,
  // leaving two subgraph nodes on the canvas.
  const msg = refusal();
  assert.match(msg, /created subgraph node 302/);
  assert.match(msg, /on the canvas/);
  assert.match(msg, /Nothing has been undone/);
  assert.doesNotMatch(msg, /Nothing is being reported as created/);
});

test("#1571 the refusal names the node, the slot and the link", () => {
  const msg = refusal();
  assert.match(msg, /RBG_Smart_Seed_Variance node 192/);
  assert.match(msg, /input 0 "conditioning"/);
  assert.match(msg, /link 505/);
  assert.match(msg, /bypassed/, "the mode matters — a bypassed node is resolved THROUGH");
});

test("#1571 the refusal connects itself to the error the run would have shown", () => {
  // The whole cost of the bug: `[302:192]` appeared for the first time at run time, with
  // nothing tying it to the conversion. Printing it here is what closes that gap.
  assert.match(refusal(), /No link found in parent graph for id \[302:192\] slot \[0\]/);
});

test("#1571 the refusal offers both recoveries and does not claim to have repaired anything", () => {
  const msg = refusal();
  assert.match(msg, /Ctrl\+Z|undo/i);
  assert.match(msg, /panel_enter_subgraph/);
  assert.match(msg, /panel_expose_subgraph_input/);
  assert.doesNotMatch(msg, /has been (repaired|fixed|reconnected)/i);
});

test("#1571 the refusal attributes the cause to the frontend, without hiding behind it", () => {
  const msg = refusal();
  assert.match(msg, /convertToSubgraph produced this/);
  assert.match(msg, /comfyui-mcp#1571/);
});

test("#1571 the unfed boundary slots ride along in the refusal", () => {
  assert.match(refusal(), /input slot\(s\) that nothing in the parent graph feeds/);
  // …and are omitted entirely when there are none, rather than printed as "0".
  const none = brokenConversionRefusal({
    what: "panel_create_subgraph",
    subgraphNodeId: 9,
    dangling: danglingInputLinks(brokenSubgraph()),
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
    bypassed: false,
  }));
  const msg = brokenConversionRefusal({
    what: "panel_subgraph_group",
    subgraphNodeId: 302,
    dangling: many,
    disconnected: [],
  });
  assert.ok(msg.length < 2000, `refusal must stay readable, was ${msg.length} chars`);
  assert.match(msg, /and 32 more/);
});

test("#1571 the refusal survives entries it cannot fully describe", () => {
  // It is composed while explaining a failure; throwing here would replace a useful
  // refusal with a second, unrelated error.
  const msg = brokenConversionRefusal({
    what: "panel_subgraph_group",
    subgraphNodeId: undefined,
    dangling: [{ node_id: null, node_type: null, slot: 2, name: null, link_id: 9, bypassed: false }],
    disconnected: null,
  });
  assert.match(msg, /link 9/);
  assert.match(msg, /input 2/);
});

// ── WIRING. The helpers above are inert unless both conversion tools consult them, and
//    that is two lines inside a 30k-line file. Deleting either one leaves every test
//    above green — which is exactly how #1571 shipped in the first place.

test("#1571 BOTH conversion paths assert serializability, AFTER the node landed", () => {
  const s = src();
  for (const tool of ["panel_create_subgraph", "panel_subgraph_group"]) {
    const landed = s.indexOf(`assertSubgraphNodeLanded(res, graph, "${tool}")`);
    const serializable = s.indexOf(`assertSubgraphConversionSerializable(res, `);
    assert.ok(landed > 0, `${tool} must still assert the node landed`);
    const call = new RegExp(
      `assertSubgraphConversionSerializable\\(res, \\w+, "${tool}"\\)`,
    );
    assert.match(s, call, `${tool} must assert the conversion is serializable`);
    assert.ok(serializable > 0);
    // ORDER: the serializability check reads the node the landing check returned, so a
    // conversion that produced nothing must fail with the sibling's clearer message.
    assert.ok(
      s.search(call) > landed,
      `${tool} must check the node landed BEFORE checking it serializes`,
    );
  }
});

test("#1571 the advisory findings reach the reported payload on both paths", () => {
  // A finding computed and then dropped on the floor is the same as no finding. This is a
  // one-line spread that no helper test can see.
  const s = src();
  const occurrences = s.match(/\.\.\.subgraphConversionAdvisories\(advisories\)/g) ?? [];
  assert.equal(occurrences.length, 2, "both conversion tools must report the advisories");
  // …and only the FATAL findings may refuse (codex gate P1).
  assert.match(s, /const fatal = dangling\.filter\(\(entry\) => entry\.fatal\);/);
  assert.match(s, /if \(fatal\.length\) \{/);
});

test("#1571 the guard is imported, not shadowed by a local stub", () => {
  assert.match(
    src(),
    /import \{\s*danglingInputLinks,\s*disconnectedBoundaryInputs,\s*brokenConversionRefusal,\s*\} from "\.\/lib\/subgraph-conversion-integrity\.js";/,
  );
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
    /function subgraphConversionAdvisories\(\{ disconnected, dormant \}\) \{[\s\S]*?\r?\n\}/,
  );
  assert.ok(landed && serializable && advisories, "the conversion guards must be locatable in the source");
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
    new Function(`return ${landed[0]};`)(),
    new Function(
      "danglingInputLinks",
      "disconnectedBoundaryInputs",
      "brokenConversionRefusal",
      `return ${serializable[0]};`,
    )(danglingInputLinks, disconnectedBoundaryInputs, brokenConversionRefusal),
    new Function(`return ${advisories[0]};`)(),
  );
}

/** The subgraph node convertToSubgraph put on the canvas, boundary input unfed. */
const wrapperNode = (link) => ({
  id: 302,
  type: "3be9b3b8-5e79-4bd1-acc6-015115c03be5",
  inputs: [{ name: "conditioning", type: "CONDITIONING", link }],
});

test("#1571 BEHAVIOUR: panel_subgraph_group REFUSES the reported conversion", () => {
  const wrapper = wrapperNode(null);
  const group = realExecutor(
    "graph_subgraph_group",
    "\\{ group \\}",
    () => ({ node: wrapper, subgraph: brokenSubgraph() }),
    wrapper,
  );
  assert.throws(
    () => group({ group: "COMBOS VARIANCE" }),
    (err) => {
      assert.match(err.message, /panel_subgraph_group created subgraph node 302/);
      assert.match(err.message, /RBG_Smart_Seed_Variance node 192 \(bypassed\) input 0 "conditioning" → link 505/);
      assert.match(err.message, /No link found in parent graph for id \[302:192\]/);
      return true;
    },
    "the tool that reported success must now refuse",
  );
});

test("#1571 BEHAVIOUR: a healthy conversion still reports success, with the unfed slot named", () => {
  // The direction that would break the tool for everyone. Same executor, same wrapper —
  // only the subgraph's link table differs.
  const wrapper = wrapperNode(null);
  const group = realExecutor(
    "graph_subgraph_group",
    "\\{ group \\}",
    () => ({ node: wrapper, subgraph: healthySubgraph() }),
    wrapper,
  );
  const out = group({ group: "COMBOS VARIANCE" });
  assert.equal(out.subgraph.node_id, 302);
  assert.deepEqual(out.subgraph.from_nodes, [192, 265, 273]);
  // The advisory tier: reported, never fatal.
  assert.deepEqual(out.subgraph.unfed_boundary_inputs, [
    { slot: 0, name: "conditioning", type: "CONDITIONING" },
  ]);
});

test("#1571 BEHAVIOUR: a fully healthy conversion carries no advisory key at all", () => {
  // An `unfed_boundary_inputs: []` on every clean conversion would read as a finding.
  const wrapper = wrapperNode(505);
  const group = realExecutor(
    "graph_subgraph_group",
    "\\{ group \\}",
    () => ({ node: wrapper, subgraph: healthySubgraph() }),
    wrapper,
  );
  const out = group({ group: "COMBOS VARIANCE" });
  assert.ok(!("unfed_boundary_inputs" in out.subgraph), "a clean conversion reports no advisory");
});

test("#1571 P1 BEHAVIOUR: a conversion whose only breakage is MUTED still succeeds", () => {
  // The over-refusal the gate caught, driven through the real executor. This graph queues
  // today, so the tool must report it — with the finding attached, not swallowed.
  const wrapper = wrapperNode(505);
  const muted = brokenSubgraph();
  muted._nodes = [rbg(505, 2)];
  const group = realExecutor(
    "graph_subgraph_group",
    "\\{ group \\}",
    () => ({ node: wrapper, subgraph: muted }),
    wrapper,
  );
  const out = group({ group: "COMBOS VARIANCE" });
  assert.equal(out.subgraph.node_id, 302, "a runnable graph must not be refused");
  assert.equal(out.subgraph.dangling_inputs_not_reached.length, 1);
  assert.equal(out.subgraph.dangling_inputs_not_reached[0].node_id, 192);
  assert.ok(!("unfed_boundary_inputs" in out.subgraph));
});

test("#1571 P1 the refusal separates what is broken NOW from what is only latent", () => {
  const g = brokenSubgraph();
  g._nodes = [rbg(505), { id: 77, type: "Note", mode: 2, inputs: [{ name: "text", link: 997 }] }];
  const all = danglingInputLinks(g);
  const msg = brokenConversionRefusal({
    what: "panel_subgraph_group",
    subgraphNodeId: 302,
    dangling: all.filter((e) => e.fatal),
    dormant: all.filter((e) => !e.fatal),
    disconnected: [],
  });
  assert.match(msg, /1 input inside the new subgraph still references/, "only the fatal one counts");
  assert.doesNotMatch(msg, /2 inputs inside/, "the dormant one must not inflate the breakage");
  assert.match(msg, /NOT reached by the serializer today/);
  assert.match(msg, /Note node 77 \(muted\)/);
  assert.match(msg, /re-enabled or rewired/);
});

test("#1571 BEHAVIOUR: panel_create_subgraph refuses the same corruption", () => {
  const wrapper = wrapperNode(null);
  const create = realExecutor(
    "graph_create_subgraph",
    "\\{ node_ids \\}",
    () => ({ node: wrapper, subgraph: brokenSubgraph() }),
    wrapper,
  );
  assert.throws(
    () => create({ node_ids: [192, 265, 273] }),
    /panel_create_subgraph created subgraph node 302/,
  );
});
