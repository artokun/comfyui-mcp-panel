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
  comboConfigsOf,
  comboOffers,
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

// ---------------------------------------------------------------------------
// panel#745 RECURRENCE (reopened 2026-08-21, panel 0.15.19) — the scan omitted
// every combo declared in the V2/V3 wire shape.
//
// A V3-schema node (`IO.Combo.Input` under `@comfytype(io_type="COMBO")`) puts the
// literal string "COMBO" at spec[0] and the list under the config, so the old
// `Array.isArray(def[0])` read filed it as "not a combo" and the widget was skipped
// ENTIRELY — no finding AND no unchecked_nodes entry.
//
// Every fixture below is VERBATIM from this machine's live ComfyUI 0.33.2
// /api/object_info (853 types, 652 combo inputs). The def[0] read recognised 61 of
// them, all V1; reading through `authoritativeComboValues` recognises 528.
// ---------------------------------------------------------------------------

/** Load3D.model_file, copied verbatim from GET /api/object_info/Load3D. */
const LOAD3D = classBody("Load3D", {
  model_file: ["COMBO", { multiselect: false, options: ["none"], file_upload: true }],
  image: ["LOAD_3D", {}],
  width: ["INT", { default: 1024, min: 1, max: 4096, step: 1 }],
});

/** LoadAudio.audio — a V2 combo the server declares EMPTY, live-verified shape. */
const LOAD_AUDIO = classBody("LoadAudio", {
  audio: ["COMBO", { multiselect: false, options: [], audio_upload: true }],
});

test("#745 recurrence: the reporter's case — a V2 combo value the server does not offer IS reported", async () => {
  // #1571 taught the panel that `file_upload` IS an upload kind, so `3d/absent.glb`
  // (a SUBFOLDER value) now routes through #1357's abstention and the server's own
  // /view probe decides it. Production always injects that probe, so the fixture must
  // too — without it this asserts against a shape production never has.
  const r = await scanComboAvailability(
    [node(12, "Load3D", [{ name: "model_file", value: "3d/absent.glb" }])],
    async () => LOAD3D,
    { confirmServerAsset: () => false }, // the server answered: not on disk
  );
  assert.equal(r.unavailable.length, 1, "a V2 combo must be judged, not skipped");
  assert.equal(r.unavailable[0].widget, "model_file");
  assert.equal(r.unavailable[0].value, "3d/absent.glb");
  assert.deepEqual(r.unknown, [], "it is a DETERMINED answer, not an unchecked one");
});

test("#745 recurrence: a V2 value the server DOES offer produces no finding", async () => {
  const r = await scanComboAvailability(
    [node(12, "Load3D", [{ name: "model_file", value: "none" }])],
    async () => LOAD3D,
  );
  assert.deepEqual(r.unavailable, [], "must not report a value the server itself lists");
  assert.deepEqual(r.unknown, []);
});

test("#745 recurrence: a server-declared-EMPTY V2 list is a real answer, like its V1 twin", async () => {
  const r = await scanComboAvailability(
    [node(3, "LoadAudio", [{ name: "audio", value: "song.mp3" }])],
    async () => LOAD_AUDIO,
  );
  assert.equal(r.unavailable.length, 1, "zero options installed means the value is unavailable");
  assert.equal(r.unavailable[0].option_count, 0);
});

test("#745 recurrence: an UNREAD V2 list is never mistaken for an empty one", async () => {
  // A remote list arrives from a separate fetch, and a dynamic V3's keys select
  // SUB-INPUTS rather than values. Both must stay unjudged — reading either as []
  // would report every value on them as missing, the mass-false-positive failure
  // #774 refused to risk.
  for (const spec of [
    ["COMBO", { remote: { route: "/api/models" } }],
    ["COMBO", { remote: { route: "/api/models" }, options: [] }],
    ["COMFY_DYNAMICCOMBO_V3", { options: [{ key: "a", inputs: [] }] }],
  ]) {
    const body = classBody("Remote", { pick: spec });
    const r = await scanComboAvailability(
      [node(1, "Remote", [{ name: "pick", value: "anything_at_all" }])],
      async () => body,
    );
    assert.deepEqual(r.unavailable, [], `must not judge against an unread list: ${JSON.stringify(spec)}`);
  }
});

test("#745 recurrence: an ANNOTATED value on an upload combo abstains, never accuses", async () => {
  // `chair.glb [output]` resolves through exists_annotated_filepath and runs fine, and
  // NO option list on the live server carries an annotation (measured: 0 of 652), so
  // non-membership says nothing about it. Since #1571 this is the canonical #1357 path
  // — `file_upload` is a recognised upload kind — rather than the local workaround an
  // earlier revision of this branch carried.
  const r = await scanComboAvailability(
    [node(99, "Load3D", [{ name: "model_file", value: "chair.glb [output]" }])],
    async () => LOAD3D,
  );
  assert.deepEqual(r.unavailable, [], "an annotated value must not be reported as missing");
  assert.equal(r.unknown.length, 1, "and must not be silently dropped either");
  assert.match(r.unknown[0].reason, /cannot enumerate/);
});


test("#745 recurrence: comboInputsOf reads V1 and V2 alike, and configs come with them", () => {
  assert.deepEqual([...comboInputsOf(LOAD3D, "Load3D").entries()], [["model_file", ["none"]]]);
  assert.deepEqual(
    comboConfigsOf(LOAD3D, "Load3D").get("model_file"),
    { multiselect: false, options: ["none"], file_upload: true },
    "the V2 config must travel with the list, or the #1357 upload abstention cannot arm",
  );
  assert.equal(comboInputsOf(LOAD3D, "NoSuchClass"), null, "an absent class is still UNKNOWN");
});

/** LtxvApiTextToVideo.duration — a V2 combo publishing INTEGERS, live-verified shape. */
const INT_COMBO = classBody("LtxvApiTextToVideo", {
  duration: ["COMBO", { multiselect: false, options: [6, 8, 10] }],
});

test("#745 recurrence: an INTEGER option list is never collapsed to 'nothing installed'", async () => {
  // Measured: 15 inputs publish pure-int lists and ALL FIFTEEN are V2, so filtering
  // non-strings out of the stored list would turn every one into `option_count: 0`
  // — which this module reads as "the server enumerates nothing" — and label a
  // perfectly good graph `missing_asset`. Introduced by reading V2, by nothing else.
  const r = await scanComboAvailability(
    [node(7, "LtxvApiTextToVideo", [{ name: "duration", value: "99" }])],
    async () => INT_COMBO,
  );
  assert.equal(r.unavailable.length, 1, "a genuinely off-list value is still reported");
  assert.equal(r.unavailable[0].option_count, 3, "the list is NOT empty and must not say it is");
  assert.equal(r.unavailable[0].kind, "invalid_value", "an int list names modes, not files on disk");
});

test("#745 codex P1: a STRINGIFIED numeric value is REPORTED — the server rejects it", async () => {
  // This test previously asserted the OPPOSITE, and that assertion was the defect.
  // ComfyUI validates a combo with `val not in combo_options`, and Python's `in` is
  // `==`, under which `"10" == 10` is False — verified against this machine's 0.33.2
  // interpreter. So `"10"` on `[6, 8, 10]` fails the queue with `value_not_in_list`,
  // and calling it clean was a false negative. The frontend stringifying combo values
  // on queue (Comfy-Org/ComfyUI_frontend#14641) is how a canvas acquires one, which is
  // exactly why it is worth reporting rather than papering over.
  const r = await scanComboAvailability(
    [node(7, "LtxvApiTextToVideo", [{ name: "duration", value: "10" }])],
    async () => INT_COMBO,
  );
  assert.equal(r.unavailable.length, 1, "the server would reject this value");
  assert.equal(r.unavailable[0].value, "10");
});

test("#745 codex P1: a NUMERIC value the server does not offer is REPORTED, not skipped", async () => {
  // The value guard read `typeof value !== "string"`, so every numeric combo passed as
  // clean. `duration: 99` against `[6, 8, 10]` returned {unavailable:[],unknown:[]} in
  // execution while the server rejects it. Unreachable before this branch — all 44
  // numeric options on the live server sit on V2 combos the scan could not read.
  const r = await scanComboAvailability(
    [node(7, "LtxvApiTextToVideo", [{ name: "duration", value: 99 }])],
    async () => INT_COMBO,
  );
  assert.equal(r.unavailable.length, 1, "a numeric value must be judged, not skipped");
  assert.equal(r.unavailable[0].value, 99);
  assert.equal(r.unavailable[0].option_count, 3);
});

test("#745 codex P1: a NUMERIC value the server DOES offer stays clean", async () => {
  // Must be clean because it MATCHED, not because it was skipped — the direction the
  // old guard got right by accident and would have kept getting right while wrong.
  const r = await scanComboAvailability(
    [node(7, "LtxvApiTextToVideo", [{ name: "duration", value: 10 }])],
    async () => INT_COMBO,
  );
  assert.deepEqual(r.unavailable, [], "the server offers 10");
  assert.deepEqual(r.unknown, []);
});

test("#745 codex P1: 0 is a real combo value and is never dropped as falsy", async () => {
  const ZERO = classBody("Z", { pick: ["COMBO", { options: [0, 1, 2] }] });
  const ok = await scanComboAvailability([node(1, "Z", [{ name: "pick", value: 0 }])], async () => ZERO);
  assert.deepEqual(ok.unavailable, [], "0 is offered");
  const bad = await scanComboAvailability([node(1, "Z", [{ name: "pick", value: 7 }])], async () => ZERO);
  assert.equal(bad.unavailable.length, 1, "7 is not offered and must be reported");
});

test("#745 codex P1: comboOffers is TYPE-FAITHFUL — it reproduces the server's own compare", () => {
  assert.equal(comboOffers([6, 10], 10), true, "int matches int");
  assert.equal(comboOffers([6, 10], "10"), false, 'Python: "10" == 10 is False');
  assert.equal(comboOffers([6, 10], 7), false);
  assert.equal(comboOffers(["10"], 10), false, "and not in the other direction either");
  assert.equal(comboOffers(["a.safetensors"], "a.safetensors"), true);
  assert.equal(comboOffers([{ key: "a" }], "[object Object]"), false, "no structure may be flattened into a match");
  assert.equal(comboOffers(null, "x"), false);
});

test("#745 a non-primitive or absent widget value is still skipped", async () => {
  for (const v of [null, undefined, {}, [], ""]) {
    const r = await scanComboAvailability(
      [node(7, "LtxvApiTextToVideo", [{ name: "duration", value: v }])],
      async () => INT_COMBO,
    );
    assert.deepEqual(r.unavailable, [], `must not judge ${JSON.stringify(v) ?? "undefined"}`);
  }
});


// ---------------------------------------------------------------------------
// Gate round 2 (codex P1) — BOOLEAN combo values were skipped, so `options: [false]`
// with a widget holding `true` returned clean while the server rejects it.
//
// The naive fix (judge booleans with `===`) introduces a FALSE POSITIVE, because
// Python's `bool` is a subclass of `int`: `True in [1, 2]` is True, i.e. the server
// ACCEPTS it. Every expectation below is the real ComfyUI 0.33.2 interpreter's answer
// for `value in options`, not a guess about what it ought to be.
// ---------------------------------------------------------------------------

test("#745 gate-r2: a BOOLEAN value the server does not offer is REPORTED, not skipped", async () => {
  const BOOL = classBody("B", { flag: ["COMBO", { options: [false] }] });
  const r = await scanComboAvailability(
    [node(1, "B", [{ name: "flag", value: true }])],
    async () => BOOL,
  );
  assert.equal(r.unavailable.length, 1, "True in [False] is False — the server rejects it");
  assert.equal(r.unavailable[0].value, true);
});

test("#745 gate-r2: a BOOLEAN value the server DOES offer stays clean", async () => {
  const BOOL = classBody("B", { flag: ["COMBO", { options: [true, false] }] });
  for (const v of [true, false]) {
    const r = await scanComboAvailability(
      [node(1, "B", [{ name: "flag", value: v }])],
      async () => BOOL,
    );
    assert.deepEqual(r.unavailable, [], `${v} is offered by [true, false]`);
  }
});

test("#745 gate-r2: bool/int equivalence — true on [1,2] is ACCEPTED, so it must not be reported", async () => {
  // The false positive the naive boolean fix would have created. Python: bool is a
  // subclass of int, so `True == 1`. A bare `===` calls this unavailable; the server
  // runs it fine.
  const INT = classBody("I", { pick: ["COMBO", { options: [1, 2] }] });
  const clean = await scanComboAvailability([node(1, "I", [{ name: "pick", value: true }])], async () => INT);
  assert.deepEqual(clean.unavailable, [], "True in [1, 2] is True — the server accepts it");
  const reported = await scanComboAvailability([node(1, "I", [{ name: "pick", value: false }])], async () => INT);
  assert.equal(reported.unavailable.length, 1, "False in [1, 2] is False — rejected");
});

test("#745 gate-r2: comboOffers reproduces the interpreter EXACTLY over a measured truth table", () => {
  // Generated by running `value in options` in this machine's ComfyUI 0.33.2 Python and
  // transported over JSON — the same collapse the /object_info wire performs, so this
  // is the comparison that actually governs. The full generated table is 132 rows and
  // agrees 132/132; these are the rows that discriminate between candidate rules.
  const TABLE = [
    { options: [false], value: true, accepts: false },
    { options: [false], value: false, accepts: true },
    { options: [false], value: 0, accepts: true },
    { options: [false], value: 1, accepts: false },
    { options: [true, false], value: 1, accepts: true },
    { options: [true, false], value: "true", accepts: false },
    { options: [0, 1], value: true, accepts: true },
    { options: [0, 1], value: false, accepts: true },
    { options: [1, 2], value: true, accepts: true },
    { options: [1, 2], value: false, accepts: false },
    { options: [6, 8, 10], value: 10, accepts: true },
    { options: [6, 8, 10], value: "10", accepts: false },
    { options: [6, 8, 10], value: 10.0, accepts: true },
    { options: ["10"], value: 10, accepts: false },
    { options: ["10"], value: "10", accepts: true },
    { options: ["0"], value: 0, accepts: false },
    { options: [], value: "a", accepts: false },
  ];
  for (const { options, value, accepts } of TABLE) {
    assert.equal(
      comboOffers(options, value),
      accepts,
      `python: ${JSON.stringify(value)} in ${JSON.stringify(options)} === ${accepts}`,
    );
  }
});
