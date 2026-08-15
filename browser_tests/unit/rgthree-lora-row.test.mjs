/**
 * #757 — `panel_set_widget` could not CREATE an rgthree Power Lora Loader row.
 *
 * The rows exist only after the user clicks "➕ Add Lora", a DOM-only control an agent
 * cannot activate, so every write to `lora_1` on a fresh node was refused for a widget no
 * tool could bring into existence.
 *
 * The load-bearing constraint is what this must NOT become. The panel deliberately refuses
 * to auto-press a pressable control, because a generic "press this node's button" rule
 * would mutate the graph on an ordinary TYPO — the overwhelmingly common reason a widget
 * name misses. Most of these tests exist to pin that the route cannot be reached by
 * anything but the real case.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  isRgthreeLoraRowCreation,
  createRgthreeLoraRow,
  POWER_LORA_LOADER_TYPE,
} from "../../web/js/lib/rgthree-lora-row.js";

const SLOT = { on: true, lora: "x.safetensors", strength: 0.5, strengthTwo: null };

/**
 * A Power Lora Loader as it looks fresh from panel_add_node: no rows yet.
 *
 * Modelled on the pack's SHIPPED source (`rgthree-comfy/web/comfyui/power_lora_loader.js`),
 * which increments `this.loraWidgetsCounter` and only then derives the row name from it: the
 * increment happens first and is never undone by removing the row. `nextRow` says which row
 * the next mint produces; the counter itself therefore starts one BELOW it.
 *
 * `trackCounter: false` stands in for a pack build that keeps no counter we can read.
 */
function loader({ nextRow = 1, addNew = true, widgets = null, trackCounter = true } = {}) {
  const node = {
    id: 153,
    type: POWER_LORA_LOADER_TYPE,
    widgets: widgets ?? [
      { name: "divider" },
      { name: "PowerLoraLoaderHeaderWidget" },
      { name: "divider" },
      { name: "➕ Add Lora" },
    ],
    removeWidget(w) {
      const i = node.widgets.indexOf(w);
      if (i >= 0) node.widgets.splice(i, 1);
    },
  };
  let shadow = nextRow - 1; // used when the node exposes no readable counter
  if (trackCounter) node.loraWidgetsCounter = nextRow - 1;
  if (addNew) {
    // rgthree's real behaviour: a MONOTONIC counter, so names are not positional.
    node.addNewLoraWidget = () => {
      let n;
      if (trackCounter) n = ++node.loraWidgetsCounter;
      else n = ++shadow;
      node.widgets.push({ name: `lora_${n}`, value: { on: true, lora: null, strength: 1, strengthTwo: null } });
    };
  }
  return node;
}

// ---------------------------------------------------------------------------
// The classifier — three independent facts, all required
// ---------------------------------------------------------------------------

test("#757 the reported case classifies: right type, lora_N name, slot-shaped value", () => {
  assert.equal(isRgthreeLoraRowCreation(loader(), "lora_1", SLOT), true);
});

test("#757 a TYPO does not reach the creation route", () => {
  // The whole reason the panel refuses to auto-press a button. `strenght` or `lora1` or
  // `seed` must all get the ordinary refusal (and its pressable hint), never a new row.
  for (const name of ["lora1", "loras_1", "lora_", "seed", "strenght", "LORA_1", ""]) {
    assert.equal(isRgthreeLoraRowCreation(loader(), name, SLOT), false, `name ${JSON.stringify(name)}`);
  }
});

test("#757 another node type never reaches it, even with a lora_N name and a slot value", () => {
  const other = { ...loader(), type: "LoraLoader" };
  assert.equal(isRgthreeLoraRowCreation(other, "lora_1", SLOT), false);
  const noType = { ...loader(), type: undefined, comfyClass: undefined };
  assert.equal(isRgthreeLoraRowCreation(noType, "lora_1", SLOT), false);
});

test("#757 a value that is not a lora slot never reaches it", () => {
  // A slot is minted to receive a row. Growing the node for a value the writer would then
  // refuse leaves a stray row behind and reports a failure — worse than refusing up front.
  for (const value of [null, undefined, 5, "x.safetensors", [], { on: true }, { on: true, lora: "a", strength: 1, extra: 1 }]) {
    assert.equal(isRgthreeLoraRowCreation(loader(), "lora_1", value), false, `value ${JSON.stringify(value)}`);
  }
});

// ---------------------------------------------------------------------------
// The shape the TOOL sends — a JSON string, not an object
// ---------------------------------------------------------------------------
//
// This is the defect that made the whole route dead code, and the reason it survived the
// first round of tests: `panel_set_widget` carries scalar values and `coerceWidgetValue`
// parses the composite at widget-write.js:508-512, well AFTER this classifier runs. Every
// test above hands in an OBJECT — the shape the tests chose, not the shape production uses.
// So each of these drives the STRING form deliberately.

test("#757 the value as the TOOL actually sends it — a JSON string — classifies", () => {
  assert.equal(
    isRgthreeLoraRowCreation(loader(), "lora_1", JSON.stringify(SLOT)),
    true,
    "this is the production shape; with it rejected the feature never fired at all",
  );
});

test("#757 every slot spelling the writer accepts also classifies as a string", () => {
  for (const slot of [
    { on: true, lora: "x.safetensors", strength: 0.5, strengthTwo: null },
    { on: false, lora: "nested/dir/y.safetensors", strength: 1, strengthTwo: 0.8 },
    { on: true, lora: "z.safetensors", strength: 0 },
  ]) {
    const asString = JSON.stringify(slot);
    assert.equal(
      isRgthreeLoraRowCreation(loader(), "lora_1", asString),
      isRgthreeLoraRowCreation(loader(), "lora_1", slot),
      `the string and object forms must agree for ${asString}`,
    );
    assert.equal(isRgthreeLoraRowCreation(loader(), "lora_1", asString), true, asString);
  }
});

test("#757 parsing does not WIDEN what counts as a slot", () => {
  // The string form is normalized, not trusted. Anything whose PARSE is not a slot is still
  // not a creation request — otherwise "any JSON string" would become a fourth way in, and
  // the typo guard is only as strong as its narrowest fact.
  for (const value of [
    "not json at all",
    "",
    "null",
    "5",
    '"x.safetensors"',
    "[]",
    '{"on":true}',
    '{"on":true,"lora":"a","strength":1,"extra":1}',
    '{"on":true,"lora":"a","strength":1,"strengthTwo":null,',
  ]) {
    assert.equal(isRgthreeLoraRowCreation(loader(), "lora_1", value), false, `value ${JSON.stringify(value)}`);
  }
});

test("#757 a STRING value does not bypass the other two facts either", () => {
  const asString = JSON.stringify(SLOT);
  assert.equal(isRgthreeLoraRowCreation({ ...loader(), type: "LoraLoader" }, "lora_1", asString), false, "wrong type");
  assert.equal(isRgthreeLoraRowCreation(loader(), "strenght", asString), false, "typo name");
  const existing = loader();
  existing.widgets.push({ name: "lora_1", value: { on: false, lora: null, strength: 1, strengthTwo: null } });
  assert.equal(isRgthreeLoraRowCreation(existing, "lora_1", asString), false, "row already present");
});

test("#757 an EXISTING row is left to the ordinary write path", () => {
  const n = loader();
  n.widgets.push({ name: "lora_1", value: { on: false, lora: null, strength: 1, strengthTwo: null } });
  assert.equal(isRgthreeLoraRowCreation(n, "lora_1", SLOT), false, "minting over it would duplicate the row");
});

test("#757 the classifier is total — a hostile node answers false, never throws", () => {
  const hostile = {
    get type() {
      throw new TypeError("disposed");
    },
  };
  assert.doesNotThrow(() => isRgthreeLoraRowCreation(hostile, "lora_1", SLOT));
  assert.equal(isRgthreeLoraRowCreation(hostile, "lora_1", SLOT), false);
});

// ---------------------------------------------------------------------------
// Creation, and the post-verify that makes a pack-private call safe
// ---------------------------------------------------------------------------

test("#757 the reported case: the row is created and named", () => {
  const n = loader();
  const events = [];
  const r = createRgthreeLoraRow(n, "lora_1", {
    beforeChange: () => events.push("before"),
    afterChange: () => events.push("after"),
    setDirty: () => events.push("dirty"),
  });
  assert.equal(r.created, "lora_1");
  assert.equal(typeof r.remove, "function", "the caller must be able to take the row back out again");
  assert.ok(n.widgets.some((w) => w.name === "lora_1"), "the row now exists for the write that follows");
  assert.deepEqual(events, ["before", "after", "dirty"], "the mutation is bracketed for undo");
});

test("#757 a pack without addNewLoraWidget refuses LOUDLY, and changes nothing", () => {
  // Feature detection, as ltx-director.js does for its own pack-private entry point. A
  // renamed or dropped method must produce an actionable refusal, never a silent no-op.
  const n = loader({ addNew: false });
  const before = n.widgets.length;
  assert.throws(() => createRgthreeLoraRow(n, "lora_1", {}), /does not expose addNewLoraWidget/);
  assert.equal(n.widgets.length, before);
});

test("#757 a call that adds NOTHING is caught — the effect is verified, not the call", () => {
  // The probe that motivated this file found pack callbacks that accept a call and create
  // nothing. Only comparing the widget list catches that.
  const n = loader();
  n.addNewLoraWidget = () => {};
  assert.throws(() => createRgthreeLoraRow(n, "lora_1", {}), /ran but added no widget/);
});

test("#757 a pack method that THROWS is attributed to the pack", () => {
  const n = loader();
  n.addNewLoraWidget = () => {
    throw new Error("rgthree exploded");
  };
  assert.throws(() => createRgthreeLoraRow(n, "lora_1", {}), /rgthree pack's own addNewLoraWidget\(\) threw \(rgthree exploded\)/);
});

test("#757 afterChange still runs when the pack method throws", () => {
  const n = loader();
  n.addNewLoraWidget = () => {
    throw new Error("boom");
  };
  const events = [];
  assert.throws(() =>
    createRgthreeLoraRow(n, "lora_1", {
      beforeChange: () => events.push("before"),
      afterChange: () => events.push("after"),
    }),
  );
  assert.deepEqual(events, ["before", "after"], "an unclosed beforeChange would corrupt the undo stack");
});

test("#757 a MONOTONIC counter: the wrong row is taken back out and the real name is named", () => {
  // rgthree's loraWidgetsCounter only ever increases, so after a row is removed the next
  // created row is NOT the removed name. A refusal that left the stray row behind could not
  // be safely retried.
  const n = loader({ nextRow: 7 });
  const before = n.widgets.length;
  assert.throws(
    () => createRgthreeLoraRow(n, "lora_1", {}),
    /this node's next row is "lora_7", not "lora_1"[\s\S]*has been removed again/,
  );
  assert.equal(n.widgets.length, before, "nothing is left behind");
  assert.ok(!n.widgets.some((w) => w.name === "lora_7"), "including the row it minted");
});

test("#757 the refusal's remedy actually WORKS — the row counter is rewound too", () => {
  // The defect this pins: `addNewLoraWidget` increments the counter BEFORE it names the row,
  // and removing the row does not undo the increment. Rolling back only the widget left a
  // refusal that said `nothing was changed. Set "lora_7" instead` having already moved the
  // next name to lora_8 — so obeying it refused again, one name further along, forever.
  // Measured before it was fixed; this is the assertion that would have caught it.
  const n = loader({ nextRow: 7 });
  let named = null;
  try {
    createRgthreeLoraRow(n, "lora_1", {});
    assert.fail("expected a refusal");
  } catch (err) {
    named = err.message.match(/next row is "(lora_\d+)"/)?.[1];
    assert.match(err.message, /counter was rewound/);
  }
  assert.equal(named, "lora_7");
  assert.equal(n.loraWidgetsCounter, 6, "the increment the refusal undid");
  // Doing exactly what the refusal said must succeed. A remedy that cannot be obeyed is
  // worse than no remedy: it reads as actionable and costs a row name on every attempt.
  assert.equal(createRgthreeLoraRow(n, named, {}).created, "lora_7");
});

test("#757 a call that adds nothing does not silently burn a row name either", () => {
  const n = loader({ nextRow: 4 });
  n.addNewLoraWidget = () => {
    n.loraWidgetsCounter++; // incremented, then whatever appends the row failed
  };
  assert.throws(() => createRgthreeLoraRow(n, "lora_4", {}), /ran but added no widget/);
  assert.equal(n.loraWidgetsCounter, 3, "'nothing was changed' includes the counter");
});

test("#757 a pack with no readable counter is told the truth, not an unusable remedy", () => {
  // Nothing can be rewound here, so `lora_9` really is used up. Promising "set lora_9
  // instead" would be advice that cannot work — name the state instead.
  const n = loader({ nextRow: 9, trackCounter: false });
  assert.throws(
    () => createRgthreeLoraRow(n, "lora_2", {}),
    /next row is "lora_9"[\s\S]*could not be rewound[\s\S]*"lora_9" is now used up/,
  );
  assert.ok(!("loraWidgetsCounter" in n), "no counter was invented on the node");
});

test("#757 the counter is NOT rewound while the stray row is still on the node", () => {
  // Rewinding past a name a surviving row still holds would point the next mint at a
  // duplicate — a worse outcome than the burnt name.
  const n = loader({ nextRow: 5 });
  n.removeWidget = () => {}; // a node that protects its rows
  assert.throws(() => createRgthreeLoraRow(n, "lora_1", {}), /could not be rewound/);
  assert.equal(n.loraWidgetsCounter, 5, "left alone, because lora_5 is still there");
  assert.ok(n.widgets.some((w) => w.name === "lora_5"));
});

test("#757 the stray row is removed even on a node with no removeWidget method", () => {
  const n = loader({ nextRow: 9 });
  delete n.removeWidget;
  const before = n.widgets.length;
  assert.throws(() => createRgthreeLoraRow(n, "lora_2", {}), /next row is "lora_9"/);
  assert.equal(n.widgets.length, before, "the splice fallback still cleans up");
});

test("#757 consecutive creates work: lora_1 then lora_2", () => {
  const n = loader();
  assert.equal(createRgthreeLoraRow(n, "lora_1", {}).created, "lora_1");
  assert.equal(createRgthreeLoraRow(n, "lora_2", {}).created, "lora_2");
  assert.deepEqual(
    n.widgets.map((w) => w.name).filter((x) => x.startsWith("lora_")),
    ["lora_1", "lora_2"],
  );
});

// ---------------------------------------------------------------------------
// `remove` — the undo the caller needs when the write it made room for refuses
// ---------------------------------------------------------------------------

test("#757 remove() takes the created row back out", () => {
  const n = loader();
  const before = n.widgets.map((w) => w.name);
  createRgthreeLoraRow(n, "lora_1", {}).remove();
  assert.deepEqual(n.widgets.map((w) => w.name), before, "the node is back to what it was");
});

test("#757 remove() rewinds the row counter as well as the row", () => {
  // The same trap the mismatch refusal hit: addNewLoraWidget increments BEFORE it names, so
  // dropping only the widget leaves the number spent and the next mint lands further along.
  // A rolled-back write must not cost the node a row name.
  const n = loader({ nextRow: 1 });
  assert.equal(n.loraWidgetsCounter, 0);
  createRgthreeLoraRow(n, "lora_1", {}).remove();
  assert.equal(n.loraWidgetsCounter, 0, "the increment the rollback undid");
  // And the proof that it matters: the next create must be able to mint lora_1 again.
  assert.equal(createRgthreeLoraRow(n, "lora_1", {}).created, "lora_1");
});

test("#757 remove() will not rewind past a row that is still there", () => {
  // Rewinding while the name is still held would point the next mint at a duplicate.
  const n = loader({ nextRow: 3 });
  const made = createRgthreeLoraRow(n, "lora_3", {});
  n.removeWidget = () => {}; // a node that refuses to give the row up
  made.remove();
  assert.equal(n.loraWidgetsCounter, 3, "left alone, because lora_3 survived");
  assert.ok(n.widgets.some((w) => w.name === "lora_3"));
});

test("#757 remove() targets the row BY IDENTITY, not by name", () => {
  // rgthree's configure() re-mints rows from serialized order, so `lora_1` after an undo is
  // not necessarily the widget this call grew. Removing by name would take out a stranger.
  const n = loader();
  const made = createRgthreeLoraRow(n, "lora_1", {});
  const mine = n.widgets.find((w) => w.name === "lora_1");
  n.widgets = n.widgets.filter((w) => w !== mine);
  const impostor = { name: "lora_1", value: { on: true, lora: "someone-elses.safetensors", strength: 1 } };
  n.widgets.push(impostor);
  made.remove();
  assert.ok(n.widgets.includes(impostor), "the row that answers to the name now is not ours to remove");
});

test("#757 remove() never throws, whatever the node does", () => {
  const n = loader();
  const made = createRgthreeLoraRow(n, "lora_1", {});
  n.removeWidget = () => {
    throw new Error("disposed");
  };
  assert.doesNotThrow(() => made.remove(), "an undo on an error path must not replace the refusal");
});

// ---------------------------------------------------------------------------
// The panel wiring
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
const PANEL_SRC = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");

test("#757 creation runs AFTER the history seed and BEFORE runSetWidget", () => {
  // The seed is what makes the #458 authorization meaningful, and growing a node is a
  // mutation: it must not happen on a call authorization is about to refuse.
  const seed = PANEL_SRC.indexOf("await awaitObjectInfoHistorySeed();", PANEL_SRC.indexOf("async graph_set_widget("));
  const create = PANEL_SRC.indexOf("createRgthreeLoraRow(node, widget, {");
  const run = PANEL_SRC.indexOf("await runSetWidget(");
  assert.ok(seed > 0 && create > seed, "creation is after the history seed");
  assert.ok(run > create, "…and before the write");
});

test("#757 the uuid fence brackets the creation", () => {
  // The user can switch workflows during the awaits above; a row must never be grown on a
  // canvas the caller did not address (#570/#718).
  const at = PANEL_SRC.indexOf("if (isRgthreeLoraRowCreation(node, widget, value)) {");
  assert.notEqual(at, -1);
  const block = PANEL_SRC.slice(at, PANEL_SRC.indexOf("createRgthreeLoraRow(node, widget, {", at));
  assert.match(block, /assertActiveWorkflowCommandTarget\(\{/, "the fence runs before the mutation");
});

test("#757 the created row is disclosed on its own field, not in `warning`", () => {
  assert.match(PANEL_SRC, /created_widget: createdLoraRow/);
  const sw = PANEL_SRC.slice(PANEL_SRC.indexOf("async graph_set_widget("));
  const body = sw.slice(0, sw.indexOf("async graph_remove_widget("));
  assert.ok(!/warning:[^\n]*createdLoraRow/.test(body), "it must not displace a warning about the write");
});

// ---------------------------------------------------------------------------
// The executor itself — the SHIPPED method, extracted and run
// ---------------------------------------------------------------------------
//
// Source-text assertions cannot answer the two questions review actually asked: does a
// REFUSED write leave the row behind, and is create+assign ONE undo step? Both are about
// what happens at runtime across a rejected await. So the real `graph_set_widget` is pulled
// out of the panel and run against doubles, the way graph-edit-node.test.mjs does — the
// implementation is verified, never a copy of it.

const SET_WIDGET_SRC = (() => {
  const m = PANEL_SRC.match(/ {2}async graph_set_widget\(\{ node_id, widget, value, workflow_uuid \}\) \{[\s\S]*?\n {2}\},/);
  assert.ok(m, "could not locate graph_set_widget in the panel source");
  return m[0];
})();

/** Every free name the extracted method can reach. Injected, so nothing resolves to a global. */
const EXECUTOR_DEPS = [
  "getGraphCtx",
  "resolveNode",
  "classifyLtxTimelineWrite",
  "derivedTimelineRefusal",
  "applyLtxTimelineWrite",
  "classifyPromptRelayTimelineWrite",
  "promptRelayDerivedRefusal",
  "applyPromptRelayTimelineWrite",
  "classifyRgthreeFastGroupsWrite",
  "rgthreeFastGroupsRefusal",
  "awaitObjectInfoHistorySeed",
  "isRgthreeLoraRowCreation",
  "createRgthreeLoraRow",
  "assertActiveWorkflowCommandTarget",
  "WORKFLOW_UUID_FIELD",
  "runSetWidget",
  "objectInfoCache",
  "CACHE_OUTCOME",
  "fetchWholeObjectInfo",
  "api",
  "backendReconnectEpoch",
  "objectInfoSnapshot",
  "recordObjectInfoTypes",
  "objectInfoOracleFailureNote",
  "comfyBackendSocketDown",
  "objectInfoHistory",
  "sourceForSubgraphInput",
  "refreshComboOptionsFromDefs",
  "refreshComfyNodeDefs",
  "clearStaleRedFlag",
  "snapshotAuthorizationNote",
];

/**
 * A graph that keeps score the way ComfyUI's ChangeTracker does.
 *
 * Verified against the shipped frontend bundle: `beforeChange(){this.changeCount++}` and
 * `afterChange(){--this.changeCount||this.captureCanvasState()}`, reached from
 * `LGraph.beforeChange` via `canvasAction(c => c.onBeforeChange?.(this))`. So nested pairs
 * collapse into ONE captured state — and an unmatched close drives the count to -1, which is
 * truthy, so the capture never fires and the command vanishes from undo history entirely.
 * That second failure mode is why `afterChange` here throws rather than going negative.
 */
function trackedGraph(node) {
  const g = {
    node,
    changeCount: 0,
    /** One entry per undo step the tracker would record: the widget names at that moment. */
    captures: [],
    log: [],
    beforeChange() {
      g.log.push("before");
      g.changeCount += 1;
    },
    afterChange() {
      g.log.push("after");
      g.changeCount -= 1;
      if (g.changeCount < 0) {
        throw new Error("afterChange() without a matching beforeChange() — the undo entry would be lost");
      }
      if (g.changeCount === 0) g.captures.push(g.node.widgets.map((w) => w.name));
    },
    setDirtyCanvas() {
      g.log.push("dirty");
    },
  };
  return g;
}

/** Stands in for runSetWidget, including the beforeChange/afterChange pair it opens itself. */
function stubRunSetWidget({ fail = null, result = { ok: true } } = {}) {
  const fn = async (n, widgetName, v, opts) => {
    fn.calls.push({ node: n, widget: widgetName, value: v });
    // The real one brackets its write and fires afterChange BEFORE the #240 read-back
    // verification that can still reject — so a refusal arrives with its own pair closed.
    opts.beforeChange?.();
    opts.afterChange?.();
    if (fail) throw fail;
    return result;
  };
  fn.calls = [];
  return fn;
}

function executor(node, overrides = {}) {
  const graph = overrides.graph ?? trackedGraph(node);
  const deps = {
    getGraphCtx: () => ({ app: { canvas: null }, graph, LG: { registered_node_types: {} }, rootGraph: graph }),
    resolveNode: () => node,
    classifyLtxTimelineWrite: () => null,
    classifyPromptRelayTimelineWrite: () => null,
    classifyRgthreeFastGroupsWrite: () => null,
    awaitObjectInfoHistorySeed: async () => {},
    // The REAL classifier and the REAL creator: a double here would let the executor pass
    // against a route that never fires, which is precisely the defect under test.
    isRgthreeLoraRowCreation,
    createRgthreeLoraRow,
    assertActiveWorkflowCommandTarget: () => {},
    WORKFLOW_UUID_FIELD: "workflow_uuid",
    runSetWidget: overrides.runSetWidget ?? stubRunSetWidget(),
    clearStaleRedFlag: () => {},
    objectInfoHistory: { wasTypeEverDefined: () => true },
    ...overrides,
  };
  const factory = new Function(
    ...EXECUTOR_DEPS,
    `const GRAPH_TOOL_EXECUTORS = { ${SET_WIDGET_SRC} }; return GRAPH_TOOL_EXECUTORS.graph_set_widget;`,
  );
  const run = factory(...EXECUTOR_DEPS.map((name) => deps[name]));
  return { run, graph, runSetWidget: deps.runSetWidget };
}

/** The production value shape: a JSON string, not an object. */
const SLOT_JSON = JSON.stringify(SLOT);

test("#757 executor: create + assign is ONE undo step", async () => {
  const node = loader();
  const { run, graph } = executor(node);
  const reply = await run({ node_id: 153, widget: "lora_1", value: SLOT_JSON, workflow_uuid: "u" });
  assert.equal(reply.created_widget, "lora_1", "the structural change is disclosed");
  assert.ok(node.widgets.some((w) => w.name === "lora_1"));
  assert.equal(graph.changeCount, 0, "the transaction is balanced");
  assert.equal(
    graph.captures.length,
    1,
    "two captures would be two Ctrl+Z, the first of which leaves a default row behind",
  );
  assert.ok(graph.captures[0].includes("lora_1"), "and the one undo step covers the created row");
});

test("#757 executor: a REFUSED write takes the row back out", async () => {
  // runSetWidget can still refuse after the row exists — a removed pack, invalid slot fields,
  // a workflow switched mid-await, the #240 read-back rollback. Reporting that over a graph
  // this command had already grown is mutate-then-refuse, and every retry adds another row.
  const node = loader();
  const before = node.widgets.map((w) => w.name);
  const refusal = new Error("value is not a valid option");
  const { run, graph } = executor(node, { runSetWidget: stubRunSetWidget({ fail: refusal }) });
  await assert.rejects(
    () => run({ node_id: 153, widget: "lora_1", value: SLOT_JSON, workflow_uuid: "u" }),
    /value is not a valid option/,
    "the refusal reaches the caller unchanged",
  );
  assert.deepEqual(node.widgets.map((w) => w.name), before, "and the node is back to what it was");
});

test("#757 executor: a refused write rewinds the row counter too", async () => {
  // The counter is the half of the mutation that is easy to miss: addNewLoraWidget increments
  // BEFORE it names the row, so removing the widget alone still spends the name and the next
  // attempt lands on lora_2 — the retry loop the mismatch refusal already had to fix.
  const node = loader({ nextRow: 1 });
  assert.equal(node.loraWidgetsCounter, 0);
  const { run } = executor(node, { runSetWidget: stubRunSetWidget({ fail: new Error("nope") }) });
  await assert.rejects(() => run({ node_id: 153, widget: "lora_1", value: SLOT_JSON, workflow_uuid: "u" }));
  assert.equal(node.loraWidgetsCounter, 0, "the refused attempt cost the node nothing");
  // The retry the caller will actually make must now succeed under the SAME name.
  const second = executor(node);
  const reply = await second.run({ node_id: 153, widget: "lora_1", value: SLOT_JSON, workflow_uuid: "u" });
  assert.equal(reply.created_widget, "lora_1", "retrying the same request works, rather than drifting to lora_2");
});

test("#757 executor: a refused write leaves NO undo step to step through", async () => {
  const node = loader();
  const before = node.widgets.map((w) => w.name);
  const { run, graph } = executor(node, { runSetWidget: stubRunSetWidget({ fail: new Error("nope") }) });
  await assert.rejects(() => run({ node_id: 153, widget: "lora_1", value: SLOT_JSON, workflow_uuid: "u" }));
  assert.equal(graph.changeCount, 0, "the transaction is closed exactly once, even on the error path");
  assert.equal(graph.captures.length, 1, "closed once — not zero times, and not twice");
  assert.deepEqual(
    graph.captures[0],
    before,
    "and the state it captured is the state the command started from, so nothing is recorded",
  );
});

test("#757 executor: an ordinary write opens no transaction of its own", async () => {
  // Everything that is not a creation must be untouched by this route — including the undo
  // bookkeeping, which runSetWidget owns on that path.
  const node = loader();
  node.widgets.push({ name: "lora_1", value: { on: false, lora: null, strength: 1, strengthTwo: null } });
  const { run, graph } = executor(node);
  const reply = await run({ node_id: 153, widget: "lora_1", value: SLOT_JSON, workflow_uuid: "u" });
  assert.equal(reply.created_widget, undefined, "nothing was created, so nothing is disclosed");
  assert.deepEqual(graph.log, ["before", "after"], "exactly one pair, and it is runSetWidget's");
  assert.equal(graph.captures.length, 1);
});

test("#757 executor: creation that REFUSES closes its transaction and never reaches the write", async () => {
  const node = loader({ addNew: false }); // a pack build with no addNewLoraWidget
  const { run, graph, runSetWidget } = executor(node);
  await assert.rejects(
    () => run({ node_id: 153, widget: "lora_1", value: SLOT_JSON, workflow_uuid: "u" }),
    /does not expose addNewLoraWidget/,
  );
  assert.equal(graph.changeCount, 0, "an unclosed transaction would swallow the next command's undo entry");
  assert.equal(graph.captures.length, 1, "closed exactly once");
  assert.equal(runSetWidget.calls.length, 0, "the write is never attempted for a row that does not exist");
});

test("#757 executor: the write is handed the row that was just created", async () => {
  const node = loader();
  const { run, runSetWidget } = executor(node);
  await run({ node_id: 153, widget: "lora_1", value: SLOT_JSON, workflow_uuid: "u" });
  assert.equal(runSetWidget.calls.length, 1);
  assert.equal(runSetWidget.calls[0].widget, "lora_1");
  assert.equal(runSetWidget.calls[0].value, SLOT_JSON, "the value is passed through untouched, string and all");
});
