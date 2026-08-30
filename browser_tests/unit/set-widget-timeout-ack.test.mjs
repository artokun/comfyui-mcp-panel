/**
 * #2025 — a live-canvas panel_set_widget mutation that already landed must not
 * be reported as outcome-unknown when the command relay times out.
 *
 * The shipped graph_set_widget path budgets 80s; the outer relay reports 90s.
 * After the write lands, the handler result/ack must be flushed and correlated
 * once runSetWidget resolves. Defence-in-depth: when that wait times out after
 * delivery, an idempotent readback of the targeted widget returns
 * "applied and verified" when it equals the requested value.
 *
 * These drive the SHIPPED awaitSetWidgetAck / widgetWriteTimeoutReadback
 * functions (and runSetWidget through them) — not a mock of the unit under test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { runSetWidget, awaitSetWidgetAck } from "../../web/js/lib/set-widget.js";
import {
  honestWidgetAck,
  widgetWriteTimeoutReadback,
  APPLIED_AND_VERIFIED_NOTE,
} from "../../web/js/lib/delivery-ack.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_SRC = readFileSync(join(HERE, "../../web/js/comfyui-mcp-panel.js"), "utf8");
const SET_WIDGET_SRC = readFileSync(join(HERE, "../../web/js/lib/set-widget.js"), "utf8");

const REGISTRY = { LoraLoader: {} };
const FRESH = { LoraLoader: {} };
const freshOracle = { getFreshObjectInfo: async () => FRESH };

function makeLoraLoader(strength = 0.9) {
  const widget = { name: "strength_model", type: "number", value: strength };
  const node = { id: 12, type: "LoraLoader", widgets: [widget] };
  return { node, widget };
}

function fireableTimers() {
  const timers = [];
  return {
    timers,
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => {},
    fire: () => {
      assert.equal(timers.length, 1, "the outer wait must arm a timeout");
      timers[0]();
    },
  };
}

test("#2025 readback: a landed widget equals the request is applied and verified", () => {
  const out = widgetWriteTimeoutReadback({
    requested: 0.35,
    actual: 0.35,
    found: true,
    node_id: 12,
    widget: "strength_model",
    delivered: true,
  });
  assert.equal(out.applied, true);
  assert.equal(out.verified, true);
  assert.equal(out.set.value, 0.35);
  assert.equal(out.set.node_id, 12);
  assert.equal(out.set.widget, "strength_model");
  assert.equal(out.error, undefined);
  assert.equal(out.ack_note, APPLIED_AND_VERIFIED_NOTE);
  assert.match(String(out.ack_note), /applied and verified/i);
});

test("#2025 readback: a mismatch after delivery stays unknown, not applied", () => {
  const out = widgetWriteTimeoutReadback({
    requested: 0.35,
    actual: 0.9,
    found: true,
    node_id: 12,
    widget: "strength_model",
    delivered: true,
  });
  assert.equal(out.applied, false);
  assert.notEqual(out.verified, true);
  assert.match(String(out.error), /receipt|unknown|retry/i);
  assert.doesNotMatch(String(out.ack_note ?? ""), /applied and verified/i);
});

test("#2025 readback: an undelivered command never claims applied even if values match", () => {
  const out = widgetWriteTimeoutReadback({
    requested: 0.35,
    actual: 0.35,
    found: true,
    node_id: 12,
    widget: "strength_model",
    delivered: false,
  });
  assert.equal(out.applied, false);
  assert.notEqual(out.verified, true);
});

test("#2025 timeout after delivery: hanging handler + matching live widget is applied and verified", async () => {
  const { node } = makeLoraLoader(0.35);
  const never = new Promise(() => {});
  const clock = fireableTimers();
  const pending = awaitSetWidgetAck(never, {
    node,
    widget: "strength_model",
    requested: 0.35,
    timeoutMs: 80,
    delivered: true,
    timers: { setTimer: clock.setTimer, clearTimer: clock.clearTimer },
  });
  clock.fire();
  const out = await pending;
  assert.equal(out.applied, true, "a landed write is not outcome-unknown");
  assert.equal(out.verified, true);
  assert.equal(out.set.value, 0.35);
  assert.equal(out.set.node_id, 12);
  assert.equal(out.error, undefined);
  assert.match(String(out.ack_note), /applied and verified/i);
});

test("#2025 timeout after delivery: a mismatch keeps the inner refusal instead of inventing unknown", async () => {
  const { node } = makeLoraLoader(0.9);
  let rejectWrite;
  const hung = new Promise((_, reject) => {
    rejectWrite = reject;
  });
  const clock = fireableTimers();
  const pending = awaitSetWidgetAck(hung, {
    node,
    widget: "strength_model",
    requested: 0.35,
    timeoutMs: 80,
    delivered: true,
    timers: { setTimer: clock.setTimer, clearTimer: clock.clearTimer },
  });
  clock.fire();
  const early = await Promise.race([
    pending.then(() => "answered", () => "answered"),
    new Promise((resolve) => setTimeout(() => resolve("still waiting"), 20)),
  ]);
  assert.equal(early, "still waiting", "an unlanded write must not be rewritten as a timeout ack");
  rejectWrite(new Error("the value is not a valid option"));
  await assert.rejects(() => pending, /not a valid option/);
});

test("#2025 once runSetWidget resolves, the handler ack is flushed and correlated", async () => {
  const { node, widget } = makeLoraLoader(0.9);
  const res = await awaitSetWidgetAck(
    runSetWidget(node, "strength_model", 0.35, {
      registry: REGISTRY,
      ...freshOracle,
    }),
    {
      node,
      widget: "strength_model",
      requested: 0.35,
      timeoutMs: 1000,
    },
  );
  assert.equal(widget.value, 0.35, "the production write path must land the value");
  assert.equal(res.applied, true, "a resolved write must flush applied:true");
  assert.equal(res.set.value, 0.35);
  assert.equal(res.set.node_id, 12);
  assert.equal(res.set.widget, "strength_model");
  assert.equal(res.error, undefined);
});

test("#2025 a resolved receipt is flushed even without a live node readback", async () => {
  const set = { node_id: 12, widget: "strength_model", value: 0.35 };
  const out = await awaitSetWidgetAck(Promise.resolve({ set }), {
    timeoutMs: 50,
  });
  assert.equal(out.applied, true);
  assert.equal(out.set.value, 0.35);
  assert.equal(out.error, undefined);
  assert.deepEqual(honestWidgetAck({ set }).set, set);
});

test("#2025 a refused write is still a refusal, not a verified apply", async () => {
  await assert.rejects(
    () =>
      awaitSetWidgetAck(Promise.reject(new Error("strength_model is not a valid option")), {
        node: makeLoraLoader(0.9).node,
        widget: "strength_model",
        requested: 0.35,
        timeoutMs: 50,
      }),
    /not a valid option/,
  );
});

test("#2025 wiring: graph_set_widget threads the command budget into awaitSetWidgetAck", () => {
  const start = PANEL_SRC.indexOf("async graph_set_widget({");
  const end = PANEL_SRC.indexOf("\n  // artokun/comfyui-mcp#938", start);
  assert.ok(start >= 0, "graph_set_widget handler not found");
  assert.ok(end > start, "graph_set_widget handler boundary not found");
  const handler = PANEL_SRC.slice(start, end);
  assert.match(handler, /await runSetWidget\(node, widget, value, setWidgetOpts\)/);
  assert.match(handler, /timeoutMs:\s*budget\.bounded\(\)/);
  assert.match(SET_WIDGET_SRC, /return awaitSetWidgetAck\(/);
  assert.match(SET_WIDGET_SRC, /widgetWriteTimeoutReadback/);
  assert.match(SET_WIDGET_SRC, /from "\.\/delivery-ack\.js"/);
});
