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
  sameSegmentContent,
  recordPreLoadPromptRelayEditors,
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

test("a SHRINK push during an ACTIVE reorder/drag invalidates it — no stale-index splice, no throw", () => {
  // The pack's editor keys its in-flight pointer interactions on segment INDICES: an active
  // reorder splices `sourceIdx`→`targetIdx` on pointer-up and a boundary drag resizes from
  // `dragStart.initialLengths[handle]` on pointer-move. A push that SHRINKS the timeline
  // between pointer-down and pointer-up leaves those indices pointing past the end of the new
  // list: the release would splice `undefined` into segments and the editor's own commit()
  // would throw on `s.prompt` BEFORE the derived widgets update — timeline_data corrupted and
  // desynced. Rehydration must end the interaction instead.
  const { node, widgets, editor } = makeRelayNode({
    timelineSegments: [seg("a"), seg("b", 36), seg("c", 48)],
  });
  // Mid-reorder of block 2 toward slot 0, AND mid boundary-drag — both index-keyed.
  editor.reorder = {
    sourceIdx: 2,
    targetIdx: 0,
    startX: 0,
    startY: 0,
    cursorX: 5,
    dragOffsetPx: 2,
    active: true,
  };
  editor.dragHandle = 1;
  editor.dragStart = { x: 0, initialLengths: [24, 36, 48] };

  const res = relay(applyPromptRelayTimelineWrite(node, { segments: [seg("only one", 5)] }));

  assert.equal(res.editor_synced, true);
  // The interaction is over, at exactly the pack's idle values.
  assert.equal(editor.reorder, null);
  assert.equal(editor.dragHandle, -1);
  assert.equal(editor.dragStart, null);

  // Replay the pack's onPointerUp VERBATIM against the released pointer: with no drag state
  // it is a no-op. (Mirrors prompt_relay_timeline.js — splice(sourceIdx,1)[0] then
  // splice(targetIdx,0,seg), then commit()'s segments.map(s => s.prompt), which is what threw.)
  const packPointerUp = (ed) => {
    if (ed.dragHandle >= 0) {
      ed.dragHandle = -1;
      ed.dragStart = null;
    }
    if (ed.reorder) {
      if (ed.reorder.active && ed.reorder.sourceIdx !== ed.reorder.targetIdx) {
        const segm = ed.timeline.segments.splice(ed.reorder.sourceIdx, 1)[0];
        ed.timeline.segments.splice(ed.reorder.targetIdx, 0, segm);
        ed.committedPrompts = ed.timeline.segments.map((s) => s.prompt).join(" | ");
      }
      ed.reorder = null;
    }
  };
  assert.doesNotThrow(() => packPointerUp(editor));
  // No splice happened: the pushed list is untouched, no undefined was inserted.
  assert.deepEqual(editor.timeline.segments.map((s) => s.prompt), ["only one"]);
  assert.equal(editor.committedPrompts, undefined);
  // …and timeline_data still re-derives to exactly the derived widgets (consistent triplet).
  const back = derivePromptRelayWidgets(JSON.parse(widgets.timeline_data.value).segments);
  assert.equal(back.local_prompts, widgets.local_prompts.value);
  assert.equal(back.segment_lengths, widgets.segment_lengths.value);
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

test("CORRUPT MASTER: discarding the editor copy is disclosed when timeline_data is unreadable", () => {
  // With timeline_data unreadable the editor holds the ONLY record of that content, so a write
  // that does not reproduce it must hand it back — there is no second copy to recover it from.
  const { node, widgets } = makeRelayNode();
  widgets.timeline_data.value = "corrupt {{{";
  const res = relay(applyPromptRelayTimelineWrite(node, { segments: [seg("replacement", 11)] }));
  assert.equal(res.merge_base, "editor");
  assert.deepEqual(res.overwrote_uncommitted_edit, { prompts: ["a", "b"], lengths: [24, 36] });
  assert.ok(res.warnings.some((w) => w.includes("UNCOMMITTED timeline edit")));
  // Nothing to supersede: there was no readable timeline_data copy.
  assert.equal(res.superseded_timeline_data, undefined);
});

test("CORRUPT MASTER: a write that reproduces the editor copy stays quiet", () => {
  const { node, widgets } = makeRelayNode();
  widgets.timeline_data.value = "corrupt {{{";
  const res = relay(applyPromptRelayTimelineWrite(node, { segments: [seg("a", 24), seg("b", 36)] }));
  assert.equal(res.overwrote_uncommitted_edit, undefined);
});

test("HEADLESS: an ordinary write with no editor never fires an overwrite disclosure", () => {
  // Not an anomaly — the widget is the single normal record and the caller read it.
  const { node } = makeRelayNode({ withEditor: false });
  const res = relay(applyPromptRelayTimelineWrite(node, { segments: [seg("brand new", 5)] }));
  assert.equal(res.overwrote_uncommitted_edit, undefined);
  assert.equal(res.superseded_timeline_data, undefined);
  assert.equal(res.warnings, undefined);
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

test("MID-TYPING: an explicit segments write that would DISCARD in-flight text FAILS CLOSED", () => {
  // The review finding: a push with explicit segments landing inside the 120 ms debounce
  // DETECTED the newer editor text (the filter makes the editor authoritative), then reported
  // success anyway and overwrote every widget AND the editor — the user's in-progress edit
  // survived only as a result-envelope disclosure. Silent loss is the bug; a loud conflict is
  // the contract. No non-guessing merge of two conflicting segment lists exists, so the write
  // is REFUSED with both states disclosed per segment and NOTHING mutated.
  const { node, widgets, editor } = makeRelayNode();
  editor.timeline.segments[0].prompt = "user was typing this";
  widgets.local_prompts.value = derivePromptRelayWidgets(editor.timeline.segments).local_prompts;
  const timelineBefore = widgets.timeline_data.value;
  const editorTimelineBefore = editor.timeline;

  const order = [];
  assert.throws(
    () =>
      applyPromptRelayTimelineWrite(node, { segments: [seg("agent set", 20)] }, {
        beforeChange: () => order.push("before"),
        afterChange: () => order.push("after"),
        setDirty: () => order.push("dirty"),
      }),
    (err) => {
      assert.ok(err instanceof PromptRelayTimelineWriteError);
      assert.match(err.message, /UNCOMMITTED timeline edit/);
      // BOTH states are disclosed PER SEGMENT — the in-flight edit and the supplied segments.
      assert.ok(
        err.message.includes('"user was typing this","b"'),
        "editor copy missing from the refusal",
      );
      assert.ok(err.message.includes('"agent set"'), "supplied segments missing from the refusal");
      return true;
    },
  );
  // ZERO mutation — not the widgets, not the editor, not the undo history. The edit SURVIVES.
  assert.equal(widgets.timeline_data.value, timelineBefore);
  assert.equal(widgets.local_prompts.value, "user was typing this | b");
  assert.equal(widgets.segment_lengths.value, "24, 36");
  assert.equal(editor.timeline, editorTimelineBefore);
  assert.deepEqual(editor.timeline.segments.map((s) => s.prompt), ["user was typing this", "b"]);
  assert.deepEqual(order, []);

  // The remedy the refusal documents: once the debounce has settled (the editor's commit has
  // reached timeline_data, so the node's two records agree), the very same write succeeds as
  // an ordinary one — no livelock.
  widgets.timeline_data.value = JSON.stringify(editor.timeline);
  const res = relay(applyPromptRelayTimelineWrite(node, { segments: [seg("agent set", 20)] }));
  assert.equal(res.reconciled, true);
  assert.equal(res.overwrote_uncommitted_edit, undefined);
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

test("MID-TYPING with a REALISTIC partial editor: fields the editor does not model are NOT dropped", () => {
  // The shipped editor's parser retains ONLY prompt/length/color per segment and nothing
  // top-level, so a real editor's this.timeline is NOT a full copy of timeline_data. Merging
  // FROM it would silently drop every field the parser does not model — the fixture never
  // caught that because it seeds the editor with the COMPLETE timeline. This seeds it the way
  // the pack's parser actually leaves it, then proves the merge loses nothing.
  const { node, widgets, editor } = makeRelayNode({
    timelineSegments: [
      seg("a", 24, { legacyMeta: "keep-0" }),
      seg("b", 36, { legacyMeta: "keep-1" }),
    ],
    extraTimelineFields: { zoom: 3, note: "keep me" },
  });
  editor.timeline = {
    segments: JSON.parse(widgets.timeline_data.value).segments.map(({ prompt, length, color }) => ({
      prompt,
      length,
      color,
    })),
  };
  // Mid-typing: the user edits segment 0; local_prompts updates immediately, timeline_data lags.
  editor.timeline.segments[0].prompt = "typed just now";
  widgets.local_prompts.value = derivePromptRelayWidgets(editor.timeline.segments).local_prompts;

  const res = relay(applyPromptRelayTimelineWrite(node, { fps: 24 }));

  assert.equal(res.merge_base, "editor");
  const written = JSON.parse(widgets.timeline_data.value);
  // Unmentioned TOP-LEVEL fields survive from the persisted widget, and the overlay applied.
  assert.equal(written.zoom, 3);
  assert.equal(written.note, "keep me");
  assert.equal(written.fps, 24);
  // The editor's typed text wins — it is authoritative mid-typing…
  assert.deepEqual(written.segments.map((s) => s.prompt), ["typed just now", "b"]);
  // …while PER-SEGMENT fields the editor does not model survive by index.
  assert.equal(written.segments[0].legacyMeta, "keep-0");
  assert.equal(written.segments[1].legacyMeta, "keep-1");
  // The in-flight text is current, not a loss — no bogus disclosures.
  assert.equal(res.overwrote_uncommitted_edit, undefined);
  assert.equal(res.replaced_out_of_band, undefined);
});

/**
 * Seed a REALISTIC partial editor (the pack's parser keeps only prompt/length/color) holding
 * `editorSegments` — the un-committed state mid-debounce — over a persisted timeline_data whose
 * segments carry per-segment fields the editor does not model. local_prompts is refreshed to
 * the editor's content, timeline_data lags, so the editor is authoritative on reconciliation.
 */
function makeMidEditNode(editorSegments, persistedSegments, extraTimelineFields = {}) {
  const n = makeRelayNode({ timelineSegments: persistedSegments, extraTimelineFields });
  n.editor.timeline = { segments: editorSegments };
  n.widgets.local_prompts.value = derivePromptRelayWidgets(editorSegments).local_prompts;
  n.widgets.segment_lengths.value = derivePromptRelayWidgets(editorSegments).segment_lengths;
  return n;
}

test("MID-TYPING REORDER: unmodelled per-segment fields follow their PROMPT, never their old index", () => {
  // Before the debounce commits, the user swaps the two blocks. The persisted widget still
  // holds [A, B] with per-segment metadata; carrying BY INDEX would attach A's metadata to B
  // and B's to A — writing fields onto segments they were never authored for.
  const n = makeMidEditNode(
    [
      { prompt: "b", length: 36, color: "#222222" },
      { prompt: "a", length: 24, color: "#111111" },
    ],
    [
      seg("a", 24, { color: "#111111", legacyMeta: "keep-A" }),
      seg("b", 36, { color: "#222222", legacyMeta: "keep-B" }),
    ],
    { zoom: 3 },
  );

  const res = relay(applyPromptRelayTimelineWrite(n.node, { fps: 24 }));

  assert.equal(res.merge_base, "editor");
  const written = JSON.parse(n.widgets.timeline_data.value);
  assert.deepEqual(written.segments.map((s) => s.prompt), ["b", "a"]);
  // Keyed by the unique prompt: each segment keeps ITS OWN metadata.
  assert.equal(written.segments[0].legacyMeta, "keep-B");
  assert.equal(written.segments[1].legacyMeta, "keep-A");
  assert.equal(written.zoom, 3);
});

test("MID-TYPING SHRINK: deleting the FIRST block does not shift its metadata onto the survivor", () => {
  // The user deletes block A; the editor now holds only [B]. Index carry would stamp A's
  // metadata onto B (index 0) and drop B's entirely — the exact misattachment the carry keys
  // on content to prevent.
  const n = makeMidEditNode(
    [{ prompt: "b", length: 36, color: "#222222" }],
    [
      seg("a", 24, { color: "#111111", legacyMeta: "keep-A" }),
      seg("b", 36, { color: "#222222", legacyMeta: "keep-B" }),
    ],
  );

  const res = relay(applyPromptRelayTimelineWrite(n.node, { fps: 24 }));

  assert.equal(res.merge_base, "editor");
  const written = JSON.parse(n.widgets.timeline_data.value);
  assert.equal(written.segments.length, 1);
  assert.equal(written.segments[0].prompt, "b");
  assert.equal(written.segments[0].legacyMeta, "keep-B");
});

test("MID-TYPING with an AMBIGUOUS mapping: the carry is DROPPED, never guessed", () => {
  // The user shrank the list AND retyped the survivor, so no prompt matches anything in the
  // persisted record. Index carry would attach A's metadata to the retyped segment; content
  // matching finds no pair. Ambiguous → no carry: losing an unmodelled field beats writing it
  // onto the WRONG segment.
  const n = makeMidEditNode(
    [{ prompt: "retyped from scratch", length: 24, color: "#111111" }],
    [
      seg("a", 24, { color: "#111111", legacyMeta: "keep-A" }),
      seg("b", 36, { color: "#222222", legacyMeta: "keep-B" }),
    ],
  );

  const res = relay(applyPromptRelayTimelineWrite(n.node, { fps: 24 }));

  const written = JSON.parse(n.widgets.timeline_data.value);
  assert.equal(res.merge_base, "editor");
  assert.equal(written.segments.length, 1);
  assert.equal(written.segments[0].legacyMeta, undefined);
  // The persisted record's own fields still survive where they belong: top level.
  assert.equal(typeof written.segments[0].color, "string");
});

test("MID-TYPING with DUPLICATED prompts: a non-1:1 content match carries nothing", () => {
  // The user duplicated block A while also keeping B (list grew, so positional alignment is
  // already broken). Both editor copies of "a" match the SAME persisted segment, so neither
  // pairing is provably the original — carrying "keep-A" onto either would be a guess. The
  // 1:1 match for "b" is unaffected and still carries.
  const n = makeMidEditNode(
    [
      { prompt: "a", length: 24, color: "#111111" },
      { prompt: "b", length: 36, color: "#222222" },
      { prompt: "a", length: 24, color: "#111111" },
    ],
    [
      seg("a", 24, { color: "#111111", legacyMeta: "keep-A" }),
      seg("b", 36, { color: "#222222", legacyMeta: "keep-B" }),
    ],
  );

  const res = relay(applyPromptRelayTimelineWrite(n.node, { fps: 24 }));

  const written = JSON.parse(n.widgets.timeline_data.value);
  assert.equal(res.merge_base, "editor");
  // "a" is not unique on the editor's side → no carry for either copy…
  assert.equal(written.segments[0].legacyMeta, undefined);
  assert.equal(written.segments[2].legacyMeta, undefined);
  // …while the unique "b" still matches its own persisted segment 1:1.
  assert.equal(written.segments[1].legacyMeta, "keep-B");
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
  assert.deepEqual(res.superseded_timeline_data, {
    prompts: ["raw write never applied"],
    lengths: [24],
  });
  assert.ok(res.warnings.some((w) => w.includes("superseded_timeline_data")));
  assert.equal(widgets.local_prompts.value, "a | b");
  assert.equal(editor.timeline.zoom, 4);
});

test("a write reproducing timeline_data while the editor holds the current text FAILS CLOSED — then converges", () => {
  // The persisted #506 state: a raw write put "wanted" into timeline_data but it never reached
  // the editor, so the editor still holds (and the node still executes) "a | b". Re-asserting
  // the master's prompts through this route would DISCARD the text the node would run right
  // now — structurally identical to a mid-debounce edit, so the same fail-closed rule applies:
  // the filter cannot tell "editor holds an in-flight edit" from "master holds an out-of-band
  // raw write", and unknown is never treated as safe. The documented remedy then converges the
  // node deterministically: first write the editor's disclosed segments verbatim (nothing is
  // discarded, so it applies), after which the intended write is an ordinary one.
  const { node, widgets } = makeRelayNode();
  widgets.timeline_data.value = JSON.stringify({ segments: [seg("wanted", 24)] });
  const timelineBefore = widgets.timeline_data.value;

  assert.throws(
    () => applyPromptRelayTimelineWrite(node, { segments: [seg("wanted", 24)] }),
    (err) => {
      assert.ok(err instanceof PromptRelayTimelineWriteError);
      assert.match(err.message, /UNCOMMITTED timeline edit/);
      assert.ok(err.message.includes('"a","b"'), "editor copy missing from the refusal");
      assert.ok(err.message.includes('"wanted"'), "supplied segments missing from the refusal");
      return true;
    },
  );
  // Nothing moved: the master still holds the raw write, the editor still holds what executes.
  assert.equal(widgets.timeline_data.value, timelineBefore);
  assert.equal(widgets.local_prompts.value, "a | b");

  // Remedy, step 1: converge the node's two records onto the editor's current text. The write
  // reproduces the editor's segments, so nothing is discarded and it applies — disclosing the
  // out-of-band master copy it sets aside.
  const converge = relay(
    applyPromptRelayTimelineWrite(node, { segments: [seg("a", 24), seg("b", 36)] }),
  );
  assert.equal(converge.reconciled, true);
  assert.deepEqual(converge.superseded_timeline_data, { prompts: ["wanted"], lengths: [24] });
  // Remedy, step 2: with the records agreeing, the intended write is ordinary — no conflict,
  // no disclosures.
  const res = relay(applyPromptRelayTimelineWrite(node, { segments: [seg("wanted", 24)] }));
  assert.equal(res.merge_base, "timeline_data");
  assert.equal(res.superseded_timeline_data, undefined);
  assert.equal(res.overwrote_uncommitted_edit, undefined);
  assert.equal(widgets.local_prompts.value, "wanted");
});

// ─── The lossy " | " join must never gate a data-loss disclosure ───

test("PIPE COLLISION: an overwrite is REFUSED even when the joined local_prompts is IDENTICAL", () => {
  // The exact hazard the join hides. Persisted timeline is ["old", "c"]. During the 120ms
  // debounce the user types segment 0 as the perfectly valid prompt "a | b", so the live editor
  // holds ["a | b", "c"] and local_prompts is already "a | b | c". An incoming write supplies
  // ["a", "b | c"] with the same lengths — a COMPLETELY different segmentation that joins to the
  // SAME string. The detection is STRUCTURAL, never the join: the editor is provably current
  // and the supplied segments do not reproduce it, so the write is REFUSED and the user's
  // single authored prompt "a | b" is not silently split into two different segment prompts.
  const { node, widgets, editor } = makeRelayNode({
    timelineSegments: [seg("old", 24), seg("c", 36)],
  });
  editor.timeline.segments[0].prompt = "a | b";
  widgets.local_prompts.value = "a | b | c";
  widgets.segment_lengths.value = "24, 36";
  const timelineBefore = widgets.timeline_data.value;

  assert.throws(
    () => applyPromptRelayTimelineWrite(node, { segments: [seg("a", 24), seg("b | c", 36)] }),
    (err) => {
      assert.ok(err instanceof PromptRelayTimelineWriteError);
      assert.match(err.message, /UNCOMMITTED timeline edit/);
      // Same join on both sides — the ONLY thing that distinguishes them is the segment
      // structure, and BOTH structures are disclosed per segment.
      assert.ok(err.message.includes('"a | b","c"'), "editor copy missing from the refusal");
      assert.ok(err.message.includes('"a","b | c"'), "supplied segments missing from the refusal");
      return true;
    },
  );
  // Nothing mutated: the in-flight edit survives byte-for-byte.
  assert.equal(widgets.timeline_data.value, timelineBefore);
  assert.equal(widgets.local_prompts.value, "a | b | c");
  assert.equal(widgets.segment_lengths.value, "24, 36");
  assert.deepEqual(editor.timeline.segments.map((s) => s.prompt), ["a | b", "c"]);
});

test("PIPE COLLISION mirror: genuinely identical segments report NO overwrite", () => {
  // Same starting state, but the write reproduces the in-flight segments exactly. Nothing is
  // lost, so the disclosure must stay silent — a structural compare, not a join compare, is the
  // only thing that can tell these two cases apart.
  const { node, widgets, editor } = makeRelayNode({
    timelineSegments: [seg("old", 24), seg("c", 36)],
  });
  editor.timeline.segments[0].prompt = "a | b";
  widgets.local_prompts.value = "a | b | c";
  widgets.segment_lengths.value = "24, 36";

  const res = relay(
    applyPromptRelayTimelineWrite(node, { segments: [seg("a | b", 24), seg("c", 36)] }),
  );
  assert.equal(res.overwrote_uncommitted_edit, undefined);
  // The stale timeline_data copy (["old","c"]) IS still set aside, and that is disclosed.
  assert.deepEqual(res.superseded_timeline_data, { prompts: ["old", "c"], lengths: [24, 36] });
});

test("PIPE COLLISION: a length-only change to in-flight text is REFUSED despite identical prompt joins", () => {
  // Reproducing the in-flight PROMPTS is not reproducing the in-flight CONTENT: the supplied
  // segments change the user's first segment from 24 to 90 frames, so the write still discards
  // the editor's current content and fails closed.
  const { node, widgets, editor } = makeRelayNode({
    timelineSegments: [seg("old", 24), seg("c", 36)],
  });
  editor.timeline.segments[0].prompt = "a | b";
  widgets.local_prompts.value = "a | b | c";
  widgets.segment_lengths.value = "24, 36";
  const timelineBefore = widgets.timeline_data.value;

  assert.throws(
    () => applyPromptRelayTimelineWrite(node, { segments: [seg("a | b", 90), seg("c", 36)] }),
    (err) => {
      assert.ok(err instanceof PromptRelayTimelineWriteError);
      assert.match(err.message, /UNCOMMITTED timeline edit/);
      // Prompts match on both sides; the LENGTHS are what conflicts — and both lists disclose them.
      assert.ok(err.message.includes('"a | b","c"'));
      assert.ok(err.message.includes("(lengths [24,36])"), "editor lengths missing from the refusal");
      assert.ok(err.message.includes("(lengths [90,36])"), "supplied lengths missing from the refusal");
      return true;
    },
  );
  assert.equal(widgets.timeline_data.value, timelineBefore);
  assert.deepEqual(editor.timeline.segments.map((s) => s.length), [24, 36]);
});

test("PIPE COLLISION: a metadata-only overlay on an unresolvable tie FAILS CLOSED", () => {
  // The join cannot decide AUTHORITY. Persisted timeline_data + widgets are
  // ["a", "b | c"] / [24, 36]. Within one debounce interval the user edits BOTH prompt boxes,
  // leaving the live editor at ["a | b", "c"] with the same lengths — which derives the SAME
  // "a | b | c" and "24, 36", so the stale master still looks perfectly consistent. A caller
  // then writes a metadata-only overlay that asks for no segment change at all. Neither copy
  // is provably current, so the write must REFUSE: guessing the editor could destroy the
  // persisted timeline (the post-load wrong-workflow loss), guessing the master could destroy
  // the in-flight edit — and a refusal mutates NOTHING, so both survive and the caller can
  // retry once the debounce settles, or supply the segments outright.
  const { node, widgets, editor } = makeRelayNode({
    timelineSegments: [seg("a", 24), seg("b | c", 36)],
  });
  editor.timeline.segments = [seg("a | b", 24), seg("c", 36)];
  // Both candidates serialize to byte-identical derived widget values.
  assert.equal(widgets.local_prompts.value, "a | b | c");
  assert.equal(
    derivePromptRelayWidgets(editor.timeline.segments).local_prompts,
    widgets.local_prompts.value,
  );
  assert.equal(
    derivePromptRelayWidgets(editor.timeline.segments).segment_lengths,
    widgets.segment_lengths.value,
  );

  const timelineBefore = widgets.timeline_data.value;
  const order = [];
  assert.throws(
    () =>
      applyPromptRelayTimelineWrite(node, { zoom: 4 }, {
        beforeChange: () => order.push("before"),
        afterChange: () => order.push("after"),
        setDirty: () => order.push("dirty"),
      }),
    (err) => {
      assert.ok(err instanceof PromptRelayTimelineWriteError);
      assert.match(err.message, /CANNOT tell which is current/);
      // Both copies are handed back PER SEGMENT, so the caller can resolve the tie explicitly.
      assert.ok(err.message.includes('"a | b","c"'), "editor copy missing from the refusal");
      assert.ok(err.message.includes('"a","b | c"'), "timeline_data copy missing from the refusal");
      return true;
    },
  );
  // NOTHING was mutated — not the widgets, not the editor, not the undo history. The live
  // edit SURVIVES precisely because nothing was written over it.
  assert.equal(widgets.timeline_data.value, timelineBefore);
  assert.equal(widgets.local_prompts.value, "a | b | c");
  assert.deepEqual(editor.timeline.segments.map((s) => s.prompt), ["a | b", "c"]);
  assert.deepEqual(order, []);
});

test("an unresolvable tie FAILS CLOSED even with explicit segments; an ordinary write has no tie", () => {
  // Neither record matches the derived widgets (a genuinely desynced node) and they differ
  // structurally: unresolvable. Explicit segments used to replace BOTH records outright here —
  // but that still permanently destroys whichever copy they do not reproduce behind a
  // "reconciled" report, and the filter just said it cannot prove which copy is current. No
  // resolved base, no write: refused with both copies disclosed, nothing mutated.
  const { node, widgets, editor } = makeRelayNode({ localPrompts: "hand written | text" });
  widgets.timeline_data.value = JSON.stringify({ segments: [seg("master only", 24)] });
  const timelineBefore = widgets.timeline_data.value;
  const order = [];
  assert.throws(
    () =>
      applyPromptRelayTimelineWrite(node, { segments: [seg("caller decides", 5)] }, {
        beforeChange: () => order.push("before"),
        afterChange: () => order.push("after"),
        setDirty: () => order.push("dirty"),
      }),
    (err) => {
      assert.ok(err instanceof PromptRelayTimelineWriteError);
      assert.match(err.message, /CANNOT tell which is current/);
      // BOTH copies are handed back PER SEGMENT, so the caller knows exactly what is at stake.
      assert.ok(err.message.includes('"a","b"'), "editor copy missing from the refusal");
      assert.ok(err.message.includes('"master only"'), "timeline_data copy missing from the refusal");
      return true;
    },
  );
  // ZERO mutation — not the widgets, not the editor, not the undo history.
  assert.equal(widgets.timeline_data.value, timelineBefore);
  assert.equal(widgets.local_prompts.value, "hand written | text");
  assert.deepEqual(editor.timeline.segments.map((s) => s.prompt), ["a", "b"]);
  assert.deepEqual(order, []);

  // A node whose two records agree has no tie to declare, and a successful write carries no
  // ambiguity flag.
  const plain = relay(applyPromptRelayTimelineWrite(makeRelayNode().node, { segments: [seg("x", 3)] }));
  assert.equal(plain.merge_base, "timeline_data");
  assert.equal(plain.merge_base_ambiguous, undefined);
});

test("sameSegmentContent compares structurally, never through the join", () => {
  const A = [seg("a | b", 24), seg("c", 36)];
  const B = [seg("a", 24), seg("b | c", 36)];
  // Identical derived strings…
  assert.equal(
    derivePromptRelayWidgets(A).local_prompts,
    derivePromptRelayWidgets(B).local_prompts,
  );
  // …but not the same content.
  assert.equal(sameSegmentContent(A, B), false);
  assert.equal(sameSegmentContent(A, [seg("a | b", 24), seg("c", 36)]), true);
  // A numeric-string length matches its normalized number; a real change does not.
  assert.equal(sameSegmentContent([{ prompt: "p", length: "24" }], [{ prompt: "p", length: 24 }]), true);
  assert.equal(sameSegmentContent([{ prompt: "p", length: 24 }], [{ prompt: "p", length: 25 }]), false);
  assert.equal(sameSegmentContent(A, A.slice(0, 1)), false);
  assert.equal(sameSegmentContent(A, null), false);
  // Lengths are NOT compared by stringifying — that would make null equal "null".
  assert.equal(sameSegmentContent([{ prompt: "p", length: null }], [{ prompt: "p", length: "null" }]), false);
  assert.equal(sameSegmentContent([{ prompt: "p", length: NaN }], [{ prompt: "p", length: 24 }]), false);
  assert.equal(sameSegmentContent([{ prompt: "p" }], [{ prompt: "p" }]), true);
  // …nor by a plain Number() coercion. The pack's parseInt reads "2e3" as 2, so calling it equal
  // to 2000 would suppress the disclosure while a 2000-frame segment was replaced by a 2-frame
  // one. Only the LOSSLESS forms the write path accepts count as equal.
  const len = (x, y) => sameSegmentContent([{ prompt: "p", length: x }], [{ prompt: "p", length: y }]);
  assert.equal(len("2e3", 2000), false);
  assert.equal(len("0x10", 16), false);
  assert.equal(len("24.7", 24), false);
  assert.equal(len("24.0", 24), true);
  assert.equal(len("+24", 24), true);
  assert.equal(len(" 24 ", 24), true);
  // Prompts are compared strictly — no coercion, and an empty prompt is distinct from absent.
  assert.equal(sameSegmentContent([{ prompt: "", length: 1 }], [{ length: 1 }]), false);
});

test("MID-TYPING: after a REFUSED push, the editor's pending debounce commit lands normally", () => {
  // The old contract applied the push and re-hydrated the editor so its pending commit became
  // a no-op — at the cost of the in-flight text. The new contract refuses the push, so the
  // pending commit is not a no-op: it is the whole point. The user's text commits to
  // timeline_data exactly as if the push had never arrived.
  const { node, widgets, editor } = makeRelayNode();
  editor.timeline.segments[0].prompt = "in flight";
  widgets.local_prompts.value = derivePromptRelayWidgets(editor.timeline.segments).local_prompts;
  assert.throws(
    () => applyPromptRelayTimelineWrite(node, { segments: [seg("agent set", 20)] }),
    PromptRelayTimelineWriteError,
  );
  // Replay the pack's commit() → syncWidgetsFromTimeline against the UNTOUCHED editor: the
  // in-flight text becomes the persisted state, undisturbed by the refused write.
  widgets.timeline_data.value = JSON.stringify(editor.timeline);
  const d = derivePromptRelayWidgets(editor.timeline.segments);
  widgets.local_prompts.value = d.local_prompts;
  widgets.segment_lengths.value = d.segment_lengths;
  assert.equal(widgets.local_prompts.value, "in flight | b");
  assert.deepEqual(JSON.parse(widgets.timeline_data.value).segments.map((s) => s.prompt), [
    "in flight",
    "b",
  ]);
  // …and the same push, re-issued after the settle, is an ordinary write (see the FAILS CLOSED
  // test above for the full remedy path).
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

/**
 * Model a real workflow load: the panel's app.loadGraphData fork snapshots what every
 * PromptRelay editor holds RIGHT NOW (still the previous workflow), then the load restores the
 * widgets to the new workflow's values. The editor's own re-parse is ~10ms later, so between
 * those two points it still holds the old timeline.
 */
function simulateWorkflowLoad({ node, widgets, editor }, restoredSegments) {
  recordPreLoadPromptRelayEditors([node]); // the fork, firing before the graph is replaced
  const timeline = { segments: restoredSegments };
  widgets.timeline_data.value = JSON.stringify(timeline);
  const derived = derivePromptRelayWidgets(restoredSegments);
  widgets.local_prompts.value = derived.local_prompts;
  widgets.segment_lengths.value = derived.segment_lengths;
  return { node, widgets, editor };
}

test("POST-LOAD: an editor PROVEN to predate the load is not reported as an overwritten edit", () => {
  // The routine post-load window. The pre-load snapshot proves the editor still holds exactly
  // what it held before the load — it has not been re-parsed OR typed into — so calling its
  // content an overwritten uncommitted edit would cry wolf on a routine write, and this
  // disclosure is the safety net for the genuine collision case.
  const n = makeRelayNode({ timelineSegments: [seg("previous workflow", 99)] });
  simulateWorkflowLoad(n, [seg("restored", 50)]);

  const res = relay(applyPromptRelayTimelineWrite(n.node, { zoom: 4 }));

  assert.equal(res.merge_base, "timeline_data");
  assert.equal(res.merge_base_reason, "filter-rejected-editor");
  // NO data-loss claim, and no warning at all — staleness is PROVEN, not assumed.
  assert.equal(res.overwrote_uncommitted_edit, undefined);
  assert.equal(res.discarded_unverified_editor_copy, undefined);
  assert.equal(res.warnings, undefined);
  // The payload is still handed back, under a name that says what it actually is.
  assert.deepEqual(res.discarded_stale_editor, { prompts: ["previous workflow"], lengths: [99] });
  assert.equal(n.widgets.local_prompts.value, "restored");
  assert.equal(n.widgets.segment_lengths.value, "50");
});

test("POST-LOAD: an explicit segments write does not claim the master was superseded", () => {
  // Case 3 selected the master; replacing its segments is the caller's plain intent, not a copy
  // set aside behind their back.
  const n = makeRelayNode({ timelineSegments: [seg("previous workflow", 99)] });
  simulateWorkflowLoad(n, [seg("restored", 50)]);
  const res = relay(applyPromptRelayTimelineWrite(n.node, { segments: [seg("caller wrote this", 10)] }));
  assert.equal(res.merge_base, "timeline_data");
  assert.equal(res.superseded_timeline_data, undefined);
  assert.equal(res.overwrote_uncommitted_edit, undefined);
  assert.deepEqual(res.discarded_stale_editor, { prompts: ["previous workflow"], lengths: [99] });
  assert.equal(n.widgets.local_prompts.value, "caller wrote this");
});

test("a stale editor whose content the write happens to reproduce reports nothing", () => {
  const n = makeRelayNode({ timelineSegments: [seg("previous workflow", 99)] });
  simulateWorkflowLoad(n, [seg("restored", 50)]);
  const res = relay(applyPromptRelayTimelineWrite(n.node, { segments: [seg("previous workflow", 99)] }));
  assert.equal(res.discarded_stale_editor, undefined);
  assert.equal(res.overwrote_uncommitted_edit, undefined);
  assert.equal(res.discarded_unverified_editor_copy, undefined);
});

test("POST-LOAD TIE: a stale editor colliding on BOTH joins fails CLOSED — the restored workflow is never overwritten", () => {
  // The review's wrong-workflow loss. The load restores ["x | y", "z"] / [50, 10], but the
  // editor still holds the PREVIOUS workflow's ["x", "y | z"] / [50, 10] — structurally
  // different, yet byte-identical local_prompts AND segment_lengths, so the derived widgets
  // cannot separate the two copies. Choosing the editor (the old tie behaviour) wrote the OLD
  // workflow's timeline back over the restored one and still reported success. A tie must
  // REFUSE instead: nothing is written, and both copies come back in the error.
  const n = makeRelayNode({ timelineSegments: [seg("x", 50), seg("y | z", 10)] });
  simulateWorkflowLoad(n, [seg("x | y", 50), seg("z", 10)]);
  // The collision is exact — the filter genuinely cannot tell the copies apart.
  assert.equal(n.widgets.local_prompts.value, "x | y | z");
  assert.equal(
    derivePromptRelayWidgets(n.editor.timeline.segments).local_prompts,
    n.widgets.local_prompts.value,
  );
  assert.equal(
    derivePromptRelayWidgets(n.editor.timeline.segments).segment_lengths,
    n.widgets.segment_lengths.value,
  );

  const timelineBefore = n.widgets.timeline_data.value;
  assert.throws(
    () => applyPromptRelayTimelineWrite(n.node, { zoom: 4 }),
    (err) => {
      assert.ok(err instanceof PromptRelayTimelineWriteError);
      assert.match(err.message, /CANNOT tell which is current/);
      assert.ok(err.message.includes('"x","y | z"'), "old-workflow editor copy missing from the refusal");
      assert.ok(err.message.includes('"x | y","z"'), "restored-workflow copy missing from the refusal");
      return true;
    },
  );
  // NOTHING was written: the restored workflow's timeline survives byte-for-byte, and the old
  // workflow's editor copy is left alone too — the caller resolves the tie explicitly.
  assert.equal(n.widgets.timeline_data.value, timelineBefore);
  assert.equal(n.widgets.local_prompts.value, "x | y | z");
  assert.equal(n.widgets.segment_lengths.value, "50, 10");
  assert.deepEqual(n.editor.timeline.segments.map((s) => s.prompt), ["x", "y | z"]);
});

test("TIE with explicit segments FAILS CLOSED too — no copy is destroyed behind a reconciled report", () => {
  // The same unresolvable collision, with the write supplying the segment list outright. That
  // used to be the escape hatch — the caller's list replaced BOTH records — but the filter
  // just proved it cannot tell which record is current, and the supplied list still
  // permanently destroys whichever copy it does not reproduce: exactly the live edit
  // ["x","y | z"] here, discarded while the call reported success. No resolved base, no write.
  const { node, widgets, editor } = makeRelayNode({
    timelineSegments: [seg("x | y", 50), seg("z", 10)],
    extraTimelineFields: { zoom: 3 },
  });
  // The editor still holds the PREVIOUS workflow, colliding on both derived joins.
  editor.timeline = { zoom: 9, segments: [seg("x", 50), seg("y | z", 10)] };
  const timelineBefore = widgets.timeline_data.value;

  assert.throws(
    () => applyPromptRelayTimelineWrite(node, { segments: [seg("caller decides", 7)] }),
    (err) => {
      assert.ok(err instanceof PromptRelayTimelineWriteError);
      assert.match(err.message, /CANNOT tell which is current/);
      // BOTH copies disclosed PER SEGMENT — the live edit and the persisted record.
      assert.ok(err.message.includes('"x","y | z"'), "editor copy missing from the refusal");
      assert.ok(err.message.includes('"x | y","z"'), "timeline_data copy missing from the refusal");
      return true;
    },
  );
  // NOTHING mutated: both copies survive byte-for-byte.
  assert.equal(widgets.timeline_data.value, timelineBefore);
  assert.equal(widgets.local_prompts.value, "x | y | z");
  assert.equal(widgets.segment_lengths.value, "50, 10");
  assert.deepEqual(editor.timeline.segments.map((s) => s.prompt), ["x", "y | z"]);

  // The documented remedy: the tie is transient. Once the editor's pending commit lands (the
  // records converge on the editor's copy), the very same write succeeds as an ordinary one.
  widgets.timeline_data.value = JSON.stringify(editor.timeline);
  const res = relay(applyPromptRelayTimelineWrite(node, { segments: [seg("caller decides", 7)] }));
  assert.equal(res.reconciled, true);
  assert.equal(res.merge_base, "timeline_data");
  assert.equal(widgets.local_prompts.value, "caller decides");
  assert.equal(JSON.parse(widgets.timeline_data.value).zoom, 9);
});

// ─── The filter cannot tell a stale editor from an uncommitted edit; only the load can ───

test("UNCOMMITTED TEXT whose derived widgets were refreshed back to the master is NOT suppressed", () => {
  // The mirror of the post-load case, and indistinguishable from it by the derived widgets: the
  // master and both derived widgets describe ["old","b"], while the editor holds text the user
  // typed. The filter rejects the editor exactly as it does for a stale one — but the pre-load
  // snapshot does NOT match, so the editor changed after the load and this is a real edit.
  const n = makeRelayNode({ timelineSegments: [seg("before the load", 24), seg("b", 36)] });
  simulateWorkflowLoad(n, [seg("old", 24), seg("b", 36)]);
  // …the load settles, the editor re-parses, the user types, and the derived widgets end up back
  // at the master's values (a refresh, or a commit that did not survive).
  n.editor.timeline = { segments: [seg("user typed this", 24), seg("b", 36)] };

  const res = relay(applyPromptRelayTimelineWrite(n.node, { zoom: 4 }));

  assert.equal(res.merge_base_reason, "filter-rejected-editor");
  // NOT silently dropped: the content comes back AND the caller is warned.
  assert.equal(res.discarded_stale_editor, undefined);
  assert.deepEqual(res.discarded_unverified_editor_copy, {
    prompts: ["user typed this", "b"],
    lengths: [24, 36],
  });
  assert.ok(res.warnings.some((w) => w.includes("could NOT be determined")));
});

test("with NO load ever observed, a discarded editor copy WARNS (unknown is never treated as safe)", () => {
  // No pre-load snapshot exists (the fork never ran, or the load recreated the node). Staleness
  // is unproven, so the fail-safe direction is to warn and return the content.
  const { node } = makeRelayNode({ timelineSegments: [seg("restored", 50)] });
  node._timelineEditor.timeline = { segments: [seg("unknown provenance", 99)] };
  const res = relay(applyPromptRelayTimelineWrite(node, { zoom: 4 }));
  assert.equal(res.merge_base_reason, "filter-rejected-editor");
  assert.equal(res.discarded_stale_editor, undefined);
  assert.deepEqual(res.discarded_unverified_editor_copy, {
    prompts: ["unknown provenance"],
    lengths: [99],
  });
  assert.ok(res.warnings.some((w) => w.includes("could NOT be determined")));
});

test("recordPreLoadPromptRelayEditors only touches PromptRelay nodes, and tolerates junk", () => {
  const { node } = makeRelayNode();
  const other = { id: 2, type: "KSampler", widgets: [], _timelineEditor: { timeline: { segments: [seg("x", 1)] } } };
  const noEditor = { id: 3, type: PROMPT_RELAY_TIMELINE_NODE_TYPE, widgets: [] };
  assert.equal(recordPreLoadPromptRelayEditors([node, other, noEditor], { now: () => 1000 }), 2);
  assert.equal(other.__cmcpPromptRelayPreLoadSegments, undefined);
  // A PromptRelay node with no live editor records an explicit "nothing was there".
  assert.deepEqual(noEditor.__cmcpPromptRelayPreLoadSegments, { at: 1000, segments: null });
  assert.deepEqual(node.__cmcpPromptRelayPreLoadSegments, {
    at: 1000,
    segments: [
      { prompt: "a", length: 24 },
      { prompt: "b", length: 36 },
    ],
  });
  assert.equal(recordPreLoadPromptRelayEditors(null), 0);
  assert.equal(recordPreLoadPromptRelayEditors([null, undefined, 5]), 0);
});

test("recordPreLoadPromptRelayEditors descends into subgraphs and survives a cycle", () => {
  // A write can target a node inside the viewed subgraph, so those editors need the signal too —
  // otherwise every routine post-load write on them would warn.
  const inner = makeRelayNode({ id: 9 }).node;
  const container = { id: 1, type: "Subgraph", widgets: [], subgraph: { _nodes: [inner] } };
  // A cycle: the subgraph lists a node whose own subgraph points back at the container.
  const looper = { id: 2, type: "Subgraph", widgets: [], subgraph: { _nodes: [container] } };
  container.subgraph._nodes.push(looper);
  assert.equal(recordPreLoadPromptRelayEditors([container], { now: () => 5 }), 1);
  assert.deepEqual(inner.__cmcpPromptRelayPreLoadSegments.segments, [
    { prompt: "a", length: 24 },
    { prompt: "b", length: 36 },
  ]);
});

test("a nested PromptRelay node gets the quiet post-load path, not a spurious warning", () => {
  const n = makeRelayNode({ id: 9, timelineSegments: [seg("previous workflow", 99)] });
  const container = { id: 1, type: "Subgraph", widgets: [], subgraph: { _nodes: [n.node] } };
  recordPreLoadPromptRelayEditors([container], { now: () => 0 });
  const timeline = { segments: [seg("restored", 50)] };
  n.widgets.timeline_data.value = JSON.stringify(timeline);
  const d = derivePromptRelayWidgets(timeline.segments);
  n.widgets.local_prompts.value = d.local_prompts;
  n.widgets.segment_lengths.value = d.segment_lengths;

  const res = relay(applyPromptRelayTimelineWrite(n.node, { zoom: 4 }, { now: () => 10 }));
  assert.deepEqual(res.discarded_stale_editor, { prompts: ["previous workflow"], lengths: [99] });
  assert.equal(res.warnings, undefined);
});

// ─── Content equality alone is not proof of history ───

test("RETYPING the exact pre-load text after the re-parse is NOT quietly discarded", () => {
  // The collision the snapshot cannot see on its own: the editor's content equals the pre-load
  // content, but only because the user re-authored it long after the load's re-parse. Time is
  // what separates the two — nobody retypes a timeline within the re-parse window.
  const n = makeRelayNode({ timelineSegments: [seg("the same text", 24)] });
  recordPreLoadPromptRelayEditors([n.node], { now: () => 0 });
  const timeline = { segments: [seg("restored", 50)] };
  n.widgets.timeline_data.value = JSON.stringify(timeline);
  const d = derivePromptRelayWidgets(timeline.segments);
  n.widgets.local_prompts.value = d.local_prompts;
  n.widgets.segment_lengths.value = d.segment_lengths;
  // …the load settles, the editor re-parses, and the user types the old text back in.
  n.editor.timeline = { segments: [seg("the same text", 24)] };

  const res = relay(applyPromptRelayTimelineWrite(n.node, { zoom: 4 }, { now: () => 60_000 }));
  assert.equal(res.discarded_stale_editor, undefined);
  assert.deepEqual(res.discarded_unverified_editor_copy, {
    prompts: ["the same text"],
    lengths: [24],
  });
  assert.ok(res.warnings.some((w) => w.includes("could NOT be determined")));
});

test("the stale window is bounded, and a stale clock never proves staleness", () => {
  const build = () => {
    const n = makeRelayNode({ timelineSegments: [seg("previous workflow", 99)] });
    recordPreLoadPromptRelayEditors([n.node], { now: () => 1_000 });
    const timeline = { segments: [seg("restored", 50)] };
    n.widgets.timeline_data.value = JSON.stringify(timeline);
    const d = derivePromptRelayWidgets(timeline.segments);
    n.widgets.local_prompts.value = d.local_prompts;
    n.widgets.segment_lengths.value = d.segment_lengths;
    return n;
  };
  const at = (t) => relay(applyPromptRelayTimelineWrite(build().node, { zoom: 4 }, { now: () => t }));
  // Inside the re-parse window: proven stale, quiet.
  assert.ok(at(1_000).discarded_stale_editor);
  assert.ok(at(1_250).discarded_stale_editor);
  // Outside it: the editor has certainly re-parsed, so equal content means re-authored → warn.
  assert.equal(at(1_251).discarded_stale_editor, undefined);
  assert.ok(at(1_251).discarded_unverified_editor_copy);
  // A clock that went backwards proves nothing.
  assert.equal(at(999).discarded_stale_editor, undefined);
  assert.ok(at(999).discarded_unverified_editor_copy);
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

test("the pre-load snapshot is taken inside the app.loadGraphData fork, BEFORE the load runs", () => {
  // The signal only works if it is recorded before the graph is replaced. Pin both the call and
  // its position relative to the original loadGraphData, and that it cannot break a load.
  assert.match(panelSrc, /recordPreLoadPromptRelayEditors,\n\} from "\.\/lib\/prompt-relay-timeline\.js";/);
  const callAt = panelSrc.indexOf("recordPreLoadPromptRelayEditors(appRef?.graph?._nodes");
  // The delegation itself (its result may be captured so post-load identity
  // bookkeeping can run before returning).
  const origAt = panelSrc.indexOf("orig(graphData, clean, restoreView, workflow, options)");
  assert.ok(callAt > 0, "recorder is not called from the loadGraphData fork");
  assert.ok(origAt > 0);
  assert.ok(callAt < origAt, "the snapshot must be taken BEFORE the load is delegated");
  // Wrapped so bookkeeping can never break a graph load.
  const between = panelSrc.slice(callAt - 400, origAt);
  assert.ok(/try \{\s*\n\s*recordPreLoadPromptRelayEditors\(/.test(between));
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
