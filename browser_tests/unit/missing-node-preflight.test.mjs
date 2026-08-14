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
  assert.match(src, /import \{[\s\S]*?unrunnableNodeIds,[\s\S]*?\} from "\.\/lib\/missing-node-preflight\.js";/);
  const at = src.indexOf("const built = await app.graphToPrompt();");
  assert.ok(at > 0, "the preflight must serialize the prompt itself");
  // Bounded by the pre-flight's OWN catch rather than a byte count. A fixed 600 excluded
  // `unrunnableNodeIds(built)` as soon as #1582 added a guard above it — reporting missing
  // wiring while the wiring was fine. The window exists to keep this assertion scoped to
  // the pre-flight block, and that block ends at its catch.
  const endOfTry = src.indexOf("} catch (err) {", at);
  assert.ok(endOfTry > at, "the pre-flight's try block must still be recognisable");
  const block = src.slice(at, endOfTry);
  assert.match(block, /unrunnableNodeIds\(built\)/);
  // The refuted approach must be gone entirely.
  assert.equal((src.match(/findUnregisteredTypes/g) ?? []).length, 0);
  assert.equal((src.match(/object_info\/\$\{encodeURIComponent\(cls\)\}/g) ?? []).length, 0);
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
