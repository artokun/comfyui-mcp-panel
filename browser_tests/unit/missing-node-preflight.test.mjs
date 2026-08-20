// comfyui-mcp#1460 — panel_load_workflow put pack nodes on the canvas, several were
// UNREGISTERED, and graph_run queued anyway and failed obscurely server-side.
//
// Measured on the rig: graphToPrompt INCLUDES a node whose type the frontend cannot
// resolve, emitting it with `class_type: undefined`. So the prompt leaves the browser
// carrying an entry the server cannot execute.
//
// The first cut probed /object_info per canvas node type. Review found that refuses
// runs that would have SUCCEEDED — virtual and frontend-only nodes have no object_info
// entry yet serialize away cleanly — which is strictly worse than the bug. These tests
// pin the serialized-prompt approach that replaced it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  unrunnableNodeIds,
  unrunnableNodeIdsInScope,
  describeUnrunnable,
  missingNodeRunRefusal,
} from "../../web/js/lib/missing-node-preflight.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const GOOD = { class_type: "KSampler", inputs: {} };

test("#1460 an entry with no class_type is caught", () => {
  // The measured shape: graphToPrompt emits class_type: undefined for an unresolved type.
  const prompt = { output: { 1: GOOD, 7: { class_type: undefined, inputs: {} } } };
  assert.deepEqual(unrunnableNodeIds(prompt), ["7"]);
});

test("#1460 a fully runnable prompt refuses nothing", () => {
  assert.deepEqual(unrunnableNodeIds({ output: { 1: GOOD, 2: GOOD } }), []);
});

test("#1460 both graphToPrompt shapes are accepted", () => {
  // Frontends differ: some callers hand over the whole result, some the output map.
  const bad = { class_type: undefined, inputs: {} };
  assert.deepEqual(unrunnableNodeIds({ output: { 3: bad } }), ["3"]);
  assert.deepEqual(unrunnableNodeIds({ 3: bad }), ["3"]);
});

test("#1460 an empty or unreadable prompt NEVER refuses", () => {
  // This gates a RUN. An input it cannot read must not become a refusal — that would
  // trade the reported failure for a worse one.
  for (const bad of [undefined, null, "", 0, [], { output: null }, { output: [] }]) {
    assert.deepEqual(unrunnableNodeIds(bad), [], JSON.stringify(bad));
  }
  // A POPULATED array is the case that matters: Object.entries walks it happily and
  // would manufacture a refusal out of a shape that is not a prompt at all. An empty
  // array cannot show that, which is why a mutation weakening this guard survived.
  const arrayish = [{ class_type: undefined, inputs: {} }, { class_type: "KSampler" }];
  assert.deepEqual(unrunnableNodeIds(arrayish), []);
  assert.deepEqual(unrunnableNodeIds({ output: arrayish }), []);
});

test("#1460 a blank or non-string class_type counts as unrunnable", () => {
  assert.deepEqual(unrunnableNodeIds({ output: { 1: { class_type: "" } } }), ["1"]);
  assert.deepEqual(unrunnableNodeIds({ output: { 1: { class_type: "   " } } }), ["1"]);
  assert.deepEqual(unrunnableNodeIds({ output: { 1: { class_type: 42 } } }), ["1"]);
});

test("#1460 VIRTUAL nodes cannot trip this — they are not in the prompt", () => {
  // The P0 the probing version had: Note/Reroute/PrimitiveNode have no /object_info
  // entry, so probing declared a canvas full of legitimate reroutes unrunnable.
  // graphToPrompt has already removed them, so there is nothing here to catch.
  const prompt = { output: { 1: GOOD, 2: GOOD } };
  assert.deepEqual(unrunnableNodeIds(prompt), []);
});

test("#1460 the canvas is consulted for LABELS only, never for the verdict", () => {
  const live = [{ id: 7, type: "ImpactWildcardEncode" }, { id: 1, type: "KSampler" }];
  assert.deepEqual(describeUnrunnable(["7"], live), [{ id: "7", type: "ImpactWildcardEncode" }]);
  // A node the graph cannot name STILL counts — reported by id.
  assert.deepEqual(describeUnrunnable(["9"], live), [{ id: "9", type: null }]);
  assert.deepEqual(describeUnrunnable(["9"], null), [{ id: "9", type: null }]);
  // A non-string type is not a label. Reporting `42` or an object in the refusal text
  // reads as a corrupted message; it must degrade to the id.
  assert.deepEqual(describeUnrunnable(["5"], [{ id: 5, type: 42 }]), [{ id: "5", type: null }]);
  assert.deepEqual(describeUnrunnable(["5"], [{ id: 5, type: {} }]), [{ id: "5", type: null }]);
  assert.deepEqual(describeUnrunnable(["5"], [{ id: 5, type: "" }]), [{ id: "5", type: null }]);
});

test("#1460 ids are matched as strings, so numeric graph ids resolve", () => {
  assert.deepEqual(describeUnrunnable(["7"], [{ id: 7, type: "Foo" }]), [
    { id: "7", type: "Foo" },
  ]);
});

test("#1460 the refusal says nothing was sent, and names the types", () => {
  const msg = missingNodeRunRefusal([
    { id: "7", type: "ImpactWildcardEncode" },
    { id: "8", type: null },
  ]);
  assert.match(msg, /^NOT queued:/); // the prefix the caller filters on
  assert.match(msg, /ImpactWildcardEncode \(node 7\)/);
  assert.match(msg, /node 8/);
  assert.match(msg, /Nothing was sent and the queue is\s+untouched/);
});

test("#1460 the refusal explains the cause and the way out", () => {
  const msg = missingNodeRunRefusal([{ id: "7", type: "Foo" }]);
  assert.match(msg, /not registered on this\s+ComfyUI/);
  assert.match(msg, /no class_type/);
  assert.match(msg, /install the pack/i);
  assert.match(msg, /restart ComfyUI/);
  // The escape hatch, so a caller with deliberately-optional nodes is not stuck.
  assert.match(msg, /bypass/);
});

test("#1460 a long list is bounded but says how many were withheld", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: String(i), type: `T${i}` }));
  const msg = missingNodeRunRefusal(many);
  assert.match(msg, /30 nodes/);
  assert.match(msg, /and 18 more/); // 12 shown
});

test("#1460 WIRING: the preflight reads the SERIALIZED prompt, not the canvas", () => {
  const src = readFileSync(join(ROOT, "web/js/comfyui-mcp-panel.js"), "utf8");
  assert.match(src, /import \{[\s\S]*?unrunnableNodeIdsInScope,[\s\S]*?\} from "\.\/lib\/missing-node-preflight\.js";/);
  const at = src.indexOf("const built = await app.graphToPrompt();");
  assert.ok(at > 0, "the preflight must serialize the prompt itself");
  // Bounded by the pre-flight's OWN catch rather than a byte count. A fixed 600 excluded
  // `unrunnableNodeIds(built)` as soon as #1582 added a guard above it — reporting missing
  // wiring while the wiring was fine. The window exists to keep this assertion scoped to
  // the pre-flight block, and that block ends at its catch.
  const endOfTry = src.indexOf("} catch (err) {", at);
  assert.ok(endOfTry > at, "the pre-flight's try block must still be recognisable");
  const block = src.slice(at, endOfTry);
  // comfyui-mcp#1871 - and the SCOPE must be handed to it. `unrunnableNodeIdsInScope(built)`
  // with the second argument dropped compiles, reads correctly, and silently restores the
  // unscoped refusal for every run-to-node; only naming `partialTargets` here can see that.
  assert.match(block, /unrunnableNodeIdsInScope\(built, partialTargets\)/);
  // The refuted approach must be gone entirely.
  assert.equal((src.match(/findUnregisteredTypes/g) ?? []).length, 0);
  assert.equal((src.match(/object_info\/\$\{encodeURIComponent\(cls\)\}/g) ?? []).length, 0);
});

// ── comfyui-mcp#1871: the refusal is narrowed to the requested branch, and to nothing
//    else. Each case below is a direction the narrowing could go wrong in.

const TWO_BRANCH = {
  output: {
    "43": { class_type: "PreviewImage", inputs: { images: ["44", 0] } },
    "44": { class_type: "EmptyImage", inputs: {} },
    "56": { inputs: { image: ["57", 0] } }, // pack absent ⇒ no class_type
    "57": { inputs: {} },
  },
};

test("#1871 a scoped run is refused only for unrunnable nodes inside its closure", () => {
  assert.deepEqual(unrunnableNodeIdsInScope(TWO_BRANCH, ["43"]), []);
  // …and the SAME prompt, targeted at the broken branch, still names both.
  assert.deepEqual(unrunnableNodeIdsInScope(TWO_BRANCH, ["56"]), ["56", "57"]);
});

test("#1871 the narrowing never applies to a full run", () => {
  for (const targets of [undefined, null, [], "43", 43]) {
    assert.deepEqual(
      unrunnableNodeIdsInScope(TWO_BRANCH, targets),
      ["56", "57"],
      `targets=${JSON.stringify(targets)} is not a scope`,
    );
  }
});

test("#1871 the narrowing never applies on a guess", () => {
  // A root that is not a key of this prompt makes the closure unknowable; the honest
  // answer is the one that already exists, not "probably fine".
  assert.deepEqual(unrunnableNodeIdsInScope(TWO_BRANCH, ["nope"]), ["56", "57"]);
  assert.deepEqual(unrunnableNodeIdsInScope(TWO_BRANCH, ["43", "nope"]), ["56", "57"]);
  assert.deepEqual(unrunnableNodeIdsInScope({ output: null }, ["43"]), []);
});

test("#1871 the result is always a SUBSET of the unscoped answer", () => {
  // The narrowing may only ever remove. A version that recomputed the list, or that
  // reported closure members rather than filtering, could add an id that is perfectly
  // runnable — and refuse a run for a node that has nothing wrong with it.
  const all = unrunnableNodeIds(TWO_BRANCH);
  for (const targets of [["43"], ["56"], ["44"], ["43", "56"], ["nope"], []]) {
    for (const id of unrunnableNodeIdsInScope(TWO_BRANCH, targets)) {
      assert.ok(all.includes(id), `${id} was invented for targets ${JSON.stringify(targets)}`);
    }
  }
});

test("#1871 a healthy graph is never refused, scoped or not", () => {
  const clean = { output: { "1": { class_type: "PreviewImage", inputs: { images: ["2", 0] } }, "2": { class_type: "EmptyImage", inputs: {} } } };
  assert.deepEqual(unrunnableNodeIdsInScope(clean, ["1"]), []);
  assert.deepEqual(unrunnableNodeIdsInScope(clean, undefined), []);
});

test("#1871 WIRING: the run-to-node target is RESOLVED before the pre-flight reads it", () => {
  // `partialTargets` is a `let` in graph_run. If the resolve block ever moves back below
  // the pre-flight, the call site hits the temporal dead zone — and the pre-flight's own
  // catch swallows everything that is not /^NOT queued:/, so a ReferenceError there does
  // not surface as an error at all: it silently disables the whole missing-node
  // pre-flight. Ordering is the only thing that stops that.
  const src = readFileSync(join(ROOT, "web/js/comfyui-mcp-panel.js"), "utf8");
  const runAt = src.indexOf("async graph_run({ batch_count, to_node_id }) {");
  assert.ok(runAt > 0, "graph_run must still be recognisable");
  const declared = src.indexOf("let partialTargets;", runAt);
  const assigned = src.indexOf("partialTargets = [res.execId];", runAt);
  const read = src.indexOf("unrunnableNodeIdsInScope(built, partialTargets)", runAt);
  assert.ok(declared > runAt, "partialTargets must be declared inside graph_run");
  assert.ok(assigned > declared, "the resolved target must be assigned to it");
  assert.ok(read > assigned, "the pre-flight must read it AFTER it is resolved, never before");
});

test("#1460 WIRING: it runs BEFORE the prompt is queued", () => {
  const src = readFileSync(join(ROOT, "web/js/comfyui-mcp-panel.js"), "utf8");
  const check = src.indexOf("const built = await app.graphToPrompt();");
  const queue = src.indexOf("app.queuePrompt", check);
  assert.ok(check > 0 && queue > check, "the check must precede queuePrompt");
});

test("#1460 WIRING: only our refusal propagates", () => {
  // A preflight that becomes a NEW failure mode is worse than no preflight.
  const src = readFileSync(join(ROOT, "web/js/comfyui-mcp-panel.js"), "utf8");
  assert.match(src, /\/\^NOT queued:\/\.test\(err\.message\)/);
});
