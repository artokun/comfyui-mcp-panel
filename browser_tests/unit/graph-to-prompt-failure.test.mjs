// #1582 — a full-graph run whose graph cannot be serialized fails with a bare TypeError.
//
// On a 317-node community workflow referencing packs that are not installed:
//
//   panel_run {}                      → "Cannot read properties of undefined (reading 'workflow')"
//   panel_run { to_node_id: 2934 }    → "the prompt could not be fingerprinted (graphToPrompt
//                                        failed) … Nothing was queued rather than risk a
//                                        full-graph execution (#556)."
//
// Same root cause, two very different answers. The first names nothing, reads like an internal
// panel crash, and gave the reporter no reason to suspect their graph — they only learned the
// truth by chance, retrying with `to_node_id`.
//
// The TypeError itself comes from ComfyUI's own `queuePrompt`, which dereferences `.workflow`
// on the `graphToPrompt()` result. Our pre-flight runs first and lets it through:
// `unrunnableNodeIds(undefined)` answers `[]` — no offenders — because a result that does not
// exist has no unrunnable entries in it. Absence of evidence, read as evidence of absence.
import test from "node:test";
import assert from "node:assert/strict";

import {
  unrunnableNodeIds,
  graphToPromptUnusable,
  unserializableGraphRefusal,
  unresolvedNodeTypes,
} from "../../web/js/lib/missing-node-preflight.js";

test("#1582 unrunnableNodeIds cannot speak for a result that does not exist", () => {
  // Not a defect in this function — it is answering a different question. Pinned so the
  // reason the pre-flight needs a SEPARATE check stays visible.
  assert.deepEqual(unrunnableNodeIds(undefined), []);
  assert.deepEqual(unrunnableNodeIds(null), []);
});

test("#1582 an absent or malformed graphToPrompt result is recognised", () => {
  for (const bad of [undefined, null, {}, { output: undefined }, { output: null }, "nope", 7]) {
    assert.equal(graphToPromptUnusable(bad), true, JSON.stringify(bad) ?? String(bad));
  }
});

test("#1582 a USABLE result is not flagged", () => {
  // The direction that would break every run: a healthy prompt must sail through. An empty
  // output object is legitimate (an empty graph), and is not this failure.
  for (const ok of [
    { output: { 1: { class_type: "KSampler", inputs: {} } }, workflow: {} },
    { output: {}, workflow: {} },
  ]) {
    assert.equal(graphToPromptUnusable(ok), false, JSON.stringify(ok));
  }
});

test("#1582 the refusal says WHAT failed and that nothing was queued", () => {
  const msg = unserializableGraphRefusal([]);
  // The two things the bare TypeError did not say.
  assert.match(msg, /graphToPrompt/);
  assert.match(msg, /nothing was queued|not queued/i);
  // And it must not read as a panel crash, which is what sent the reporter looking in the
  // wrong place.
  assert.doesNotMatch(msg, /Cannot read properties/);
});

test("#1582 the refusal NAMES the node types the frontend could not resolve", () => {
  // The reporter's item 2. "Serialization failed" still leaves them guessing which of the
  // 317 nodes is at fault; the panel already knows the unresolved types.
  const msg = unserializableGraphRefusal(["LCKreaSampler", "Florence2Run", "SAM_SmartInpainter"]);
  assert.match(msg, /LCKreaSampler/);
  assert.match(msg, /Florence2Run/);
  assert.match(msg, /SAM_SmartInpainter/);
});

test("#1582 with no types identified it still refuses, without inventing a cause", () => {
  // Serialization can fail for reasons other than a missing pack. Naming one anyway would
  // send the user to install something they already have.
  const msg = unserializableGraphRefusal([]);
  assert.doesNotMatch(msg, /missing (custom )?node|install the/i);
  assert.match(msg, /graphToPrompt/);
});

test("#1582 a long type list is bounded", () => {
  // The reported graph has ~35 LC* nodes alone. An unbounded list buries the instruction
  // underneath it.
  const many = Array.from({ length: 60 }, (_, i) => `LCNode${i}`);
  const msg = unserializableGraphRefusal(many);
  assert.ok(msg.length < 1200, `refusal must stay readable, was ${msg.length} chars`);
  assert.match(msg, /LCNode0/);
  assert.match(msg, /more|…|\.\.\./);
});

// ── WIRING. The helpers are useless if the run path never consults them, and the guard is
//    a few lines inside a 30k-line file that a refactor could drop with every unit test
//    still green.

test("#1582 the run path guards graphToPrompt BEFORE reading offenders", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf-8");
  const at = src.indexOf("const built = await app.graphToPrompt();");
  assert.ok(at > 0, "the pre-flight's graphToPrompt call must still be recognisable");
  // Bounded by the pre-flight's OWN catch, not a byte count. A fixed 1800 truncated
  // `unrunnableNodeIds(built)` the moment the guard's comment grew — which is the third
  // time today a fixed window in this repo reported missing wiring that was present
  // (#1472, #1460, here). The block ends where its catch begins; say that instead.
  const endOfTry = src.indexOf("} catch (err) {", at);
  assert.ok(endOfTry > at, "the pre-flight try block must still be recognisable");
  const block = src.slice(at, endOfTry);
  const guard = block.indexOf("graphToPromptUnusable(built)");
  const offenders = block.indexOf("unrunnableNodeIds(built)");
  assert.ok(guard > -1, "the unusable-result guard must exist");
  assert.ok(offenders > -1, "the offender check must still exist");
  // ORDER is the fix. Asking for offenders first answers `[]` for an absent result and
  // lets it through to queuePrompt, which is the reported TypeError.
  assert.ok(guard < offenders, "the guard must run BEFORE the offender check");
  assert.match(block, /unserializableGraphRefusal\(/);
});

test("#1582 the refusal keeps the prefix its own catch requires", async () => {
  // The pre-flight is wrapped in a try whose catch re-throws ONLY /^NOT queued:/ — anything
  // else is swallowed so a broken pre-flight cannot become a new failure mode. A refusal
  // without that prefix would be silently discarded and the run would proceed into the
  // TypeError, with every helper test still passing.
  assert.match(unserializableGraphRefusal([]), /^NOT queued:/);
  assert.match(unserializableGraphRefusal(["LCKreaSampler"]), /^NOT queued:/);
});

// ── BEHAVIOUR, from the REAL source. The wiring tests above pin that the guard exists and
//    runs first; they cannot see whether it actually refuses. Extracting the pre-flight
//    block and driving it against stubs proves the reported call now fails with a reason —
//    the same real-source extraction pattern manager-dialect.test.mjs uses.

/** Pull the pre-flight try/catch out of the monolith and run it with injected deps. */
async function buildPreflight({ graphToPrompt, nodes = [], viewedNodes, registry = {} }) {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf-8");
  const marker = src.indexOf("      // Inspect the SERIALIZED prompt");
  assert.ok(marker > 0, "the pre-flight comment must still be recognisable");
  const start = src.lastIndexOf("try {", marker);
  const endMark = src.indexOf("if (err instanceof Error && /^NOT queued:/.test(err.message)) throw err;", start);
  assert.ok(endMark > start, "the pre-flight catch must still be recognisable");
  const body = src.slice(start, src.indexOf("\n", endMark)) + "\n    }";
  const mod = await import("../../web/js/lib/missing-node-preflight.js");
  const factory = new Function(
    "app",
    "graph",
    "LG",
    "unrunnableNodeIds",
    "describeUnrunnable",
    "missingNodeRunRefusal",
    "graphToPromptUnusable",
    "unserializableGraphRefusal",
    // #1582 review: the block became ROOT-scoped, so the harness has to supply the root
    // graph and the walker. Not injecting them made the extracted body throw a
    // ReferenceError that the pre-flight catch swallows — which is exactly the silent
    // failure this file exists to stop, one layer down.
    "rootGraph",
    "unresolvedNodeTypes",
    // The block reads LiteGraph off `window` (`LG` is a local in other functions and is
    // NOT in scope there — the panel-scope gate caught that). Node has no `window`, so
    // without this the extracted body throws a ReferenceError that the pre-flight catch
    // swallows, and the test sees no refusal at all.
    "window",
    `return async function preflight() {\n${body}\n};`,
  );
  // The VIEWED graph is deliberately a DIFFERENT object from the root when the caller
  // supplies one: the pre-flight must read the ROOT (serialization is root-scoped), and a
  // harness that passes the same object for both cannot tell the two apart — a mutation
  // swapping rootGraph for graph survived exactly that way.
  return factory(
    { graphToPrompt },
    { _nodes: viewedNodes ?? nodes },
    { registered_node_types: registry },
    mod.unrunnableNodeIds,
    mod.describeUnrunnable,
    mod.missingNodeRunRefusal,
    mod.graphToPromptUnusable,
    mod.unserializableGraphRefusal,
    { _nodes: nodes },
    mod.unresolvedNodeTypes,
    { LiteGraph: { registered_node_types: registry } },
  );
}

const runPreflight = async (opts) => {
  const preflight = await buildPreflight(opts);
  try {
    await preflight();
    return "__NO_REFUSAL__";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};

test("#1582 BEHAVIOUR: an undefined graphToPrompt result refuses, naming the packs", async () => {
  // The reported call, end to end through the real pre-flight source.
  const msg = await runPreflight({
    graphToPrompt: async () => undefined,
    nodes: [
      { id: 1, type: "KSampler" },
      { id: 2, type: "LCKreaSampler" },
      { id: 3, type: "Florence2Run" },
    ],
    registry: { KSampler: {} },
  });
  assert.notEqual(msg, "__NO_REFUSAL__", "an unserializable graph must not reach queuePrompt");
  assert.match(msg, /^NOT queued:/);
  assert.match(msg, /graphToPrompt/);
  assert.match(msg, /LCKreaSampler/);
  assert.match(msg, /Florence2Run/);
  // Only the UNREGISTERED ones. Naming a type the frontend has would send the user to
  // reinstall something that is already working.
  assert.doesNotMatch(msg, /KSampler\b(?!.*could not)/);
});

test("#1582 BEHAVIOUR: a healthy prompt passes the pre-flight untouched", async () => {
  const msg = await runPreflight({
    graphToPrompt: async () => ({
      output: { 1: { class_type: "KSampler", inputs: {} } },
      workflow: {},
    }),
    nodes: [{ id: 1, type: "KSampler" }],
    registry: { KSampler: {} },
  });
  assert.equal(msg, "__NO_REFUSAL__", "a runnable graph must not be refused");
});

test("#1582 BEHAVIOUR: the #1460 unrunnable-node refusal still fires", async () => {
  // The check this guard was inserted above. It must keep working — a serialized prompt
  // that EXISTS but carries a node with no class_type is a different failure with its own
  // (more specific) message.
  const msg = await runPreflight({
    graphToPrompt: async () => ({ output: { 7: { inputs: {} } }, workflow: {} }),
    nodes: [{ id: 7, type: "GoneNode" }],
    registry: {},
  });
  assert.match(msg, /^NOT queued:/);
  assert.match(msg, /cannot be executed by the server/);
  assert.match(msg, /GoneNode/);
});

// ── ROOT SCOPE (review, P1). graphToPrompt serializes the WHOLE workflow, so naming
//    offenders from the currently VIEWED graph misses a missing pack inside a subgraph —
//    or at the root while the user is inside one. The first extraction test modelled a
//    single flat graph and passed despite exactly that scope bug.

test("#1582 unresolved types are collected from NESTED subgraphs", () => {
  const root = {
    _nodes: [
      { id: 1, type: "KSampler" },
      { id: 2, type: "SubgraphNode", subgraph: { _nodes: [{ id: 3, type: "LCKreaSampler" }] } },
    ],
  };
  const types = unresolvedNodeTypes(root, { KSampler: {}, SubgraphNode: {} });
  assert.deepEqual(types, ["LCKreaSampler"]);
});

test("#1582 …and from a subgraph nested inside a subgraph", () => {
  const root = {
    _nodes: [
      {
        id: 1,
        type: "SubgraphNode",
        subgraph: {
          _nodes: [
            { id: 2, type: "SubgraphNode", subgraph: { _nodes: [{ id: 3, type: "DeepMissing" }] } },
          ],
        },
      },
    ],
  };
  assert.deepEqual(unresolvedNodeTypes(root, { SubgraphNode: {} }), ["DeepMissing"]);
});

test("#1582 a CYCLE cannot spin the walk", () => {
  // A subgraph referencing an ancestor must terminate. Without the seen-set this hangs the
  // panel at the exact moment it is trying to explain a failure.
  const root = { _nodes: [{ id: 1, type: "Missing1" }] };
  root._nodes.push({ id: 2, type: "SubgraphNode", subgraph: root });
  const types = unresolvedNodeTypes(root, { SubgraphNode: {} });
  assert.deepEqual(types, ["Missing1"]);
});

test("#1582 duplicates across subgraphs are reported once", () => {
  const root = {
    _nodes: [
      { id: 1, type: "LCKreaSampler" },
      { id: 2, type: "SubgraphNode", subgraph: { _nodes: [{ id: 3, type: "LCKreaSampler" }] } },
    ],
  };
  assert.deepEqual(unresolvedNodeTypes(root, { SubgraphNode: {} }), ["LCKreaSampler"]);
});

test("#1582 a fully-registered workflow yields nothing", () => {
  const root = {
    _nodes: [
      { id: 1, type: "KSampler" },
      { id: 2, type: "SubgraphNode", subgraph: { _nodes: [{ id: 3, type: "CLIPTextEncode" }] } },
    ],
  };
  assert.deepEqual(unresolvedNodeTypes(root, { KSampler: {}, SubgraphNode: {}, CLIPTextEncode: {} }), []);
});

test("#1582 junk graphs answer nothing rather than throwing", () => {
  // This runs while composing a failure message. Throwing here would replace a useful
  // refusal with a second, unrelated error.
  for (const junk of [null, undefined, 42, "graph", {}, { _nodes: null }, { _nodes: [null, 7] }]) {
    assert.deepEqual(unresolvedNodeTypes(junk, {}), [], String(junk));
  }
});

test("#1582 BEHAVIOUR: the refusal names a type from a SUBGRAPH", async () => {
  const preflight = await buildPreflight({
    graphToPrompt: async () => undefined,
    nodes: [
      { id: 1, type: "KSampler" },
      { id: 2, type: "SubgraphNode", subgraph: { _nodes: [{ id: 3, type: "LCKreaSampler" }] } },
    ],
    registry: { KSampler: {}, SubgraphNode: {} },
  });
  // The pre-flight reads rootGraph; buildPreflight wires graph as both, so nest there.
  const msg = await (async () => {
    try {
      await preflight();
      return "__NO_REFUSAL__";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  })();
  assert.match(msg, /^NOT queued:/);
  assert.match(msg, /LCKreaSampler/, "a type that only exists inside a subgraph must be named");
});

test("#1582 a cycle is visited ONCE, not re-walked to the depth cap", () => {
  // Termination alone is not the property. The depth cap already guarantees that, so a
  // missing seen-set does not hang — it re-walks the cycle at every level, which for a wide
  // graph is combinatorial work while the panel is trying to explain a failure.
  //
  // Counted rather than timed: `_nodes` is a getter, so the number of reads IS the number
  // of visits, and the assertion cannot flake on a slow machine.
  let reads = 0;
  const root = {
    get _nodes() {
      reads += 1;
      return nodes;
    },
  };
  const nodes = [
    { id: 1, type: "Missing1" },
    { id: 2, type: "SubgraphNode", subgraph: root },
  ];
  const types = unresolvedNodeTypes(root, { SubgraphNode: {} });
  assert.deepEqual(types, ["Missing1"]);
  assert.equal(reads, 1, `the cyclic graph must be walked once, was walked ${reads} times`);
});

test("#1582 BEHAVIOUR: the scan reads the ROOT graph, not the one on screen", async () => {
  // The user is inside a subgraph, so the viewed graph holds nothing interesting. The
  // missing pack is at the root — and serialization is root-scoped, so it is what broke.
  const preflight = await buildPreflight({
    graphToPrompt: async () => undefined,
    nodes: [{ id: 1, type: "LCKreaSampler" }], // root
    viewedNodes: [{ id: 9, type: "KSampler" }], // what is on screen
    registry: { KSampler: {} },
  });
  const msg = await preflight().then(
    () => "__NO_REFUSAL__",
    (e) => (e instanceof Error ? e.message : String(e)),
  );
  assert.match(msg, /^NOT queued:/);
  assert.match(msg, /LCKreaSampler/, "a root-level missing type must be named while viewing a subgraph");
});
