/**
 * #2001 — `panel_set_widget` timed out at 90s after an inner-subgraph scalar
 * write had already stuck. The assignment/readback is the receipt; a widget
 * callback thenable, a parent-rail restore callback, or a canvas rAF that
 * never fires must not own the command reply.
 *
 * These drive applyWidgetWrite / runSetWidget / withPreservedPromotedInstanceWidgets
 * — the SAME units the dispatcher uses — so a later `await callback()` or an
 * unbounded rAF flush fails a test instead of the relay.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { applyWidgetWrite } from "../../web/js/lib/widget-write.js";
import {
  runSetWidget,
  awaitFrontendWidgetFlush,
  FRONTEND_WIDGET_FLUSH_MS,
} from "../../web/js/lib/set-widget.js";
import {
  collectSubgraphInstanceNodes,
  restorePromotedInstanceWidgets,
  snapshotPromotedInstanceWidgets,
  withPreservedPromotedInstanceWidgets,
} from "../../web/js/lib/subgraph-instance-widgets.js";
import { CONTROL_AFTER_GENERATE_MODES } from "../../web/js/lib/control-after-generate.js";

const PANEL_SRC = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
const SET_WIDGET_SRC = readFileSync(new URL("../../web/js/lib/set-widget.js", import.meta.url), "utf8");

const NEVER = new Promise(() => {});

function mkCtor() {
  const c = function NodeCtor() {};
  c.nodeData = { input: { required: {} } };
  return c;
}

function innerKSamplerAdvanced(controlValue = "fixed") {
  const ctor = mkCtor();
  return {
    id: 6,
    type: "KSamplerAdvanced",
    constructor: ctor,
    widgets: [
      { name: "noise_seed", type: "INT", value: 0 },
      {
        name: "control_after_generate",
        type: "combo",
        value: controlValue,
        options: {
          values: [...CONTROL_AFTER_GENERATE_MODES],
          serialize: false,
          canvasOnly: true,
        },
      },
    ],
  };
}

function wired(extra = {}) {
  const r = { KSamplerAdvanced: mkCtor() };
  return {
    registry: r,
    getRegistry: () => r,
    getFreshObjectInfo: async () => ({ KSamplerAdvanced: {} }),
    beforeChange() {},
    afterChange() {},
    setDirty() {},
    ...extra,
  };
}

function neverFiringFlush() {
  return awaitFrontendWidgetFlush({
    setTimer: (fn) => {
      queueMicrotask(fn);
      return 1;
    },
    clearTimer() {},
  });
}

test("#2001 FRONTEND_WIDGET_FLUSH_MS is a short bound, not the 90s relay", () => {
  assert.equal(FRONTEND_WIDGET_FLUSH_MS, 250);
  assert.match(SET_WIDGET_SRC, /withTimeout\(flush, FRONTEND_WIDGET_FLUSH_MS/);
});

test("#2001 awaitFrontendWidgetFlush resolves when rAF never fires", async () => {
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  try {
    await awaitFrontendWidgetFlush({
      setTimer: (fn) => {
        queueMicrotask(fn);
        return 1;
      },
      clearTimer() {},
    });
  } finally {
    if (previousRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousRaf;
  }
});

test("#2001 an inner control_after_generate write still replies when rAF never fires", async () => {
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  try {
    const node = innerKSamplerAdvanced("fixed");
    const res = await runSetWidget(node, "control_after_generate", "randomize", {
      ...wired(),
      awaitFrontendWidgetFlush: neverFiringFlush,
    });
    assert.equal(res.set.value, "randomize");
    assert.equal(res.set.previous, "fixed");
    assert.equal(node.widgets[1].value, "randomize");
  } finally {
    if (previousRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousRaf;
  }
});

test("#2001 applyWidgetWrite does not wait on a hanging widget-callback thenable", () => {
  const node = innerKSamplerAdvanced("fixed");
  node.widgets[1].callback = () => NEVER;
  const set = applyWidgetWrite(node, "control_after_generate", "randomize", {});
  assert.equal(set.value, "randomize");
  assert.equal(node.widgets[1].value, "randomize");
});

test("#2001 applyWidgetWrite does not wait on a hanging options.setValue thenable", () => {
  const node = innerKSamplerAdvanced("fixed");
  node.widgets[1].options.setValue = () => NEVER;
  const set = applyWidgetWrite(node, "control_after_generate", "randomize", {});
  assert.equal(set.value, "randomize");
  assert.equal(node.widgets[1].value, "randomize");
});

test("#2001 restore does not wait on a hanging parent-rail callback thenable", () => {
  const subgraph = { id: "sg-uuid", _nodes: [] };
  const store = { value: "INSTANCE-A" };
  const widgetId = "g:82:text";
  const rail = {
    name: "text",
    widgetId,
    get value() {
      return store.value;
    },
    set value(next) {
      store.value = next;
    },
    callback() {
      return NEVER;
    },
  };
  const node = {
    id: 82,
    type: subgraph.id,
    subgraph,
    inputs: [{ name: "text", widgetId }],
    widgets: [rail],
  };
  const root = { _nodes: [node] };
  const snap = snapshotPromotedInstanceWidgets(root, subgraph);
  store.value = "";
  const res = restorePromotedInstanceWidgets(root, snap);
  assert.equal(res.restored, 1);
  assert.equal(store.value, "INSTANCE-A");
});

test("#2001 withPreserved still returns a landed inner mutation when restore throws", async () => {
  const subgraph = { id: "sg-uuid", _nodes: [] };
  const rail = {
    name: "text",
    widgetId: "g:82:text",
    value: "keep-me",
  };
  let restoring = false;
  const wrapper = {
    id: 82,
    type: subgraph.id,
    subgraph,
    get inputs() {
      if (restoring) throw new Error("restore exploded");
      return [{ name: "text", widgetId: "g:82:text" }];
    },
    widgets: [rail],
  };
  const root = { _nodes: [wrapper] };
  const out = await withPreservedPromotedInstanceWidgets(root, subgraph, () => {
    restoring = true;
    rail.value = "";
    return { set: { node_id: 6, widget: "control_after_generate", value: "randomize" } };
  });
  assert.equal(out.set.value, "randomize");
});

test("#2001 withPreserved returns the inner mutation result even when restore callbacks hang", async () => {
  const subgraph = { id: "sg-uuid", _nodes: [{ id: 6, type: "KSamplerAdvanced" }] };
  const store = { value: "keep-me" };
  const widgetId = "g:82:text";
  const rail = {
    name: "text",
    widgetId,
    get value() {
      return store.value;
    },
    set value(next) {
      store.value = next;
    },
    callback() {
      return NEVER;
    },
  };
  const wrapper = {
    id: 82,
    type: subgraph.id,
    subgraph,
    inputs: [{ name: "text", widgetId }],
    widgets: [rail],
  };
  const root = { _nodes: [wrapper] };
  const out = await withPreservedPromotedInstanceWidgets(root, subgraph, () => {
    store.value = "";
    return { set: { node_id: 6, widget: "control_after_generate", value: "randomize" } };
  });
  assert.equal(out.set.value, "randomize");
  assert.equal(store.value, "keep-me", "the rail restore still landed");
});

test("#2001 collectSubgraphInstanceNodes stops when subgraph identity is a new object each read", () => {
  let reads = 0;
  const node = {
    id: 1,
    type: "sg-uuid",
    get subgraph() {
      reads += 1;
      return { id: "sg-uuid", _nodes: [] };
    },
  };
  const found = collectSubgraphInstanceNodes({ _nodes: [node] }, { id: "sg-uuid" });
  assert.ok(found.some((n) => n.id === 1));
  assert.ok(reads <= 10000 + 2, `walk must be capped, got ${reads} subgraph reads`);
});

test("#2001 inner subgraph mutations still run inside the preserve wrapper", () => {
  assert.match(PANEL_SRC, /withPreservedPromotedInstanceWidgets/);
  assert.match(
    PANEL_SRC,
    /visibleMutationTarget\.graph !== visibleMutationTarget\.rootGraph/,
  );
});
