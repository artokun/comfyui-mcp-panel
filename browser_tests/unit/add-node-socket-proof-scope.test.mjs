// panel#821 — `panel_add_node` refused a node whose input types ARE produced by nodes
// that were already on the canvas:
//
//   Cannot add "SeedVR2VideoUpscaler": 2 required input types had no widget after 5.0s ...
//     - input "dit" (declared type "SEEDVR2_DIT"): no installed node outputs "SEEDVR2_DIT"
//     - input "vae" (declared type "SEEDVR2_VAE"): no installed node outputs "SEEDVR2_VAE"
//
// The premise was demonstrably false: `SeedVR2LoadDiTModel` (id 11) and
// `SeedVR2LoadVAEModel` (id 12) had just been added BY THIS SAME TOOL and output exactly
// those types, and `/object_info` listed all three classes.
//
// WHY IT HAPPENED — a regression from #780 (`7ed9291`), shipped in 0.11.45 (`d2c1aa3`).
//
// `graph_add_node` reuses one `freshDefs` map for two questions of different arity:
//
//   1. #458's authority test — "does the live backend still provide `class_type`?"
//      One entry is enough; `hasOwnProperty` reads the same either way.
//   2. the socket proof — `registeredSocketTypes(freshDefs)`, "which datatypes does SOME
//      installed node declare as an OUTPUT?"  This quantifies over the WHOLE install.
//
// #780 made (1) cheap by fetching `/object_info/<class_type>` when the class is already
// registered — 3 KB instead of 5.4 MB. The same one-entry map then flows into (2), whose
// answer collapses to "the output types of this one class". Every custom link datatype
// produced by a SIBLING node becomes unproven, `linkProven` goes false, and the input
// waits 5 s for a widget constructor that no one will ever register for a link datatype.
//
// It is a SIBLING bug, which is why the reporter's own two loaders adding fine was not a
// contradiction: their required inputs are combos, so they never consulted the proof.
//
// THE HARNESS: these tests run the SHIPPED `graph_add_node` body, extracted from the panel
// source and given injected collaborators — the same technique as
// add-node-upload-widget.test.mjs. A helper-only test could not have caught this: both
// `registeredSocketTypes` and `fetchSingleNodeDef` are individually correct. The defect is
// entirely in which payload the CALL SITE hands to which question.
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
import {
  assertAddNodeResolvableRefreshing,
  isRegisteredNodeType,
} from "../../web/js/lib/node-resolve.js";
import { fetchSingleNodeDef } from "../../web/js/lib/single-node-def.js";
import {
  describeUnmaterializedRequiredWidgets,
  snapshotBackendDef,
} from "../../web/js/lib/add-node-widget-guard.js";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8");

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

// #1180 — the SHIPPED bounded fetch, extracted rather than re-implemented. A harness copy
// can drift from the real one, and then these tests prove nothing about what ships. Same
// extraction technique this file already uses for graph_add_node itself.
const boundedMatch = panelSrc.match(/\nasync function boundedGetNodeDefs\([\s\S]*?\n\}/);
assert.ok(boundedMatch, "could not locate boundedGetNodeDefs in panel source");

// ---------------------------------------------------------------------------
// The reporter's install: seedvr2_videoupscaler, freshly installed, ComfyUI restarted,
// browser tab NOT reloaded (the panel reconnects on its own and registers the new defs).
// ---------------------------------------------------------------------------

/** The live whole-schema /object_info. A fresh object each call, exactly like a fetch. */
function backendObjectInfo() {
  return {
    // The two loaders. Their own required inputs are plain combos, which is why they
    // added successfully and never consulted the socket proof.
    SeedVR2LoadDiTModel: {
      name: "SeedVR2LoadDiTModel",
      input: { required: { model: [["seedvr2_3b.safetensors"], {}] } },
      output: ["SEEDVR2_DIT"],
    },
    SeedVR2LoadVAEModel: {
      name: "SeedVR2LoadVAEModel",
      input: { required: { vae: [["seedvr2_vae.safetensors"], {}] } },
      output: ["SEEDVR2_VAE"],
    },
    // The main node. `dit`/`vae` are link sockets — no config keys at all, so
    // inputDeclaredAsSocket() is satisfied and only the TYPE proof is in question.
    SeedVR2VideoUpscaler: {
      name: "SeedVR2VideoUpscaler",
      input: {
        required: {
          images: ["IMAGE", {}],
          dit: ["SEEDVR2_DIT", {}],
          vae: ["SEEDVR2_VAE", {}],
          seed: ["INT", { default: 100, min: 0, max: 1000 }],
        },
      },
      output: ["IMAGE"],
    },
  };
}

function wildcardDictObjectInfo() {
  return {
    JsonParseNode: {
      name: "JsonParseNode",
      input: { required: {} },
      output: ["*,IMAGE"],
    },
    DictGetNode: {
      name: "DictGetNode",
      input: { required: { py_dict: ["DICT", {}] } },
      output: ["DICT_VALUE"],
    },
  };
}

function videoObjectInfo({ widgetInput = false } = {}) {
  return {
    LoadVideo: {
      name: "LoadVideo",
      input: { required: {} },
      output: ["VIDEO"],
    },
    GetVideoComponents: {
      name: "GetVideoComponents",
      input: {
        required: {
          video: ["VIDEO", widgetInput ? { default: "a-video-value" } : {}],
        },
      },
      output: ["IMAGE", "AUDIO"],
    },
  };
}

function apiForObjectInfo(defs) {
  return {
    // The issue is the bounded whole-schema read not answering. The per-class route still
    // answers, which is the production fast path for an already-registered core class.
    async getNodeDefs() {
      return NODE_DEFS_NO_ANSWER;
    },
    async fetchApi(route) {
      const classType = decodeURIComponent(String(route).replace("/object_info/", ""));
      const body = Object.prototype.hasOwnProperty.call(defs, classType)
        ? { [classType]: defs[classType] }
        : {};
      return { status: 200, json: async () => body };
    },
  };
}

function makeComfy(defs = backendObjectInfo()) {
  const widgets = {
    COMBO(node, name, spec) {
      return { widget: node.addWidget("combo", name, spec[0][0], null, { values: spec[0] }) };
    },
    INT(node, name, spec) {
      return { widget: node.addWidget("number", name, spec[1]?.default ?? 0, null, { ...spec[1] }) };
    },
  };

  const registry = {};
  let nextId = 11; // the reporter's loaders were 11 and 12

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
        cls.nodeData = nodeData;
        cls.comfyClass = type;
        registry[type] = cls;
      }
    },
  };

  // Step 4 of the report: the tab was NOT reloaded, but the panel reconnected and the
  // pack's three classes are registered. That is precisely what arms the #780 fast path.
  void app.registerNodesFromDefs(defs);

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

/** Build the SHIPPED graph_add_node with its collaborators injected. */
function realGraphAddNode(comfy, overrides = {}) {
  const { app, LG, graph } = comfy;
  const context = { app, LG, graph, rootGraph: graph, workflow: { uuid: "wf" } };
  const calls = { single: [], whole: 0 };
  // #1223 — what the add filed into the last-observed-schema snapshot, and with what epoch.
  const snapshotFilings = [];

  const api = {
    // The whole-schema route. Counting it is how these tests prove #780's saving survives.
    async getNodeDefs() {
      calls.whole += 1;
      return backendObjectInfo();
    },
    // ComfyUI's per-class route, faithful to its real shape: absence is `{}` with HTTP 200.
    async fetchApi(route) {
      const cls = decodeURIComponent(String(route).replace("/object_info/", ""));
      calls.single.push(cls);
      const all = backendObjectInfo();
      const body = Object.prototype.hasOwnProperty.call(all, cls) ? { [cls]: all[cls] } : {};
      return { status: 200, json: async () => body };
    },
  };

  const deps = {
    captureGraphMutationContext: () => context,
    revalidateGraphMutationContext: () => context,
    awaitObjectInfoHistorySeed: async () => {},
    recordObjectInfoTypes: (defs) => defs,
    objectInfoHistory: { wasTypeEverDefined: () => false },
    // #1223 — the last-observed-schema snapshot the add path files its WHOLE payload into,
    // and the connection epoch it stamps that with. Both are module scope in the real file,
    // so this rebuilt scope has to name them or the executor throws ReferenceError.
    //
    // A RECORDING spy, not a stub: the add is one of the readers that must feed the
    // fallback, and the epoch it stamps has to be the one at the WHOLE request — not the
    // one before the optional per-class probe that may precede it.
    objectInfoSnapshot: { record: (defs, opts) => (snapshotFilings.push({ defs, opts }), true), clear: () => {} },
    backendReconnectEpoch: 0,
    api,
    refreshComfyNodeDefs: async (defs) => app.registerNodesFromDefs(defs ?? backendObjectInfo()),
    summarizeNode: (node) => ({
      id: node.id,
      type: node.type,
      widgets: node.widgets.map((w) => w.name),
      inputs: node.inputs.map((i) => i.name),
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
    fetchSingleNodeDef,
    describeUnmaterializedRequiredWidgets,
    // #1180 — the panel's bounded `api.getNodeDefs()` and its timeout sentinel. Both are
    // module-scope in the real file; this harness rebuilds `graph_add_node` in a synthetic
    // scope, so every collaborator it names has to be injected here. Real `withTimeout`, so
    // the bound is exercised rather than stubbed away.
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

  // Resolved from `deps` at CALL time, not closed over the `api` above: several tests pass
  // their own `api` through `overrides` to drive the widen (null / {} / non-object), and a
  // helper bound to the default would quietly call the wrong one and report the default's
  // healthy schema instead of the payload under test.
  if (!("boundedGetNodeDefs" in deps)) {
    // The SHIPPED helper, built from panel source. A hand-written copy here would let the
    // real one regress while these tests stayed green — the exact way a harness can make a
    // suite prove nothing. `api` is resolved from `deps` at call time because several tests
    // pass their own through overrides to drive the widen.
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
  return { graph_add_node: factory(...names.map((n) => deps[n])), calls, snapshotFilings };
}

// ---------------------------------------------------------------------------
// 1. The mechanism, in the helper, in isolation.
// ---------------------------------------------------------------------------

test("#821 mechanism: a single-class payload is silent about a SIBLING's output type", () => {
  const whole = backendObjectInfo();
  const single = { SeedVR2VideoUpscaler: whole.SeedVR2VideoUpscaler };

  // The whole schema proves both custom datatypes are link sockets.
  const fromWhole = registeredSocketTypes(whole);
  assert.equal(fromWhole.has("SEEDVR2_DIT"), true);
  assert.equal(fromWhole.has("SEEDVR2_VAE"), true);

  // The single-class payload proves neither — and it is not wrong to, because the
  // question "which types does some installed node output" was never asked of it.
  const fromSingle = registeredSocketTypes(single);
  assert.equal(fromSingle.has("SEEDVR2_DIT"), false);
  assert.equal(fromSingle.has("SEEDVR2_VAE"), false);

  // Fed the narrow proof, the guard produces the report the reporter pasted: both
  // inputs unavailable, and `linkProven: false` — the flag that picks the "no installed
  // node outputs X" half of the message.
  // `INT` is supplied because the core frontend really does register it — omitting it
  // would manufacture a third unavailable type that has nothing to do with this bug.
  const def = whole.SeedVR2VideoUpscaler;
  const constructors = { INT: () => {} };
  const narrow = unavailableRequiredWidgetReport(null, constructors, fromSingle, def);
  assert.deepEqual(
    narrow.map((e) => [e.type, e.linkProven]),
    [
      ["SEEDVR2_DIT", false],
      ["SEEDVR2_VAE", false],
    ],
  );
  assert.match(
    unavailableRequiredWidgetMessage(narrow, "SeedVR2VideoUpscaler", 5000),
    /no installed node outputs "SEEDVR2_DIT"/,
  );

  // Fed the whole schema, there is nothing to report at all.
  assert.deepEqual(unavailableRequiredWidgetReport(null, constructors, fromWhole, def), []);
});

// ---------------------------------------------------------------------------
// 2. The live defect, on the shipped add path. This is the test that matters.
// ---------------------------------------------------------------------------

test("#821: the reported add succeeds — sibling-produced link types are not refused", async () => {
  const comfy = makeComfy();
  const { graph_add_node } = realGraphAddNode(comfy);

  // Steps 5 and 6 of the report: both loaders add cleanly. (They always did.)
  const dit = await graph_add_node({ class_type: "SeedVR2LoadDiTModel" });
  const vae = await graph_add_node({ class_type: "SeedVR2LoadVAEModel" });
  assert.equal(dit.added.type, "SeedVR2LoadDiTModel");
  assert.equal(vae.added.type, "SeedVR2LoadVAEModel");

  // Step 7: the add that failed for the reporter, twice, plus once after a refresh.
  const res = await graph_add_node({ class_type: "SeedVR2VideoUpscaler" });
  assert.equal(res.added.type, "SeedVR2VideoUpscaler");
  // `dit`/`vae` land as SOCKETS, which is the whole point — they are wired, not typed in.
  // `images` is one too (IMAGE is a built-in link datatype); `seed` is the only widget.
  assert.deepEqual(res.added.inputs, ["images", "dit", "vae"]);
  assert.deepEqual(res.added.widgets, ["seed"]);
  assert.equal(comfy.graph._nodes.length, 3);
});

test("#821: refusal is not merely deferred — it does not spend the wait window either", async () => {
  // A link datatype has nothing to wait FOR: no constructor is ever registered for one.
  // Widening AFTER the poll would return the same verdict 5 s later, so the fix widens
  // BEFORE it. With the harness window at 200 ms, a post-wait widen shows up as elapsed
  // time; this pins that it does not happen.
  const comfy = makeComfy();
  const { graph_add_node } = realGraphAddNode(comfy);
  const startedAt = Date.now();
  await graph_add_node({ class_type: "SeedVR2VideoUpscaler" });
  assert.ok(
    Date.now() - startedAt < 150,
    `add should not consume the registration wait window (took ${Date.now() - startedAt}ms)`,
  );
});

test("#1584: a live wildcard producer makes a custom dict input addable", async () => {
  const comfy = makeComfy(wildcardDictObjectInfo());
  const { graph_add_node } = realGraphAddNode(comfy, {
    api: {
      async getNodeDefs() {
        return wildcardDictObjectInfo();
      },
      async fetchApi(route) {
        const classType = decodeURIComponent(String(route).replace("/object_info/", ""));
        const defs = wildcardDictObjectInfo();
        const body = Object.prototype.hasOwnProperty.call(defs, classType)
          ? { [classType]: defs[classType] }
          : {};
        return { status: 200, json: async () => body };
      },
    },
  });

  const producer = await graph_add_node({ class_type: "JsonParseNode" });
  assert.equal(producer.added.type, "JsonParseNode");
  assert.equal(comfy.graph._nodes[0].type, "JsonParseNode", "the wildcard producer is live");

  const consumer = await graph_add_node({ class_type: "DictGetNode" });
  assert.equal(consumer.added.type, "DictGetNode");
  assert.deepEqual(consumer.added.inputs, ["py_dict"]);
  assert.equal(comfy.graph._nodes.length, 2);
});

// ---------------------------------------------------------------------------
// #1589 — a producer already live on the canvas is direct socket evidence even when the
// bounded whole-schema widen cannot answer. The call-site tests below drive the shipped
// graph_add_node body; helper-only coverage would miss the captured live graph callback.
// ---------------------------------------------------------------------------

function addLiveVideoProducer(comfy, outputType) {
  comfy.graph._nodes.push({
    type: "LoadVideo",
    outputs: [{ name: "video", type: outputType }],
    inputs: [],
    widgets: [],
  });
}

function videoAdd(comfy, defs = videoObjectInfo()) {
  return realGraphAddNode(comfy, {
    api: apiForObjectInfo(defs),
    // Keep the regression test bounded without waiting ten seconds for a synthetic
    // half-open whole-schema request.
    boundedGetNodeDefs: async () => NODE_DEFS_NO_ANSWER,
  });
}

test("#1589: GetVideoComponents adds when a live producer exposes VIDEO", async () => {
  const comfy = makeComfy(videoObjectInfo());
  addLiveVideoProducer(comfy, "VIDEO");
  const { graph_add_node } = videoAdd(comfy);

  const result = await graph_add_node({ class_type: "GetVideoComponents" });

  assert.equal(result.added.type, "GetVideoComponents");
  assert.deepEqual(result.added.inputs, ["video"]);
  assert.deepEqual(result.added.widgets, []);
  assert.equal(comfy.graph._nodes.length, 2);
});

test("#1589: no live VIDEO producer still refuses GetVideoComponents", async () => {
  const comfy = makeComfy(videoObjectInfo());
  const { graph_add_node } = videoAdd(comfy);

  await assert.rejects(
    () => graph_add_node({ class_type: "GetVideoComponents" }),
    (err) => {
      assert.match(err.message, /whether any installed node outputs it is UNKNOWN/);
      assert.match(err.message, /VIDEO/);
      return true;
    },
  );
  assert.equal(comfy.graph._nodes.length, 0, "the refused add does not mutate the graph");
});

test("#1589: a live producer of another type does not prove VIDEO", async () => {
  const comfy = makeComfy(videoObjectInfo());
  addLiveVideoProducer(comfy, "IMAGE");
  const { graph_add_node } = videoAdd(comfy);

  await assert.rejects(
    () => graph_add_node({ class_type: "GetVideoComponents" }),
    /VIDEO/,
  );
  assert.equal(comfy.graph._nodes.length, 1, "the unrelated producer remains the only live node");
});

test("#1589: a VIDEO producer does not waive a widget-valued VIDEO input", async () => {
  const defs = videoObjectInfo({ widgetInput: true });
  const comfy = makeComfy(defs);
  addLiveVideoProducer(comfy, "VIDEO");
  const { graph_add_node } = videoAdd(comfy, defs);

  await assert.rejects(
    () => graph_add_node({ class_type: "GetVideoComponents" }),
    /needs a registered widget/,
  );
  assert.equal(comfy.graph._nodes.length, 1, "the widget-shaped refusal does not add a node");
});

// ---------------------------------------------------------------------------
// 3. #780's saving is kept: the whole schema is fetched only when it is NEEDED.
// ---------------------------------------------------------------------------

test("#821: an add that needs no proof never fetches the whole schema (#780 preserved)", async () => {
  const comfy = makeComfy();
  const { graph_add_node, calls } = realGraphAddNode(comfy);

  await graph_add_node({ class_type: "SeedVR2LoadDiTModel" });

  assert.deepEqual(calls.single, ["SeedVR2LoadDiTModel"], "the cheap per-class route is used");
  assert.equal(calls.whole, 0, "a healthy add must not pull the 5.4 MB document");
});

test("#821: a refusal does NOT re-fetch a schema that was already fetched whole", async () => {
  // The other direction of the partiality flag, and the one that is easy to get wrong.
  // When the class is NOT yet registered the fast path is skipped and `getNodeDefs()`
  // already returned the WHOLE schema — so the proof is complete and widening would
  // re-download 5.4 MB to reach the identical verdict. Arming the widen only when the
  // payload was partial is what prevents that; without the flag this fetches twice.
  //
  // (Mutation note: this is the test that kills "widen unconditionally". The healthy-add
  // test cannot, because the widen is invoked lazily and a healthy add never reaches it.)
  const withGhost = () => ({
    ...backendObjectInfo(),
    GhostWidgetNode: {
      name: "GhostWidgetNode",
      input: { required: { setting: ["ACME_NEVER_OUTPUT", { default: 1, min: 0, max: 9 }] } },
      output: ["IMAGE"],
    },
  });
  const comfy = makeComfy(); // GhostWidgetNode is deliberately NOT registered at boot
  const counted = { whole: 0, single: [] };
  const { graph_add_node } = realGraphAddNode(comfy, {
    api: {
      async getNodeDefs() {
        counted.whole += 1;
        return withGhost();
      },
      async fetchApi(route) {
        const cls = decodeURIComponent(String(route).replace("/object_info/", ""));
        counted.single.push(cls);
        const all = withGhost();
        const body = Object.prototype.hasOwnProperty.call(all, cls) ? { [cls]: all[cls] } : {};
        return { status: 200, json: async () => body };
      },
    },
  });

  await assert.rejects(() => graph_add_node({ class_type: "GhostWidgetNode" }));

  assert.deepEqual(counted.single, [], "an unregistered class never takes the per-class route");
  assert.equal(counted.whole, 1, "the whole schema was already in hand — fetching it twice is waste");
});

test("#821: the widen happens once, and only for the add that needs it", async () => {
  const comfy = makeComfy();
  const { graph_add_node, calls } = realGraphAddNode(comfy);

  await graph_add_node({ class_type: "SeedVR2LoadDiTModel" }); // no proof needed
  assert.equal(calls.whole, 0);

  await graph_add_node({ class_type: "SeedVR2VideoUpscaler" }); // needs the proof
  assert.equal(calls.whole, 1, "widened exactly once, not once per unproven input");
});

// ---------------------------------------------------------------------------
// 4. #580 is intact: widening proves a type is a socket, it does not waive the guard.
// ---------------------------------------------------------------------------

test("#821: a type the WHOLE schema also cannot prove is still refused", async () => {
  // A pack whose frontend extension never loads: the node declares a custom required
  // input carrying widget-value config, and nothing outputs that type. Widening changes
  // nothing here, and it must not — this is #580's false-accept, and it stays refused.
  const comfy = makeComfy();
  const withGhost = () => ({
    ...backendObjectInfo(),
    GhostWidgetNode: {
      name: "GhostWidgetNode",
      input: { required: { setting: ["ACME_NEVER_OUTPUT", { default: 1, min: 0, max: 9 }] } },
      output: ["IMAGE"],
    },
  });
  void comfy.app.registerNodesFromDefs(withGhost());

  const { graph_add_node, calls } = realGraphAddNode(comfy, {
    api: {
      async getNodeDefs() {
        calls.whole += 1;
        return withGhost();
      },
      async fetchApi(route) {
        const cls = decodeURIComponent(String(route).replace("/object_info/", ""));
        const all = withGhost();
        const body = Object.prototype.hasOwnProperty.call(all, cls) ? { [cls]: all[cls] } : {};
        return { status: 200, json: async () => body };
      },
    },
  });

  await assert.rejects(
    () => graph_add_node({ class_type: "GhostWidgetNode" }),
    /no installed node outputs "ACME_NEVER_OUTPUT"/,
  );
  assert.equal(comfy.graph._nodes.length, 0, "nothing reached the graph");
});

// A node with TWO custom required socket types: one it produces ITSELF (so the
// single-class payload already proves it) and one produced by a SIBLING (so it does not).
// Only this combination reaches the interesting state — a report that is non-empty, and
// therefore widens, while the narrow proof still holds real evidence worth not losing.
function chainSchema() {
  return {
    ...backendObjectInfo(),
    SeedVR2Chain: {
      name: "SeedVR2Chain",
      input: {
        required: {
          dit: ["SEEDVR2_DIT", {}], // produced by SeedVR2Chain itself
          vae: ["SEEDVR2_VAE", {}], // produced only by SeedVR2LoadVAEModel
        },
      },
      output: ["SEEDVR2_DIT"],
    },
  };
}

/** An api whose per-class route works but whose whole-schema route answers `bad`. */
function apiWithBrokenWholeSchema(bad, schema = chainSchema) {
  return {
    async getNodeDefs() {
      return typeof bad === "function" ? bad() : bad;
    },
    async fetchApi(route) {
      const cls = decodeURIComponent(String(route).replace("/object_info/", ""));
      const all = schema();
      const body = Object.prototype.hasOwnProperty.call(all, cls) ? { [cls]: all[cls] } : {};
      return { status: 200, json: async () => body };
    },
  };
}

for (const [label, bad] of [
  ["returns null", null],
  ["returns an empty object", {}],
  ["returns a non-object", "<html>proxy sign-in</html>"],
  [
    "throws",
    () => {
      throw new Error("backend went away mid-add");
    },
  ],
]) {
  test(`#821 (codex): a widen that ${label} must not WEAKEN the proof it already had`, async () => {
    // The single-class payload proves SEEDVR2_DIT (SeedVR2Chain outputs it). Only
    // SEEDVR2_VAE is unproven, so the node is refused either way — that is not the bug.
    // The bug is the MESSAGE: registeredSocketTypes maps an unusable payload to an EMPTY
    // set, and adopting it would make the refusal also claim nothing outputs SEEDVR2_DIT,
    // which the panel had already disproved moments earlier in the same call.
    const comfy = makeComfy();
    void comfy.app.registerNodesFromDefs(chainSchema());
    const { graph_add_node } = realGraphAddNode(comfy, { api: apiWithBrokenWholeSchema(bad) });

    const err = await graph_add_node({ class_type: "SeedVR2Chain" }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err, "still fails closed — an unproven sibling type is not waived");
    // #1848 — the widen is what would have answered "does anything output SEEDVR2_VAE?",
    // and in this fixture it could not. Refusing is right; asserting ABSENCE is not, and
    // that over-claim is the same one #821 was filed about, left behind on the failure
    // path after #821 fixed the success path.
    assert.doesNotMatch(
      err.message,
      /no installed node outputs "SEEDVR2_VAE"/,
      "a broken whole-schema read is not evidence that nothing produces the type",
    );
    assert.match(err.message, /whether any installed node outputs it is UNKNOWN/);
    assert.match(err.message, /ALSO worth a RETRY/, "the unresolved producer question is surfaced");
    assert.match(err.message, /Reload the ComfyUI browser tab/, "and the proven cause keeps its remedy");
    assert.doesNotMatch(
      err.message,
      /SEEDVR2_DIT/,
      "the proof already in hand must survive a widen that found nothing out",
    );
    assert.equal(comfy.graph._nodes.length, 0);
  });
}

test("#821 (codex): a widen with no getNodeDefs at all is treated as doubt, not as empty", async () => {
  const comfy = makeComfy();
  void comfy.app.registerNodesFromDefs(chainSchema());
  const { graph_add_node } = realGraphAddNode(comfy, {
    api: {
      // No getNodeDefs — an older/reduced api surface.
      async fetchApi(route) {
        const cls = decodeURIComponent(String(route).replace("/object_info/", ""));
        const all = chainSchema();
        const body = Object.prototype.hasOwnProperty.call(all, cls) ? { [cls]: all[cls] } : {};
        return { status: 200, json: async () => body };
      },
    },
  });

  const err = await graph_add_node({ class_type: "SeedVR2Chain" }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err);
  assert.doesNotMatch(err.message, /SEEDVR2_DIT/);
});

test("#821: a failed widen leaves the guard exactly as it fails closed today", async () => {
  // The widen is best-effort. If the whole-schema fetch throws, the original (narrow)
  // proof stands and the add is refused — never admitted on the strength of a fetch
  // that did not happen.
  const comfy = makeComfy();
  const { graph_add_node } = realGraphAddNode(comfy, {
    api: {
      async getNodeDefs() {
        throw new Error("backend went away mid-add");
      },
      async fetchApi(route) {
        const cls = decodeURIComponent(String(route).replace("/object_info/", ""));
        const all = backendObjectInfo();
        const body = Object.prototype.hasOwnProperty.call(all, cls) ? { [cls]: all[cls] } : {};
        return { status: 200, json: async () => body };
      },
    },
  });

  // #1848 — the guard's behaviour is unchanged (still refused, nothing added); what the
  // refusal SAYS is not. getNodeDefs throws here, so the whole-schema proof never
  // happened, and this is the exact sentence #821 was reported for: SeedVR2VideoUpscaler
  // told "no installed node outputs SEEDVR2_DIT" while SeedVR2LoadDiTModel — which
  // outputs precisely that — sat on the canvas.
  const err = await graph_add_node({ class_type: "SeedVR2VideoUpscaler" }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "still fails closed on a fetch that did not happen");
  assert.doesNotMatch(err.message, /no installed node outputs "SEEDVR2_DIT"/);
  assert.match(err.message, /UNKNOWN/);
  assert.equal(comfy.graph._nodes.length, 0);
});

test("#1180 EXECUTED: a widen whose getNodeDefs never answers returns rather than parking", async () => {
  // The other #1180 tests are structural. This one runs the SHIPPED bounded fetch — built
  // from panel source above, not re-implemented — against a getNodeDefs that never settles,
  // which is the half-open connection this issue is about.
  //
  // Two things must hold, and only execution shows them: it RETURNS, and it returns the
  // answer that makes the caller KEEP its narrower proof rather than weaken it to an empty
  // socket set (the #695/#700 false-cause message).
  const build = new Function(
    "api",
    "withTimeout",
    "NODE_DEFS_NO_ANSWER",
    "NODE_DEFS_FETCH_TIMEOUT_MS",
    `${boundedMatch[0]}
     return boundedGetNodeDefs;`,
  );
  const shipped = build(
    { getNodeDefs: () => new Promise(() => {}) },
    withTimeout,
    NODE_DEFS_NO_ANSWER,
    10000,
  );

  // NEVER await this unbounded. node --test has no default timeout, so a helper that lost
  // its bound would park the whole suite instead of naming itself — verified: removing the
  // bound made `npm run test:unit` hang rather than fail. A regression must be a red test,
  // not a hung CI job.
  const settled = (p, what) =>
    Promise.race([
      p,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${what} never settled — the bound is gone`)), 3000),
      ),
    ]);

  const started = Date.now();
  const result = await settled(shipped(60), "the bounded fetch"); // scaled-down bound; the shipped defaults are pinned structurally
  const elapsed = Date.now() - started;

  assert.equal(result, NODE_DEFS_NO_ANSWER, "a call that never answers must resolve the sentinel");
  assert.ok(elapsed < 2000, `it must return on the bound, took ${elapsed}ms`);

  // …and the widen maps that to null, which is what "keep the proof you already have" is.
  const whole = result === NODE_DEFS_NO_ANSWER ? null : result;
  assert.equal(whole, null, "the widen must treat a non-answer as doubt, not as an empty schema");

  // The bound is real, not decorative: a generous one lets the same call through.
  const answering = build(
    { getNodeDefs: () => new Promise((r) => setTimeout(() => r({ A: { output: ["T"] } }), 30)) },
    withTimeout,
    NODE_DEFS_NO_ANSWER,
    10000,
  );
  assert.equal(await settled(answering(5), "the 5ms bound"), NODE_DEFS_NO_ANSWER, "a 5ms bound must cut off a 30ms answer");
  assert.deepEqual(await settled(answering(1000), "the 1s bound"), { A: { output: ["T"] } }, "…and a 1s bound must not");
});

test("#1180: the registration wait measures itself on the monotonic clock", () => {
  // This deadline gates #580's protection: it is how long the panel waits for a V3 class's
  // custom widgets to finish registering before refusing to build the node. Measured on the
  // wall clock, an NTP correction, a DST change or a VM resume between the two reads either
  // ends the wait instantly — reporting widgets unmaterialised without ever having polled
  // for them — or extends it past the command budget entirely.
  //
  // The panel already settled this question once, for the /object_info oracle, and it cost
  // three review rounds. Asserted here because the fix is two characters and reverting it is
  // invisible: the mutation back to Date.now() passed the entire suite.
  const fn = widenSrcForConsts.slice(
    widenSrcForConsts.indexOf("async function awaitRequiredCustomWidgetRegistration("),
    widenSrcForConsts.indexOf("\n}", widenSrcForConsts.indexOf("async function awaitRequiredCustomWidgetRegistration(")),
  );
  assert.ok(fn.length > 0, "the registration wait must be findable");
  assert.match(fn, /const startedAt = monotonicNow\(\);/, "the deadline must be taken on the monotonic clock");
  assert.match(fn, /while \(monotonicNow\(\) < deadline\)/, "…and the poll must read the SAME clock it was set on");
  assert.doesNotMatch(fn, /Date\.now\(\)/, "no wall-clock reading may survive in this function");
});

test("#1223: the add files a WHOLE schema, and never a single-class payload", async () => {
  // graph_add_node is one of the readers that must feed the last-observed-schema fallback:
  // an add that registers a new type is often the last thing to have read a whole map, and
  // dropping it leaves the next render-time widget edit refused for want of it.
  //
  // UNREGISTERED type ⇒ the #780 fast path is skipped and the WHOLE schema is fetched.
  const comfy = makeComfy();
  delete comfy.LG.registered_node_types.SeedVR2VideoUpscaler;
  const { graph_add_node, snapshotFilings } = realGraphAddNode(comfy);
  await graph_add_node({ class_type: 'SeedVR2VideoUpscaler', workflow_uuid: 'wf' });

  assert.equal(snapshotFilings.length, 1, 'one whole schema was fetched, so one is filed');
  const [{ defs, opts }] = snapshotFilings;
  assert.ok(Object.keys(defs).length > 1, 'the WHOLE map, not a single-class payload');
  assert.equal(opts.whole, true, 'and the wholeness claim is stated');
  assert.equal(
    opts.observedAtEpoch,
    opts.currentEpoch,
    'the epoch must be read where the WHOLE request goes out — a reconnect during the ' +
      'optional per-class probe before it would leave this stale and the record rejected',
  );
});

test("#1223: an add that takes the single-class fast path files NOTHING", async () => {
  // A one-entry /object_info/<Type> payload reaching the snapshot would make every other
  // type read as absent, and the #458 ever-seen gate would diagnose the whole install as
  // removed packs. The fast path only runs for an ALREADY-REGISTERED type.
  const comfy = makeComfy();
  const { graph_add_node, snapshotFilings, calls } = realGraphAddNode(comfy);
  await graph_add_node({ class_type: 'SeedVR2VideoUpscaler', workflow_uuid: 'wf' });
  assert.ok(calls.single.length > 0, 'the fast path ran');
  assert.deepEqual(snapshotFilings, [], 'and nothing was filed from it');
});
