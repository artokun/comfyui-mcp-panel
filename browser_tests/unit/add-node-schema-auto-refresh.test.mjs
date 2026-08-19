// panel#1242 — `panel_add_node` refused to add LoadImage because the registered
// frontend node schema was stale:
//
//   "LoadImage" required input "image" was added or retyped since this page
//   loaded its node schema
//
// — and the retried identical add, after a manual `panel_refresh_nodes`,
// succeeded. The panel was refusing a condition it could clear itself, in the
// same call, at the cost of one forced refresh the caller was going to pay
// anyway. The reporter's follow-up made the cost concrete: the tool replied
// with a successful added-node payload while the sidebar reported the refusal,
// an inconsistent outcome born of the add depending on a recovery only the
// caller could perform.
//
// THE FIX: the drift branch of `graph_add_node` now RUNS the panel_refresh_nodes
// recovery itself — `refreshComfyNodeDefs(undefined, { force: true })`, the same
// forced re-register — then re-reads the registry nodeData and re-checks the
// drift. A drift the refresh clears is added from the CURRENT definition, with
// the recovery disclosed on the result; only a drift that SURVIVES a real
// re-registration is refused, and that refusal says the recovery already ran
// (and why it did not complete, when the refresh said so).
//
// The re-check reads the REGISTRY, not the refresh's verdict: a refresh that
// only claims to have run must not be able to wave a stale schema through.
//
// THE HARNESS: these tests run the SHIPPED `graph_add_node` body, extracted from
// the panel source and given injected collaborators — the same technique as
// add-node-socket-proof-scope.test.mjs, whose harness this one mirrors.
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

const boundedMatch = panelSrc.match(/\nasync function boundedGetNodeDefs\([\s\S]*?\n\}/);
assert.ok(boundedMatch, "could not locate boundedGetNodeDefs in panel source");

import {
  NODE_DEFS_FETCH_TIMEOUT_MS,
  NODE_DEFS_NO_ANSWER,
  WIDEN_SOCKET_PROOF_TIMEOUT_MS,
  addNodeCommandBudgetDeps,
  monotonicNow,
} from "./_panel-constants.mjs";

// ---------------------------------------------------------------------------
// The reporter's condition: the backend's CURRENT LoadImage declares a required
// `image` combo; the registry this page loaded still holds the OLD shape.
// ---------------------------------------------------------------------------

/** The live backend /object_info. A fresh object each call, exactly like a fetch. */
function backendObjectInfo() {
  return {
    LoadImage: {
      name: "LoadImage",
      input: { required: { image: [["a.png", "b.png"], {}] } },
      output: ["IMAGE", "MASK"],
    },
  };
}

/** The page-load registry entry, from BEFORE the pack added `image`. */
function staleLoadImageNodeData() {
  return {
    name: "LoadImage",
    input: { required: {} },
    output: ["IMAGE", "MASK"],
  };
}

function makeComfy({ stale = true } = {}) {
  const widgets = {
    COMBO(node, name, spec) {
      return { widget: node.addWidget("combo", name, spec[0][0], null, { values: spec[0] }) };
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
        cls.nodeData = nodeData;
        cls.comfyClass = type;
        registry[type] = cls;
      }
    },
  };

  // The class IS registered — that is what arms the per-class fast path and what
  // makes this a DRIFT case rather than a freshly-installed-class case. Whether
  // the entry is the stale page-load one or already current is the scenario knob.
  void app.registerNodesFromDefs({
    LoadImage: stale ? staleLoadImageNodeData() : backendObjectInfo().LoadImage,
  });

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
  const refreshCalls = [];

  const api = {
    async getNodeDefs() {
      return backendObjectInfo();
    },
    // ComfyUI's per-class route, faithful to its real shape: absence is `{}` with HTTP 200.
    async fetchApi(route) {
      const cls = decodeURIComponent(String(route).replace("/object_info/", ""));
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
    objectInfoSnapshot: { record: () => true, clear: () => {} },
    backendReconnectEpoch: 0,
    api,
    // The default is the refresh the reporter ran by hand: forced, whole-schema,
    // and it re-registers the CURRENT defs — the recovery that clears the drift.
    // Tests that need it to fail or to lie pass their own through overrides.
    refreshComfyNodeDefs: async (defs, opts) => {
      refreshCalls.push({ defs, opts });
      await app.registerNodesFromDefs(defs ?? backendObjectInfo());
      return { refreshed: true };
    },
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
    NODE_DEFS_NO_ANSWER,
    WIDEN_SOCKET_PROOF_TIMEOUT_MS,
    monotonicNow,
    NODE_DEFS_FETCH_TIMEOUT_MS,
    withTimeout,
    // #1192 — the command budget's module bindings, shared across the three harnesses that
    // rebuild this executor so a new binding is added in ONE place.
    ...addNodeCommandBudgetDeps(),
    ...overrides,
  };

  if (!("boundedGetNodeDefs" in deps)) {
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
  return { graph_add_node: factory(...names.map((n) => deps[n])), refreshCalls };
}

// ---------------------------------------------------------------------------
// 1. The reported flow, now in ONE call: drift detected → refresh → add.
// ---------------------------------------------------------------------------

test("#1242: the reporter's add succeeds in one call — the panel refreshes first", async () => {
  const comfy = makeComfy({ stale: true });
  const { graph_add_node, refreshCalls } = realGraphAddNode(comfy);

  const res = await graph_add_node({ class_type: "LoadImage" });

  assert.equal(res.added.type, "LoadImage");
  assert.deepEqual(res.added.widgets, ["image"], "the node is built from the CURRENT definition");
  assert.equal(comfy.graph._nodes.length, 1);
  assert.equal(refreshCalls.length, 1, "exactly one refresh — the recovery, not a retry storm");
  assert.equal(refreshCalls[0].defs, undefined, "the refresh is the whole-schema forced one");
  assert.equal(refreshCalls[0].opts.force, true, "the recovery is the forced whole-schema one");
  // #1192 — and it is BOUNDED now. This recovery awaits any refresh already in flight before
  // queueing its own; unbounded that wait is the composition defect #1192 is about, arriving
  // at the one await inside this command that named no bound. Asserting the bound EXISTS is
  // stronger than the literal `{ force: true }` this replaces, which could not see it.
  assert.ok(
    Number.isFinite(refreshCalls[0].opts.joinMs) && refreshCalls[0].opts.joinMs > 0,
    "the drift recovery's wait must be bounded by what the command has left",
  );
  assert.deepEqual(
    Object.keys(refreshCalls[0].opts).sort(),
    ["force", "joinMs"],
    "…and nothing else is passed",
  );
});

test("#1242: the recovery is disclosed on the result, not silent", async () => {
  const comfy = makeComfy({ stale: true });
  const { graph_add_node } = realGraphAddNode(comfy);

  const res = await graph_add_node({ class_type: "LoadImage" });

  assert.equal(res.added.schema_refreshed, true, "the caller must be told the schema moved");
  assert.match(res.added.warning, /schema .* was stale/i);
  assert.match(res.added.warning, /panel_refresh_nodes/);
  // The limit the refusal has always stated applies here too: existing nodes
  // were not retrofitted.
  assert.match(res.added.warning, /ALREADY on the canvas/);
});

// ---------------------------------------------------------------------------
// 2. The refusal survives — for the drift a real refresh could not clear.
// ---------------------------------------------------------------------------

test("#1242: a drift that survives the refresh is still refused, with the reason named", async () => {
  const comfy = makeComfy({ stale: true });
  // The refresh ran but reported it did not complete, and the registry still
  // holds the old shape — the #852 refusal is the right answer HERE, not before.
  let refreshRan = 0;
  const { graph_add_node } = realGraphAddNode(comfy, {
    refreshComfyNodeDefs: async () => {
      refreshRan += 1;
      return { refreshed: false, reason: "defs_fetch_failed" };
    },
  });

  await assert.rejects(
    () => graph_add_node({ class_type: "LoadImage" }),
    (err) => {
      assert.match(err.message, /added or retyped since this page loaded its node schema/);
      assert.match(err.message, /panel_refresh_nodes recovery itself/);
      assert.match(err.message, /did not complete \(reason: defs_fetch_failed\)/);
      assert.match(err.message, /Reloading the ComfyUI tab/);
      return true;
    },
  );
  assert.equal(refreshRan, 1, "the recovery was attempted before refusing");
  assert.equal(comfy.graph._nodes.length, 0, "a refused add creates nothing");
});

test("#1242: a refresh that THROWS is a not-completed refresh, not a crashed add", async () => {
  const comfy = makeComfy({ stale: true });
  const { graph_add_node } = realGraphAddNode(comfy, {
    refreshComfyNodeDefs: async () => {
      throw new Error("backend gone");
    },
  });

  await assert.rejects(
    () => graph_add_node({ class_type: "LoadImage" }),
    (err) => {
      assert.match(err.message, /did not complete \(reason: backend gone\)/);
      return true;
    },
  );
  assert.equal(comfy.graph._nodes.length, 0);
});

test("#1242: a refresh that cleared nothing REGISTRY-side cannot wave the drift through", async () => {
  // The re-check reads the registry the refresh rewrote — not the verdict. A
  // refresh that claims success but leaves the old nodeData in place must still
  // be refused; trusting the verdict would be the silent-corruption path.
  const comfy = makeComfy({ stale: true });
  const { graph_add_node } = realGraphAddNode(comfy, {
    refreshComfyNodeDefs: async () => ({ refreshed: true }), // claims it ran; registers nothing
  });

  await assert.rejects(
    () => graph_add_node({ class_type: "LoadImage" }),
    (err) => {
      assert.match(err.message, /added or retyped since this page loaded its node schema/);
      assert.match(err.message, /survived it/);
      return true;
    },
  );
  assert.equal(comfy.graph._nodes.length, 0);
});

// ---------------------------------------------------------------------------
// 3. A healthy add pays nothing: the refresh is drift-triggered, not routine.
// ---------------------------------------------------------------------------

test("#1242: an add with no drift never calls the refresh", async () => {
  const comfy = makeComfy({ stale: false });
  const { graph_add_node, refreshCalls } = realGraphAddNode(comfy);

  const res = await graph_add_node({ class_type: "LoadImage" });

  assert.equal(res.added.type, "LoadImage");
  assert.equal(refreshCalls.length, 0, "a healthy add must not pay for a whole-schema refresh");
  assert.equal(res.added.schema_refreshed, undefined, "nothing to disclose when nothing happened");
});
