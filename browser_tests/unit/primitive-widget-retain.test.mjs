/**
 * #1922 — `panel_set_widget` on a just-added PrimitiveStringMultiline can report
 * success while a later frontend init (Vue mount / widget-value store) still
 * replaces `value` with "". Repeating the identical write then sticks.
 *
 * These drive `runSetWidget()`, the SAME async unit `graph_set_widget` delegates
 * to, so the production write path is exercised — not a parallel reimplementation.
 *
 * The unfixed race is: immediate verification sees the new string, the call
 * returns ok, then a microtask+rAF initializer writes the empty default back.
 * After that later init, the test requires either (a) the written value is still
 * there or (b) the call threw. Success-then-empty is the lie this issue forbids.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { runSetWidget, awaitFrontendWidgetFlush } from "../../web/js/lib/set-widget.js";

const PANEL_SRC = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");

const REGISTRY = { PrimitiveStringMultiline: {} };
const FRESH = { PrimitiveStringMultiline: {} };
const freshOracle = { getFreshObjectInfo: async () => FRESH };

// The reporter's payload: a Windows glob written to a brand-new multiline primitive.
const PATH = "X:\\root\\extra*\\**\\*";

function makePrimitive(initial = "") {
  let current = initial;
  const widget = {
    name: "value",
    type: "customtext",
    get value() {
      return current;
    },
    set value(next) {
      current = next;
    },
  };
  const node = {
    id: 12,
    type: "PrimitiveStringMultiline",
    widgets: [widget],
  };
  return { node, widget, read: () => current, write: (next) => { current = next; } };
}

async function drainFrontend() {
  await new Promise((resolve) => queueMicrotask(resolve));
  await new Promise((resolve) => queueMicrotask(resolve));
  await new Promise((resolve) => queueMicrotask(resolve));
}

test("graph_set_widget still delegates the write to runSetWidget", () => {
  const start = PANEL_SRC.indexOf("async graph_set_widget({");
  const end = PANEL_SRC.indexOf("\n  // artokun/comfyui-mcp#938", start);
  assert.ok(start >= 0, "graph_set_widget handler not found");
  assert.ok(end > start, "graph_set_widget handler boundary not found");
  const handler = PANEL_SRC.slice(start, end);
  assert.ok(
    handler.includes("await runSetWidget(node, widget, value, setWidgetOpts)"),
    "the shipped handler must still await runSetWidget — a bypass would skip #1922's flush",
  );
});

test("#1922: a later empty init cannot ride on a successful first write", async () => {
  const { node, widget, read, write } = makePrimitive("");
  let initRan = false;
  const frontendInit = () => {
    if (initRan) return;
    initRan = true;
    write("");
  };

  let thrown = null;
  let res = null;
  try {
    res = await runSetWidget(node, "value", PATH, {
      registry: REGISTRY,
      ...freshOracle,
      awaitFrontendWidgetFlush: async () => {
        frontendInit();
      },
    });
  } catch (err) {
    thrown = err;
  }
  // The real frontend init is not owned by the write: if production returned
  // before waiting, this is the overwrite the reporter then read.
  frontendInit();
  await drainFrontend();

  if (thrown) {
    assert.match(
      String(thrown.message),
      /did not retain|frontend widget store/i,
      "a refusal must name the retention failure, not some unrelated gate",
    );
  } else {
    assert.equal(res?.set?.value, PATH);
    assert.equal(read(), PATH, "must not report success then lose the value to frontend init");
    assert.equal(widget.value, PATH);
  }
});

test("#1922: the first write is retained when init overwrites once then settles", async () => {
  const { node, read, write } = makePrimitive("");
  let initRan = false;
  const res = await runSetWidget(node, "value", PATH, {
    registry: REGISTRY,
    ...freshOracle,
    awaitFrontendWidgetFlush: async () => {
      if (initRan) return;
      initRan = true;
      write("");
    },
  });
  assert.equal(res.set.value, PATH);
  assert.equal(read(), PATH);
});

test("#1922: a store that keeps reverting refuses instead of reporting success", async () => {
  const { node, write, read } = makePrimitive("");
  await assert.rejects(
    () =>
      runSetWidget(node, "value", PATH, {
        registry: REGISTRY,
        ...freshOracle,
        awaitFrontendWidgetFlush: async () => {
          write("");
        },
      }),
    (err) => {
      assert.match(String(err.message), /did not retain|frontend widget store/i);
      assert.equal(read(), "", "the lying success path is the one that returns ok while empty");
      return true;
    },
  );
});

test("#1922: an ordinary write is unchanged when nothing overwrites after the flush", async () => {
  const { node, read } = makePrimitive("old");
  const res = await runSetWidget(node, "value", PATH, {
    registry: REGISTRY,
    ...freshOracle,
  });
  assert.equal(res.set.value, PATH);
  assert.equal(res.set.previous, "old");
  assert.equal(read(), PATH);
});

test("#1922: the default flush observes an rAF overwrite the immediate check would miss", async () => {
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (cb) => {
    queueMicrotask(() => cb(0));
    return 1;
  };
  try {
    const primitive = makePrimitive("");
    let armed = false;
    Object.defineProperty(primitive.widget, "value", {
      configurable: true,
      enumerable: true,
      get() {
        return primitive.read();
      },
      set(next) {
        primitive.write(next);
        if (next === PATH && !armed) {
          armed = true;
          requestAnimationFrame(() => {
            if (primitive.read() === PATH) primitive.write("");
          });
        }
      },
    });

    const res = await runSetWidget(primitive.node, "value", PATH, {
      registry: REGISTRY,
      ...freshOracle,
    });
    await drainFrontend();
    assert.equal(res.set.value, PATH);
    assert.equal(primitive.read(), PATH, "default flush must see the rAF init overwrite");
  } finally {
    if (previousRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousRaf;
  }
});

test("#1922: awaitFrontendWidgetFlush waits for a queued animation frame", async () => {
  const previousRaf = globalThis.requestAnimationFrame;
  const calls = [];
  globalThis.requestAnimationFrame = (cb) => {
    calls.push(cb);
    queueMicrotask(() => cb(0));
    return calls.length;
  };
  try {
    let sawFrame = false;
    requestAnimationFrame(() => {
      sawFrame = true;
    });
    await awaitFrontendWidgetFlush();
    assert.equal(sawFrame, true, "the production flush must not resolve before rAF");
    assert.ok(calls.length >= 1);
  } finally {
    if (previousRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousRaf;
  }
});
