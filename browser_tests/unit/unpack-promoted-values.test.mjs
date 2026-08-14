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
  findDivergentPromotedValues,
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
    assert.equal(res.unrecoverable.length, 1);
    assert.match(res.unrecoverable[0].reason, /rejected the write|did not retain the value/);
  }
});

test("#979 (codex): a setter that MUTATES then THROWS is rolled back, not left half-applied", () => {
  // The path the first version corrupted: assignment happened, the throw was caught,
  // the widget was reported unresolved — and left holding the new value, which the
  // unpack then made permanent. Silent destructive corruption on the error path.
  const inner = {
    name: "text",
    _v: "ORIGINAL",
    get value() {
      return this._v;
    },
    set value(v) {
      this._v = v; // applies…
      throw new Error("setter boom"); // …then fails
    },
  };
  const sgNode = { id: 5, widgets: [widget("text", "NEW")] };
  const res = materializePromotedValues(sgNode, resolverFor({ text: { node: { id: 9 }, widget: inner } }));
  assert.equal(inner._v, "ORIGINAL", "the widget is left exactly as it was found");
  assert.deepEqual(res.applied, []);
  assert.match(res.unrecoverable[0].reason, /inner widget rejected the write/);
});

test("#979 (codex): a COERCING setter is rolled back — a third value never reaches the graph", () => {
  // Worse than a rejection: the widget ends up holding something that was in neither
  // the rail nor the inner, and the unpack commits it.
  const inner = {
    name: "steps",
    _v: 20,
    get value() {
      return this._v;
    },
    set value(v) {
      this._v = Math.min(Number(v) || 0, 30); // clamps 45 -> 30
    },
  };
  const sgNode = { id: 5, widgets: [widget("steps", 45)] };
  const res = materializePromotedValues(sgNode, resolverFor({ steps: { node: { id: 9 }, widget: inner } }));
  assert.equal(inner._v, 20, "restored to what was found, not left at the clamped 30");
  assert.deepEqual(res.applied, []);
  assert.match(res.unrecoverable[0].reason, /inner widget did not retain the value/);
});

test("#979 (codex): one hostile widget costs its own entry, not every rail after it", () => {
  // A throwing accessor used to abort the whole loop: the remaining rails kept their
  // stale inner values AND the disclosure was suppressed, on a path that destroys the
  // subgraph regardless.
  const good = widget("text", "OLD");
  const hostile = {
    get name() {
      throw new Error("name boom");
    },
  };
  const sgNode = { id: 5, widgets: [hostile, widget("text", "NEW")] };
  const res = materializePromotedValues(sgNode, resolverFor({ text: { node: { id: 9 }, widget: good } }));
  assert.equal(good.value, "NEW", "the rail AFTER the hostile one was still carried");
  assert.deepEqual(res.applied.map((a) => a.widget), ["text"]);
  // codex final: a throwing accessor is UNRECOVERABLE, not a benign annotation. The
  // latch proves a write happened; its absence proves nothing, because the resolver
  // and the value getters all run before it — and an accessor that MUTATES and then
  // throws is precisely this module's stated threat model. On a destructive path an
  // exception means the state cannot be proven, and unprovable is treated as unsafe.
  assert.equal(res.unrecoverable.length, 1, "the hostile widget refuses the unpack");
  assert.match(res.unrecoverable[0].reason, /cannot be established|value from neither side/);
  assert.deepEqual(res.unresolved, [], "no longer filed as merely unresolved");
});

test("#979 (codex final): promoted-but-unresolvable REFUSES; definitively-not-promoted does not", () => {
  // Collapsing these was the last hole. `promoted: false` is proof the rail is an
  // ordinary widget — refusing over those would block healthy unpacks. `promoted: true`
  // with no usable target is an UNKNOWN, and its value may be diverged.
  const unknown = materializePromotedValues({ id: 5, widgets: [widget("text", "NEW")] }, () => ({
    promoted: true,
    target: null,
  }));
  assert.deepEqual(unknown.unresolved, []);
  assert.equal(unknown.unrecoverable.length, 1, "an unresolvable promotion must stop the unpack");
  assert.match(unknown.unrecoverable[0].reason, /could not be identified/);
  assert.equal(unknown.unrecoverable[0].value_restored, true, "nothing was written, so the graph is as found");

  const ordinary = materializePromotedValues({ id: 5, widgets: [widget("text", "NEW")] }, () => ({ promoted: false }));
  assert.deepEqual(ordinary.unrecoverable, [], "an ordinary widget is not a reason to refuse");
  assert.equal(ordinary.unresolved.length, 1);
});

test("#979 (codex final): an accessor that MUTATES then throws refuses — it is not swallowed", () => {
  // The internal catches used to file these as `unresolved`, so the unpack proceeded
  // over state nothing could prove. Each of the three pre-write reads is injected or
  // node-supplied code that can mutate on its way to throwing.
  let sideEffects = 0;
  const cases = {
    "resolver throws": {
      widgets: [widget("text", "NEW")],
      resolve: () => {
        sideEffects += 1;
        throw new Error("resolver mutated then threw");
      },
    },
    "rail getter throws": {
      widgets: [
        {
          name: "text",
          get value() {
            sideEffects += 1;
            throw new Error("rail getter mutated then threw");
          },
        },
      ],
      resolve: () => ({ promoted: true, target: { node: { id: 9 }, widget: widget("text", "OLD") } }),
    },
    "inner getter throws": {
      widgets: [widget("text", "NEW")],
      resolve: () => ({
        promoted: true,
        target: {
          node: { id: 9 },
          widget: {
            name: "text",
            get value() {
              sideEffects += 1;
              throw new Error("inner getter mutated then threw");
            },
            set value(_v) {},
          },
        },
      }),
    },
  };
  for (const [label, c] of Object.entries(cases)) {
    const res = materializePromotedValues({ id: 5, widgets: c.widgets }, c.resolve);
    assert.deepEqual(res.unresolved, [], `${label}: never benign`);
    assert.equal(res.unrecoverable.length, 1, `${label}: must refuse the unpack`);
  }
  assert.ok(sideEffects >= 3, "each case really did run the accessor");
});

test("#979 (codex final): the preflight refuses a promoted rail whose target cannot be identified", () => {
  const divergent = findDivergentPromotedValues({ id: 5, widgets: [widget("text", "NEW")] }, () => ({
    promoted: true,
    target: null,
  }));
  assert.equal(divergent.length, 1, "unknown promotion + no snapshot ⇒ refuse");
  assert.match(divergent[0].reason, /could not be identified/);
  // And a definitive non-promotion still does not block.
  assert.deepEqual(
    findDivergentPromotedValues({ id: 5, widgets: [widget("x", 1)] }, () => ({ promoted: false })),
    [],
  );
});

test("#979 (codex final): an INDETERMINATE resolver result refuses — only `promoted === false` is proof", () => {
  // Truthiness was too weak: `undefined`, `null`, `{}` and `{promoted: undefined}` are
  // all "I do not know", and treating them as ordinary widgets let a divergent value be
  // destroyed in BOTH modes — carried-with-snapshot and preflight-without.
  for (const result of [
    undefined,
    null,
    {},
    { promoted: undefined },
    { promoted: true, target: {} },
    // A widget with NO node: accepted before, so a malformed resolver could steer the
    // carry into a widget nothing owns — the write lands there and is reported as a
    // success while the unpack still inlines the real inner widget's old value.
    { promoted: true, target: { widget: { name: "text", value: "DECOY" } } },
    // …and the mirror image.
    { promoted: true, target: { node: { id: 9 } } },
  ]) {
    const res = materializePromotedValues({ id: 5, widgets: [widget("text", "NEW")] }, () => result);
    assert.deepEqual(res.unresolved, [], `snapshot mode: ${JSON.stringify(result)} must not be benign`);
    assert.equal(res.unrecoverable.length, 1, `snapshot mode: ${JSON.stringify(result)} must refuse`);

    const div = findDivergentPromotedValues({ id: 5, widgets: [widget("text", "NEW")] }, () => result);
    assert.equal(div.length, 1, `preflight mode: ${JSON.stringify(result)} must refuse`);
  }
  // The one benign shape, in both modes.
  const ok = materializePromotedValues({ id: 5, widgets: [widget("text", "NEW")] }, () => ({ promoted: false }));
  assert.equal(ok.unresolved.length, 1);
  assert.deepEqual(ok.unrecoverable, []);
  assert.deepEqual(
    findDivergentPromotedValues({ id: 5, widgets: [widget("text", "NEW")] }, () => ({ promoted: false })),
    [],
  );
});

test("#979 (codex final): an ITERATION-level throw is reported as aborted, not as no-work-done", () => {
  // Per-rail isolation does not cover the loop itself. An indexed getter that throws
  // after an earlier rail was carried used to escape the function, so the executor
  // discarded the whole record and unpacked anyway — destroying the very values this
  // protects. The partial carry must reach the caller as a refusal.
  const good = widget("text", "OLD");
  const rails = [widget("text", "NEW"), widget("other", 1)];
  const hostileList = new Proxy(rails, {
    get(target, key) {
      if (key === "1") throw new Error("index boom");
      return target[key];
    },
  });
  const sgNode = { id: 5, widgets: hostileList };
  const res = materializePromotedValues(sgNode, resolverFor({ text: { node: { id: 9 }, widget: good } }));
  assert.equal(res.aborted, true, "the caller must learn the loop came apart");
  assert.equal(good.value, "NEW", "and that work HAD already been done, which is why it matters");
});

test("#979 (codex final): a resolver that throws in the read-only preflight refuses, not skips", () => {
  // With no snapshot there is nothing to undo with, so an unknown promotion status is
  // exactly what must stop the unpack — skipping would destroy a divergent value with
  // no copy anywhere.
  const divergent = findDivergentPromotedValues({ id: 5, widgets: [widget("text", "NEW")] }, () => {
    throw new Error("resolver boom");
  });
  assert.equal(divergent.length, 1);
  assert.match(divergent[0].reason, /could not be resolved/);
});

test("#979 (codex): a throwing accessor on the REPORT metadata does not lose the transfer", () => {
  const inner = {
    _v: "OLD",
    get value() {
      return this._v;
    },
    set value(v) {
      this._v = v;
    },
    get name() {
      throw new Error("meta boom");
    },
  };
  const sgNode = { id: 5, widgets: [widget("text", "NEW")] };
  const res = materializePromotedValues(sgNode, resolverFor({ text: { node: { id: 9 }, widget: inner } }));
  assert.equal(inner._v, "NEW", "the value WAS carried — that must not be undone by a reporting failure");
  assert.equal(
    res.applied.length + res.unresolved.length + res.unrecoverable.length,
    1,
    "and it is accounted for exactly once, in whichever bucket",
  );
});

test("#979 (codex r2): a restore that ALSO normalizes is UNRECOVERABLE, not merely unresolved", () => {
  // The case the transactional restore alone did not cover: the setter clamps the
  // rail write (45 → 30) AND clamps the restore of the original (20 → 25). The widget
  // ends up holding a third value that was in neither the rail nor the inner, and
  // unpacking over it would make that invented value permanent.
  const inner = {
    name: "steps",
    _v: 20,
    get value() {
      return this._v;
    },
    set value(v) {
      this._v = Math.max(Math.min(Number(v) || 0, 30), 25); // clamps BOTH directions
    },
  };
  const sgNode = { id: 5, widgets: [widget("steps", 45)] };
  const res = materializePromotedValues(sgNode, resolverFor({ steps: { node: { id: 9 }, widget: inner } }));
  assert.deepEqual(res.applied, []);
  assert.deepEqual(res.unresolved, [], "this is NOT a mere annotation");
  assert.equal(res.unrecoverable.length, 1, "it is the condition that must stop the unpack");
  assert.match(res.unrecoverable[0].reason, /could not be restored/);
});

test("#979 (codex r2): a recoverable failure stays unresolved and does NOT stop the unpack", () => {
  // The boundary: a clean rollback is reported, but it is not a reason to refuse.
  const inner = {
    name: "steps",
    _v: 20,
    get value() {
      return this._v;
    },
    set value(v) {
      this._v = Number(v) === 45 ? 30 : Number(v); // clamps the write, restores cleanly
    },
  };
  const sgNode = { id: 5, widgets: [widget("steps", 45)] };
  const res = materializePromotedValues(sgNode, resolverFor({ steps: { node: { id: 9 }, widget: inner } }));
  assert.equal(inner._v, 20, "put back exactly");
  assert.equal(res.unrecoverable.length, 1);
  assert.equal(res.unrecoverable.length, 1, "codex r3: a clean scalar restore is still not proof the widget is recovered");
});

test("#979 (codex r2) source guard: the unpack REFUSES when a carry could not be rolled back", () => {
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const guard = src.indexOf("materialized?.unrecoverable?.length");
  const unpack = src.indexOf("graph.unpackSubgraph(node, { skipMissingNodes: true })");
  assert.ok(guard > 0, "the refusal must exist");
  assert.ok(guard < unpack, "and it must come BEFORE the destructive call");
  assert.match(src, /unpack_subgraph refused/, "and it refuses rather than annotating");
  assert.match(src, /nothing was destroyed/, "and says the subgraph is intact when it could restore");
});

test("#979 (codex r4): the write-attempt latch keeps a post-write throw UNRECOVERABLE", () => {
  // A setter can mutate and then a LATER read (read-back, metadata, any accessor) can
  // throw. The outer per-rail catch used to file that as a benign "could not inspect"
  // and let the unpack proceed over a widget that had already been written.
  let reads = 0;
  const inner = {
    _v: "OLD",
    get value() {
      reads += 1;
      if (reads > 1) throw new Error("read-back boom"); // throws AFTER the write
      return this._v;
    },
    set value(v) {
      this._v = v;
    },
  };
  const sgNode = { id: 5, widgets: [widget("text", "NEW")] };
  const res = materializePromotedValues(sgNode, resolverFor({ text: { node: { id: 9 }, widget: inner } }));
  assert.deepEqual(res.applied, []);
  assert.deepEqual(res.unresolved, [], "a post-write throw is never benign");
  assert.equal(res.unrecoverable.length, 1, "it stops the unpack");
});

test("#979 (codex r4): findDivergentPromotedValues is READ-ONLY and finds the divergence", () => {
  // Used when no rollback snapshot exists, so it must not write anything.
  let writes = 0;
  const inner = {
    name: "text",
    _v: "OLD",
    get value() {
      return this._v;
    },
    set value(v) {
      writes += 1;
      this._v = v;
    },
  };
  const sgNode = { id: 5, widgets: [widget("text", "NEW")] };
  const divergent = findDivergentPromotedValues(sgNode, resolverFor({ text: { node: { id: 9 }, widget: inner } }));
  assert.deepEqual(divergent, [{ widget: "text" }]);
  assert.equal(writes, 0, "READ-ONLY — it runs where a failed write could not be undone");
  assert.equal(inner._v, "OLD");
});

test("#979 (codex r4): no divergence ⇒ nothing to refuse over", () => {
  const inner = widget("text", "SAME");
  const sgNode = { id: 5, widgets: [widget("text", "SAME")] };
  assert.deepEqual(findDivergentPromotedValues(sgNode, resolverFor({ text: { node: { id: 9 }, widget: inner } })), []);
  // A rail that is not a promotion is not a divergence either.
  assert.deepEqual(findDivergentPromotedValues({ id: 5, widgets: [widget("x", 1)] }, resolverFor({})), []);
  assert.deepEqual(findDivergentPromotedValues(null, resolverFor({})), []);
});

test("#979 (codex final) source guard: an aborted or thrown carry refuses instead of unpacking", () => {
  // The worst case codex found: the carry throws at iteration level AFTER carrying a
  // rail, the executor discards the record, and unpacks anyway. The refusal must key
  // on the carry having FAILED, not only on it having produced findings.
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  assert.match(src, /carryFailed = !!materialized\?\.aborted/, "an aborted iteration is a failure");
  assert.match(src, /carryFailed = true/, "and so is a throw escaping the carry");
  const guard = src.indexOf("if (carryFailed || materialized?.unrecoverable?.length)");
  const unpack = src.indexOf("graph.unpackSubgraph(node, { skipMissingNodes: true })");
  assert.ok(guard > 0, "the refusal must key on carryFailed, not only on findings");
  assert.ok(guard < unpack, "and precede the destructive call");
});

test("#979 (codex r4) source guard: no snapshot ⇒ preflight refuses rather than losing values", () => {
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const preflight = src.indexOf("findDivergentPromotedValues(node,");
  const unpack = src.indexOf("graph.unpackSubgraph(node, { skipMissingNodes: true })");
  assert.ok(preflight > 0 && preflight < unpack, "the preflight must run before the destructive call");
  assert.match(src, /could not be snapshotted/, "and it says why it refused");
  assert.match(src, /Nothing was ` \+\s*`changed/, "and that nothing was changed");
});

test("#979 a THROWING resolver REFUSES the unpack (contract tightened by codex final)", () => {
  // This test originally asserted the opposite — that a throwing resolver merely cost
  // coverage and the unpack continued. That was the hole: the resolver is injected
  // code running against the live graph, and one that mutates before throwing left
  // the unpack to proceed over state nothing could prove.
  const sgNode = { id: 5, widgets: [widget("text", "NEW")] };
  const res = materializePromotedValues(sgNode, () => {
    throw new Error("resolver boom");
  });
  assert.deepEqual(res.applied, []);
  assert.deepEqual(res.unresolved, []);
  assert.equal(res.unrecoverable.length, 1);
  assert.match(res.unrecoverable[0].reason, /cannot be established/);
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
