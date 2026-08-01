// #314: driving the LTXDirector custom timeline via panel_set_widget.
//
// The lib routes a `timeline_data` write through the node's OWN _applyLoadedTimeline
// re-hydration (which drives the UI and regenerates the derived widgets) and REFUSES the
// derived widgets (local_prompts / segment_lengths / guide_strength), which are silently
// reverted if written directly. These tests drive the REAL shipped lib.
import test from "node:test";
import assert from "node:assert/strict";
import {
  LTX_DIRECTOR_NODE_TYPE,
  LTX_TIMELINE_MASTER_WIDGET,
  LTX_DERIVED_TIMELINE_WIDGETS,
  isLtxDirectorNode,
  classifyLtxTimelineWrite,
  normalizeLtxTimelineValue,
  currentTimelineSnapshot,
  derivedTimelineRefusal,
  applyLtxTimelineWrite,
  LtxTimelineWriteError,
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

test("applyLtxTimelineWrite fails LOUDLY when the editor / load path is missing", () => {
  // No editor at all (node UI not initialized).
  const noEditor = makeLtxNode({ withEditor: false });
  assert.throws(() => applyLtxTimelineWrite(noEditor.node, "{}"), LtxTimelineWriteError);
  // Editor present but without the _applyLoadedTimeline method (pack version mismatch).
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
