// #506: driving the ComfyUI-PromptRelay "PromptRelayEncodeTimeline" node via panel_set_widget.
//
// The node's python execute() reads ONLY local_prompts + segment_lengths, both DERIVED by the
// in-browser editor from timeline_data. A raw timeline_data write therefore reports success
// while the RENDER still uses the previous prompts. The lib reconciles: it regenerates the
// derived widgets from the new timeline and writes all three atomically, re-hydrates the live
// editor, refuses every value the node would silently coerce or reset, and refuses direct
// derived writes. These tests drive the REAL shipped lib.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PROMPT_RELAY_TIMELINE_NODE_TYPE,
  PROMPT_RELAY_MASTER_WIDGET,
  PROMPT_RELAY_DERIVED_WIDGETS,
  isPromptRelayTimelineNode,
  classifyPromptRelayTimelineWrite,
  normalizePromptRelayTimelineValue,
  parsePromptRelayTimeline,
  derivePromptRelayWidgets,
  promptRelayDerivedRefusal,
  applyPromptRelayTimelineWrite,
  PromptRelayTimelineWriteError,
} from "../../web/js/lib/prompt-relay-timeline.js";

const seg = (prompt, length = 24, extra = {}) => ({ prompt, length, color: "#4f8edc", ...extra });

/**
 * A fake node matching the real one's widget layout. `timelineSegments` seeds timeline_data
 * AND (unless overridden) the two derived widgets, i.e. a node that starts in sync.
 */
function makeRelayNode({
  id = 7,
  timelineSegments = [seg("a"), seg("b", 36)],
  extraTimelineFields = {},
  localPrompts,
  segmentLengths,
  withEditor = true,
  omitWidgets = [],
} = {}) {
  const timeline = timelineSegments ? { ...extraTimelineFields, segments: timelineSegments } : null;
  const derived = derivePromptRelayWidgets(timelineSegments ?? []);
  const all = {
    timeline_data: { name: "timeline_data", value: timeline ? JSON.stringify(timeline) : "" },
    local_prompts: { name: "local_prompts", value: localPrompts ?? derived.local_prompts },
    segment_lengths: { name: "segment_lengths", value: segmentLengths ?? derived.segment_lengths },
  };
  const widgets = Object.values(all).filter((w) => !omitWidgets.includes(w.name));
  const editor = withEditor
    ? {
        timeline: timeline ? JSON.parse(JSON.stringify(timeline)) : { segments: [] },
        selectedIndex: 0,
        _displayedX: new Map([[0, 5]]),
        _targetX: new Map([[0, 5]]),
        _settling: true,
        uiCalls: [],
        updateUIFromSelection() {
          this.uiCalls.push("updateUIFromSelection");
        },
        render() {
          this.uiCalls.push("render");
        },
      }
    : null;
  const node = { id, type: PROMPT_RELAY_TIMELINE_NODE_TYPE, widgets, _timelineEditor: editor };
  return { node, widgets: all, editor };
}

const relay = (r) => r.prompt_relay_timeline;

test("isPromptRelayTimelineNode matches on type or comfyClass, nothing else", () => {
  assert.equal(isPromptRelayTimelineNode({ type: PROMPT_RELAY_TIMELINE_NODE_TYPE }), true);
  assert.equal(isPromptRelayTimelineNode({ comfyClass: PROMPT_RELAY_TIMELINE_NODE_TYPE }), true);
  // A non-matching `type` must NOT mask a matching `comfyClass` (the `type ?? comfyClass` trap).
  assert.equal(
    isPromptRelayTimelineNode({ type: "SomeVirtualType", comfyClass: PROMPT_RELAY_TIMELINE_NODE_TYPE }),
    true,
  );
  // The NON-timeline sibling in the same pack has no editor and no timeline_data — never match it.
  assert.equal(isPromptRelayTimelineNode({ type: "PromptRelayEncode" }), false);
  assert.equal(isPromptRelayTimelineNode({ type: "LTXDirector" }), false);
  assert.equal(isPromptRelayTimelineNode(null), false);
  assert.equal(isPromptRelayTimelineNode({}), false);
});

test("classifyPromptRelayTimelineWrite: master / derived / null", () => {
  const node = { type: PROMPT_RELAY_TIMELINE_NODE_TYPE };
  assert.equal(classifyPromptRelayTimelineWrite(node, PROMPT_RELAY_MASTER_WIDGET), "master");
  for (const w of PROMPT_RELAY_DERIVED_WIDGETS) {
    assert.equal(classifyPromptRelayTimelineWrite(node, w), "derived");
  }
  // Ordinary widgets on the SAME node take the normal write path.
  for (const w of ["global_prompt", "max_frames", "epsilon", "fps", "time_units"]) {
    assert.equal(classifyPromptRelayTimelineWrite(node, w), null);
  }
  // Other node types are never perturbed — including LTXDirector, which owns its own route.
  assert.equal(classifyPromptRelayTimelineWrite({ type: "LTXDirector" }, "timeline_data"), null);
  assert.equal(classifyPromptRelayTimelineWrite({ type: "KSampler" }, "local_prompts"), null);
});

test("derivePromptRelayWidgets mirrors the node's syncWidgetsFromTimeline joins", () => {
  const d = derivePromptRelayWidgets([seg("a cat", 10), seg("a dog", 20), seg("a bird", 30)]);
  assert.equal(d.local_prompts, "a cat | a dog | a bird");
  assert.equal(d.segment_lengths, "10, 20, 30");
});

test("parsePromptRelayTimeline: object / empty / invalid / non-object", () => {
  assert.deepEqual(parsePromptRelayTimeline('{"segments":[]}'), { segments: [] });
  assert.equal(parsePromptRelayTimeline(""), null);
  assert.equal(parsePromptRelayTimeline("   "), null);
  assert.equal(parsePromptRelayTimeline("not json"), null);
  assert.equal(parsePromptRelayTimeline("[1,2]"), null);
  assert.equal(parsePromptRelayTimeline(null), null);
});

test("normalizePromptRelayTimelineValue accepts an object or a JSON string, refuses the rest", () => {
  assert.deepEqual(normalizePromptRelayTimelineValue({ segments: [] }), { segments: [] });
  assert.deepEqual(normalizePromptRelayTimelineValue('{"segments":[]}'), { segments: [] });
  assert.throws(() => normalizePromptRelayTimelineValue("nope"), PromptRelayTimelineWriteError);
  assert.throws(() => normalizePromptRelayTimelineValue("[]"), PromptRelayTimelineWriteError);
  assert.throws(() => normalizePromptRelayTimelineValue(42), PromptRelayTimelineWriteError);
  assert.throws(() => normalizePromptRelayTimelineValue(null), PromptRelayTimelineWriteError);
});

// ─── The #506 core: the derived widgets never stay stale ───

test("a timeline_data write REGENERATES local_prompts and segment_lengths (#506)", () => {
  const { node, widgets, editor } = makeRelayNode();
  assert.equal(widgets.local_prompts.value, "a | b");

  const res = relay(
    applyPromptRelayTimelineWrite(node, JSON.stringify({ segments: [seg("new one", 40), seg("b", 36)] })),
  );

  assert.equal(widgets.local_prompts.value, "new one | b");
  assert.equal(widgets.segment_lengths.value, "40, 36");
  assert.deepEqual(JSON.parse(widgets.timeline_data.value).segments.map((s) => s.prompt), ["new one", "b"]);
  assert.equal(res.reconciled, true);
  assert.equal(res.segments, 2);
  assert.equal(res.local_prompts, "new one | b");
  assert.equal(res.segment_lengths, "40, 36");
  // The live editor is re-hydrated so its next commit re-derives the SAME values instead of
  // reverting to the stale in-memory timeline.
  assert.equal(res.editor_synced, true);
  assert.deepEqual(editor.timeline.segments.map((s) => s.prompt), ["new one", "b"]);
  assert.deepEqual(editor.uiCalls, ["updateUIFromSelection", "render"]);
});

test("the three widgets always agree — timeline_data JSON re-derives to the written values", () => {
  const { node, widgets } = makeRelayNode();
  applyPromptRelayTimelineWrite(node, { segments: [seg("x", 1), seg("y", 2), seg("z", 3)] });
  const back = derivePromptRelayWidgets(JSON.parse(widgets.timeline_data.value).segments);
  assert.equal(back.local_prompts, widgets.local_prompts.value);
  assert.equal(back.segment_lengths, widgets.segment_lengths.value);
});

test("the editor's own commit after our write is a NO-OP (no silent revert)", () => {
  const { node, widgets, editor } = makeRelayNode();
  applyPromptRelayTimelineWrite(node, { segments: [seg("driven", 12)] });
  // Replay the node's syncWidgetsFromTimeline against the re-hydrated editor.
  const segs = editor.timeline.segments;
  assert.equal(JSON.stringify(editor.timeline), widgets.timeline_data.value);
  assert.equal(segs.map((s) => s.prompt).join(" | "), widgets.local_prompts.value);
  assert.equal(segs.map((s) => s.length).join(", "), widgets.segment_lengths.value);
});

test("a write with NO live editor still leaves all three widgets consistent", () => {
  const { node, widgets } = makeRelayNode({ withEditor: false });
  const res = relay(applyPromptRelayTimelineWrite(node, { segments: [seg("headless", 9)] }));
  assert.equal(res.editor_synced, false);
  assert.equal(res.reconciled, true);
  assert.equal(widgets.local_prompts.value, "headless");
  assert.equal(widgets.segment_lengths.value, "9");
});

test("segment count SHRINKS and GROWS cleanly (derived lists track exactly)", () => {
  const { node, widgets, editor } = makeRelayNode({
    timelineSegments: [seg("a"), seg("b"), seg("c")],
  });
  applyPromptRelayTimelineWrite(node, { segments: [seg("only", 5)] });
  assert.equal(widgets.local_prompts.value, "only");
  assert.equal(widgets.segment_lengths.value, "5");
  // selectedIndex is clamped into the shrunken list rather than dangling past the end.
  assert.equal(editor.selectedIndex, 0);

  applyPromptRelayTimelineWrite(node, { segments: [seg("p", 1), seg("q", 2), seg("r", 3), seg("s", 4)] });
  assert.equal(widgets.local_prompts.value, "p | q | r | s");
  assert.equal(widgets.segment_lengths.value, "1, 2, 3, 4");
});

test("selectedIndex past the end of a shrunken timeline is clamped, and anim state is reset", () => {
  const { node, editor } = makeRelayNode({ timelineSegments: [seg("a"), seg("b"), seg("c")] });
  editor.selectedIndex = 2;
  applyPromptRelayTimelineWrite(node, { segments: [seg("a"), seg("b")] });
  assert.equal(editor.selectedIndex, 1);
  assert.equal(editor._displayedX.size, 0);
  assert.equal(editor._targetX.size, 0);
  assert.equal(editor._settling, false);
});

// ─── Merge: omitted fields preserved, never defaulted away ───

test("a partial write MERGES onto the current timeline (unmentioned fields preserved)", () => {
  const { node, widgets } = makeRelayNode({ extraTimelineFields: { zoom: 3, note: "keep me" } });
  const res = relay(applyPromptRelayTimelineWrite(node, { segments: [seg("changed", 7)] }));
  const written = JSON.parse(widgets.timeline_data.value);
  assert.equal(written.zoom, 3);
  assert.equal(written.note, "keep me");
  assert.equal(res.merged_onto_current, true);
});

test("per-segment fields the caller does not know about survive the round-trip", () => {
  const { node, widgets } = makeRelayNode();
  applyPromptRelayTimelineWrite(node, {
    segments: [{ prompt: "p", length: 8, color: "#abcdef", futureField: { a: 1 } }],
  });
  const s = JSON.parse(widgets.timeline_data.value).segments[0];
  assert.equal(s.color, "#abcdef");
  assert.deepEqual(s.futureField, { a: 1 });
});

test("a segment without a color inherits the same-index color, else a stable fallback", () => {
  const { node, widgets } = makeRelayNode({
    timelineSegments: [seg("a", 24, { color: "#111111" }), seg("b", 24, { color: "#222222" })],
  });
  applyPromptRelayTimelineWrite(node, {
    segments: [{ prompt: "a2", length: 24 }, { prompt: "b2", length: 24 }, { prompt: "c2", length: 24 }],
  });
  const colors = JSON.parse(widgets.timeline_data.value).segments.map((s) => s.color);
  assert.equal(colors[0], "#111111");
  assert.equal(colors[1], "#222222");
  assert.equal(typeof colors[2], "string");
  assert.ok(colors[2].length > 0);
});

test("per-segment fields that exist ONLY on the current timeline are NOT index-merged back", () => {
  // Deliberate: supplying `segments` REPLACES the list, and index-matching unknown metadata
  // across a reordered/resized list would attach it to the wrong segment. `color` is the one
  // documented exception (purely cosmetic, and the canvas needs it).
  const { node, widgets } = makeRelayNode({
    timelineSegments: [seg("a", 24, { legacyMeta: "old" }), seg("b", 36)],
  });
  applyPromptRelayTimelineWrite(node, { segments: [{ prompt: "a2", length: 24 }, seg("b", 36)] });
  const written = JSON.parse(widgets.timeline_data.value).segments;
  assert.equal(written[0].legacyMeta, undefined);
  assert.equal(written[0].color, "#4f8edc"); // colour DID carry over by index
});

test("an unreadable current timeline_data AND no editor falls back to a pure replace", () => {
  const { node, widgets } = makeRelayNode({ withEditor: false });
  widgets.timeline_data.value = "corrupt {{{";
  const res = relay(applyPromptRelayTimelineWrite(node, { segments: [seg("fresh", 11)] }));
  assert.equal(res.merged_onto_current, false);
  assert.equal(res.merge_base, "none");
  assert.equal(widgets.local_prompts.value, "fresh");
});

test("an unreadable current timeline_data still merges from the LIVE editor", () => {
  const { node, widgets } = makeRelayNode({ extraTimelineFields: { zoom: 2 } });
  widgets.timeline_data.value = "corrupt {{{";
  const res = relay(applyPromptRelayTimelineWrite(node, { segments: [seg("fresh", 11)] }));
  assert.equal(res.merge_base, "editor");
  assert.equal(JSON.parse(widgets.timeline_data.value).zoom, 2);
});

// ─── The merge base: whichever copy of the timeline is actually current ───

test("MID-TYPING: the live editor wins over a timeline_data widget lagging by the 120ms debounce", () => {
  // Reproduces the pack's textarea handler: it writes seg.prompt + local_prompts IMMEDIATELY
  // and defers the timeline_data JSON by 120ms. Merging onto the stale widget would DESTROY
  // the text the user just typed.
  const { node, widgets, editor } = makeRelayNode();
  editor.timeline.segments[0].prompt = "just typed, not yet committed";
  widgets.local_prompts.value = derivePromptRelayWidgets(editor.timeline.segments).local_prompts;
  // timeline_data still holds the pre-keystroke JSON ("a | b").

  // A write that does not mention segments must PRESERVE the in-flight text, not roll it back.
  const res = relay(applyPromptRelayTimelineWrite(node, {}));
  assert.equal(res.merge_base, "editor");
  assert.equal(widgets.local_prompts.value, "just typed, not yet committed | b");
  assert.deepEqual(JSON.parse(widgets.timeline_data.value).segments.map((s) => s.prompt), [
    "just typed, not yet committed",
    "b",
  ]);
  // The in-flight text is current, not "out of band" — no bogus data-loss report.
  assert.equal(res.replaced_out_of_band, undefined);
});

test("MID-TYPING: an explicit segments write that DISCARDS in-flight text says so", () => {
  // Replacing `segments` is the caller's stated intent, so it is applied — but the prompt text
  // the user had typed and not yet committed is handed back rather than vanishing silently.
  const { node, widgets, editor } = makeRelayNode();
  editor.timeline.segments[0].prompt = "user was typing this";
  widgets.local_prompts.value = derivePromptRelayWidgets(editor.timeline.segments).local_prompts;

  const res = relay(applyPromptRelayTimelineWrite(node, { segments: [seg("agent set", 20)] }));
  assert.equal(res.merge_base, "editor");
  assert.equal(res.overwrote_uncommitted_edit, "user was typing this | b");
  assert.ok(res.warnings.some((w) => w.includes("UNCOMMITTED prompt edit")));
  assert.equal(widgets.local_prompts.value, "agent set");
});

test("MID-TYPING: a write that PRESERVES the in-flight text reports no overwrite", () => {
  const { node, widgets, editor } = makeRelayNode();
  editor.timeline.segments[0].prompt = "user was typing this";
  widgets.local_prompts.value = derivePromptRelayWidgets(editor.timeline.segments).local_prompts;
  const res = relay(applyPromptRelayTimelineWrite(node, { zoom: 4 }));
  assert.equal(res.overwrote_uncommitted_edit, undefined);
  assert.equal(widgets.local_prompts.value, "user was typing this | b");
});

test("a normal (non-debounce) write never reports overwrote_uncommitted_edit", () => {
  const { node } = makeRelayNode();
  const res = relay(applyPromptRelayTimelineWrite(node, { segments: [seg("totally different", 3)] }));
  assert.equal(res.merge_base, "timeline_data");
  assert.equal(res.overwrote_uncommitted_edit, undefined);
});

test("a PERSISTED #506 stale-master state discloses the timeline_data prompts it sets aside", () => {
  // timeline_data holds prompts a raw write put there that never reached the editor (the #506
  // state). The editor + derived widgets still hold the previous prompts, so the editor is what
  // the node would execute and it wins — but the prompts in timeline_data are handed back.
  const { node, widgets, editor } = makeRelayNode();
  widgets.timeline_data.value = JSON.stringify({ segments: [seg("raw write never applied", 24)] });
  assert.equal(widgets.local_prompts.value, "a | b"); // editor + derived still the old pair

  const res = relay(applyPromptRelayTimelineWrite(node, { zoom: 4 }));
  assert.equal(res.merge_base, "editor");
  assert.equal(res.superseded_timeline_data, "raw write never applied");
  assert.ok(res.warnings.some((w) => w.includes("superseded_timeline_data")));
  assert.equal(widgets.local_prompts.value, "a | b");
  assert.equal(editor.timeline.zoom, 4);
});

test("a write that reproduces the timeline_data prompts reports no supersede", () => {
  const { node, widgets } = makeRelayNode();
  widgets.timeline_data.value = JSON.stringify({ segments: [seg("wanted", 24)] });
  const res = relay(applyPromptRelayTimelineWrite(node, { segments: [seg("wanted", 24)] }));
  assert.equal(res.superseded_timeline_data, undefined);
  assert.equal(widgets.local_prompts.value, "wanted");
});

test("MID-TYPING: a pending debounce commit AFTER our write is a no-op (no rollback)", () => {
  const { node, widgets, editor } = makeRelayNode();
  editor.timeline.segments[0].prompt = "in flight";
  widgets.local_prompts.value = derivePromptRelayWidgets(editor.timeline.segments).local_prompts;
  applyPromptRelayTimelineWrite(node, { segments: [seg("agent set", 20)] });
  // Replay the pack's commit() → syncWidgetsFromTimeline against the re-hydrated editor.
  const before = { ...widgets.timeline_data, ...widgets.local_prompts };
  const segs = editor.timeline.segments;
  assert.equal(JSON.stringify(editor.timeline), widgets.timeline_data.value);
  assert.equal(segs.map((s) => s.prompt).join(" | "), widgets.local_prompts.value);
  assert.equal(segs.map((s) => s.length).join(", "), widgets.segment_lengths.value);
  assert.ok(before);
});

test("POST-LOAD: a stale editor is rejected even when its derived strings COLLIDE with the widgets", () => {
  // The dangerous near-miss: after a load the restored widgets agree with each other, but the
  // old editor's timeline happens to derive the SAME prompt join and length list while
  // differing in per-segment data. Preferring the widget whenever it is self-consistent means
  // the stale editor can never win, so its timeline is not resurrected.
  const { node, widgets, editor } = makeRelayNode({
    timelineSegments: [seg("a", 24, { color: "#new" }), seg("b", 36, { color: "#new2" })],
  });
  editor.timeline = {
    stalePreviousWorkflow: true,
    segments: [seg("a", 24, { color: "#old" }), seg("b", 36, { color: "#old2" })],
  };
  const res = relay(applyPromptRelayTimelineWrite(node, {}));
  assert.equal(res.merge_base, "timeline_data");
  const written = JSON.parse(widgets.timeline_data.value);
  assert.equal(written.stalePreviousWorkflow, undefined);
  assert.deepEqual(written.segments.map((s) => s.color), ["#new", "#new2"]);
});

test("POST-LOAD: the timeline_data widget wins over an editor still holding the OLD workflow", () => {
  // onConfigure restores the widgets first and re-parses the editor ~10ms later. Merging onto
  // the editor in that window would resurrect the previous workflow's timeline.
  const { node, widgets, editor } = makeRelayNode({ timelineSegments: [seg("restored", 50)] });
  editor.timeline = { segments: [seg("previous workflow", 99)] };
  const res = relay(applyPromptRelayTimelineWrite(node, {}));
  assert.equal(res.merge_base, "timeline_data");
  assert.equal(widgets.local_prompts.value, "restored");
  assert.equal(widgets.segment_lengths.value, "50");
});

test("the live editor never has its segment objects aliased into the written timeline", () => {
  const { node, widgets, editor } = makeRelayNode();
  const originalSeg = editor.timeline.segments[0];
  applyPromptRelayTimelineWrite(node, {});
  assert.notEqual(editor.timeline.segments[0], originalSeg);
  // Mutating the pre-write object must not change what was written.
  originalSeg.prompt = "mutated after the fact";
  assert.equal(widgets.local_prompts.value, "a | b");
});

// ─── Refusals: everything the node would silently coerce or reset ───

test("REFUSES an empty / non-array segments list (node resets to a blank default)", () => {
  for (const bad of [{ segments: [] }, { segments: null }, { segments: "a|b" }, { segments: {} }]) {
    const { node, widgets } = makeRelayNode();
    assert.throws(() => applyPromptRelayTimelineWrite(node, bad), PromptRelayTimelineWriteError);
    // Nothing was touched — a refusal never half-writes.
    assert.equal(widgets.local_prompts.value, "a | b");
    assert.equal(widgets.segment_lengths.value, "24, 36");
    assert.equal(JSON.parse(widgets.timeline_data.value).segments.length, 2);
  }
});

test("an overlay with NO segments key is an idempotent RE-RECONCILE, not a wipe", () => {
  // `segments` is merged from the node's current timeline, so nothing is defaulted away. This
  // doubles as the repair path for a node that is already desynced.
  const { node, widgets } = makeRelayNode({ localPrompts: "stale text" });
  const res = relay(applyPromptRelayTimelineWrite(node, {}));
  assert.equal(res.segments, 2);
  assert.equal(widgets.local_prompts.value, "a | b");
  assert.deepEqual(res.replaced_out_of_band, { local_prompts: "stale text" });
});

test("with NO readable base at all, an existing derived value is still reported before replacement", () => {
  // No editor yet (it is built in a setTimeout(0)) and no readable timeline_data, but the node
  // carries hand-written local_prompts. Nothing could have derived that, so it is out-of-band
  // by definition and must not be overwritten silently.
  const { node, widgets } = makeRelayNode({ timelineSegments: null, withEditor: false });
  widgets.local_prompts.value = "hand written | prompts";
  widgets.segment_lengths.value = "10, 10";
  const res = relay(applyPromptRelayTimelineWrite(node, { segments: [seg("from the agent", 7)] }));
  assert.equal(res.merge_base, "none");
  assert.deepEqual(res.replaced_out_of_band, {
    local_prompts: "hand written | prompts",
    segment_lengths: "10, 10",
  });
  assert.ok(res.warnings.some((w) => w.includes("ALREADY desynced")));
  assert.equal(widgets.local_prompts.value, "from the agent");
});

test("a first write onto a truly EMPTY node reports nothing replaced", () => {
  const { node } = makeRelayNode({ timelineSegments: null, withEditor: false });
  const res = relay(applyPromptRelayTimelineWrite(node, { segments: [seg("first", 5)] }));
  assert.equal(res.replaced_out_of_band, undefined);
  assert.equal(res.warnings, undefined);
});

test("an overlay with no segments AND no readable current timeline is REFUSED", () => {
  const { node } = makeRelayNode({ timelineSegments: null });
  assert.throws(() => applyPromptRelayTimelineWrite(node, {}), PromptRelayTimelineWriteError);
});

test("REFUSES a non-object segment (node falls back to a blank timeline, wiping prompts)", () => {
  for (const bad of [null, undefined, "a prompt", 5, ["x"]]) {
    const { node, widgets } = makeRelayNode();
    assert.throws(
      () => applyPromptRelayTimelineWrite(node, { segments: [seg("ok"), bad] }),
      PromptRelayTimelineWriteError,
    );
    assert.equal(widgets.local_prompts.value, "a | b");
  }
});

test("REFUSES a missing/non-string prompt — the node would coerce it to \"\" (data loss)", () => {
  for (const bad of [undefined, null, 42, { text: "hi" }, ["hi"]]) {
    const { node, widgets } = makeRelayNode();
    assert.throws(
      () => applyPromptRelayTimelineWrite(node, { segments: [{ prompt: bad, length: 24 }] }),
      PromptRelayTimelineWriteError,
    );
    assert.equal(widgets.local_prompts.value, "a | b");
  }
  // An EXPLICIT empty string is a legitimate value and is accepted.
  const { node, widgets } = makeRelayNode();
  applyPromptRelayTimelineWrite(node, { segments: [{ prompt: "", length: 24 }, seg("b")] });
  assert.equal(widgets.local_prompts.value, " | b");
});

test("REFUSES a length the node would clamp/truncate; accepts every LOSSLESS integer form", () => {
  // "24.7"  — parseInt TRUNCATES it to 24, silently shortening the segment.
  // "2e3"   — parseInt stops at the "e" and yields 2, so a caller meaning 2000 would get 2.
  //           "24e0" is refused with it: allowing the harmless form would open the lossy one.
  // 1e21    — String() renders it as "1e+21", which python's int() rejects outright and the
  //           pack's own parseInt reads back as 1. Anything past MAX_SAFE_INTEGER is refused.
  for (const bad of [
    undefined, null, 0, -5, 12.5, "24px", "24.7", "2e3", "24e0", "", NaN, Infinity,
    1e21, Number.MAX_SAFE_INTEGER + 2, {},
  ]) {
    const { node, widgets } = makeRelayNode();
    assert.throws(
      () => applyPromptRelayTimelineWrite(node, { segments: [{ prompt: "p", length: bad }] }),
      PromptRelayTimelineWriteError,
    );
    assert.equal(widgets.segment_lengths.value, "24, 36");
  }
  // Forms parseInt handles losslessly are accepted and stored as real numbers.
  const { node, widgets } = makeRelayNode();
  applyPromptRelayTimelineWrite(node, {
    segments: [
      { prompt: "p", length: "30" },
      { prompt: "q", length: "+12" },
      { prompt: "r", length: "8.0" },
      { prompt: "s", length: " 5 " },
      seg("t", 1),
    ],
  });
  assert.equal(widgets.segment_lengths.value, "30, 12, 8, 5, 1");
  for (const s of JSON.parse(widgets.timeline_data.value).segments) {
    assert.equal(typeof s.length, "number");
  }
});

test("REFUSES a PRESENT non-string colour (the node would swap in a palette entry)", () => {
  for (const bad of [42, null, {}, ["#fff"]]) {
    const { node, widgets } = makeRelayNode();
    assert.throws(
      () => applyPromptRelayTimelineWrite(node, { segments: [{ prompt: "p", length: 5, color: bad }] }),
      PromptRelayTimelineWriteError,
    );
    assert.equal(widgets.segment_lengths.value, "24, 36");
  }
});

test("REFUSES when any of the three widgets is missing (a reconcile would be impossible)", () => {
  for (const missing of ["timeline_data", "local_prompts", "segment_lengths"]) {
    const { node } = makeRelayNode({ omitWidgets: [missing] });
    assert.throws(
      () => applyPromptRelayTimelineWrite(node, { segments: [seg("p")] }),
      (err) => err instanceof PromptRelayTimelineWriteError && err.message.includes(missing),
    );
  }
});

test("REFUSES a direct write to a derived widget and redirects to timeline_data", () => {
  for (const w of PROMPT_RELAY_DERIVED_WIDGETS) {
    const msg = promptRelayDerivedRefusal(w, 7);
    assert.ok(msg.includes(w));
    assert.ok(msg.includes(PROMPT_RELAY_MASTER_WIDGET));
    assert.ok(msg.includes("#506"));
  }
});

// ─── Honesty: nothing diverges silently ───

test("a PRE-EXISTING desync is reported, not silently overwritten (#506 workaround recovery)", () => {
  // A node whose local_prompts was written directly (the issue's workaround): that text exists
  // ONLY there and the node would revert it anyway. Our reconcile replaces it — and says so.
  const { node, widgets } = makeRelayNode({ localPrompts: "hand written | prompts" });
  const res = relay(applyPromptRelayTimelineWrite(node, { segments: [seg("timeline says", 24)] }));
  assert.deepEqual(res.replaced_out_of_band, { local_prompts: "hand written | prompts" });
  assert.ok(res.warnings.some((w) => w.includes("ALREADY desynced")));
  assert.equal(widgets.local_prompts.value, "timeline says");
});

test("an IN-SYNC node reports no replaced_out_of_band and no desync warning", () => {
  const { node } = makeRelayNode();
  const res = relay(applyPromptRelayTimelineWrite(node, { segments: [seg("a"), seg("b", 36)] }));
  assert.equal(res.replaced_out_of_band, undefined);
  assert.equal(res.warnings, undefined);
});

test("WARNS about an empty prompt — the python side drops blanks and shifts every later segment", () => {
  const { node } = makeRelayNode();
  const res = relay(
    applyPromptRelayTimelineWrite(node, { segments: [seg("a"), seg("   ", 12), seg("c")] }),
  );
  assert.ok(res.warnings.some((w) => w.includes("EMPTY prompt")));
  assert.equal(res.local_prompts, "a |     | c");
});

test("WARNS about a literal | inside a prompt — the python side splits on it", () => {
  const { node } = makeRelayNode();
  const res = relay(applyPromptRelayTimelineWrite(node, { segments: [seg("a cat | a dog", 24)] }));
  assert.ok(res.warnings.some((w) => w.includes('literal "|"')));
});

test("WARNS about leading/trailing whitespace — the python side strips each entry", () => {
  const { node } = makeRelayNode();
  const res = relay(
    applyPromptRelayTimelineWrite(node, { segments: [seg("  red fox  ", 24), seg("clean", 24)] }),
  );
  assert.ok(res.warnings.some((w) => w.includes("leading/trailing whitespace")));
  // The prompt is stored VERBATIM; only the note about what the encoder will do is added.
  assert.equal(res.local_prompts, "  red fox   | clean");
  // A fully-blank prompt is reported by the stronger blank-prompt warning, not this one.
  const clean = relay(applyPromptRelayTimelineWrite(makeRelayNode().node, { segments: [seg("   ", 24)] }));
  assert.equal(clean.warnings.filter((w) => w.includes("leading/trailing whitespace")).length, 0);
});

test("the whitespace notice tracks PYTHON str.strip(), not JS trim()", () => {
  // python's str.strip() also removes U+001C…U+001F and U+0085, which JS trim() keeps. A
  // prompt padded with one of those IS dropped/shifted by the encoder, so it must be reported.
  for (const pad of ["\u001c", "\u001d", "\u001e", "\u001f", "\u0085", "\u00a0", "\u3000"]) {
    const res = relay(
      applyPromptRelayTimelineWrite(makeRelayNode().node, { segments: [seg(pad + "fox" + pad, 24)] }),
    );
    assert.ok(
      res.warnings?.some((w) => w.includes("leading/trailing whitespace")),
      `no whitespace warning for U+${pad.codePointAt(0).toString(16)}`,
    );
  }
  // U+FEFF goes the OTHER way: JS trim() strips it but python does NOT, so the render keeps it
  // verbatim and warning would be a lie.
  const bom = relay(
    applyPromptRelayTimelineWrite(makeRelayNode().node, { segments: [seg("\ufefffox\ufeff", 24)] }),
  );
  assert.equal(bom.warnings, undefined);
  // A prompt made only of python-whitespace counts as BLANK (python drops it entirely).
  const blank = relay(
    applyPromptRelayTimelineWrite(makeRelayNode().node, { segments: [seg("\u001c\u0085", 24), seg("b")] }),
  );
  assert.ok(blank.warnings.some((w) => w.includes("EMPTY prompt")));
});

test("a UI-refresh failure does NOT fail the write, and is reported", () => {
  const { node, widgets, editor } = makeRelayNode();
  editor.render = () => {
    throw new Error("canvas gone");
  };
  const res = relay(applyPromptRelayTimelineWrite(node, { segments: [seg("still applied", 15)] }));
  // The values the node EXECUTES are correct; only the repaint failed.
  assert.equal(widgets.local_prompts.value, "still applied");
  assert.equal(widgets.segment_lengths.value, "15");
  assert.equal(res.editor_synced, true);
  assert.equal(res.ui_refresh_error, "canvas gone");
});

// ─── Undo envelope ───

test("wraps the mutation in one undo envelope: before → write → after → dirty", () => {
  const { node } = makeRelayNode();
  const order = [];
  applyPromptRelayTimelineWrite(node, { segments: [seg("p")] }, {
    beforeChange: () => order.push("before"),
    afterChange: () => order.push("after"),
    setDirty: () => order.push("dirty"),
  });
  assert.deepEqual(order, ["before", "after", "dirty"]);
});

test("fires NO undo hooks when a refusal happens (no empty undo step)", () => {
  const order = [];
  const hooks = {
    beforeChange: () => order.push("before"),
    afterChange: () => order.push("after"),
    setDirty: () => order.push("dirty"),
  };
  const { node } = makeRelayNode();
  assert.throws(() => applyPromptRelayTimelineWrite(node, "not json", hooks));
  assert.throws(() => applyPromptRelayTimelineWrite(node, { segments: [] }, hooks));
  assert.throws(
    () => applyPromptRelayTimelineWrite(makeRelayNode({ omitWidgets: ["local_prompts"] }).node, { segments: [seg("p")] }, hooks),
  );
  assert.deepEqual(order, []);
});

// ─── The route is actually WIRED into graph_set_widget ───
//
// The lib is only reached through the branch inside graph_set_widget in
// comfyui-mcp-panel.js. That method references browser/ComfyUI globals, so (following the
// graph-resize-node.test.mjs convention) the PromptRelay branch is extracted from the REAL
// panel source and evaluated with injected stubs — a deleted or misordered route fails here
// rather than shipping a panel that silently falls through to the raw widget write (#506).

// Normalized to LF: the working copy is checked out CRLF on Windows.
const panelSrc = readFileSync(
  fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

const relayBranch = panelSrc.match(
  /const relayKind = classifyPromptRelayTimelineWrite\(node, widget\);[\s\S]*?\n {6}\}\);\n {4}\}/,
);

test("graph_set_widget's PromptRelay branch exists and is ordered before the generic write", () => {
  assert.ok(relayBranch, "PromptRelay branch not found in graph_set_widget");
  assert.match(panelSrc, /import \{[\s\S]*?\} from "\.\/lib\/prompt-relay-timeline\.js";/);
  const relayAt = panelSrc.indexOf("const relayKind = classifyPromptRelayTimelineWrite");
  const genericAt = panelSrc.indexOf("await runSetWidget(node, widget, value");
  const ltxAt = panelSrc.indexOf("const ltxKind = classifyLtxTimelineWrite");
  assert.ok(relayAt > 0 && genericAt > 0 && ltxAt > 0);
  // Must intercept BEFORE the generic raw write, and must not displace the LTXDirector route.
  assert.ok(relayAt < genericAt, "PromptRelay branch must run before runSetWidget");
  assert.ok(ltxAt < relayAt, "the LTXDirector route (#314) must keep its position");
});

test("graph_set_widget routes master → apply, derived → refusal, everything else → fall through", () => {
  const run = (kind) => {
    const calls = [];
    const factory = new Function(
      "classifyPromptRelayTimelineWrite",
      "promptRelayDerivedRefusal",
      "applyPromptRelayTimelineWrite",
      "node",
      "widget",
      "value",
      "graph",
      `return () => { ${relayBranch[0]}\n return "fell-through"; };`,
    );
    const fn = factory(
      () => kind,
      (w, id) => `refused ${w} on ${id}`,
      (n, v, hooks) => {
        calls.push({ n: n.id, v, hooks: Object.keys(hooks).sort() });
        return { applied: true };
      },
      { id: 3 },
      "timeline_data",
      { segments: [] },
      { beforeChange() {}, afterChange() {}, setDirtyCanvas() {} },
    );
    return { fn, calls };
  };

  const master = run("master");
  assert.deepEqual(master.fn(), { applied: true });
  assert.deepEqual(master.calls[0].hooks, ["afterChange", "beforeChange", "setDirty"]);

  const derived = run("derived");
  assert.throws(() => derived.fn(), /refused timeline_data on 3/);
  assert.equal(derived.calls.length, 0);

  const other = run(null);
  assert.equal(other.fn(), "fell-through");
  assert.equal(other.calls.length, 0);
});

test("honors an injected getEditor", () => {
  const { node } = makeRelayNode({ withEditor: false });
  const editor = { timeline: null, selectedIndex: 0, uiCalls: [], render() { this.uiCalls.push("render"); } };
  const res = relay(applyPromptRelayTimelineWrite(node, { segments: [seg("p")] }, { getEditor: () => editor }));
  assert.equal(res.editor_synced, true);
  assert.deepEqual(editor.timeline.segments.map((s) => s.prompt), ["p"]);
});
