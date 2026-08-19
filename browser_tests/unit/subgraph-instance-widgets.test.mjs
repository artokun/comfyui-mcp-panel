/**
 * comfyui-mcp#1827 — after panel_enter_subgraph on a COPIED subgraph, adding and
 * rewiring inner nodes (without touching the promoted STRING), then
 * panel_exit_subgraph, both parent instances showed widgets.text="" .
 *
 * The frontend reconfigures every instance of the shared definition and reseeds
 * the per-instance store from the INNER widget (or leaves the rail empty). The
 * panel snapshots instance-scoped rails before the inner mutation and writes
 * them back after.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  collectSubgraphInstanceNodes,
  snapshotPromotedInstanceWidgets,
  restorePromotedInstanceWidgets,
  withPreservedPromotedInstanceWidgets,
} from "../../web/js/lib/subgraph-instance-widgets.js";

const ROOT_GRAPH_ID = "c4a254bb-935e-4013-b380-5e36954de4b0";
const SRC = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");

/**
 * Two wrappers, one shared Subgraph — the copied-subgraph shape. Each instance
 * has its own store-backed promoted STRING; the inner CLIPTextEncode keeps the
 * template default.
 */
function makeCopiedSubgraph({ definitionValue = "TEMPLATE-DEFAULT" } = {}) {
  const inner = {
    id: 10,
    type: "CLIPTextEncode",
    widgets: [{ name: "text", type: "STRING", value: definitionValue }],
  };
  const subgraph = { id: "sg-uuid", _nodes: [inner] };
  const store = new Map();

  function instance(id, text) {
    const widgetId = `${ROOT_GRAPH_ID}:${encodeURIComponent(String(id))}:${encodeURIComponent("text")}`;
    store.set(widgetId, { name: "text", type: "STRING", value: text });
    const rail = {
      name: "text",
      type: "STRING",
      get widgetId() {
        return widgetId;
      },
      get value() {
        return store.get(widgetId)?.value;
      },
      set value(next) {
        const state = store.get(widgetId);
        if (state) state.value = next;
      },
      callback(next) {
        const state = store.get(widgetId);
        if (state) state.value = next;
      },
    };
    const input = { name: "text", widgetId, _widget: rail };
    const node = {
      id,
      type: subgraph.id,
      subgraph,
      inputs: [input],
      get widgets() {
        return [rail];
      },
    };
    return { node, rail, widgetId };
  }

  /** What SubgraphNode.configure + _setWidget does to copied instances. */
  function wipeInstanceOverrides(to = "") {
    for (const state of store.values()) state.value = to;
  }

  return { inner, subgraph, store, instance, wipeInstanceOverrides };
}

test("#1827 collectSubgraphInstanceNodes finds every copy that shares the definition", () => {
  const sg = makeCopiedSubgraph();
  const a = sg.instance(82, "A");
  const b = sg.instance(116, "B");
  const other = { id: 3, type: "KSampler", subgraph: { id: "other" } };
  const root = { _nodes: [a.node, b.node, other] };
  const found = collectSubgraphInstanceNodes(root, sg.subgraph);
  assert.deepEqual(
    found.map((n) => n.id).sort((x, y) => x - y),
    [82, 116],
  );
});

test("#1827 collect matches a copy by type UUID even when the subgraph object was cloned", () => {
  const sg = makeCopiedSubgraph();
  const a = sg.instance(82, "A");
  const cloneDef = { id: "sg-uuid", _nodes: sg.subgraph._nodes };
  const b = sg.instance(116, "B");
  b.node.subgraph = cloneDef;
  const root = { _nodes: [a.node, b.node] };
  const found = collectSubgraphInstanceNodes(root, sg.subgraph);
  assert.equal(found.length, 2);
});

test("#1827: enter → inner mutation → exit keeps each copy's promoted STRING", async () => {
  const sg = makeCopiedSubgraph();
  const a = sg.instance(82, "INSTANCE-A-PROMPT");
  const b = sg.instance(116, "INSTANCE-B-PROMPT");
  const root = { _nodes: [a.node, b.node] };

  await withPreservedPromotedInstanceWidgets(root, sg.subgraph, () => {
    // Inner graph mutation: add/rewire nodes. The promoted STRING is not touched.
    sg.subgraph._nodes.push({ id: 11, type: "Note" });
    sg.wipeInstanceOverrides("");
    assert.equal(a.rail.value, "", "the frontend wipe is what the reporter read");
    assert.equal(b.rail.value, "");
  });

  assert.equal(a.rail.value, "INSTANCE-A-PROMPT");
  assert.equal(b.rail.value, "INSTANCE-B-PROMPT");
  assert.equal(sg.inner.widgets[0].value, "TEMPLATE-DEFAULT", "the shared definition must not move");
});

test("#1827 restore does not write the shared inner widget", () => {
  const sg = makeCopiedSubgraph();
  const a = sg.instance(82, "INSTANCE-A-PROMPT");
  const root = { _nodes: [a.node] };
  const snap = snapshotPromotedInstanceWidgets(root, sg.subgraph);
  sg.wipeInstanceOverrides("");
  sg.inner.widgets[0].value = "TEMPLATE-DEFAULT";
  restorePromotedInstanceWidgets(root, snap);
  assert.equal(sg.inner.widgets[0].value, "TEMPLATE-DEFAULT");
  assert.equal(a.rail.value, "INSTANCE-A-PROMPT");
});

test("#1827 a definition-scoped rail (no widgetId) is not written — that store is the inner widget", () => {
  const inner = { widgets: [{ name: "text", value: "TEMPLATE-DEFAULT" }] };
  const subgraph = { id: "sg-uuid", _nodes: [inner] };
  const rail = {
    name: "text",
    get value() {
      return inner.widgets[0].value;
    },
    set value(next) {
      inner.widgets[0].value = next;
    },
  };
  const node = {
    id: 82,
    type: "sg-uuid",
    subgraph,
    inputs: [{ name: "text" }],
    widgets: [rail],
  };
  const root = { _nodes: [node] };
  const snap = snapshotPromotedInstanceWidgets(root, subgraph);
  inner.widgets[0].value = "";
  const res = restorePromotedInstanceWidgets(root, snap);
  assert.equal(res.restored, 0);
  assert.equal(inner.widgets[0].value, "", "must not broadcast the snapshot into the definition");
});

test("#1827 an unexposed widget is skipped, not invented", () => {
  const sg = makeCopiedSubgraph();
  const a = sg.instance(82, "INSTANCE-A-PROMPT");
  const root = { _nodes: [a.node] };
  const snap = snapshotPromotedInstanceWidgets(root, sg.subgraph);
  a.node.inputs = [];
  Object.defineProperty(a.node, "widgets", { get: () => [] });
  const res = restorePromotedInstanceWidgets(root, snap);
  assert.equal(res.restored, 0);
  assert.equal(res.skipped, 1);
});

test("#1827 empty string, 0 and false are snapshotted — they are real values", () => {
  const sg = makeCopiedSubgraph();
  const a = sg.instance(82, "");
  const root = { _nodes: [a.node] };
  const snap = snapshotPromotedInstanceWidgets(root, sg.subgraph);
  assert.equal(snap.entries[0].value, "");
  a.rail.value = "CHANGED";
  restorePromotedInstanceWidgets(root, snap);
  assert.equal(a.rail.value, "");
});

test("#1827 withPreserved is a no-op at the root graph", async () => {
  let ran = 0;
  const root = { _nodes: [] };
  const out = await withPreservedPromotedInstanceWidgets(root, root, () => {
    ran += 1;
    return "ok";
  });
  assert.equal(out, "ok");
  assert.equal(ran, 1);
});

test("#1827 restore still runs when the inner mutation throws", async () => {
  const sg = makeCopiedSubgraph();
  const a = sg.instance(82, "INSTANCE-A-PROMPT");
  const root = { _nodes: [a.node] };
  await assert.rejects(
    withPreservedPromotedInstanceWidgets(root, sg.subgraph, () => {
      sg.wipeInstanceOverrides("");
      throw new Error("connect threw after wiring");
    }),
    /connect threw/,
  );
  assert.equal(a.rail.value, "INSTANCE-A-PROMPT", "a throw must not keep the wiped rails");
});

test("#1827 the dispatcher snapshots before a subgraph mutation and restores after", () => {
  assert.match(
    SRC,
    /withPreservedPromotedInstanceWidgets/,
    "inner mutations must run inside the preserve wrapper, not only have the helper imported",
  );
  assert.match(
    SRC,
    /visibleMutationTarget\.graph !== visibleMutationTarget\.rootGraph/,
    "preserve only while INSIDE a subgraph — the reported enter/mutate/exit path",
  );
});
