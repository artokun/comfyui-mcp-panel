/**
 * #979 — panel_unpack_subgraph replaced promoted widget values with the inner nodes'
 * defaults: a long custom prompt became a pack's template text, a duration of 15
 * became 2.
 *
 * MEASURED on ComfyUI 0.31.1 / frontend 1.48.7, forcing rail and inner to differ:
 *
 *   before unpack:  rail = "RAIL-VALUE-THE-USER-SET"   inner = "ORIGINAL-INNER"
 *   after  unpack:  "ORIGINAL-INNER"
 *
 * `unpackSubgraph` inlines the INNER value and drops the parent rail's. #366 makes
 * the rail authoritative — it is what serializes at queue time — so the fix carries
 * rail → inner BEFORE the unpack, which is destructive and cannot be undone from its
 * own result.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  materializePromotedValues,
  materializedValuesNote,
} from "../../web/js/lib/unpack-promoted-values.js";

const widget = (name, value) => ({ name, value });
/** A resolver in the shape resolvePromotedInnerTarget returns. */
const resolverFor = (map) => (_sgNode, widgetName) => {
  const hit = map[widgetName];
  return hit ? { promoted: true, target: { node: hit.node, widget: hit.widget } } : { promoted: false };
};

test("#979 a diverged promoted value is carried into the inner widget", () => {
  const inner = widget("text", "ORIGINAL-INNER");
  const sgNode = { id: 5, widgets: [widget("text", "RAIL-VALUE-THE-USER-SET")] };
  const res = materializePromotedValues(sgNode, resolverFor({ text: { node: { id: 9 }, widget: inner } }));
  assert.equal(inner.value, "RAIL-VALUE-THE-USER-SET", "the value that would have rendered is the one kept");
  assert.deepEqual(res.applied, [{ widget: "text", node_id: "9", inner_widget: "text" }]);
  assert.deepEqual(res.unresolved, []);
});

test("#979 the reporter's two shapes: a long prompt and a numeric duration", () => {
  const prompt = widget("prompt", "Vaporwave template default");
  const duration = widget("value", 2);
  const sgNode = {
    id: 105,
    widgets: [widget("prompt", "a long custom cosmic prompt"), widget("value_1", 15)],
  };
  const res = materializePromotedValues(
    sgNode,
    resolverFor({
      prompt: { node: { id: 134 }, widget: prompt },
      value_1: { node: { id: 136 }, widget: duration },
    }),
  );
  assert.equal(prompt.value, "a long custom cosmic prompt");
  assert.equal(duration.value, 15);
  assert.equal(res.applied.length, 2);
});

test("#979 a value that already matches is NOT rewritten — no callback fired for a no-op", () => {
  // The unpack path is about to restructure the graph; firing node callbacks for
  // values that never changed is gratuitous risk on the way there.
  let writes = 0;
  const inner = {
    name: "text",
    _v: "same",
    get value() {
      return this._v;
    },
    set value(v) {
      writes += 1;
      this._v = v;
    },
  };
  const sgNode = { id: 5, widgets: [widget("text", "same")] };
  const res = materializePromotedValues(sgNode, resolverFor({ text: { node: { id: 9 }, widget: inner } }));
  assert.equal(writes, 0, "no write for an identical value");
  assert.equal(res.skipped, 1);
  assert.deepEqual(res.applied, []);
});

test("#979 a rail widget that resolves to NO promotion is left alone and reported", () => {
  // Not every widget on a subgraph node is a promotion. Writing one that could not be
  // resolved would be #233's silent-corruption class, pointed inward.
  const sgNode = { id: 5, widgets: [widget("not_promoted", "x")] };
  const res = materializePromotedValues(sgNode, resolverFor({}));
  assert.deepEqual(res.applied, []);
  assert.deepEqual(res.unresolved, [{ widget: "not_promoted" }]);
});

test("#979 an inner widget that REJECTS or ignores the write is reported, never claimed as carried", () => {
  const frozen = Object.freeze({ name: "text", value: "ORIGINAL" });
  const ignoring = {
    name: "text",
    get value() {
      return "ORIGINAL";
    },
    set value(_v) {
      /* silently drops it */
    },
  };
  for (const inner of [frozen, ignoring]) {
    const sgNode = { id: 5, widgets: [widget("text", "NEW")] };
    const res = materializePromotedValues(sgNode, resolverFor({ text: { node: { id: 9 }, widget: inner } }));
    assert.deepEqual(res.applied, [], "a value that did not land is never reported as preserved");
    assert.equal(res.unresolved.length, 1);
    assert.match(res.unresolved[0].reason, /rejected the write|did not retain the value/);
  }
});

test("#979 a THROWING resolver costs coverage, never the unpack", () => {
  const sgNode = { id: 5, widgets: [widget("text", "NEW")] };
  const res = materializePromotedValues(sgNode, () => {
    throw new Error("resolver boom");
  });
  assert.deepEqual(res.applied, []);
  assert.deepEqual(res.unresolved, [{ widget: "text" }]);
});

test("#979 malformed input yields nothing and never throws", () => {
  for (const bad of [null, undefined, {}, { widgets: "nope" }, { widgets: [null, {}, { name: 7 }] }]) {
    assert.doesNotThrow(() => materializePromotedValues(bad, resolverFor({})));
    assert.deepEqual(materializePromotedValues(bad, resolverFor({})).applied, []);
  }
  assert.deepEqual(materializePromotedValues({ widgets: [widget("a", 1)] }, null).applied, []);
});

test("#979 the note discloses what moved, and stays silent when nothing did", () => {
  const inner = widget("text", "OLD");
  const sgNode = { id: 5, widgets: [widget("text", "NEW")] };
  const res = materializePromotedValues(sgNode, resolverFor({ text: { node: { id: 9 }, widget: inner } }));
  const note = materializedValuesNote(res);
  assert.match(note, /Carried 1 promoted widget value/);
  assert.match(note, /text → node 9/, "names what moved and where it went");
  assert.match(note, /serializes at queue time/, "says WHY the parent's value is the one kept");
  assert.equal(materializedValuesNote({ applied: [], unresolved: [], skipped: 3 }), "", "silent when nothing moved");
  assert.equal(materializedValuesNote(null), "");
});

test("#979 the note warns that unresolved widgets cannot be checked afterwards", () => {
  const note = materializedValuesNote({ applied: [], unresolved: [{ widget: "seed" }] });
  assert.match(note, /could not be matched/);
  assert.match(note, /unpack cannot be undone/, "the reason to check now rather than later");
});

test("#979 source guard: the unpack path materializes BEFORE it unpacks, and discloses", () => {
  // Order is the whole fix — running it after the unpack would read a rail that no
  // longer exists. The executor lives inside the monolith's switch, so this is
  // asserted against the shipped source.
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const materialize = src.indexOf("materialized = materializePromotedValues(node,");
  const unpack = src.indexOf("graph.unpackSubgraph(node, { skipMissingNodes: true })");
  assert.ok(materialize > 0, "the unpack path must carry promoted values");
  assert.ok(unpack > 0, "the unpack call must still be there");
  assert.ok(materialize < unpack, "and the carry must happen BEFORE the unpack");
  assert.match(src, /promoted_values_carried/, "and the result discloses what was carried");
});
