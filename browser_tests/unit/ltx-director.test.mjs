// #314: driving the LTXDirector custom timeline via panel_set_widget.
//
// The lib routes a `timeline_data` write through the node's OWN _applyLoadedTimeline
// re-hydration (which drives the UI and regenerates the derived widgets) and REFUSES the
// derived widgets (local_prompts / segment_lengths / guide_strength), which are silently
// reverted if written directly. These tests drive the REAL shipped lib.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  LTX_DIRECTOR_NODE_TYPE,
  LTX_TIMELINE_MASTER_WIDGET,
  LTX_DERIVED_TIMELINE_WIDGETS,
  isLtxDirectorNode,
  classifyLtxTimelineWrite,
  normalizeLtxTimelineValue,
  currentTimelineSnapshot,
  parseTimelineSnapshot,
  deriveLtxTimelineWidgets,
  readLtxTimelineWindow,
  derivedTimelineRefusal,
  applyLtxTimelineWrite,
  LtxTimelineWriteError,
  LTX_AUDIO_TOGGLE_WIDGET,
  LTX_MOTION_TOGGLE_WIDGET,
} from "../../web/js/lib/ltx-director.js";

/** A fake node whose _timelineEditor records the _applyLoadedTimeline call. */
function makeLtxNode({
  id = 42,
  withEditor = true,
  method = "_applyLoadedTimeline",
  withWidget = true,
  widgetValue = "",
} = {}) {
  const calls = [];
  const editor = withEditor
    ? {
        [method]: (jsonStr, fileHandle) => calls.push({ jsonStr, fileHandle }),
        ...(withWidget ? { timelineDataWidget: { name: "timeline_data", value: widgetValue } } : {}),
      }
    : null;
  return { node: { id, type: LTX_DIRECTOR_NODE_TYPE, _timelineEditor: editor }, calls };
}

/** The JSON string passed to the node's _applyLoadedTimeline, parsed back. */
const drivenPayload = (calls) => JSON.parse(calls[0].jsonStr);

/** A headless LTXDirector — widgets exist, live TimelineEditor does not (#1308). */
function makeHeadlessLtxNode({
  id = 42,
  timelineData = "",
  localPrompts = "",
  segmentLengths = "",
  guideStrength = "",
  useCustomAudio = false,
  useCustomMotion = true,
  startFrame = 0,
  durationFrames = 120,
  extraWidgets = [],
} = {}) {
  const widgets = [
    { name: "timeline_data", value: timelineData },
    { name: "local_prompts", value: localPrompts },
    { name: "segment_lengths", value: segmentLengths },
    { name: "guide_strength", value: guideStrength },
    { name: LTX_AUDIO_TOGGLE_WIDGET, value: useCustomAudio },
    { name: LTX_MOTION_TOGGLE_WIDGET, value: useCustomMotion },
    { name: "start_frame", value: startFrame },
    { name: "duration_frames", value: durationFrames },
    ...extraWidgets,
  ];
  return { id, type: LTX_DIRECTOR_NODE_TYPE, widgets, _timelineEditor: null };
}

function widgetOf(node, name) {
  return node.widgets.find((w) => w.name === name);
}

/** A minimally-valid segment — finite numeric start + length are REQUIRED (NaN-timing guard). */
const seg = (extra = {}) => ({ start: 0, length: 24, ...extra });

test("isLtxDirectorNode matches on type or comfyClass, nothing else", () => {
  assert.equal(isLtxDirectorNode({ type: "LTXDirector" }), true);
  assert.equal(isLtxDirectorNode({ comfyClass: "LTXDirector" }), true);
  // EITHER field matching is enough — a non-LTX `type` must NOT mask a matching
  // `comfyClass` (the `type ?? comfyClass` bug codex flagged; would reproduce #314).
  assert.equal(isLtxDirectorNode({ type: "SomeVirtualType", comfyClass: "LTXDirector" }), true);
  assert.equal(isLtxDirectorNode({ type: "LTXDirector", comfyClass: "LTXDirector" }), true);
  assert.equal(isLtxDirectorNode({ type: "KSampler", comfyClass: "KSampler" }), false);
  assert.equal(isLtxDirectorNode({ type: "KSampler" }), false);
  assert.equal(isLtxDirectorNode(null), false);
  assert.equal(isLtxDirectorNode({}), false);
});

test("classifyLtxTimelineWrite: master / derived / null", () => {
  const node = { type: LTX_DIRECTOR_NODE_TYPE };
  assert.equal(classifyLtxTimelineWrite(node, LTX_TIMELINE_MASTER_WIDGET), "master");
  for (const w of LTX_DERIVED_TIMELINE_WIDGETS) {
    assert.equal(classifyLtxTimelineWrite(node, w), "derived");
  }
  // A normal widget on the LTX node still uses the normal write path.
  assert.equal(classifyLtxTimelineWrite(node, "seed"), null);
  // A NON-LTX node is never intercepted, even for a same-named widget.
  assert.equal(classifyLtxTimelineWrite({ type: "KSampler" }, "timeline_data"), null);
  assert.equal(classifyLtxTimelineWrite({ type: "KSampler" }, "local_prompts"), null);
});

test("normalizeLtxTimelineValue accepts an object and a JSON-object string", () => {
  const obj = { global_prompt: "hi", segments: [seg({ prompt: "a" }), seg({ prompt: "b" })] };
  const fromObj = normalizeLtxTimelineValue(obj);
  assert.equal(fromObj.timeline.segments.length, 2);
  assert.equal(JSON.parse(fromObj.jsonStr).global_prompt, "hi");

  const fromStr = normalizeLtxTimelineValue(JSON.stringify(obj));
  assert.deepEqual(fromStr.timeline, obj);
});

test("normalizeLtxTimelineValue rejects non-JSON strings, arrays, scalars, null", () => {
  assert.throws(() => normalizeLtxTimelineValue("not json {"), LtxTimelineWriteError);
  assert.throws(() => normalizeLtxTimelineValue("[1,2,3]"), LtxTimelineWriteError);
  assert.throws(() => normalizeLtxTimelineValue(42), LtxTimelineWriteError);
  assert.throws(() => normalizeLtxTimelineValue(""), LtxTimelineWriteError);
  assert.throws(() => normalizeLtxTimelineValue(null), LtxTimelineWriteError);
});

test("normalizeLtxTimelineValue REFUSES malformed segment arrays that would silently WIPE the timeline", () => {
  // A null/undefined/primitive segment makes the node's parseInitial destructure THROW,
  // then silently fall back to an empty timeline (data loss). Refuse loudly instead.
  assert.throws(() => normalizeLtxTimelineValue({ segments: [null] }), /segments\[0\] must be a segment OBJECT/);
  assert.throws(() => normalizeLtxTimelineValue({ segments: [seg({ prompt: "ok" }), null] }), /segments\[1\]/);
  assert.throws(() => normalizeLtxTimelineValue({ segments: [42] }), /segments\[0\]/);
  assert.throws(() => normalizeLtxTimelineValue({ segments: ["x"] }), /segments\[0\]/);
  assert.throws(() => normalizeLtxTimelineValue({ segments: [[]] }), /segments\[0\]/);
  assert.throws(() => normalizeLtxTimelineValue({ motionSegments: [null] }), /motionSegments\[0\]/);
  assert.throws(() => normalizeLtxTimelineValue({ audioSegments: [null] }), /audioSegments\[0\]/);
  assert.throws(() => normalizeLtxTimelineValue({ segments: "not-array" }), /must be an ARRAY/);
  // Also caught through the WRAPPED { timeline: {…} } shape (data.timeline || data).
  assert.throws(() => normalizeLtxTimelineValue({ timeline: { segments: [null] } }), /segments\[0\]/);
});

test("normalizeLtxTimelineValue REFUSES a truthy non-object .timeline wrapper (node's data.timeline||data wipe)", () => {
  // The node uses `data.timeline || data`, so a truthy array/primitive .timeline is what it
  // serializes → parses as an empty timeline → WIPE. Reject before it can happen.
  assert.throws(() => normalizeLtxTimelineValue({ timeline: [null] }), /non-object timeline/);
  assert.throws(() => normalizeLtxTimelineValue({ timeline: [{ prompt: "x" }] }), /non-object timeline/);
  assert.throws(() => normalizeLtxTimelineValue({ timeline: 5 }), /non-object timeline/);
  assert.throws(() => normalizeLtxTimelineValue({ timeline: "str" }), /non-object timeline/);
  assert.throws(() => normalizeLtxTimelineValue(JSON.stringify({ timeline: [null] })), /non-object timeline/);
  // A FALSY .timeline falls back to the object itself (node's `|| data`) — valid.
  assert.doesNotThrow(() => normalizeLtxTimelineValue({ timeline: null, segments: [seg({ prompt: "a" })] }));
  assert.doesNotThrow(() => normalizeLtxTimelineValue({ timeline: 0, global_prompt: "g" }));
  assert.doesNotThrow(() => normalizeLtxTimelineValue({ timeline: "", global_prompt: "g" }));
});

test("normalizeLtxTimelineValue REFUSES a PRESENT null/non-array segment field (node clears the track)", () => {
  // A present `null` (or any non-array) is NOT the same as absent: the node reloads that
  // track as [], silently clearing it. Only an ABSENT field is safe.
  assert.throws(() => normalizeLtxTimelineValue({ segments: null }), /segments.*must be an ARRAY/);
  assert.throws(() => normalizeLtxTimelineValue({ motionSegments: null }), /motionSegments.*must be an ARRAY/);
  assert.throws(() => normalizeLtxTimelineValue({ audioSegments: null }), /audioSegments.*must be an ARRAY/);
  assert.throws(() => normalizeLtxTimelineValue({ segments: {} }), /segments.*must be an ARRAY/);
  // Absent is fine.
  assert.doesNotThrow(() => normalizeLtxTimelineValue({ global_prompt: "g" }));
});

test("applyLtxTimelineWrite REFUSES an editor that lacks the timeline_data widget (false-success guard)", () => {
  const { node, calls } = makeLtxNode({ withWidget: false });
  assert.throws(() => applyLtxTimelineWrite(node, "{}"), LtxTimelineWriteError);
  assert.equal(calls.length, 0, "must not call a load path that would silently no-op");
});

test("normalizeLtxTimelineValue REFUSES exotic (non-plain) objects that serialize to {} (Map/Date/instance)", () => {
  // JSON.stringify turns these into "{}" → empty timeline → false 'driven' success.
  class Foo {}
  assert.throws(() => normalizeLtxTimelineValue(new Map()), LtxTimelineWriteError);
  assert.throws(() => normalizeLtxTimelineValue(new Date()), LtxTimelineWriteError);
  assert.throws(() => normalizeLtxTimelineValue(new Foo()), LtxTimelineWriteError);
  assert.throws(() => normalizeLtxTimelineValue({ timeline: new Map() }), /non-object timeline/);
  assert.throws(() => normalizeLtxTimelineValue({ segments: [new Map()] }), /segments\[0\]/);
  // A plain object with a null prototype is still a valid timeline container.
  assert.doesNotThrow(() => normalizeLtxTimelineValue(Object.assign(Object.create(null), { global_prompt: "g" })));
});

test("normalizeLtxTimelineValue ACCEPTS well-formed / empty / absent segment arrays", () => {
  assert.doesNotThrow(() => normalizeLtxTimelineValue({ segments: [seg({ prompt: "a" }), seg({ prompt: "b" })] }));
  assert.doesNotThrow(() => normalizeLtxTimelineValue({ segments: [] }));
  assert.doesNotThrow(() => normalizeLtxTimelineValue({ global_prompt: "only global, no segments" }));
  assert.doesNotThrow(() => normalizeLtxTimelineValue({})); // explicit clear-to-empty is allowed
  assert.doesNotThrow(() => normalizeLtxTimelineValue({ timeline: { segments: [seg({ prompt: "a" })] } }));
});

test("applyLtxTimelineWrite REFUSES a wipe-inducing segment BEFORE opening the undo envelope or calling the node", () => {
  const { node, calls } = makeLtxNode();
  const order = [];
  assert.throws(
    () =>
      applyLtxTimelineWrite(node, { segments: [null] }, {
        beforeChange: () => order.push("before"),
        afterChange: () => order.push("after"),
        setDirty: () => order.push("dirty"),
      }),
    LtxTimelineWriteError,
  );
  assert.equal(calls.length, 0, "must not invoke the node's load path with a wipe-inducing payload");
  assert.deepEqual(order, [], "must not open an undo envelope for a refused payload");
});

test("applyLtxTimelineWrite counts segments through the wrapped { timeline: {…} } shape", () => {
  const { node } = makeLtxNode();
  const res = applyLtxTimelineWrite(node, { timeline: { segments: [seg(), seg()] } });
  assert.equal(res.ltx_timeline.segments, 2);
});

test("applyLtxTimelineWrite drives the node's _applyLoadedTimeline with a JSON string + null handle", () => {
  const { node, calls } = makeLtxNode();
  const value = JSON.stringify({ global_prompt: "g", segments: [seg({ prompt: "x" })] });
  const res = applyLtxTimelineWrite(node, value);
  assert.equal(calls.length, 1);
  // The node's load path receives a JSON STRING (re-serialized) and fileHandle=null.
  assert.equal(typeof calls[0].jsonStr, "string");
  assert.equal(calls[0].fileHandle, null);
  assert.equal(JSON.parse(calls[0].jsonStr).global_prompt, "g");
  // Result envelope reports the drive + derived regeneration for the toast/summary.
  assert.equal(res.ltx_timeline.driven, true);
  assert.equal(res.ltx_timeline.node_id, 42);
  assert.equal(res.ltx_timeline.widget, LTX_TIMELINE_MASTER_WIDGET);
  assert.equal(res.ltx_timeline.segments, 1);
  assert.deepEqual(res.ltx_timeline.derived_regenerated, [...LTX_DERIVED_TIMELINE_WIDGETS]);
});

test("applyLtxTimelineWrite accepts an object value directly (segments counted)", () => {
  const { node, calls } = makeLtxNode();
  const res = applyLtxTimelineWrite(node, { segments: [seg(), seg(), seg()] });
  assert.equal(calls.length, 1);
  assert.equal(res.ltx_timeline.segments, 3);
});

test("normalizeLtxTimelineValue REFUSES a segment lacking finite numeric start/length (NaN-timing corruption)", () => {
  assert.throws(() => normalizeLtxTimelineValue({ segments: [{ prompt: "no timing" }] }), /\.start must be a finite number/);
  assert.throws(() => normalizeLtxTimelineValue({ segments: [{ start: 0 }] }), /\.length must be a finite number/);
  assert.throws(() => normalizeLtxTimelineValue({ segments: [{ start: 0, length: "24" }] }), /\.length must be a finite number/);
  assert.throws(() => normalizeLtxTimelineValue({ segments: [{ start: NaN, length: 24 }] }), /\.start must be a finite number/);
  assert.throws(() => normalizeLtxTimelineValue({ motionSegments: [{ prompt: "m" }] }), /motionSegments\[0\]\.start/);
  assert.throws(() => normalizeLtxTimelineValue({ audioSegments: [{ start: 0 }] }), /audioSegments\[0\]\.length/);
  // A properly-timed segment is accepted; extra fields are fine.
  assert.doesNotThrow(() => normalizeLtxTimelineValue({ segments: [{ start: 0, length: 24, prompt: "ok", guideStrength: 1 }] }));
});

test("applyLtxTimelineWrite MERGES a partial write onto the current timeline (omitted tracks/scalars PRESERVED)", () => {
  // Current timeline has all three tracks + a global prompt.
  const current = {
    global_prompt: "old global",
    segments: [seg({ prompt: "old-seg" })],
    motionSegments: [seg({ prompt: "keep-motion" })],
    audioSegments: [seg({ prompt: "keep-audio" })],
    retakeMode: true,
  };
  const { node, calls } = makeLtxNode({ widgetValue: JSON.stringify(current) });
  // Caller only changes segments — nothing else.
  const res = applyLtxTimelineWrite(node, { segments: [seg({ prompt: "new-seg" })] });
  const payload = drivenPayload(calls);
  assert.deepEqual(payload.segments, [seg({ prompt: "new-seg" })], "provided field overrides");
  assert.deepEqual(payload.motionSegments, [seg({ prompt: "keep-motion" })], "omitted motion track PRESERVED");
  assert.deepEqual(payload.audioSegments, [seg({ prompt: "keep-audio" })], "omitted audio track PRESERVED");
  assert.equal(payload.global_prompt, "old global", "omitted global_prompt PRESERVED (not reset to '')");
  assert.equal(payload.retakeMode, true, "omitted scalar PRESERVED");
  assert.equal(res.ltx_timeline.merged_onto_current, true);
  assert.deepEqual(res.ltx_timeline.preserved_tracks.sort(), ["audioSegments", "motionSegments"]);
});

test("applyLtxTimelineWrite treats a PRESENT empty array as an explicit clear (not a preserve)", () => {
  const current = { segments: [seg({ prompt: "a" })], motionSegments: [seg({ prompt: "m" })] };
  const { node, calls } = makeLtxNode({ widgetValue: JSON.stringify(current) });
  const res = applyLtxTimelineWrite(node, { motionSegments: [] });
  const payload = drivenPayload(calls);
  assert.deepEqual(payload.motionSegments, [], "explicit empty array clears the track");
  assert.deepEqual(payload.segments, [seg({ prompt: "a" })], "unmentioned segments still preserved");
  assert.equal(res.ltx_timeline.preserved_tracks.includes("motionSegments"), false, "explicitly-set track is not 'preserved'");
});

test("applyLtxTimelineWrite falls back to pure replace when no current snapshot is readable", () => {
  const { node, calls } = makeLtxNode({ widgetValue: "" }); // empty widget → no snapshot
  const res = applyLtxTimelineWrite(node, { segments: [seg({ prompt: "x" })] });
  const payload = drivenPayload(calls);
  assert.deepEqual(payload, { segments: [seg({ prompt: "x" })] });
  assert.equal(res.ltx_timeline.merged_onto_current, false);
  assert.deepEqual(res.ltx_timeline.preserved_tracks, []);
});

test("applyLtxTimelineWrite merges through the wrapped { timeline: {…} } overlay too", () => {
  const current = { global_prompt: "g", audioSegments: [seg({ prompt: "keep" })] };
  const { node, calls } = makeLtxNode({ widgetValue: JSON.stringify(current) });
  applyLtxTimelineWrite(node, { timeline: { segments: [seg({ prompt: "s" })] } });
  const payload = drivenPayload(calls);
  assert.deepEqual(payload.segments, [seg({ prompt: "s" })]);
  assert.deepEqual(payload.audioSegments, [seg({ prompt: "keep" })], "preserved through the wrapper overlay");
  assert.equal(payload.global_prompt, "g");
});

test("currentTimelineSnapshot reads the widget JSON, and null on empty/invalid", () => {
  assert.deepEqual(currentTimelineSnapshot({ timelineDataWidget: { value: '{"a":1}' } }), { a: 1 });
  assert.equal(currentTimelineSnapshot({ timelineDataWidget: { value: "" } }), null);
  assert.equal(currentTimelineSnapshot({ timelineDataWidget: { value: "not json" } }), null);
  assert.equal(currentTimelineSnapshot({ timelineDataWidget: { value: "[1,2]" } }), null, "array snapshot is not a timeline");
  assert.equal(currentTimelineSnapshot({}), null);
});

test("applyLtxTimelineWrite fails LOUDLY when the editor is missing AND there are no serialized widgets", () => {
  // No editor and no node.widgets — nothing to write.
  const noEditor = makeLtxNode({ withEditor: false });
  assert.throws(() => applyLtxTimelineWrite(noEditor.node, "{}"), LtxTimelineWriteError);
  // Editor present but without the _applyLoadedTimeline method, and no node widgets.
  const wrongMethod = makeLtxNode({ method: "_somethingElse" });
  assert.throws(() => applyLtxTimelineWrite(wrongMethod.node, "{}"), LtxTimelineWriteError);
});

test("applyLtxTimelineWrite rejects invalid JSON BEFORE calling the node (node swallows parse errors)", () => {
  const { node, calls } = makeLtxNode();
  assert.throws(() => applyLtxTimelineWrite(node, "totally not json"), LtxTimelineWriteError);
  assert.equal(calls.length, 0, "must not invoke the node's load path with un-validated input");
});

test("applyLtxTimelineWrite honors an injected getEditor", () => {
  const calls = [];
  const editor = { _applyLoadedTimeline: (s) => calls.push(s), timelineDataWidget: { name: "timeline_data" } };
  const node = { id: 7, type: LTX_DIRECTOR_NODE_TYPE };
  applyLtxTimelineWrite(node, "{}", { getEditor: () => editor });
  assert.equal(calls.length, 1);
});

test("applyLtxTimelineWrite wraps the drive in an undo envelope: before → apply → after → dirty", () => {
  const { node, calls } = makeLtxNode();
  const order = [];
  applyLtxTimelineWrite(node, "{}", {
    beforeChange: () => order.push("before"),
    afterChange: () => order.push("after"),
    setDirty: () => order.push("dirty"),
    getEditor: (n) => ({
      _applyLoadedTimeline: (s) => order.push("apply") || calls.push(s),
      timelineDataWidget: { name: "timeline_data" },
    }),
  });
  assert.deepEqual(order, ["before", "apply", "after", "dirty"]);
});

test("applyLtxTimelineWrite closes the undo envelope (afterChange) even when the load path throws", () => {
  const order = [];
  const node = { id: 3, type: LTX_DIRECTOR_NODE_TYPE };
  assert.throws(
    () =>
      applyLtxTimelineWrite(node, "{}", {
        beforeChange: () => order.push("before"),
        afterChange: () => order.push("after"),
        setDirty: () => order.push("dirty"),
        getEditor: () => ({
          _applyLoadedTimeline: () => {
            throw new Error("boom");
          },
          timelineDataWidget: { name: "timeline_data" },
        }),
      }),
    /boom/,
  );
  // afterChange must still fire; setDirty must NOT (no successful repaint).
  assert.deepEqual(order, ["before", "after"]);
});

test("applyLtxTimelineWrite fires NO undo hooks when input/editor validation refuses", () => {
  const order = [];
  const hooks = {
    beforeChange: () => order.push("before"),
    afterChange: () => order.push("after"),
    setDirty: () => order.push("dirty"),
  };
  // Invalid JSON — refused before any envelope.
  assert.throws(
    () => applyLtxTimelineWrite({ id: 1, type: LTX_DIRECTOR_NODE_TYPE }, "nope", hooks),
    LtxTimelineWriteError,
  );
  // Missing editor — refused before any envelope.
  assert.throws(
    () => applyLtxTimelineWrite({ id: 1, type: LTX_DIRECTOR_NODE_TYPE }, "{}", { ...hooks, getEditor: () => null }),
    LtxTimelineWriteError,
  );
  assert.deepEqual(order, [], "a refusal must not open an empty undo step");
});

test("derivedTimelineRefusal names the widget, the node, and points at timeline_data", () => {
  const msg = derivedTimelineRefusal("local_prompts", 99);
  assert.match(msg, /local_prompts/);
  assert.match(msg, /node 99/);
  assert.match(msg, /timeline_data/);
  assert.match(msg, /#314/);
});

test("parseTimelineSnapshot / currentTimelineSnapshot read the widget JSON, and null on empty/invalid", () => {
  assert.deepEqual(parseTimelineSnapshot('{"a":1}'), { a: 1 });
  assert.equal(parseTimelineSnapshot(""), null);
  assert.equal(parseTimelineSnapshot("not json"), null);
  assert.deepEqual(currentTimelineSnapshot({ timelineDataWidget: { value: '{"a":1}' } }), { a: 1 });
});

test("deriveLtxTimelineWidgets mirrors commitChanges: joiners, gap absorb, window fill", () => {
  // Two 24-frame segments on a 120-frame window: last length absorbs the trailing 72.
  const d = deriveLtxTimelineWidgets(
    { segments: [seg({ prompt: "a" }), seg({ start: 24, length: 24, prompt: "b" })] },
    { startFrames: 0, durationFrames: 120 },
  );
  assert.equal(d.local_prompts, "a | b");
  assert.equal(d.segment_lengths, "24,96", "no space after comma; last segment fills the window");
  assert.equal(d.guide_strength, "1.00,1.00", "non-text segments emit default 1.00");
});

test("deriveLtxTimelineWidgets skips text segments for guide_strength and uses explicit strength", () => {
  const d = deriveLtxTimelineWidgets(
    {
      segments: [
        seg({ prompt: "img", guideStrength: 0.4 }),
        seg({ start: 24, length: 24, prompt: "txt", type: "text" }),
      ],
    },
    { startFrames: 0, durationFrames: 48 },
  );
  assert.equal(d.local_prompts, "img | txt");
  assert.equal(d.guide_strength, "0.40");
});

test("deriveLtxTimelineWidgets retake mode emits preserved/retake/preserved regions", () => {
  const d = deriveLtxTimelineWidgets(
    {
      retakeMode: true,
      global_prompt: "keep",
      retakeStart: 24,
      retakeLength: 48,
      retakePrompt: "new take",
      retakeStrength: 0.7,
    },
    { startFrames: 0, durationFrames: 120 },
  );
  assert.equal(d.local_prompts, "keep | new take | keep");
  assert.equal(d.segment_lengths, "24,48,48");
  assert.equal(d.guide_strength, "0.00,0.70,0.00");
});

test("readLtxTimelineWindow reads start_frame / duration_frames with the editor's fallbacks", () => {
  const node = makeHeadlessLtxNode({ startFrame: 8, durationFrames: 96 });
  assert.deepEqual(readLtxTimelineWindow(node), { startFrames: 8, durationFrames: 96 });
  assert.deepEqual(readLtxTimelineWindow({ widgets: [] }), { startFrames: 0, durationFrames: 24 });
  assert.deepEqual(readLtxTimelineWindow({ widgets: [{ name: "duration_frames", value: 0 }] }), {
    startFrames: 0,
    durationFrames: 24,
  });
});

test("applyLtxTimelineWrite authors a timeline from serialized widgets when the editor is absent (#1308)", () => {
  const node = makeHeadlessLtxNode();
  const value = { global_prompt: "g", segments: [seg({ prompt: "hello", guideStrength: 0.5 })] };
  const res = applyLtxTimelineWrite(node, value);
  assert.equal(res.ltx_timeline.driven, true);
  assert.equal(res.ltx_timeline.fallback, true);
  assert.equal(res.ltx_timeline.editor_driven, false);
  assert.equal(res.ltx_timeline.segments, 1);
  assert.deepEqual(res.ltx_timeline.derived_regenerated, [...LTX_DERIVED_TIMELINE_WIDGETS]);
  assert.equal(JSON.parse(widgetOf(node, "timeline_data").value).global_prompt, "g");
  assert.equal(widgetOf(node, "local_prompts").value, "hello");
  // 24-frame segment on the node's 120-frame window → last (only) segment fills to 120.
  assert.equal(widgetOf(node, "segment_lengths").value, "120");
  assert.equal(widgetOf(node, "guide_strength").value, "0.50");
  assert.equal(res.ltx_timeline.local_prompts, "hello");
  assert.equal(res.ltx_timeline.segment_lengths, "120");
  assert.equal(res.ltx_timeline.guide_strength, "0.50");
});

test("serialized fallback MERGES onto the current timeline_data widget (omitted tracks preserved)", () => {
  const current = {
    global_prompt: "old global",
    segments: [seg({ prompt: "old-seg" })],
    motionSegments: [seg({ prompt: "keep-motion" })],
    audioSegments: [seg({ prompt: "keep-audio" })],
    audioTrackEnabled: true,
  };
  const node = makeHeadlessLtxNode({ timelineData: JSON.stringify(current) });
  const res = applyLtxTimelineWrite(node, { segments: [seg({ prompt: "new-seg" })] });
  const written = JSON.parse(widgetOf(node, "timeline_data").value);
  assert.deepEqual(written.segments, [seg({ prompt: "new-seg" })]);
  assert.deepEqual(written.motionSegments, [seg({ prompt: "keep-motion" })]);
  assert.deepEqual(written.audioSegments, [seg({ prompt: "keep-audio" })]);
  assert.equal(written.global_prompt, "old global");
  assert.equal(res.ltx_timeline.merged_onto_current, true);
  assert.deepEqual(res.ltx_timeline.preserved_tracks.sort(), ["audioSegments", "motionSegments"]);
  assert.equal(widgetOf(node, "local_prompts").value, "new-seg");
});

test("serialized fallback sets use_custom_audio / use_custom_motion from the timeline flags", () => {
  const node = makeHeadlessLtxNode({ useCustomAudio: false, useCustomMotion: true });
  const res = applyLtxTimelineWrite(node, {
    segments: [seg({ prompt: "a" })],
    audioTrackEnabled: true,
    motionTrackEnabled: false,
  });
  assert.equal(widgetOf(node, LTX_AUDIO_TOGGLE_WIDGET).value, true);
  assert.equal(widgetOf(node, LTX_MOTION_TOGGLE_WIDGET).value, false);
  assert.deepEqual(res.ltx_timeline.audio_motion_toggles, {
    [LTX_AUDIO_TOGGLE_WIDGET]: true,
    [LTX_MOTION_TOGGLE_WIDGET]: false,
  });
});

test("serialized fallback defaults omitted audio/motion flags to ON (pack: `!== false`)", () => {
  const node = makeHeadlessLtxNode({ useCustomAudio: false, useCustomMotion: false });
  applyLtxTimelineWrite(node, { segments: [seg({ prompt: "a" })] });
  assert.equal(widgetOf(node, LTX_AUDIO_TOGGLE_WIDGET).value, true);
  assert.equal(widgetOf(node, LTX_MOTION_TOGGLE_WIDGET).value, true);
});

test("an unready editor plus serialized widgets takes the fallback, not a refusal (#1308)", () => {
  const node = makeHeadlessLtxNode();
  // Editor object exists but has no load path — the install-without-hard-refresh shape.
  node._timelineEditor = { timeline: {} };
  const res = applyLtxTimelineWrite(node, { segments: [seg({ prompt: "via-fallback" })] });
  assert.equal(res.ltx_timeline.fallback, true);
  assert.equal(widgetOf(node, "local_prompts").value, "via-fallback");
});

test("a ready live editor is preferred over the serialized fallback", () => {
  const { node, calls } = makeLtxNode();
  node.widgets = [
    { name: "timeline_data", value: "" },
    { name: "local_prompts", value: "" },
    { name: "segment_lengths", value: "" },
    { name: "guide_strength", value: "" },
  ];
  const res = applyLtxTimelineWrite(node, { segments: [seg({ prompt: "via-editor" })] });
  assert.equal(res.ltx_timeline.editor_driven, true);
  assert.equal(res.ltx_timeline.fallback, false);
  assert.equal(calls.length, 1);
  assert.equal(widgetOf(node, "local_prompts").value, "", "fallback must not also assign widgets");
});

test("serialized fallback REFUSES when derived widgets are missing (execute would stay on old prompts)", () => {
  const node = {
    id: 9,
    type: LTX_DIRECTOR_NODE_TYPE,
    widgets: [{ name: "timeline_data", value: "" }],
  };
  assert.throws(() => applyLtxTimelineWrite(node, { segments: [seg({ prompt: "x" })] }), /local_prompts/);
  assert.equal(widgetOf(node, "timeline_data").value, "", "must not write timeline_data alone");
});

test("serialized fallback REFUSES a wipe-inducing payload BEFORE opening the undo envelope", () => {
  const node = makeHeadlessLtxNode();
  const order = [];
  assert.throws(
    () =>
      applyLtxTimelineWrite(node, { segments: [null] }, {
        beforeChange: () => order.push("before"),
        afterChange: () => order.push("after"),
        setDirty: () => order.push("dirty"),
      }),
    LtxTimelineWriteError,
  );
  assert.deepEqual(order, []);
  assert.equal(widgetOf(node, "timeline_data").value, "");
});

test("serialized fallback wraps the write in an undo envelope: before → after → dirty", () => {
  const node = makeHeadlessLtxNode();
  const order = [];
  applyLtxTimelineWrite(node, { segments: [seg({ prompt: "x" })] }, {
    beforeChange: () => order.push("before"),
    afterChange: () => order.push("after"),
    setDirty: () => order.push("dirty"),
  });
  assert.deepEqual(order, ["before", "after", "dirty"]);
});

// The SHIPPED graph_set_widget branch — not a copy of it. A headless LTXDirector
// (widgets exist, no live editor) must author the timeline through that exact code.
const PANEL_SRC = readFileSync(
  fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

const LTX_SET_WIDGET_BRANCH = PANEL_SRC.match(
  /const ltxKind = classifyLtxTimelineWrite\(node, widget\);\n    if \(ltxKind === "derived"\) \{[\s\S]*?setDirty: \(\) => graph\.setDirtyCanvas\(true, true\),\n      \}\);\n    \}/,
);

test("graph_set_widget still routes LTXDirector timeline_data through applyLtxTimelineWrite", () => {
  assert.ok(LTX_SET_WIDGET_BRANCH, "LTXDirector branch not found in graph_set_widget");
  const ltxAt = PANEL_SRC.indexOf("const ltxKind = classifyLtxTimelineWrite");
  const applyAt = PANEL_SRC.indexOf("return applyLtxTimelineWrite(node, value,");
  const genericAt = PANEL_SRC.indexOf("await runSetWidget(node, widget, value");
  assert.ok(ltxAt > 0 && applyAt > 0 && genericAt > 0);
  assert.ok(ltxAt < applyAt && applyAt < genericAt, "LTX route must stay ahead of the generic write");
});

test("shipped graph_set_widget authors an LTXDirector timeline without a live editor (#1308)", () => {
  assert.ok(LTX_SET_WIDGET_BRANCH, "LTXDirector branch not found in graph_set_widget");
  const node = makeHeadlessLtxNode();
  const graph = {
    log: [],
    beforeChange() {
      this.log.push("before");
    },
    afterChange() {
      this.log.push("after");
    },
    setDirtyCanvas() {
      this.log.push("dirty");
    },
  };
  const run = new Function(
    "classifyLtxTimelineWrite",
    "derivedTimelineRefusal",
    "applyLtxTimelineWrite",
    "node",
    "widget",
    "value",
    "graph",
    `return (function () { ${LTX_SET_WIDGET_BRANCH[0]} })();`,
  );
  const res = run(
    classifyLtxTimelineWrite,
    derivedTimelineRefusal,
    applyLtxTimelineWrite,
    node,
    LTX_TIMELINE_MASTER_WIDGET,
    { global_prompt: "g", segments: [seg({ prompt: "shipped" })] },
    graph,
  );
  assert.equal(res.ltx_timeline.fallback, true);
  assert.equal(res.ltx_timeline.driven, true);
  assert.equal(widgetOf(node, "local_prompts").value, "shipped");
  assert.equal(JSON.parse(widgetOf(node, "timeline_data").value).global_prompt, "g");
  assert.deepEqual(graph.log, ["before", "after", "dirty"]);
});
