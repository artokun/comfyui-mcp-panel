// #700: panel_add_node("LoadImage") failed with
//   Required custom widget "upload" did not initialize for "LoadImage".
//   Reload ComfyUI so its node extension can register, then retry.
//
// WHAT THIS FILE PINS, and why it is built the way it is.
//
// The report suspected panel_refresh_nodes: that re-registering node defs mints new
// LiteGraph classes without re-applying the extension hooks, so every node created
// afterwards permanently lacks the extension's `upload` widget (already-instantiated
// nodes keep their old constructor, which is why copy/paste still worked). The reporter
// explicitly flagged that as UNPROVEN.
//
// It is DISPROVEN here. The `upload` widget is not missing at all. ComfyUI's own
// Comfy.UploadImage extension does two things (verified against the shipped
// comfyui_frontend_package bundle, `useImageUploadWidget`):
//
//   1. beforeRegisterNodeDef INJECTS a required input the backend never declares:
//        required.upload = ["IMAGEUPLOAD", { ...imageConfig, imageInputName }]
//   2. the IMAGEUPLOAD constructor materializes it as
//        node.addWidget("button", "upload", "image", cb, { serialize: false, canvasOnly: true })
//
// So a healthy, fully-materialized LoadImage ALWAYS carries an `upload` widget whose
// options.serialize === false — and missingRequiredWidgetMaterializations treats a
// non-serializing widget for a required input as "did not materialize" (correctly: a
// canvas-only control cannot carry a required prompt value). Scanning the FRONTEND
// nodeData therefore reports `upload` every single time, with no refresh involved.
//
// The fix for that is already on main (#620/#626): the guards scan the FRESH backend
// /object_info def, which has no `upload`. What is NOT fixed, and is the live defect
// this file drives, is that graph_add_node reads that fresh def by REFERENCE out of the
// same map it hands to app.registerNodesFromDefs — and registerNodesFromDefs passes each
// def straight to beforeRegisterNodeDef, which mutates it IN PLACE. Once the refresh
// branch runs (the class is not yet in the LiteGraph registry: a freshly installed pack,
// or any class registered after page load) the "backend truth" the guard consults has
// grown a frontend-injected `upload` input, and #700's error comes back.
import test from "node:test";
import assert from "node:assert/strict";
import { withTimeout } from "../../web/js/lib/bounded-step.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  applyCurrentDefWidgetValues,
  driftedRequiredInputNames,
  missingRequiredWidgetMaterializations,
  registeredSocketTypes,
  unavailableRequiredWidgetMessage,
  unavailableRequiredWidgetReport,
} from "../../web/js/lib/node-widget-materialization.js";
import { assertAddNodeResolvableRefreshing } from "../../web/js/lib/node-resolve.js";
import {
  classifyUnmaterializedWidget,
  describeUnmaterializedRequiredWidgets,
  snapshotBackendDef,
  WIDGET_ABSENT,
  WIDGET_NON_SERIALIZING,
} from "../../web/js/lib/add-node-widget-guard.js";
// #767 — graph_add_node now consults ONE node type instead of re-downloading the
// whole schema. Both are free identifiers inside the extracted body, so they have
// to be injected like every other dependency; without them the body throws a
// ReferenceError that the resolver catches and reports as "object_info is
// unavailable", which is how this harness caught the omission.
import { isRegisteredNodeType } from "../../web/js/lib/node-resolve.js";
import { fetchSingleNodeInfo } from "../../web/js/lib/single-node-def.js";

// #1180 — READ from the panel, never restated here. Shared, because this block existed
// verbatim in both widen harnesses, and the whole point of reading a constant instead of
// copying it is that one copy cannot drift from another.
import {
  CUSTOM_WIDGET_REGISTRATION_TIMEOUT_MS,
  NODE_DEFS_FETCH_TIMEOUT_MS,
  NODE_DEFS_NO_ANSWER,
  PANEL_SRC as widenSrcForConsts,
  WIDEN_SOCKET_PROOF_TIMEOUT_MS,
  monotonicNow,
  // #1192 — the command-budget bindings graph_add_node now names. Collected in one place
  // because three harnesses rebuild that executor and would otherwise each need their own
  // copy, which is how a harness acquires a stale one.
  addNodeCommandBudgetDeps,
} from "./_panel-constants.mjs";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8");

// #1180 — the SHIPPED bounded fetch, extracted rather than re-implemented. A hand-written
// copy can drift from the real one, and then these tests prove nothing about what ships —
// the same extraction technique this file already uses for the executor itself.
const boundedMatch = panelSrc.match(/\nasync function boundedGetNodeDefs\([\s\S]*?\n\}/);
assert.ok(boundedMatch, "could not locate boundedGetNodeDefs in panel source");

const addNodeMatch = panelSrc.match(
  /\n {2}async graph_add_node\(\{ class_type, pos, title \}\) \{[\s\S]*?\n {2}\},/,
);
assert.ok(addNodeMatch, "could not locate graph_add_node in panel source");

const awaitWidgetsMatch = panelSrc.match(
  /\nasync function awaitRequiredCustomWidgetRegistration\([\s\S]*?\n\}/,
);
assert.ok(awaitWidgetsMatch, "could not locate awaitRequiredCustomWidgetRegistration");

const placementMatch = panelSrc.match(/\nfunction placementFor\(graph, pos\) \{[\s\S]*?\n\}/);
assert.ok(placementMatch, "could not locate placementFor");

// ---------------------------------------------------------------------------
// A ComfyUI double faithful to the parts that decide this bug.
// ---------------------------------------------------------------------------

/** ComfyUI's Comfy.UploadImage beforeRegisterNodeDef, transcribed from the shipped
 *  frontend bundle. Note that it mutates the nodeData object it is HANDED. */
function comfyUploadImageBeforeRegisterNodeDef(_nodeType, nodeData) {
  const required = nodeData?.input?.required;
  if (!required) return;
  const found = Object.entries(required).find(
    ([, spec]) => Array.isArray(spec) && spec[1] && spec[1].image_upload === true,
  );
  if (!found) return;
  const [imageInputName, spec] = found;
  required.upload = ["IMAGEUPLOAD", { ...spec[1], imageInputName }];
}

/** The live /object_info payload. A fresh object every call, exactly like a real fetch. */
function backendObjectInfo() {
  return {
    LoadImage: {
      name: "LoadImage",
      input: { required: { image: [["a.png", "b.png"], { image_upload: true }] } },
      output: ["IMAGE", "MASK"],
    },
    PreviewImage: {
      name: "PreviewImage",
      input: { required: { images: ["IMAGE", {}] } },
      output: [],
    },
  };
}

function makeComfy({ preRegistered = ["LoadImage", "PreviewImage"] } = {}) {
  const widgets = {
    COMBO(node, name, spec) {
      return { widget: node.addWidget("combo", name, spec[0][0], null, { values: spec[0] }) };
    },
    IMAGEUPLOAD(node, name) {
      // The shipped constructor: a canvas-only button paired with the real value widget.
      const widget = node.addWidget("button", name, "image", () => {}, {
        serialize: false,
        canvasOnly: true,
      });
      widget.label = "choose file to upload";
      return { widget };
    },
  };

  const registry = {};
  let nextId = 1;

  const LG = {
    registered_node_types: registry,
    createNode(type) {
      const cls = registry[type];
      if (!cls) return null;
      const node = {
        id: nextId++,
        type,
        constructor: cls,
        pos: [0, 0],
        size: [210, 100],
        widgets: [],
        inputs: [],
        outputs: [],
        addWidget(kind, name, value, callback, options) {
          const widget = { type: kind, name, value, callback, options: options ?? {} };
          node.widgets.push(widget);
          return widget;
        },
      };
      for (const [name, spec] of Object.entries(cls.nodeData?.input?.required ?? {})) {
        const declared = Array.isArray(spec) ? spec[0] : null;
        if (Array.isArray(declared)) widgets.COMBO(node, name, spec);
        else if (typeof widgets[declared] === "function") widgets[declared](node, name, spec);
        else node.inputs.push({ name, type: declared });
      }
      return node;
    },
  };

  const app = {
    widgets,
    async registerNodesFromDefs(defs) {
      for (const [type, nodeData] of Object.entries(defs ?? {})) {
        const cls = function ComfyNode() {};
        // ComfyUI hands registerNodeDef the CALLER's def object and lets the extension
        // hooks mutate it before wrapping it as the class's nodeData.
        comfyUploadImageBeforeRegisterNodeDef(cls, nodeData);
        cls.nodeData = nodeData;
        cls.comfyClass = type;
        registry[type] = cls;
      }
    },
  };

  // Page load: whatever the tab already registered.
  const boot = backendObjectInfo();
  const bootDefs = Object.fromEntries(
    Object.entries(boot).filter(([type]) => preRegistered.includes(type)),
  );
  void app.registerNodesFromDefs(bootDefs);

  const graph = {
    _nodes: [],
    add(node) {
      graph._nodes.push(node);
    },
    beforeChange() {},
    afterChange() {},
    setDirtyCanvas() {},
  };

  return { app, LG, graph, registry };
}

/** Build the SHIPPED graph_add_node with its collaborators injected. */
function realGraphAddNode(comfy, overrides = {}) {
  const { app, LG, graph } = comfy;
  const context = { app, LG, graph, rootGraph: graph, workflow: { uuid: "wf" } };

  const deps = {
    captureGraphMutationContext: () => context,
    revalidateGraphMutationContext: () => context,
    awaitObjectInfoHistorySeed: async () => {},
    recordObjectInfoTypes: (defs) => defs,
    objectInfoHistory: { wasTypeEverDefined: () => false },
    // #1223 — module state in the real file; this rebuilt scope has to name it or the
    // executor throws ReferenceError. See the #700 tests below for why THIS harness cares:
    // the payload the add files is the same map registerNodesFromDefs mutates in place.
    objectInfoSnapshot: { record: () => true, clear: () => {} },
    backendReconnectEpoch: 0,
    api: { getNodeDefs: async () => backendObjectInfo() },
    refreshComfyNodeDefs: async (defs) => app.registerNodesFromDefs(defs ?? backendObjectInfo()),
    summarizeNode: (node) => ({
      id: node.id,
      type: node.type,
      widgets: node.widgets.map((w) => w.name),
    }),
    assertAddNodeResolvableRefreshing,
    driftedRequiredInputNames,
    registeredSocketTypes,
    missingRequiredWidgetMaterializations,
    applyCurrentDefWidgetValues,
    unavailableRequiredWidgetReport,
    unavailableRequiredWidgetMessage,
    snapshotBackendDef,
    isRegisteredNodeType,
    fetchSingleNodeInfo,
    describeUnmaterializedRequiredWidgets,
    // #1180 — the panel's bounded api.getNodeDefs() and its sentinel. Module-scope in the
    // real file; this harness rebuilds the executor in a synthetic scope, so they are
    // injected. Real withTimeout, so the bound is exercised rather than stubbed away.
    NODE_DEFS_NO_ANSWER,
    WIDEN_SOCKET_PROOF_TIMEOUT_MS,
    monotonicNow,
    NODE_DEFS_FETCH_TIMEOUT_MS,
    withTimeout,
    // #1192 — same rule, one issue later: the command budget and the constants its steps
    // draw from are module scope in the real file, so this scope has to name them all.
    ...addNodeCommandBudgetDeps(),
    ...overrides,
  };
  // Resolved from `deps` at CALL time: tests pass their own `api` through overrides, and a
  // helper closed over the default would call the wrong one.
  if (!("boundedGetNodeDefs" in deps)) {
    // Built from panel source, with this harness's api resolved at CALL time because
    // tests pass their own through overrides.
    const build = new Function(
      "api",
      "withTimeout",
      "NODE_DEFS_NO_ANSWER",
      "NODE_DEFS_FETCH_TIMEOUT_MS",
      `${boundedMatch[0]}
       return boundedGetNodeDefs;`,
    );
    deps.boundedGetNodeDefs = (timeoutMs) =>
      build(deps.api, withTimeout, NODE_DEFS_NO_ANSWER, NODE_DEFS_FETCH_TIMEOUT_MS)(timeoutMs);
  }

  const names = Object.keys(deps);
  const factory = new Function(
    ...names,
    `${awaitWidgetsMatch[0]}
     ${placementMatch[0]}
     const CUSTOM_WIDGET_REGISTRATION_TIMEOUT_MS = 200;
     const CUSTOM_WIDGET_REGISTRATION_POLL_MS = 5;
     const executors = {${addNodeMatch[0]}};
     return executors.graph_add_node;`,
  );
  return factory(...names.map((n) => deps[n]));
}

// ---------------------------------------------------------------------------
// 1. Disproof of the refresh hypothesis + proof of the real mechanism.
// ---------------------------------------------------------------------------

test("#700 mechanism: a HEALTHY LoadImage always trips the frontend-nodeData scan, no refresh involved", () => {
  // No panel_refresh_nodes anywhere in this test — just page-load registration.
  const comfy = makeComfy();
  const node = comfy.LG.createNode("LoadImage");

  // The node is perfectly healthy: it has BOTH widgets, the upload button included.
  assert.deepEqual(
    node.widgets.map((w) => w.name),
    ["image", "upload"],
  );
  const upload = node.widgets.find((w) => w.name === "upload");
  assert.equal(upload.options.serialize, false, "ComfyUI builds the upload button canvas-only");

  // Yet the pre-#620 two-argument call — which scans the FRONTEND nodeData, where
  // beforeRegisterNodeDef injected `upload` — reports it missing. Deterministically,
  // on a freshly booted tab. That is #700's error, and nothing refreshed anything.
  assert.deepEqual(
    missingRequiredWidgetMaterializations(node, comfy.app.widgets),
    ["upload"],
    "the frontend nodeData alone cannot decide this: it carries an injected canvas-only input",
  );

  // The fresh BACKEND def never declares `upload`, so scanning it clears the guard.
  assert.deepEqual(
    missingRequiredWidgetMaterializations(node, comfy.app.widgets, backendObjectInfo().LoadImage),
    [],
  );
});

test("#700 asymmetry: a created LoadImage and a cloned one carry the SAME widgets", () => {
  // The report inferred a class-vs-instance divergence from panel_copy_nodes working.
  // There is none — clone and create produce identical widget sets; only the GUARD
  // differed, because the paste path never runs it.
  const comfy = makeComfy();
  const created = comfy.LG.createNode("LoadImage");
  const cloneSource = comfy.LG.createNode("LoadImage");
  const cloned = { ...cloneSource, widgets: cloneSource.widgets.map((w) => ({ ...w })) };

  assert.deepEqual(
    created.widgets.map((w) => [w.name, w.type, w.options.serialize]),
    cloned.widgets.map((w) => [w.name, w.type, w.options.serialize]),
  );
});

// ---------------------------------------------------------------------------
// 2. The live defect on the shipped add path.
// ---------------------------------------------------------------------------

test("#700: add LoadImage on a tab that already registered it (the reported scenario)", async () => {
  const comfy = makeComfy();
  const graph_add_node = realGraphAddNode(comfy);
  const { added } = await graph_add_node({ class_type: "LoadImage" });
  assert.deepEqual(added.widgets, ["image", "upload"]);
});

test("#700: add LoadImage when the class is NOT yet registered — registerNodesFromDefs must not poison the backend def", async () => {
  // A pack installed after page load: the resolver refreshes to register the class,
  // and that refresh hands graph_add_node's own /object_info map to
  // registerNodesFromDefs, whose beforeRegisterNodeDef injects `upload` into it in
  // place. If the guard then reads that same object as "the backend's current truth"
  // it sees a required `upload`, finds only the canvas-only button, and reports #700.
  const comfy = makeComfy({ preRegistered: ["PreviewImage"] });
  const graph_add_node = realGraphAddNode(comfy);
  const { added } = await graph_add_node({ class_type: "LoadImage" });
  assert.deepEqual(added.widgets, ["image", "upload"]);
});

test("#700: the fetched /object_info map really IS mutated by the refresh — the snapshot is what saves the add", async () => {
  // Without this the test above could pass for the wrong reason (a double that simply
  // never pollutes). Hold on to the exact object api.getNodeDefs handed back and show
  // that registerNodesFromDefs grew an `upload` requirement on it — the poison the
  // snapshot is taken to escape.
  const comfy = makeComfy({ preRegistered: ["PreviewImage"] });
  const handedOut = [];
  const graph_add_node = realGraphAddNode(comfy, {
    api: {
      getNodeDefs: async () => {
        const defs = backendObjectInfo();
        handedOut.push(defs);
        return defs;
      },
    },
  });

  await graph_add_node({ class_type: "LoadImage" });

  assert.equal(handedOut.length, 1);
  assert.ok(
    "upload" in handedOut[0].LoadImage.input.required,
    "the fetched def must still be poisoned in place — otherwise this test proves nothing",
  );
});

test("#700: repeated adds after the registering refresh stay clean", async () => {
  const comfy = makeComfy({ preRegistered: ["PreviewImage"] });
  const graph_add_node = realGraphAddNode(comfy);
  await graph_add_node({ class_type: "LoadImage" });
  const { added } = await graph_add_node({ class_type: "LoadImage" });
  assert.deepEqual(added.widgets, ["image", "upload"]);
});

test("a genuinely unmaterialized BACKEND-required widget is still refused", async () => {
  // The guard must keep failing closed: #580's bad prompt is the reason it exists.
  const comfy = makeComfy();
  const brokenDefs = () => ({
    ...backendObjectInfo(),
    BrokenNode: {
      name: "BrokenNode",
      input: { required: { amount: ["INT", { default: 1 }] } },
      output: [],
    },
  });
  const graph_add_node = realGraphAddNode(comfy, {
    api: { getNodeDefs: async () => brokenDefs() },
    refreshComfyNodeDefs: async (defs) => comfy.app.registerNodesFromDefs(defs ?? brokenDefs()),
  });
  // INT has a registered constructor, but this double materializes no INT widget.
  comfy.app.widgets.INT = () => undefined;
  await assert.rejects(
    () => graph_add_node({ class_type: "BrokenNode" }),
    (err) => {
      assert.match(err.message, /Cannot add "BrokenNode"/);
      assert.match(err.message, /required input "amount" was not built onto the node/);
      assert.match(err.message, /Nothing was added\./);
      assert.match(err.message, /Reload the ComfyUI tab/);
      return true;
    },
  );
  assert.equal(comfy.graph._nodes.length, 0, "the refusal must not have added anything");
});

// ---------------------------------------------------------------------------
// 3. The snapshot, in isolation.
// ---------------------------------------------------------------------------

test("snapshotBackendDef survives an in-place rewrite of the map it came from", () => {
  const defs = backendObjectInfo();
  const snapshot = snapshotBackendDef(defs, "LoadImage");

  // Exactly what ComfyUI's beforeRegisterNodeDef does to the def it is handed.
  comfyUploadImageBeforeRegisterNodeDef(function ComfyNode() {}, defs.LoadImage);
  defs.LoadImage.input.required.image[1].image_upload = false;
  defs.LoadImage.input.required.image[0].push("mutated.png");

  assert.deepEqual(Object.keys(snapshot.input.required), ["image"]);
  assert.equal(snapshot.input.required.image[1].image_upload, true);
  assert.deepEqual(snapshot.input.required.image[0], ["a.png", "b.png"]);
});

test("snapshotBackendDef keeps a required input literally named __proto__", () => {
  // JSON.parse hands `__proto__` back as an OWN data property, so /object_info can carry
  // one. A plain `copy[key] = …` would run Object.prototype's setter: the entry vanishes
  // from the snapshot and the guards silently stop checking that required input — a
  // fail-OPEN, the one direction this must never break in (codex gate r1 P1).
  const defs = JSON.parse('{"Odd":{"input":{"required":{"__proto__":["INT",{"default":3}]}}}}');
  const snapshot = snapshotBackendDef(defs, "Odd");

  const required = snapshot.input.required;
  assert.ok(Object.prototype.hasOwnProperty.call(required, "__proto__"));
  assert.deepEqual(Object.keys(required), ["__proto__"]);
  assert.deepEqual(Object.entries(required)[0][1], ["INT", { default: 3 }]);
  assert.equal(Object.getPrototypeOf(required), Object.prototype, "must not be re-parented");

  // …and the guard therefore still sees it as a required input to check.
  assert.deepEqual(
    missingRequiredWidgetMaterializations({ widgets: [] }, { INT: () => {} }, snapshot),
    ["__proto__"],
  );
});

test("snapshotBackendDef reports no def for a type the backend does not define", () => {
  // The frontend-only exemption (Note / Reroute / …). `undefined` is what makes the
  // guards fall back to scanning the registered node data, so it must not become {}.
  assert.equal(snapshotBackendDef(backendObjectInfo(), "MarkdownNote"), undefined);
  assert.equal(snapshotBackendDef(null, "LoadImage"), undefined);
  assert.equal(snapshotBackendDef(backendObjectInfo(), undefined), undefined);
  assert.equal(snapshotBackendDef({ Weird: null }, "Weird"), undefined);
});

// ---------------------------------------------------------------------------
// 4. The refusal message.
// ---------------------------------------------------------------------------

test("#700: the refusal names the condition that held and never claims a registration failure", () => {
  const absentOnly = describeUnmaterializedRequiredWidgets(
    "BrokenNode",
    { widgets: [] },
    ["amount"],
  );
  assert.match(absentOnly, /required input "amount" was not built onto the node/);
  assert.match(absentOnly, /Reload the ComfyUI tab/);

  const nonSerializing = describeUnmaterializedRequiredWidgets(
    "ZipnStyler",
    { widgets: [{ name: "gallery", options: { serialize: false, canvasOnly: true } }] },
    ["gallery"],
  );
  assert.match(nonSerializing, /required input "gallery" is present but does not serialize a value/);
  assert.match(nonSerializing, /not a widget-registration failure/);
  assert.match(nonSerializing, /its pack needs updating/);

  const mixed = describeUnmaterializedRequiredWidgets(
    "HalfBroken",
    { widgets: [{ name: "gallery", options: { serialize: false } }] },
    ["amount", "gallery"],
  );
  assert.match(mixed, /"amount" was not built onto the node/);
  assert.match(mixed, /"gallery" is present but does not serialize a value/);
  assert.match(mixed, /If it still fails/);

  // The claim that misdirected #700 for ~90 tool calls must not survive anywhere.
  for (const message of [absentOnly, nonSerializing, mixed]) {
    assert.doesNotMatch(message, /did not initialize/);
    assert.doesNotMatch(message, /so its node extension can register/);
    assert.match(message, /Nothing was added\./);
  }
});

test("#700: the remedy asserts no mechanism the guard cannot see", () => {
  // codex gate r2 P2. Two drafts named a cause and both were falsifiable:
  //  - "reload so the node's EXTENSION re-runs" is wrong for a core/built-in widget,
  //    which has no node extension behind it; and
  //  - "reloading helps ONLY IF the pack's frontend changed on disk" is wrong for a
  //    constructor that reads a mutable setting, where changing it and reloading works.
  // The only causal claim left is the one the caller proved, and only where it applies.
  const absentOnly = describeUnmaterializedRequiredWidgets("N", { widgets: [] }, ["amount"]);
  const present = describeUnmaterializedRequiredWidgets(
    "N",
    { widgets: [{ name: "amount", options: { serialize: false } }] },
    ["amount"],
  );

  for (const message of [absentOnly, present]) {
    assert.doesNotMatch(message, /extension re-runs/);
    assert.doesNotMatch(message, /on disk/);
    assert.doesNotMatch(message, /only if/i);
    assert.match(message, /Reload the ComfyUI tab so this node type is registered again/);
  }
  // The registration claim is made ONLY where the widget was observed on the node.
  assert.doesNotMatch(absentOnly, /not a widget-registration failure/);
  assert.match(present, /not a widget-registration failure/);
});

test("#700: the refusal describes only the flag the guard actually reads", () => {
  // The guard's condition is `widget.options?.serialize === false` — it never consults
  // `canvasOnly`. A widget carrying serialize:false WITHOUT canvasOnly is a reachable
  // refusal, so the message must not assert a canvas-only state it did not observe
  // (codex gate r1 P2).
  const message = describeUnmaterializedRequiredWidgets(
    "SomePack",
    { widgets: [{ name: "gallery", options: { serialize: false } }] },
    ["gallery"],
  );
  assert.match(message, /does not serialize a value \(serialize:false\)/);
  assert.doesNotMatch(message, /canvas-only/);
  assert.doesNotMatch(message, /canvasOnly/);
});

test("#700: the refusal pluralizes without lying about how many inputs it saw", () => {
  const two = describeUnmaterializedRequiredWidgets("N", { widgets: [] }, ["a", "b"]);
  assert.match(two, /required inputs "a", "b" were not built onto the node/);
  assert.match(two, /constructor for their type is registered/);

  const twoPresent = describeUnmaterializedRequiredWidgets(
    "N",
    { widgets: [{ name: "a" }, { name: "b" }] },
    ["a", "b"],
  );
  assert.match(twoPresent, /required inputs "a", "b" are present but do not serialize a value/);
  assert.match(twoPresent, /would omit them/);
});

test("classifyUnmaterializedWidget distinguishes the two faults", () => {
  const node = { widgets: [{ name: "upload", options: { serialize: false } }] };
  assert.equal(classifyUnmaterializedWidget(node, "upload"), WIDGET_NON_SERIALIZING);
  assert.equal(classifyUnmaterializedWidget(node, "image"), WIDGET_ABSENT);
  assert.equal(classifyUnmaterializedWidget(undefined, "image"), WIDGET_ABSENT);
});

// ---------------------------------------------------------------------------
// #767 — the fast path: verify ONE node type, not the whole schema.
// ---------------------------------------------------------------------------

test("#767 an ALREADY-REGISTERED type is verified with one class, not the whole schema", async () => {
  // The reported failure: ~10 parallel adds on an 88-node workflow, each pulling
  // the full /object_info (5.4 MB on a 63-pack install), serialising behind the
  // coalescer and blowing the 30 s deadline — after which the adds landed anyway
  // and left ghosts. LoadImage is already registered here, which is the shape of
  // every add in that report.
  const comfy = makeComfy();
  let fullFetches = 0;
  const routes = [];
  const addNode = realGraphAddNode(comfy, {
    api: {
      getNodeDefs: async () => {
        fullFetches++;
        return backendObjectInfo();
      },
      fetchApi: async (route) => {
        routes.push(route);
        return { status: 200, json: async () => ({ LoadImage: backendObjectInfo().LoadImage }) };
      },
    },
  });

  const res = await addNode({ class_type: "LoadImage", pos: [10, 10] });
  assert.deepEqual(res.added.widgets, ["image", "upload"], "the add still succeeds, fully");
  assert.deepEqual(routes, ["/object_info/LoadImage"], "it asked about exactly one class");
  assert.equal(fullFetches, 0, "and never pulled the whole schema");
});

test("#767 ANY doubt on the single-class route falls back to the full fetch", async () => {
  // The safety property this whole change rests on: the fast path may only
  // CONFIRM. A 404 (an older ComfyUI without the route) must not become a verdict
  // about the node type — it must reach exactly the code that runs today.
  const comfy = makeComfy();
  let fullFetches = 0;
  const addNode = realGraphAddNode(comfy, {
    api: {
      getNodeDefs: async () => {
        fullFetches++;
        return backendObjectInfo();
      },
      fetchApi: async () => ({ status: 404, json: async () => ({}) }),
    },
  });

  const res = await addNode({ class_type: "LoadImage", pos: [10, 10] });
  assert.deepEqual(res.added.widgets, ["image", "upload"], "the add still succeeds, via the unchanged path");
  assert.equal(fullFetches, 1, "the full fetch is the fallback and it ran");
});

test("#767 an UNREGISTERED type never takes the fast path", async () => {
  // Not about speed. The resolver hands freshDefs to refreshComfyNodeDefs() when a
  // type still needs registering, and a single-class payload reaching a
  // whole-schema refresh could deregister everything else. The gate makes that
  // branch unreachable; this proves the gate holds.
  const comfy = makeComfy();
  delete comfy.LG.registered_node_types.LoadImage;
  let fullFetches = 0;
  let singleFetches = 0;
  const addNode = realGraphAddNode(comfy, {
    api: {
      getNodeDefs: async () => {
        fullFetches++;
        return backendObjectInfo();
      },
      fetchApi: async () => {
        singleFetches++;
        return { status: 200, json: async () => ({ LoadImage: backendObjectInfo().LoadImage }) };
      },
    },
  });

  await addNode({ class_type: "LoadImage", pos: [10, 10] });
  assert.equal(singleFetches, 0, "an unregistered type must not use the single-class route");
  assert.equal(fullFetches, 1, "it takes the full-schema path, which the refresh needs");
});
