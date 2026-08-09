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

function makeComfy() {
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
  void app.registerNodesFromDefs(backendObjectInfo());

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
  const calls = { single: [], whole: 0 };

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
    ...overrides,
  };

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
  return { graph_add_node: factory(...names.map((n) => deps[n])), calls };
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
    assert.match(err.message, /no installed node outputs "SEEDVR2_VAE"/);
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

  await assert.rejects(
    () => graph_add_node({ class_type: "SeedVR2VideoUpscaler" }),
    /no installed node outputs "SEEDVR2_DIT"/,
  );
  assert.equal(comfy.graph._nodes.length, 0);
});
