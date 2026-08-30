/**
 * #2035 — a dynamic/custom widget write can outlive the panel acknowledgement wait.
 *
 * These drive runSetWidget(), the same production body used by graph_set_widget. The
 * fixture follows ComfyUI's COMFY_DYNAMICCOMBO_V3 shape: assigning the root combo updates
 * the live value synchronously and rebuilds its dotted child widgets synchronously.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runSetWidget } from "../../web/js/lib/set-widget.js";

const NODE_TYPE = "TextGenerate";
const FRESH = { [NODE_TYPE]: {} };
const REGISTRY = { [NODE_TYPE]: {} };

function fireableTimers() {
  const timers = [];
  return {
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => {},
    fire: () => {
      assert.equal(timers.length, 1, "the runSetWidget acknowledgement wait must arm one timeout");
      timers[0]();
    },
  };
}

function makeDynamicTextGenerate(initial = "on") {
  let current = initial;
  let setterCalls = 0;
  const root = {
    name: "sampling_mode",
    type: "combo",
    options: { values: ["on", "off"] },
  };
  const node = {
    id: 2035,
    type: NODE_TYPE,
    widgets: [root],
  };

  const rebuild = () => {
    node.widgets = [root, { name: `sampling_mode.${current}`, type: "text", value: "" }];
  };
  Object.defineProperty(root, "value", {
    configurable: true,
    get: () => current,
    set: (next) => {
      setterCalls += 1;
      current = next;
      rebuild();
    },
  });
  rebuild();

  return {
    node,
    root,
    forceValue(next) {
      current = next;
      rebuild();
    },
    get setterCalls() {
      return setterCalls;
    },
  };
}

function widgetOpts(extra = {}) {
  return {
    registry: REGISTRY,
    getFreshObjectInfo: async () => FRESH,
    ...extra,
  };
}

test("#2035 current behavior: a dynamic V3 root write lands and rebuilds its children", async () => {
  const dynamic = makeDynamicTextGenerate();
  const result = await runSetWidget(dynamic.node, "sampling_mode", "off", widgetOpts());

  assert.equal(result.applied, true);
  assert.equal(result.set.value, "off");
  assert.equal(dynamic.root.value, "off");
  assert.equal(dynamic.setterCalls, 1);
  assert.deepEqual(
    dynamic.node.widgets.map((widget) => widget.name),
    ["sampling_mode", "sampling_mode.off"],
  );
});

test("#2035 timeout: unknown is returned promptly and a late dynamic body cannot mutate or retry", async () => {
  const dynamic = makeDynamicTextGenerate();
  const clock = fireableTimers();
  let releaseFresh;
  const freshPending = new Promise((resolve) => {
    releaseFresh = () => resolve(FRESH);
  });
  const pending = runSetWidget(
    dynamic.node,
    "sampling_mode",
    "off",
    widgetOpts({
      getFreshObjectInfo: () => freshPending,
      timeoutMs: 80,
      ackTimers: { setTimer: clock.setTimer, clearTimer: clock.clearTimer },
    }),
  );

  clock.fire();
  await assert.rejects(pending, /outcome is UNKNOWN.*NOT retried.*panel_query_graph/i);
  assert.equal(dynamic.root.value, "on", "the delayed body must not have written before preflight completed");
  assert.equal(dynamic.setterCalls, 0);

  // The transport wait is over, but the original object-info operation is not cancellable.
  // Releasing it exercises the late continuation and proves the cooperative write fence
  // prevents the mutation that would otherwise be reported after the unknown reply.
  releaseFresh();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dynamic.root.value, "on");
  assert.equal(dynamic.setterCalls, 0, "an unknown timeout must not trigger a late write or duplicate retry");
  assert.deepEqual(dynamic.node.widgets.map((widget) => widget.name), ["sampling_mode", "sampling_mode.on"]);
});

test("#2035 timeout after a transient dynamic write does not invoke the post-flush rewrite", async () => {
  const dynamic = makeDynamicTextGenerate();
  const clock = fireableTimers();
  let releaseFlush;
  let flushStarted;
  const flushReady = new Promise((resolve) => {
    flushStarted = resolve;
  });
  const flushPending = new Promise((resolve) => {
    releaseFlush = resolve;
  });
  const pending = runSetWidget(
    dynamic.node,
    "sampling_mode",
    "off",
    widgetOpts({
      timeoutMs: 80,
      ackTimers: { setTimer: clock.setTimer, clearTimer: clock.clearTimer },
      awaitFrontendWidgetFlush: () => {
        flushStarted();
        return flushPending;
      },
    }),
  );

  await flushReady;
  assert.equal(dynamic.root.value, "off");
  assert.equal(dynamic.setterCalls, 1, "the first synchronous dynamic write must have landed");
  dynamic.forceValue("on");

  clock.fire();
  await assert.rejects(pending, /outcome is UNKNOWN.*NOT retried/i);
  releaseFlush();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dynamic.root.value, "on");
  assert.equal(dynamic.setterCalls, 1, "the timeout must suppress the existing post-flush rewrite");
});
