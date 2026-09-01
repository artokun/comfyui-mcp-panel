// #2140 — `panel_run` refused with a bare "Dynamic widget doesn't exist on node" on a
// SaveVideo added by panel_add_node. `panel_get_errors` was clean (errored_count 0,
// node_errors null): the failure happens in the frontend's graphToPrompt conversion,
// before a prompt exists, so nothing reaches the canvas error channel.
//
// The harness below is TRANSCRIBED from the shipped frontend, not modelled from intent —
// comfyui_frontend_package 1.49.6, `dynamicComboWidget` in
// static/assets/settingStore-CwkLtSKP.js (the sole occurrence of the error string in the
// bundle). Two properties of that function are load-bearing here and are the reason this
// file exists alongside dynamic-widget-reconcile.test.mjs, whose double rebuilds by name
// and can therefore never enter the failing state:
//
//   1. the throw is `node.widgets.findIndex(w => w === d) + 1 === 0` — an IDENTITY test
//      against the accessor's own captured widget, not a name lookup; and
//   2. the group's widget rows and their widget-store entries are REMOVED BEFORE that
//      check runs. A rebuild driven through a detached accessor therefore strips the
//      live rows and only then throws.
//
// The observable residue of (2) is a dynamic root whose selected option declares a child
// the node is not carrying — no orphan, no stale dotted residue, nothing for
// describeOrphanDynamicWidgets or the #1931 relocate path to see.

import test from "node:test";
import assert from "node:assert/strict";

import {
  describeUnresolvedDynamicCombos,
  describeDynamicComboCandidates,
  reconcileGraphDynamicWidgets,
  installGraphToPromptDynamicReconcile,
} from "../../web/js/lib/dynamic-widget-reconcile.js";
import { graphToPromptFailureRefusal } from "../../web/js/lib/missing-node-preflight.js";

const DYNAMIC = "COMFY_DYNAMICCOMBO_V3";

/**
 * SaveVideo as ComfyUI 0.34.2 actually declares it
 * (comfy_extras/nodes_video.py: `_save_video_codec_input` / `class SaveVideo`):
 * every `format` option — including "auto" — declares a required `codec`, `codec`'s
 * "auto" declares no further inputs, and h264/av1 each declare an OPTIONAL `encoding`
 * whose "re-encode" declares `crf`.
 */
function codecSpec(codecs = ["auto", "h264", "av1"]) {
  const encoding = (defaultCrf) => [
    DYNAMIC,
    {
      options: [
        { key: "auto", inputs: { required: {} } },
        { key: "re-encode", inputs: { required: { crf: ["FLOAT", { default: defaultCrf }] } } },
      ],
    },
  ];
  const options = [];
  if (codecs.includes("auto")) options.push({ key: "auto", inputs: { required: {} } });
  if (codecs.includes("h264")) {
    options.push({ key: "h264", inputs: { optional: { encoding: encoding(23) } } });
  }
  if (codecs.includes("av1")) {
    options.push({ key: "av1", inputs: { optional: { encoding: encoding(30) } } });
  }
  return [DYNAMIC, { options }];
}

function saveVideoDef() {
  return {
    name: "SaveVideo",
    input: {
      required: {
        video: ["VIDEO"],
        filename_prefix: ["STRING", { default: "video/ComfyUI" }],
        format: [
          DYNAMIC,
          {
            options: [
              { key: "auto", inputs: { required: { codec: codecSpec() } } },
              { key: "mp4", inputs: { required: { codec: codecSpec() } } },
              { key: "mkv", inputs: { required: { codec: codecSpec() } } },
              { key: "webm", inputs: { required: { codec: codecSpec(["auto", "av1"]) } } },
            ],
          },
        ],
      },
      optional: { codec: codecSpec() },
    },
  };
}

/**
 * A node whose DynamicCombo roots behave as 1.49.6's `dynamicComboWidget` does.
 *
 * `rebuilds` records every native rebuild so a test can prove which writes reached the
 * setter — a same-value replay and a real option round trip are otherwise
 * indistinguishable from the widget values alone, which is exactly the confusion #2140's
 * two workaround attempts turned on.
 */
function makeSaveVideo({ def = saveVideoDef() } = {}) {
  const store = new Map();
  const rebuilds = [];
  const node = { id: 21, type: "SaveVideo", constructor: { nodeData: def }, widgets: [], inputs: [] };

  const widgetIdFor = (name) => `graph:${node.id}:${name}`;

  function addWidget(name, value) {
    const widget = { type: "combo", name, options: {}, onRemove() {} };
    Object.defineProperty(widget, "widgetId", {
      configurable: true,
      get: () => widgetIdFor(widget.name),
    });
    // Every registered widget is backed by the frontend's widgetValue store, keyed by a
    // widgetId DERIVED FROM THE NAME (`widgetValueStore.registerWidget` / `widgetId()` in
    // 1.49.6). Both facts matter here: a write to a detached widget still lands in the
    // store under the live widget's key, and the native sweep DELETES that key.
    let fallback = value;
    Object.defineProperty(widget, "value", {
      configurable: true,
      enumerable: true,
      get() {
        return store.get(widget.widgetId)?.value ?? fallback;
      },
      set(next) {
        const state = store.get(widget.widgetId);
        if (state) state.value = next;
        fallback = next;
      },
    });
    node.widgets.push(widget);
    store.set(widgetIdFor(name), { value });
    return widget;
  }

  /** Verbatim shape of the bundle's `updateWidgets` closure, minus canvas/layout calls. */
  function installDynamicCombo(widget, spec) {
    const optionsByKey = new Map((spec[1]?.options ?? []).map((option) => [option.key, option.inputs]));
    let closureValue = widget.value;
    const isInGroup = (candidate) => candidate.name.startsWith(`${widget.name}.`);

    const updateWidgets = (next) => {
      const inputs = optionsByKey.get(next);
      // `er(e.inputs, isInGroup)` / `er(e.widgets, isInGroup)` — removal FIRST.
      for (let index = node.inputs.length - 1; index >= 0; index--) {
        if (isInGroup(node.inputs[index])) node.inputs.splice(index, 1);
      }
      for (let index = node.widgets.length - 1; index >= 0; index--) {
        const candidate = node.widgets[index];
        if (!isInGroup(candidate)) continue;
        candidate.onRemove?.();
        if (candidate.widgetId) store.delete(candidate.widgetId);
        node.widgets.splice(index, 1);
      }
      if (!inputs) return;
      const insertAt = node.widgets.findIndex((candidate) => candidate === widget) + 1;
      const widgetMark = node.widgets.length;
      if (insertAt === 0) throw new Error("Dynamic widget doesn't exist on node");
      rebuilds.push(`${widget.name}=${String(next)}`);
      for (const group of ["required", "optional"]) {
        for (const [childName, childSpec] of Object.entries(inputs[group] ?? {})) {
          const fullName = `${widget.name}.${childName}`;
          const isDynamic = Array.isArray(childSpec) && childSpec[0] === DYNAMIC;
          const child = addWidget(
            fullName,
            isDynamic ? childSpec[1]?.options?.[0]?.key : (childSpec?.[1]?.default ?? null),
          );
          node.inputs.push({ name: fullName, type: isDynamic ? DYNAMIC : childSpec[0], link: null });
          if (isDynamic) installDynamicCombo(child, childSpec);
        }
      }
      const created = node.widgets.splice(widgetMark);
      node.widgets.splice(insertAt, 0, ...created);
    };

    Object.defineProperty(widget, "value", {
      configurable: true,
      get() {
        return store.get(widget.widgetId)?.value ?? closureValue;
      },
      set(next) {
        const state = store.get(widget.widgetId);
        if (state) state.value = next;
        closureValue = next;
        updateWidgets(next);
      },
    });
    widget.value = closureValue;
  }

  for (const [name, spec] of Object.entries(def.input.required)) {
    if (Array.isArray(spec) && spec[0] === DYNAMIC) {
      const widget = addWidget(name, spec[1].options[0].key);
      node.inputs.push({ name, type: DYNAMIC, link: null });
      installDynamicCombo(widget, spec);
    } else if (spec[0] === "STRING") {
      addWidget(name, spec[1]?.default ?? "");
    } else {
      node.inputs.push({ name, type: spec[0], link: null });
    }
  }

  const widgetNames = () => node.widgets.map((widget) => widget.name);
  return { node, store, rebuilds, widgetNames, graph: { _nodes: [node] } };
}

test("#2140 a freshly built SaveVideo is resolved — the describer must not fire on it", () => {
  const { node, widgetNames } = makeSaveVideo();
  assert.deepEqual(widgetNames(), ["filename_prefix", "format", "format.codec"]);
  assert.equal(node.widgets.find((w) => w.name === "format").value, "auto");
  assert.equal(node.widgets.find((w) => w.name === "format.codec").value, "auto");
  assert.deepEqual(describeUnresolvedDynamicCombos({ _nodes: [node] }), []);
});

test("#2140 the native rebuild strips the live rows BEFORE it throws", () => {
  // This is the mechanism, executed rather than asserted: take the accessor the node is
  // carrying, detach it exactly as the sweep does, drive it once, and read what is left.
  const { node, store } = makeSaveVideo();
  const format = node.widgets.find((widget) => widget.name === "format");
  assert.ok(store.has(`graph:21:format.codec`));

  node.widgets.splice(node.widgets.indexOf(format), 1);
  assert.throws(() => {
    format.value = "auto";
  }, /Dynamic widget doesn't exist on node/);
  node.widgets.unshift(format);

  // The row and its widget-store entry are gone, and the throw named no node.
  assert.equal(
    node.widgets.some((widget) => widget.name === "format.codec"),
    false,
    "the live format.codec row must have been swept before the throw",
  );
  assert.equal(store.has(`graph:21:format.codec`), false, "its widget-store entry is deleted too");
});

test("#2140 the stripped state is named — node, root, selected option and missing row", () => {
  const { node } = makeSaveVideo();
  const format = node.widgets.find((widget) => widget.name === "format");
  node.widgets.splice(node.widgets.indexOf(format), 1);
  assert.throws(() => {
    format.value = "auto";
  });
  node.widgets.unshift(format);

  const found = describeUnresolvedDynamicCombos({ _nodes: [node] });
  assert.equal(found.length, 1);
  assert.equal(found[0].nodeId, 21);
  assert.equal(found[0].nodeType, "SaveVideo");
  assert.equal(found[0].root, "format");
  assert.equal(found[0].selected, "auto");
  assert.deepEqual(found[0].missing, ["format.codec"]);
  assert.equal(found[0].reason, "children-missing");
});

test("#2140 a socket-only child is not mistaken for a stripped row", () => {
  // `addInputWidget` returns before creating a row when the input is forceInput or its
  // type has no registered widget constructor. The socket is there and the row never was,
  // which must not read as the #2140 state — the native sweep takes BOTH.
  const { node } = makeSaveVideo();
  const codecIndex = node.widgets.findIndex((widget) => widget.name === "format.codec");
  node.widgets.splice(codecIndex, 1);
  assert.ok(
    node.inputs.some((input) => input.name === "format.codec"),
    "the socket survives — this is the socket-only shape, not the stripped one",
  );
  assert.deepEqual(describeUnresolvedDynamicCombos({ _nodes: [node] }), []);

  // Take the socket too and it IS the stripped shape.
  node.inputs.splice(
    node.inputs.findIndex((input) => input.name === "format.codec"),
    1,
  );
  assert.deepEqual(describeUnresolvedDynamicCombos({ _nodes: [node] })[0].missing, ["format.codec"]);
});

test("#2140 a duplicated dotted row is named too — the sweep's other residue", () => {
  const { node } = makeSaveVideo();
  const codec = node.widgets.find((widget) => widget.name === "format.codec");
  node.widgets.push({ name: "format.codec", value: "auto", options: {}, onRemove() {} });
  assert.ok(codec);

  const found = describeUnresolvedDynamicCombos({ _nodes: [node] });
  assert.equal(found.length, 1);
  assert.equal(found[0].reason, "duplicate-rows");
  assert.deepEqual(found[0].missing, ["format.codec"]);
});

test("#2140 the same-value replay reconcile leaves the caller's values alone", () => {
  // reconcileGraphDynamicWidgets is the pass that runs before EVERY prompt build. Pinning
  // it here keeps the repair from being mistaken for a licence to loosen it.
  const { node } = makeSaveVideo();
  node.widgets.find((widget) => widget.name === "format").value = "mkv";
  node.widgets.find((widget) => widget.name === "format.codec").value = "av1";
  reconcileGraphDynamicWidgets({ _nodes: [node] });
  assert.equal(node.widgets.find((widget) => widget.name === "format").value, "mkv");
  assert.equal(node.widgets.find((widget) => widget.name === "format.codec").value, "av1");
});

test("#2140 the retry-once path recovers a stripped root and the run proceeds", async () => {
  const { node } = makeSaveVideo();
  const format = node.widgets.find((widget) => widget.name === "format");
  node.widgets.splice(node.widgets.indexOf(format), 1);
  assert.throws(() => {
    format.value = "auto";
  });
  node.widgets.unshift(format);

  // A serializer that refuses for as long as the row is missing and succeeds once it is
  // back — the frontend's own behaviour, reduced to its verdict. The rescue is the
  // EXISTING same-value replay in reconcileGraphDynamicWidgets: it drives the native
  // rebuild, which is all this state needs. What #2140 broke was not that replay but
  // what ran after it — see the value-loss test below.
  const graph = { _nodes: [node] };
  const app = {
    graph,
    rootGraph: graph,
    async graphToPrompt() {
      if (!node.widgets.some((widget) => widget.name === "format.codec")) {
        throw new Error("Dynamic widget doesn't exist on node");
      }
      return { output: { 21: { class_type: "SaveVideo" } } };
    },
  };
  assert.equal(installGraphToPromptDynamicReconcile(app), true);

  const built = await app.graphToPrompt(graph);
  assert.deepEqual(built, { output: { 21: { class_type: "SaveVideo" } } });
  assert.equal(format.value, "auto", "the rescue must leave the caller's option in place");
});

test("#2140 an unrecoverable graph still names the node instead of the bare string", async () => {
  const { node } = makeSaveVideo();
  const format = node.widgets.find((widget) => widget.name === "format");
  node.widgets.splice(node.widgets.indexOf(format), 1);
  assert.throws(() => {
    format.value = "auto";
  });
  node.widgets.unshift(format);
  // Freeze the state: the row can never come back, so the retry has to report rather
  // than rescue. This is the half of #2140 that must hold whatever the root cause is.
  Object.defineProperty(format, "value", { configurable: true, get: () => "auto", set() {} });

  const graph = { _nodes: [node] };
  const app = {
    graph,
    rootGraph: graph,
    async graphToPrompt() {
      throw new Error("Dynamic widget doesn't exist on node");
    },
  };
  installGraphToPromptDynamicReconcile(app);

  await assert.rejects(app.graphToPrompt(graph), (error) => {
    assert.match(error.message, /Dynamic widget doesn't exist on node/);
    assert.match(error.message, /SaveVideo node 21/);
    assert.match(error.message, /format="auto"/);
    assert.match(error.message, /is missing format\.codec/);
    return true;
  });
});

test("#2140 a prompt build must not lose a value BELOW a rebuilt dynamic child", async () => {
  // The reporter's decisive measurement: a SAME-VALUE write of format="mp4" did not
  // recover the node, a real mp4 → mkv → mp4 round trip did, and both ended on identical
  // widget values. In the panel the two paths differ by exactly one thing —
  // wrapDynamicComboSetter's `previous === next` branch runs restorePrefixedValues, and
  // the round trip does not.
  //
  // restorePrefixedValues resolved every captured name against ONE map built before any
  // restore. The shallowest restore (`format.codec`) drives a native rebuild that
  // replaces every widget below it, so each deeper name in that map is a DETACHED
  // widget by the time it is written: the value goes nowhere, and for a dynamic child
  // the write also drives an accessor the node is no longer carrying — which sweeps the
  // live rows and deletes their widget-store entries before it throws.
  const { node, store } = makeSaveVideo();
  node.widgets.find((widget) => widget.name === "format").value = "mp4";
  node.widgets.find((widget) => widget.name === "format.codec").value = "h264";
  node.widgets.find((widget) => widget.name === "format.codec.encoding").value = "re-encode";
  const crf = node.widgets.find((widget) => widget.name === "format.codec.encoding.crf");
  assert.ok(crf, "the h264 / re-encode branch materialises crf");
  crf.value = 17;

  const graph = { _nodes: [node] };
  const app = { graph, rootGraph: graph, async graphToPrompt() { return { output: {} } } };
  installGraphToPromptDynamicReconcile(app);
  // One ordinary prompt build. Nothing about it asked to change a value.
  await app.graphToPrompt(graph);

  const read = (name) => node.widgets.find((widget) => widget.name === name)?.value;
  assert.equal(read("format"), "mp4");
  assert.equal(read("format.codec"), "h264");
  assert.equal(read("format.codec.encoding"), "re-encode", "the grandchild's value must survive");
  assert.equal(read("format.codec.encoding.crf"), 17, "and so must the value below it");
  assert.equal(
    store.get("graph:21:format.codec.encoding.crf")?.value,
    17,
    "the widget-store entry must survive too — a detached-accessor write deletes it",
  );
});

test("#2140 candidates are named when nothing specific can be found", () => {
  const { node } = makeSaveVideo();
  const candidates = describeDynamicComboCandidates({ _nodes: [node] });
  assert.deepEqual(candidates, [{ nodeId: 21, nodeType: "SaveVideo", roots: ["format"] }]);
});

test("#2140 a throw over a HEALTHY graph names candidates, through the real wrapper", async () => {
  // The fallback has to be reached from the production path, not just called: a graph
  // that serializes badly for a reason the panel cannot see is exactly the case #2140's
  // reporter hit, and the message must still hand them somewhere to start. Asserting
  // only on the exported helper would prove the helper works and nothing about whether
  // graphToPrompt ever consults it.
  const { node } = makeSaveVideo();
  assert.deepEqual(describeUnresolvedDynamicCombos({ _nodes: [node] }), [], "graph is healthy");

  const graph = { _nodes: [node] };
  const app = {
    graph,
    rootGraph: graph,
    async graphToPrompt() {
      throw new Error("Dynamic widget doesn't exist on node");
    },
  };
  installGraphToPromptDynamicReconcile(app);

  await assert.rejects(app.graphToPrompt(graph), (error) => {
    assert.match(error.message, /no node could be identified/);
    assert.match(error.message, /SaveVideo node 21 \(format\)/);
    // The panel's refusal must not then send the caller off to "the named widget".
    const refusal = graphToPromptFailureRefusal(error);
    assert.match(refusal, /did not name a node or widget/);
    assert.doesNotMatch(refusal, /inspect the named widget/i);
    return true;
  });
});

test("#2140 a graph with no dynamic-combo node yields no candidates", () => {
  const graph = { _nodes: [{ id: 3, type: "KSampler", constructor: { nodeData: { input: { required: { seed: ["INT"] } } } }, widgets: [] }] };
  assert.deepEqual(describeDynamicComboCandidates(graph), []);
  assert.deepEqual(describeUnresolvedDynamicCombos(graph), []);
});
