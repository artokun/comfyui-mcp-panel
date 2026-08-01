// Unit tests for web/js/lib/widget-null-safety.js — run with `node --test`.
//
// Guards the #445 crash: a workflow with null VHS_VideoCombine widget values
// (frame_rate:null, filename_prefix:null, pingpong:null, save_output:null) threw
// `Cannot read properties of null (reading 'replace')` inside app.queuePrompt's
// graph serialization, killing panel_run BEFORE it queued — even under
// "run to node" targeting an unrelated valid output. sanitizeNullWidgetValues
// null-safes the live graph before queueing so serialization can't crash.
import test from "node:test";
import assert from "node:assert/strict";

import {
  safeWidgetDefault,
  sanitizeNullWidgetValues,
  restoreWidgetValues,
  installGraphToPromptNullSafety,
} from "../../web/js/lib/widget-null-safety.js";

test("safeWidgetDefault prefers the widget's declared default", () => {
  assert.equal(safeWidgetDefault({ type: "text", options: { default: "AnimateDiff" } }), "AnimateDiff");
  assert.equal(safeWidgetDefault({ type: "number", options: { default: 16 } }), 16);
  assert.equal(safeWidgetDefault({ type: "toggle", options: { default: true } }), true);
  // A false / 0 default must be honoured (not treated as "missing").
  assert.equal(safeWidgetDefault({ type: "toggle", options: { default: false } }), false);
  assert.equal(safeWidgetDefault({ type: "number", options: { default: 0 } }), 0);
});

test("safeWidgetDefault falls back by widget type when no default is declared", () => {
  assert.equal(safeWidgetDefault({ type: "toggle" }), false);
  assert.equal(safeWidgetDefault({ type: "boolean" }), false);
  assert.equal(safeWidgetDefault({ type: "number" }), 0);
  assert.equal(safeWidgetDefault({ type: "number", options: { min: 8 } }), 8);
  assert.equal(safeWidgetDefault({ type: "slider", options: { min: -5 } }), -5);
  assert.equal(safeWidgetDefault({ type: "combo", options: { values: ["H.264", "H.265"] } }), "H.264");
  // A dynamic (function) combo provider is NOT invoked (side-effect/context risk).
  let invoked = false;
  assert.equal(
    safeWidgetDefault({ type: "combo", options: { values: () => { invoked = true; return ["a", "b"]; } } }),
    "",
  );
  assert.equal(invoked, false);
  // text / unknown / missing type → empty string keeps string ops safe.
  assert.equal(safeWidgetDefault({ type: "text" }), "");
  assert.equal(safeWidgetDefault({ type: "customtext" }), "");
  assert.equal(safeWidgetDefault({}), "");
  assert.equal(safeWidgetDefault(null), "");
});

// Mirror the reporter's graph: a valid target VHS node plus an UNUSED VHS node
// whose widgets serialized as null.
function vhsNode(id, values) {
  return {
    id,
    type: "VHS_VideoCombine",
    widgets: [
      { name: "frame_rate", type: "number", options: { default: 8 }, value: values.frame_rate },
      { name: "filename_prefix", type: "text", options: { default: "AnimateDiff" }, value: values.filename_prefix },
      { name: "pingpong", type: "toggle", options: { default: false }, value: values.pingpong },
      { name: "save_output", type: "toggle", options: { default: true }, value: values.save_output },
    ],
  };
}

test("sanitizeNullWidgetValues coerces every null/undefined widget and reports them", () => {
  const nulled = vhsNode(2, { frame_rate: null, filename_prefix: null, pingpong: null, save_output: undefined });
  const good = vhsNode(1, { frame_rate: 16, filename_prefix: "hero", pingpong: false, save_output: true });
  const graph = { _nodes: [good, nulled] };

  const fixed = sanitizeNullWidgetValues(graph);

  // Four repairs, all on the nulled node.
  assert.equal(fixed.length, 4);
  assert.ok(fixed.every((f) => f.nodeId === 2 && f.nodeType === "VHS_VideoCombine"));

  // Null values became their declared defaults; the good node is untouched.
  const byName = Object.fromEntries(nulled.widgets.map((w) => [w.name, w.value]));
  assert.equal(byName.frame_rate, 8);
  assert.equal(byName.filename_prefix, "AnimateDiff");
  assert.equal(byName.pingpong, false);
  assert.equal(byName.save_output, true);
  assert.equal(good.widgets.find((w) => w.name === "frame_rate").value, 16);

  // The actual crash: `.replace` on the former-null string widget must not throw.
  assert.doesNotThrow(() => byName.filename_prefix.replace(/x/g, "y"));
});

test("sanitizeNullWidgetValues descends into nested subgraphs", () => {
  const inner = vhsNode(99, { frame_rate: null, filename_prefix: null, pingpong: null, save_output: null });
  const host = { id: 10, type: "Subgraph", widgets: [], subgraph: { _nodes: [inner] } };
  const graph = { _nodes: [host] };

  const fixed = sanitizeNullWidgetValues(graph);

  assert.equal(fixed.length, 4);
  assert.ok(inner.widgets.every((w) => w.value !== null && w.value !== undefined));
});

test("sanitizeNullWidgetValues is a no-op on a clean graph and tolerates junk", () => {
  const clean = vhsNode(1, { frame_rate: 8, filename_prefix: "x", pingpong: false, save_output: true });
  assert.deepEqual(sanitizeNullWidgetValues({ _nodes: [clean] }), []);
  assert.deepEqual(sanitizeNullWidgetValues(null), []);
  assert.deepEqual(sanitizeNullWidgetValues({}), []);
  assert.deepEqual(sanitizeNullWidgetValues({ _nodes: [null, { widgets: null }, {}] }), []);
});

test("sanitizeNullWidgetValues leaves button widgets (no serializable value) alone", () => {
  const node = { id: 5, type: "SomeNode", widgets: [{ name: "run", type: "button", value: undefined }] };
  const fixed = sanitizeNullWidgetValues({ _nodes: [node] });
  assert.equal(fixed.length, 0);
  assert.equal(node.widgets[0].value, undefined);
});

test("restoreWidgetValues puts the exact prior values back (null and undefined preserved)", () => {
  const node = vhsNode(2, { frame_rate: null, filename_prefix: null, pingpong: null, save_output: undefined });
  const fixed = sanitizeNullWidgetValues({ _nodes: [node] });
  // Coerced during the window…
  assert.equal(node.widgets.find((w) => w.name === "filename_prefix").value, "AnimateDiff");
  restoreWidgetValues(fixed);
  // …then restored to the ORIGINAL semantic values, distinguishing null vs undefined.
  const byName = Object.fromEntries(node.widgets.map((w) => [w.name, w.value]));
  assert.equal(byName.frame_rate, null);
  assert.equal(byName.filename_prefix, null);
  assert.equal(byName.pingpong, null);
  assert.equal(byName.save_output, undefined);
});

test("overlapping passes are reference-counted — a value is not restored while another pass is live", () => {
  const node = vhsNode(2, { frame_rate: null, filename_prefix: null, pingpong: null, save_output: null });
  const graph = { _nodes: [node] };
  const fp = () => node.widgets.find((w) => w.name === "filename_prefix").value;

  const a = sanitizeNullWidgetValues(graph); // pass A coerces, count → 1
  const b = sanitizeNullWidgetValues(graph); // pass B joins, count → 2 (already coerced)
  assert.equal(a.length, 4);
  assert.equal(b.length, 4);
  assert.equal(fp(), "AnimateDiff");

  restoreWidgetValues(a); // count → 1: still coerced (B's serialization is protected)
  assert.equal(fp(), "AnimateDiff");

  restoreWidgetValues(b); // count → 0: now restored
  assert.equal(fp(), null);
});

test("a join RE-ASSERTS coercion if the value drifted back to null between passes", () => {
  const node = vhsNode(2, { frame_rate: null, filename_prefix: null, pingpong: null, save_output: null });
  const graph = { _nodes: [node] };
  const w = node.widgets.find((x) => x.name === "filename_prefix");

  const a = sanitizeNullWidgetValues(graph); // A: null → "AnimateDiff", count 1
  w.value = null; // a concurrent write drifts it back to null before B starts
  const b = sanitizeNullWidgetValues(graph); // B joins → must re-coerce so B can't serialize null
  assert.equal(w.value, "AnimateDiff");

  restoreWidgetValues(a);
  restoreWidgetValues(b); // count 0 → restored to original null
  assert.equal(w.value, null);
});

test("restore never clobbers an edit made during the serialization window", () => {
  const node = vhsNode(2, { frame_rate: null, filename_prefix: null, pingpong: null, save_output: null });
  const graph = { _nodes: [node] };
  const w = node.widgets.find((x) => x.name === "filename_prefix");

  const touched = sanitizeNullWidgetValues(graph); // null → "AnimateDiff"
  w.value = "user_edit"; // a concurrent edit during the awaited serialize
  restoreWidgetValues(touched); // value !== our coerced value → leave the edit alone

  assert.equal(w.value, "user_edit");
});

// A minimal fake `app` whose graphToPrompt mirrors ComfyUI's real one: it reads
// each widget's value via a VHS-like `serializeValue` that calls `.replace` — the
// exact operation that throws on null (executionUtil graphToPrompt line ~103).
function fakeApp(node) {
  const rootGraph = { _nodes: [node] };
  return {
    rootGraph,
    seenNull: false,
    async graphToPrompt(graph = this.rootGraph) {
      const out = {};
      for (const n of graph._nodes) {
        for (const w of n.widgets ?? []) {
          if (w.value === null || w.value === undefined) this.seenNull = true;
          // VHS_VideoCombine's serializeValue calls `.replace` DIRECTLY on the
          // filename_prefix value — throwing on null (the exact #445 crash).
          out[w.name] = w.name === "filename_prefix" ? w.value.replace(/\s+/g, "_") : w.value;
        }
      }
      return { output: out };
    },
  };
}

test("installGraphToPromptNullSafety makes graphToPrompt null-safe, then restores", async () => {
  const node = vhsNode(2, { frame_rate: null, filename_prefix: null, pingpong: null, save_output: null });
  const app = fakeApp(node);

  // Before the wrap, serializing the null graph throws exactly the #445 error.
  await assert.rejects(() => app.graphToPrompt(), /Cannot read properties of null|reading 'replace'/);

  assert.equal(installGraphToPromptNullSafety(app), true);
  app.seenNull = false; // reset after the pre-wrap throwing call

  // After the wrap: no throw, and the serialized prompt has coerced values.
  const prompt = await app.graphToPrompt();
  assert.equal(app.seenNull, false); // serialization never saw a null
  assert.equal(prompt.output.filename_prefix, "AnimateDiff");

  // The LIVE graph is byte-identical afterwards — the null "unset" is preserved.
  assert.ok(node.widgets.every((w) => w.value === null));
});

test("installGraphToPromptNullSafety restores even when the original serializer throws", async () => {
  const node = vhsNode(2, { frame_rate: null, filename_prefix: null, pingpong: null, save_output: null });
  const app = {
    rootGraph: { _nodes: [node] },
    async graphToPrompt() { throw new Error("serialize boom"); },
  };
  installGraphToPromptNullSafety(app);
  await assert.rejects(() => app.graphToPrompt(), /serialize boom/);
  assert.ok(node.widgets.every((w) => w.value === null)); // rolled back despite throw
});

test("installGraphToPromptNullSafety is idempotent and reversible-free", () => {
  const app = fakeApp(vhsNode(1, { frame_rate: 8, filename_prefix: "x", pingpong: false, save_output: true }));
  const first = app.graphToPrompt;
  installGraphToPromptNullSafety(app);
  const wrapped = app.graphToPrompt;
  assert.notEqual(wrapped, first); // wrapped once
  installGraphToPromptNullSafety(app);
  assert.equal(app.graphToPrompt, wrapped); // not double-wrapped
  // Nothing to wrap → false.
  assert.equal(installGraphToPromptNullSafety({}), false);
  assert.equal(installGraphToPromptNullSafety(null), false);
});
