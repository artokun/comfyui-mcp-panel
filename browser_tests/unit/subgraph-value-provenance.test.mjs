import { test } from "node:test";
import assert from "node:assert/strict";
import { graphViewIdentityFor } from "../../web/js/lib/graph-view-identity.js";
import { subgraphValueProvenance } from "../../web/js/lib/subgraph-value-provenance.js";
import { redactWidgetValue, REDACTED_WIDGET_VALUE } from "../../web/js/lib/widget-secret-redaction.js";
import {
  followPromotionToConcrete,
  MAX_PROMOTION_CHAIN_DEPTH,
  promotedInputAliases,
  resolvePromotedInnerTarget,
} from "../../web/js/lib/widget-write.js";

/**
 * #636 (minor) — panel_get_subgraph(173) reported inner node 166 value "MiniMax_H3"
 * while panel_query_graph(ids:[173]) reported the parent instance value "MM3". Both
 * correct, describing different things, with nothing in either payload saying so —
 * so the difference read as stale data.
 *
 * That is the costly failure: an agent "fixes" a value that was never wrong, or
 * re-reads in a loop waiting for two numbers to agree that never will and should not.
 */

test("the reporter's case: instance values ride alongside, labelled", () => {
  const node = { id: 173, widgets: [{ name: "value", value: "MM3" }] };
  const out = subgraphValueProvenance(node);
  assert.deepEqual(out.instance_widgets, { value: "MM3" });
  assert.match(out.values_note, /belong to the subgraph DEFINITION/);
  assert.match(out.values_note, /node 173/);
});

test("the note names the override as INTENTIONAL, not stale", () => {
  // The load-bearing sentence. Without it the payload still shows two values and
  // leaves the reader to guess which is wrong — the original failure.
  const out = subgraphValueProvenance({ id: 5, widgets: [{ name: "a", value: 1 }] });
  assert.match(out.values_note, /intentional per-instance override/i);
  assert.match(out.values_note, /NOT stale/);
  assert.match(out.values_note, /do not "correct" it/i);
});

test("a subgraph with NO promoted widgets gets no block at all", () => {
  // Nothing can diverge, so a note would be noise on every parameterless subgraph.
  for (const node of [{ id: 1 }, { id: 1, widgets: [] }, { id: 1, widgets: null }]) {
    assert.deepEqual(subgraphValueProvenance(node), {});
  }
});

test("unnamed widgets are skipped rather than keyed on undefined", () => {
  const out = subgraphValueProvenance({
    id: 2,
    widgets: [{ value: "no-name" }, { name: "", value: "empty" }, { name: "real", value: 7 }],
  });
  assert.deepEqual(out.instance_widgets, { real: 7 });
});

test("falsy and empty instance values are reported, not dropped", () => {
  // 0 / "" / false are real widget values. Dropping them would recreate the ambiguity
  // in the other direction — a caller could not tell "set to 0" from "not promoted".
  const out = subgraphValueProvenance({
    id: 3,
    widgets: [
      { name: "zero", value: 0 },
      { name: "empty", value: "" },
      { name: "off", value: false },
      { name: "nul", value: null },
    ],
  });
  assert.deepEqual(out.instance_widgets, { zero: 0, empty: "", off: false, nul: null });
});

test("a malformed node yields no block rather than throwing", () => {
  for (const bad of [null, undefined, {}, 42, "x", { widgets: "nope" }]) {
    assert.deepEqual(subgraphValueProvenance(bad), {});
  }
});

test("no promotion-to-inner-widget PAIRING is asserted", () => {
  // The mapping is not reliably recoverable across frontend versions, and a wrong
  // pairing would state a false override relationship — worse than the ambiguity
  // being fixed. The payload reports names as they are and lets the caller compare.
  const out = subgraphValueProvenance({ id: 9, widgets: [{ name: "value", value: "MM3" }] });
  assert.equal(out.instance_widgets.value, "MM3");
  assert.ok(!("overrides" in out), "must not claim which inner widget this feeds");
  assert.ok(!("mapping" in out));
});

// ── WIRING ────────────────────────────────────────────────────────────────
test("WIRING: production graph_get_subgraph gives MCP a definitive non-promoted error", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const start = src.indexOf("graph_get_subgraph({ node_id }) {");
  const end = src.indexOf("async graph_add_node(", start);
  assert.ok(start >= 0 && end > start, "graph_get_subgraph handler must remain extractable");
  const method = src.slice(start, end).replace(/,\s*$/, "");
  const getSubgraph = new Function(
    "getGraphCtx",
    "resolveNode",
    `return ({${method}}).graph_get_subgraph;`,
  )(
    () => ({ graph: {} }),
    (_graph, id) => ({ id, type: "OrdinaryNode" }),
  );

  assert.throws(
    () => getSubgraph({ node_id: 78 }),
    /Node 78 \(OrdinaryNode\) is not a subgraph/,
  );
});

test("WIRING: production graph_get_subgraph publishes the terminal nested-promotion witness", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const start = src.indexOf("graph_get_subgraph({ node_id }) {");
  const end = src.indexOf("async graph_add_node(", start);
  assert.ok(start >= 0 && end > start, "graph_get_subgraph handler must remain extractable");
  const method = src.slice(start, end).replace(/,\s*$/, "");
  const terminal = {
    widget: "quality_prompt",
    parent_rail: { authoritative: true, widget: "quality_prompt" },
    immediate_node_id: 188,
    immediate_widget: "quality_prompt",
    terminal_node_id: 2768,
    terminal_node_type: "AnimaRegionalCanvasInline",
    terminal_widget: "quality_prompt",
    terminal_inputs: [],
    chain_depth: 1,
  };
  const parent = {
    id: 78,
    title: "Nested container",
    inputs: [],
    subgraph: { _nodes: [{ id: 188, type: "SubgraphB", is_subgraph: true }] },
  };
  const graph = {};
  const getSubgraph = new Function(
    "getGraphCtx",
    "resolveNode",
    "describeActiveGraph",
    "subgraphValueProvenance",
    "redactWidgetValue",
    "graphViewIdentityFor",
    "MAX_STATE_NODES",
    "fixedCapNote",
    "summarizeNode",
    "promotedTerminalWitnesses",
    `return ({${method}}).graph_get_subgraph;`,
  )(
    () => ({ graph }),
    () => parent,
    () => ({ scope: "root", graph_identity: "root" }),
    () => ({}),
    () => ({}),
    () => "graph:nested",
    50,
    () => "truncation note",
    (node) => ({ id: node.id, type: node.type }),
    () => [terminal],
  );

  const out = getSubgraph({ node_id: 78 });
  assert.deepEqual(out.promoted_terminals, [terminal]);
  assert.equal(out.nodes[0].id, 188);
});

test("WIRING: production graph_get_subgraph publishes an explicit empty witness array", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const start = src.indexOf("graph_get_subgraph({ node_id }) {");
  const end = src.indexOf("async graph_add_node(", start);
  assert.ok(start >= 0 && end > start, "graph_get_subgraph handler must remain extractable");
  const method = src.slice(start, end).replace(/,\s*$/, "");
  const parent = { id: 78, title: "Ordinary container", inputs: [], subgraph: { _nodes: [] } };
  const getSubgraph = new Function(
    "getGraphCtx",
    "resolveNode",
    "describeActiveGraph",
    "subgraphValueProvenance",
    "redactWidgetValue",
    "graphViewIdentityFor",
    "MAX_STATE_NODES",
    "fixedCapNote",
    "summarizeNode",
    "promotedTerminalWitnesses",
    `return ({${method}}).graph_get_subgraph;`,
  )(
    () => ({ graph: {} }),
    () => parent,
    () => ({ scope: "root", graph_identity: "root" }),
    () => ({}),
    () => ({}),
    () => "graph:ordinary",
    50,
    () => "truncation note",
    (node) => ({ id: node.id, type: node.type }),
    () => [],
  );

  assert.deepEqual(getSubgraph({ node_id: 78 }).promoted_terminals, []);
});

test("WIRING: production alias witness keeps outer, immediate, and terminal names distinct", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const helperStart = src.indexOf("function resolveSubgraphLink(");
  const helperEnd = src.indexOf("\nfunction findPromotedHostInput", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "production promotion helper range must remain extractable");
  const makeWitnesses = new Function(
    "resolvePromotedInnerTarget",
    "followPromotionToConcrete",
    "MAX_PROMOTION_CHAIN_DEPTH",
    "promotedInputAliases",
    `${src.slice(helperStart, helperEnd)}; return promotedTerminalWitnesses;`,
  )(
    resolvePromotedInnerTarget,
    followPromotionToConcrete,
    MAX_PROMOTION_CHAIN_DEPTH,
    promotedInputAliases,
  );

  const cases = [
    {
      outer: "prompt_alias",
      immediate: "prompt_b",
      terminalType: "AnimaRegionalCanvasInline",
      terminalWidget: "quality_prompt",
      inputs: [{ name: "quality_prompt", type: "STRING" }],
    },
    {
      outer: "dynamic_alias",
      immediate: "dynamic_b",
      terminalType: "NestedConcreteNode",
      terminalWidget: "model.prompt",
      inputs: [
        { name: "model", type: "COMFY_DYNAMICCOMBO_V3" },
        { name: "model.prompt", type: "STRING" },
      ],
    },
    {
      outer: "stack_alias",
      immediate: "stack_b",
      terminalType: "DaSiWa_LTX2LoraLoader",
      terminalWidget: "stack_data",
      inputs: [{ name: "stack_data", type: "STRING" }],
    },
  ];

  for (const testCase of cases) {
    const terminal = {
      id: 2768,
      type: testCase.terminalType,
      inputs: testCase.inputs.map((input, index) => ({
        ...input,
        ...(index === testCase.inputs.findIndex((candidate) => candidate.name === testCase.terminalWidget)
          ? { widget: { name: testCase.terminalWidget } }
          : {}),
      })),
      widgets: [{ name: testCase.terminalWidget, value: "old" }],
    };
    const terminalSlot = testCase.inputs.findIndex((candidate) => candidate.name === testCase.terminalWidget);
    const inner = {
      id: 188,
      type: "SubgraphB",
      inputs: [{ name: testCase.immediate, widget: { name: testCase.immediate }, _subgraphSlot: { name: "inner_alias", linkIds: [2] } }],
      widgets: [{ name: testCase.immediate, value: "old" }],
      subgraph: {
        _nodes: [terminal],
        getNodeById: (id) => (String(id) === "2768" ? terminal : null),
        getLink: (id) => (id === 2 ? { origin_id: 2768, target_id: 2768, target_slot: terminalSlot } : null),
      },
    };
    const projectedWidget = {
      name: testCase.immediate,
      label: "outer display",
      _subgraphSlot: { name: "parent_alias" },
    };
    const parent = {
      id: 78,
      widgets: [projectedWidget],
      properties: { proxyWidgets: [[188, testCase.immediate]] },
      inputs: [{
        name: testCase.outer,
        label: "outer display",
        widget: projectedWidget,
        _widget: projectedWidget,
        widgetId: `root:78:${testCase.outer}`,
        _subgraphSlot: { name: "parent_alias", linkIds: [1] },
      }],
      subgraph: {
        _nodes: [inner],
        getNodeById: (id) => (String(id) === "188" ? inner : null),
        getLink: (id) => (id === 1 ? { origin_id: 188, target_id: 188, target_slot: 0 } : null),
      },
    };

    const entries = makeWitnesses(parent);
    const witness = entries.find((entry) => entry.widget === testCase.outer);
    assert.deepEqual(witness, {
      widget: testCase.outer,
      parent_rail: {
        authoritative: true,
        widget: testCase.immediate,
        widget_id: `root:78:${testCase.outer}`,
      },
      immediate_node_id: 188,
      immediate_widget: testCase.immediate,
      terminal_node_id: 2768,
      terminal_node_type: testCase.terminalType,
      terminal_widget: testCase.terminalWidget,
      terminal_inputs: testCase.inputs,
      chain_depth: 1,
    });
    for (const alias of [testCase.outer, "outer display", "parent_alias"]) {
      const aliasWitness = entries.find((entry) => entry.widget === alias);
      assert.equal(aliasWitness?.immediate_node_id, 188, `missing witness for ${alias}`);
      assert.equal(aliasWitness?.immediate_widget, testCase.immediate, `wrong target for ${alias}`);
    }

    const missingSlotEntries = makeWitnesses({
      ...parent,
      inputs: [{ name: testCase.outer, label: "outer display" }],
    });
    assert.match(
      missingSlotEntries.find((entry) => entry.widget === testCase.outer)?.error ?? "",
      /_subgraphSlot missing|unresolved/i,
    );
  }
});

test("WIRING: production witness refuses an externally-linked parent rail", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const helperStart = src.indexOf("function resolveSubgraphLink(");
  const helperEnd = src.indexOf("\nfunction findPromotedHostInput", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "production promotion helper range must remain extractable");
  const makeWitnesses = new Function(
    "resolvePromotedInnerTarget",
    "followPromotionToConcrete",
    "MAX_PROMOTION_CHAIN_DEPTH",
    "promotedInputAliases",
    `${src.slice(helperStart, helperEnd)}; return promotedTerminalWitnesses;`,
  )(
    resolvePromotedInnerTarget,
    followPromotionToConcrete,
    MAX_PROMOTION_CHAIN_DEPTH,
    promotedInputAliases,
  );
  const rail = { name: "quality_prompt", value: "old" };
  const inner = {
    id: 188,
    type: "PrimitiveStringMultiline",
    inputs: [{ name: "quality_prompt", widget: { name: "quality_prompt" } }],
    widgets: [{ name: "quality_prompt", value: "old" }],
  };
  const parent = {
    id: 78,
    widgets: [rail],
    inputs: [{
      name: "quality_prompt",
      widget: rail,
      _widget: rail,
      _subgraphSlot: { name: "quality_prompt", linkIds: [1] },
    }],
    subgraph: {
      _nodes: [inner],
      getNodeById: (id) => (String(id) === "188" ? inner : null),
      getLink: () => ({ origin_id: 188, target_id: 188, target_slot: 0 }),
    },
  };
  parent.inputs[0].link = 99;

  const [entry] = makeWitnesses(parent);
  assert.equal(entry.widget, "quality_prompt");
  assert.equal(entry.parent_rail, undefined);
  assert.match(entry.error, /externally linked|not authoritative/i);
});

test("WIRING: production witness re-evaluates parent authority after a promotion relink", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const helperStart = src.indexOf("function resolveSubgraphLink(");
  const helperEnd = src.indexOf("\nfunction findPromotedHostInput", helperStart);
  const makeWitnesses = new Function(
    "resolvePromotedInnerTarget",
    "followPromotionToConcrete",
    "MAX_PROMOTION_CHAIN_DEPTH",
    "promotedInputAliases",
    `${src.slice(helperStart, helperEnd)}; return promotedTerminalWitnesses;`,
  )(
    resolvePromotedInnerTarget,
    followPromotionToConcrete,
    MAX_PROMOTION_CHAIN_DEPTH,
    promotedInputAliases,
  );
  const rail = { name: "quality_prompt", value: "old" };
  const input = {
    name: "quality_alias",
    widget: rail,
    _widget: rail,
    _subgraphSlot: { name: "quality_alias", linkIds: [1] },
  };
  const inner = {
    id: 188,
    type: "PrimitiveStringMultiline",
    inputs: [{ name: "quality_prompt", widget: { name: "quality_prompt" } }],
    widgets: [{ name: "quality_prompt", value: "old" }],
  };
  const parent = {
    id: 78,
    widgets: [rail],
    inputs: [input],
    subgraph: {
      _nodes: [inner],
      getNodeById: (id) => (String(id) === "188" ? inner : null),
      getLink: () => ({ origin_id: 188, target_id: 188, target_slot: 0 }),
    },
  };

  const [before] = makeWitnesses(parent);
  assert.equal(before.parent_rail.authoritative, true);
  input.link = 100;
  const [after] = makeWitnesses(parent);
  assert.equal(after.parent_rail, undefined);
  assert.match(after.error, /externally linked|not authoritative/i);
});

test("WIRING: production witness refuses to publish [] for an unenumerable proxyWidgets relation", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const helperStart = src.indexOf("function resolveSubgraphLink(");
  const helperEnd = src.indexOf("\nfunction findPromotedHostInput", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "production promotion helper range must remain extractable");
  const makeWitnesses = new Function(
    "resolvePromotedInnerTarget",
    "followPromotionToConcrete",
    "MAX_PROMOTION_CHAIN_DEPTH",
    "promotedInputAliases",
    `${src.slice(helperStart, helperEnd)}; return promotedTerminalWitnesses;`,
  )(
    resolvePromotedInnerTarget,
    followPromotionToConcrete,
    MAX_PROMOTION_CHAIN_DEPTH,
    promotedInputAliases,
  );

  const entries = makeWitnesses({
    id: 78,
    properties: { proxyWidgets: [[188, "quality_prompt"]] },
    widgets: [],
    inputs: [],
    subgraph: { _nodes: [] },
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].widget, "quality_prompt");
  assert.match(entries[0].error, /proxyWidgets|node\.widgets|_subgraphSlot/i);
});

test("WIRING: production graph_get_subgraph redacts instance provenance", async () => {
  // Execute the module-private handler's source fragment. A source-only assertion
  // would miss a sanitizer applied to the wrong object, while a helper-only test
  // would miss this alternate structured-read path entirely.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  assert.match(src, /import \{ subgraphValueProvenance \} from "\.\/lib\/subgraph-value-provenance\.js";/);
  assert.match(src, /const safeProvenance = redactWidgetValue\("", subgraphValueProvenance\(node\)\);/);
  assert.match(src, /\.\.\.safeProvenance,/);

  const start = src.indexOf("graph_get_subgraph({ node_id }) {");
  const end = src.indexOf("async graph_add_node(", start);
  assert.ok(start >= 0 && end > start, "graph_get_subgraph handler must remain extractable");
  const method = src.slice(start, end).replace(/,\s*$/, "");
  const graph = {};
  const sharedParentValue = { value: "SECRET" };
  const parent = {
    id: 173,
    title: "Reusable secret node",
    widgets: [
      { name: "ordinarySettings", value: sharedParentValue },
      { name: "apiKey", value: sharedParentValue },
      {
        name: "instanceSettings",
        value: {
          visible: "keep this setting",
          api_key: "nested-api-key",
          values: [{ privateKey: "nested-private-key" }, "Bearer abcdefghijklmnop"],
        },
      },
      { name: "prompt", value: "visible prompt" },
    ],
    subgraph: { _nodes: [{ id: 166, mode: 4, inputs: [], outputs: [] }] },
  };
  const getSubgraph = new Function(
    "getGraphCtx",
    "resolveNode",
    "describeActiveGraph",
    "subgraphValueProvenance",
    "redactWidgetValue",
    "graphViewIdentityFor",
    "MAX_STATE_NODES",
    "fixedCapNote",
    "summarizeNode",
    "promotedTerminalWitnesses",
    `return ({${method}}).graph_get_subgraph;`,
  )(
    () => ({ graph }),
    () => parent,
    () => ({ graph: "root" }),
    subgraphValueProvenance,
    redactWidgetValue,
    graphViewIdentityFor,
    50,
    () => "truncation note",
    (node) => ({ id: node.id, mode: node.mode, inputs: node.inputs, outputs: node.outputs }),
    () => [],
  );

  const out = getSubgraph({ node_id: 173 });
  assert.deepEqual(out.subgraph_of, {
    node_id: 173,
    title: "Reusable secret node",
    graph_identity: graphViewIdentityFor(parent.subgraph),
  });
  assert.deepEqual(out.instance_widgets, {
    ordinarySettings: { value: "SECRET" },
    apiKey: { value: REDACTED_WIDGET_VALUE },
    instanceSettings: {
      visible: "keep this setting",
      api_key: REDACTED_WIDGET_VALUE,
      values: [{ privateKey: REDACTED_WIDGET_VALUE }, REDACTED_WIDGET_VALUE],
    },
    prompt: "visible prompt",
  });
  assert.notStrictEqual(
    out.instance_widgets.ordinarySettings,
    out.instance_widgets.apiKey,
    "production provenance must split ordinary and sensitive alias contexts",
  );
  assert.deepEqual(out.nodes, [{ id: 166, mode: 4, inputs: [], outputs: [] }]);
  assert.ok(!JSON.stringify(out).includes("nested-private-key"));
});
