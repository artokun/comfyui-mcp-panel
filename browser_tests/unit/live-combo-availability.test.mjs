// panel#745 — panel_get_errors omitted a missing model on a node added AFTER the
// workflow loaded. #774 disclosed the blind spot and deliberately left the scan
// undone, because judging combo values wrongly would report every combo on the
// canvas as missing — worse than the omission. These tests pin the two rules that
// make the scan safe:
//
//   1. UNKNOWN never becomes a finding. A class that will not resolve is reported
//      as unchecked, not as healthy and not as missing.
//   2. An EMPTY option list is a real answer, not an unknown one. The server
//      enumerating zero loras means every lora value is unavailable — which is
//      the reporter's exact case: they set a basename while the dropdown was empty.
//
// The input shapes below were verified against a live ComfyUI:
//   LoraLoaderModelOnly.lora_name -> COMBO, 95 options
//   LoraLoaderModelOnly.model     -> "MODEL"
//   /api/object_info/NoSuchClass  -> HTTP 200 with body {}

import assert from "node:assert/strict";
import test from "node:test";

import {
  scanComboAvailability,
  comboInputsOf,
  optionsLookLikeFiles,
  comboAvailabilityNote,
  linkDrivenWidgetNames,
} from "../../web/js/lib/live-combo-availability.js";

/** An /object_info/<class> body in the verified shape. */
const classBody = (name, required) => ({ [name]: { input: { required } } });

const LORA = classBody("LoraLoaderModelOnly", {
  model: ["MODEL", {}],
  lora_name: [["a.safetensors", "b.safetensors"], {}],
  strength_model: ["FLOAT", {}],
});

const SAMPLER = classBody("KSampler", {
  sampler_name: [["euler", "dpmpp_2m"], {}],
});

const EMPTY_LORA = classBody("LoraLoaderModelOnly", { lora_name: [[], {}] });

const node = (id, type, widgets) => ({ id, type, widgets });

test("#745 a value the server DOES offer is not reported", async () => {
  const r = await scanComboAvailability(
    [node(1, "LoraLoaderModelOnly", [{ name: "lora_name", value: "a.safetensors" }])],
    async () => LORA,
  );
  assert.deepEqual(r.unavailable, []);
  assert.deepEqual(r.unknown, []);
});

test("#745 the reporter's case: a value added after load, not among the options", async () => {
  const r = await scanComboAvailability(
    [node(12, "LoraLoaderModelOnly", [{ name: "lora_name", value: "krea2_realism_lora.safetensors" }])],
    async () => LORA,
  );
  assert.equal(r.unavailable.length, 1);
  assert.equal(r.unavailable[0].id, 12);
  assert.equal(r.unavailable[0].widget, "lora_name");
  assert.equal(r.unavailable[0].value, "krea2_realism_lora.safetensors");
  assert.equal(r.unavailable[0].kind, "missing_asset");
});

test("#745 an EMPTY option list is a real answer, not an unknown one", async () => {
  // The dropdown was empty because nothing is installed. That is the server
  // saying "there are none", so the value IS unavailable. Treating it as
  // unknown here would silently reproduce the omission this fix exists to close.
  const r = await scanComboAvailability(
    [node(12, "LoraLoaderModelOnly", [{ name: "lora_name", value: "anything.safetensors" }])],
    async () => EMPTY_LORA,
  );
  assert.equal(r.unavailable.length, 1);
  assert.equal(r.unavailable[0].kind, "missing_asset");
  assert.equal(r.unavailable[0].option_count, 0);
  assert.deepEqual(r.unknown, []);
});

test("#745 an ABSENT class is UNKNOWN — never a finding, never healthy", async () => {
  // /object_info/<absent> answers `{}` with HTTP 200, not a 404. If that collapsed
  // into "no combos", every widget on the node would pass as fine; if it collapsed
  // into "not in options", every widget would be reported missing. Both are the
  // mass-false-positive failure #774 stopped for.
  const r = await scanComboAvailability(
    [node(7, "SomePackNode", [{ name: "ckpt_name", value: "x.safetensors" }])],
    async () => ({}),
  );
  assert.deepEqual(r.unavailable, []);
  assert.equal(r.unknown.length, 1);
  assert.equal(r.unknown[0].id, 7);
  assert.match(r.unknown[0].reason, /not found in \/object_info/);
});

test("#745 a fetch that THROWS is unknown, not a crash and not a finding", async () => {
  const r = await scanComboAvailability(
    [node(3, "LoraLoaderModelOnly", [{ name: "lora_name", value: "z.safetensors" }])],
    async () => { throw new Error("network down"); },
  );
  assert.deepEqual(r.unavailable, []);
  assert.equal(r.unknown.length, 1);
});

test("#745 a non-combo input is never judged", async () => {
  // `model: ["MODEL", {}]` enumerates nothing. Comparing a value against it would
  // report every typed input on the canvas.
  const r = await scanComboAvailability(
    [node(1, "LoraLoaderModelOnly", [{ name: "model", value: "whatever" }])],
    async () => LORA,
  );
  assert.deepEqual(r.unavailable, []);
});

test("#745 a bad MODE value is an invalid value, not a missing asset", async () => {
  // Calling a bad scheduler a "missing model" would be its own dishonest report.
  const r = await scanComboAvailability(
    [node(5, "KSampler", [{ name: "sampler_name", value: "not_a_sampler" }])],
    async () => SAMPLER,
  );
  assert.equal(r.unavailable.length, 1);
  assert.equal(r.unavailable[0].kind, "invalid_value");
});

test("#745 one fetch per distinct CLASS, not per node", async () => {
  // Thirty KSamplers must not become thirty requests.
  const seen = [];
  const nodes = Array.from({ length: 30 }, (_, i) =>
    node(i, "LoraLoaderModelOnly", [{ name: "lora_name", value: "a.safetensors" }]));
  await scanComboAvailability(nodes, async (cls) => { seen.push(cls); return LORA; });
  assert.equal(seen.length, 1);
});

test("#745 empty / malformed input is answered with empty, never a throw", async () => {
  assert.deepEqual(await scanComboAvailability(null, async () => LORA), { unavailable: [], unknown: [] });
  assert.deepEqual(await scanComboAvailability([], null), { unavailable: [], unknown: [] });
  assert.deepEqual(
    await scanComboAvailability([node(1, "X", null)], async () => LORA),
    { unavailable: [], unknown: [] },
  );
});

test("#745 comboInputsOf separates absent (null) from present-with-no-combos (empty)", async () => {
  assert.equal(comboInputsOf({}, "Nope"), null);
  assert.equal(comboInputsOf(null, "Nope"), null);
  const none = comboInputsOf(classBody("T", { x: ["INT", {}] }), "T");
  assert.ok(none instanceof Map);
  assert.equal(none.size, 0);
});

test("#745 optional combos are judged too", async () => {
  const body = { T: { input: { optional: { lora_name: [["a.safetensors"], {}] } } } };
  const r = await scanComboAvailability(
    [node(1, "T", [{ name: "lora_name", value: "b.safetensors" }])],
    async () => body,
  );
  assert.equal(r.unavailable.length, 1);
});

test("#745 file-likeness is read from the OPTIONS, not the input name", async () => {
  assert.equal(optionsLookLikeFiles(["a.safetensors", "b.ckpt"]), true);
  assert.equal(optionsLookLikeFiles(["euler", "dpmpp_2m"]), false);
  assert.equal(optionsLookLikeFiles([]), false);
  assert.equal(optionsLookLikeFiles(null), false);
});

test("#745 the note says the scan is LIVE — the whole point of it", async () => {
  const note = comboAvailabilityNote([{ kind: "missing_asset" }]);
  assert.match(note, /object_info/);
  assert.match(note, /DOES see nodes added this session/);
  assert.match(note, /unchecked_nodes/);
  // The scan reads the graph level currently in view. Not saying so would let an
  // empty list read as proof about nodes inside a subgraph it never looked at —
  // the same silent-omission shape #745 is about.
  assert.match(note, /inside a subgraph you are not in are NOT scanned/);
  assert.equal(comboAvailabilityNote([]), "");
});

test("#745 past the class cap, nodes are UNCHECKED and the reply says so", async () => {
  // A truncated scan that silently skipped the rest would read exactly like a
  // clean one — the same collapse this whole module exists to avoid.
  const nodes = Array.from({ length: 5 }, (_, i) =>
    node(i, `Class${i}`, [{ name: "lora_name", value: "missing.safetensors" }]));
  const r = await scanComboAvailability(
    nodes,
    async (cls) => ({ [cls]: { input: { required: { lora_name: [["a.safetensors"], {}] } } } }),
    { maxClasses: 2 },
  );
  assert.equal(r.unavailable.length, 2);
  assert.equal(r.unknown.length, 3);
  assert.equal(r.unchecked_class_limit, 2);
})

test("#745 an exhausted BUDGET leaves nodes unchecked, never silently clean", async () => {
  // Overrunning get_errors' shared budget is a "did not reply" that strands the
  // agent with no error surface at all (#589) — strictly worse than the omission.
  // So the scan stops, and says it stopped.
  let clock = 0
  const r = await scanComboAvailability(
    Array.from({ length: 4 }, (_, i) =>
      node(i, `C${i}`, [{ name: "lora_name", value: "missing.safetensors" }])),
    async (cls) => { clock += 50; return { [cls]: { input: { required: { lora_name: [["a.safetensors"], {}] } } } } },
    { budgetMs: 60, now: () => clock },
  )
  assert.equal(r.unchecked_budget_exhausted, true)
  assert.ok(r.unknown.length > 0, "the classes it never reached must be reported unchecked")
  assert.match(r.unknown[0].reason, /budget/, "a budget cutoff must not be reported as a missing node type")
  assert.ok(r.unavailable.length < 4, "it must actually have stopped early")
})

test("#745 WIRING: get_errors actually calls the scan, inside its budget", async () => {
  // A green module suite proves nothing about the call site — #792 shipped two
  // features whose transport was dead while every unit test passed.
  const { readFileSync } = await import("node:fs")
  const { fileURLToPath } = await import("node:url")
  const { dirname, join } = await import("node:path")
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, "../../web/js/comfyui-mcp-panel.js"), "utf8")

  assert.match(src, /import \{[\s\S]{0,200}?scanComboAvailability,[\s\S]{0,200}?comboAvailabilityNote,[\s\S]{0,200}?\} from "\.\/lib\/live-combo-availability\.js"/)
  // It must draw from the SHARED budget, not run unbounded.
  assert.match(src, /errorsStepBudget\(GET_ERRORS_STEP_CAP_MS\)[\s\S]{0,400}scanComboAvailability/)
  // …and it must be emitted, with the unchecked list alongside it.
  assert.match(src, /unavailable_widget_values: liveScan\.unavailable/)
  assert.match(src, /unchecked_nodes: liveScan\.unknown/)
})

// ---------------------------------------------------------------------------
// #984 — a widget the graph does not READ must not be judged. When a widget is
// converted to an input, ComfyUI keeps it in `node.widgets` AND adds an input of
// the same name; while that input is CONNECTED the queue reads the link and the
// widget's own `.value` is dead weight, frequently a stale leftover from before
// the conversion. Verified against a live ComfyUI: converting KSampler's
// `sampler_name` leaves the widget in `node.widgets` and adds a `sampler_name`
// input alongside the connection inputs. Judging that value reports an error on a
// workflow that runs correctly — which mattered once #984 made the scan's findings
// decide whether get_errors may say "no errors recorded".
// ---------------------------------------------------------------------------

const inputEntry = (name, link, widgetName) => ({
  name,
  link,
  ...(widgetName ? { widget: { name: widgetName } } : {}),
});

test("#984 a CONNECTED widget-input's stale value is not judged", async () => {
  const n = node(1, "KSampler", [{ name: "sampler_name", value: "left_over_from_before" }]);
  n.inputs = [inputEntry("model", 3), inputEntry("sampler_name", 7, "sampler_name")];
  const res = await scanComboAvailability([n], async () => SAMPLER);
  assert.deepEqual(res.unavailable, [], "the link supplies this value — the widget's copy is not used");
});

test("#984 an UNCONNECTED widget-input is still judged (link: null)", async () => {
  const n = node(1, "KSampler", [{ name: "sampler_name", value: "not_a_sampler" }]);
  n.inputs = [inputEntry("sampler_name", null, "sampler_name")];
  const res = await scanComboAvailability([n], async () => SAMPLER);
  assert.equal(res.unavailable.length, 1, "nothing drives it, so the widget value is what runs");
  assert.equal(res.unavailable[0].value, "not_a_sampler");
});

test("#984 the skip matches by NAME when the input carries no widget back-reference", async () => {
  const n = node(1, "KSampler", [{ name: "sampler_name", value: "stale" }]);
  n.inputs = [inputEntry("sampler_name", 12)]; // older frontend shape
  const res = await scanComboAvailability([n], async () => SAMPLER);
  assert.deepEqual(res.unavailable, []);
});

test("#984 a connected input never silences a DIFFERENT widget", async () => {
  const n = node(1, "KSampler", [
    { name: "sampler_name", value: "not_a_sampler" },
    { name: "scheduler", value: "normal" },
  ]);
  n.inputs = [inputEntry("scheduler", 4, "scheduler")]; // a different widget is linked
  const res = await scanComboAvailability(
    [n],
    async () => classBody("KSampler", { sampler_name: [["euler"], {}], scheduler: [["normal"], {}] }),
  );
  assert.equal(res.unavailable.length, 1);
  assert.equal(res.unavailable[0].widget, "sampler_name", "only the linked widget is exempt");
});

test("#984 a node with no inputs array, or a malformed one, is judged exactly as before", async () => {
  const mk = (inputs) => {
    const n = node(1, "KSampler", [{ name: "sampler_name", value: "not_a_sampler" }]);
    if (inputs !== undefined) n.inputs = inputs;
    return n;
  };
  for (const inputs of [undefined, null, [], "nope", [null], [{}], [{ name: "sampler_name" }]]) {
    const res = await scanComboAvailability([mk(inputs)], async () => SAMPLER);
    assert.equal(res.unavailable.length, 1, `must still judge with inputs=${JSON.stringify(inputs)}`);
  }
});

test("#984 linkDrivenWidgetNames reports only CONNECTED inputs", () => {
  assert.deepEqual(
    [...linkDrivenWidgetNames({ inputs: [inputEntry("a", 1), inputEntry("b", null), inputEntry("c", 0, "c_w")] })],
    ["a", "c_w"],
    "link 0 is a real link id; only null/undefined mean unconnected",
  );
  assert.deepEqual([...linkDrivenWidgetNames(null)], []);
  assert.deepEqual([...linkDrivenWidgetNames({ inputs: {} })], []);
});
