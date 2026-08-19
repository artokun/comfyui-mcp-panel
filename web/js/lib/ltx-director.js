// Targeted support for driving the LTXDirector (WhatDreamsCost "CSGlide") custom
// timeline node via panel_set_widget (#314).
//
// THE PROBLEM. LTXDirector renders its prompts/segments from a custom JS timeline
// editor (TimelineEditor). That editor parses the `timeline_data` widget ONCE — in its
// constructor — into an in-memory `this.timeline`, the ABSOLUTE source of truth for both
// what the DOM shows AND what serializes. `local_prompts`, `segment_lengths` and
// `guide_strength` are DERIVED OUTPUTS the editor REGENERATES from `this.timeline` on
// every commitChanges(). All of these widgets are HIDDEN.
//
// A raw panel_set_widget therefore:
//   * writes the widget.value, so panel_query_graph reflects it (the tool "succeeds"),
//   * but never re-parses into `this.timeline`, so the DOM UI is unchanged, AND
//   * is SILENTLY REVERTED the next time commitChanges() runs (any UI touch, a load, or
//     the post-configure sync), because that rebuilds the widgets from the stale
//     `this.timeline`.
// That is exactly issue #314: "Tool returned success ... but the node's custom JS
// timeline UI still displayed the previous prompts."
//
// WHY A GENERAL WIDGET REPLAY IS UNSAFE, AND WHAT IS SAFE. There is no general
// onConfigure/serialize replay that safely re-hydrates arbitrary custom nodes. But
// LTXDirector ships its OWN re-hydration entry point: `_applyLoadedTimeline(jsonStr)` —
// the node's "Load Timeline" file handler — which re-parses the JSON into
// `this.timeline`, syncs the global-prompt DOM, reloads media, REGENERATES the derived
// widgets via commitChanges(), and re-renders. Routing a `timeline_data` write through
// THAT method — keyed strictly to node.type === "LTXDirector" and feature-detected —
// drives the UI correctly WITHOUT touching any other node. It accepts either the raw
// `timeline_data` object shape or the wrapped save-file shape ({ timeline: {…} }), so the
// value the agent already writes to `timeline_data` works verbatim.
//
// The DERIVED widgets (local_prompts / segment_lengths / guide_strength) CANNOT be driven
// independently — a direct write is reverted — so we REFUSE them LOUDLY (mirroring #560's
// principle of "a loud, safe failure over silent corruption") and redirect the caller to
// `timeline_data`.
//
// #1308. After a pack install + backend restart the node and its widgets exist, but the
// frontend extension may not have constructed TimelineEditor yet. Requiring the live editor
// then leaves NO programmatic authoring path, even though a serialized timeline_data + the
// derived widgets is exactly what a copy/paste of the node already persists. When the editor
// is unavailable we fall back to writing those widgets ourselves, using the same
// commitChanges() derivation the editor would have run, so execute() sees the new prompts.

export const LTX_DIRECTOR_NODE_TYPE = "LTXDirector";

// The master widget: the JSON the editor parses into its source-of-truth timeline.
export const LTX_TIMELINE_MASTER_WIDGET = "timeline_data";

// Derived OUTPUTS of the editor's commitChanges() — regenerated from the timeline, so a
// direct write is silently reverted. Refuse these and redirect to timeline_data.
export const LTX_DERIVED_TIMELINE_WIDGETS = Object.freeze([
  "local_prompts",
  "segment_lengths",
  "guide_strength",
]);

// Optional toggles commitChanges / syncWidgetsAndUI keep in lock-step with the timeline's
// audioTrackEnabled / motionTrackEnabled flags (default ON when the field is omitted).
export const LTX_AUDIO_TOGGLE_WIDGET = "use_custom_audio";
export const LTX_MOTION_TOGGLE_WIDGET = "use_custom_motion";

// Serialised fallback (#1308) needs the master + every derived widget: Python execute()
// reads local_prompts / segment_lengths / guide_strength, never timeline_data alone.
const FALLBACK_REQUIRED_WIDGETS = Object.freeze([
  LTX_TIMELINE_MASTER_WIDGET,
  ...LTX_DERIVED_TIMELINE_WIDGETS,
]);

// Separators mirrored from TimelineEditor.commitChanges() — note NO space after the
// length/strength commas (unlike PromptRelay's ", ").
const LTX_PROMPT_JOIN = " | ";
const LTX_LENGTH_JOIN = ",";
const LTX_STRENGTH_JOIN = ",";

// Match getStartFrames() / getDurationFrames() when the widget is missing or invalid.
const DEFAULT_START_FRAMES = 0;
const DEFAULT_DURATION_FRAMES = 24;

/**
 * True for an LTXDirector node (matched on the ComfyUI class, never a value shape).
 * Matches when EITHER `type` OR `comfyClass` is "LTXDirector" — not `type ?? comfyClass`,
 * which would ignore a matching `comfyClass` whenever `type` is a different non-null value.
 */
export function isLtxDirectorNode(node) {
  return node?.type === LTX_DIRECTOR_NODE_TYPE || node?.comfyClass === LTX_DIRECTOR_NODE_TYPE;
}

/**
 * Classify a set_widget request against the LTXDirector timeline widgets:
 *   "master"  → timeline_data (drive via the node's _applyLoadedTimeline)
 *   "derived" → local_prompts / segment_lengths / guide_strength (refuse)
 *   null      → not an LTXDirector timeline widget; use the normal write path
 * Non-LTXDirector nodes always return null, so this never perturbs any other node.
 */
export function classifyLtxTimelineWrite(node, widgetName) {
  if (!isLtxDirectorNode(node)) return null;
  if (widgetName === LTX_TIMELINE_MASTER_WIDGET) return "master";
  if (LTX_DERIVED_TIMELINE_WIDGETS.includes(widgetName)) return "derived";
  return null;
}

export class LtxTimelineWriteError extends Error {
  constructor(message) {
    super(message);
    this.name = "LtxTimelineWriteError";
  }
}

// A PLAIN JSON object (`{}` literal / Object.create(null)) — not an array, not a Map/Set/
// Date/class instance. The node round-trips the value through JSON.stringify, which turns
// any exotic object into `{}` (an empty timeline). Requiring a plain object rejects those
// up front so we never report a "driven" success for a value that would serialize to empty.
// In production the value is already a JSON.parse result (see normalizeLtxTimelineValue),
// so this is defense-in-depth for direct-object callers.
function isPlainObject(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// The segment arrays the node's parseInitial() ingests by DESTRUCTURING each element
// (`const { …, ...rest } = s`). A null/undefined element makes that destructure THROW,
// and parseInitial's outer try/catch then silently falls back to an EMPTY timeline —
// which would WIPE the user's existing timeline while we report success. We reject any
// non-object element up front (loud, safe failure over silent data loss, per #560).
const SEGMENT_ARRAY_FIELDS = ["segments", "motionSegments", "audioSegments"];

// The effective timeline object parseInitial reads. Mirrors the node's `data.timeline ||
// data` EXACTLY (truthy `||`, NOT a type check): a TRUTHY `.timeline` — even an array or a
// primitive — is what the node serializes and parses; only a FALSY `.timeline`
// (undefined/null/false/0/""/NaN) falls back to the object itself.
function effectiveTimeline(obj) {
  return obj.timeline ? obj.timeline : obj;
}

function assertTimelineSegments(obj) {
  const tl = effectiveTimeline(obj);
  // A truthy non-plain-object `.timeline` wrapper (array / primitive / Map / class instance)
  // is serialized by the node and parsed as a timeline with no `segments`, RESETTING to empty
  // (data loss) while the request reports success. Reject it — the effective timeline must be
  // a plain object.
  if (!isPlainObject(tl)) {
    throw new LtxTimelineWriteError(
      `timeline_data resolves to a non-object timeline (${Array.isArray(tl) ? "an array" : JSON.stringify(tl)}); ` +
        `the LTXDirector parser would reset to an EMPTY timeline (data loss) — refusing. Pass a timeline ` +
        `OBJECT, optionally wrapped as {"timeline": { … }}.`,
    );
  }
  for (const field of SEGMENT_ARRAY_FIELDS) {
    // ABSENT is safe (the node defaults the track to []). But a PRESENT non-array —
    // including an explicit `null` — makes the node reload THAT track as [], silently
    // clearing it while reporting success. Only skip a field that is truly absent.
    if (!Object.prototype.hasOwnProperty.call(tl, field)) continue;
    const arr = tl[field];
    if (!Array.isArray(arr)) {
      throw new LtxTimelineWriteError(
        `timeline_data.${field}, when present, must be an ARRAY of segment objects, not ` +
          `${arr === null ? "null" : JSON.stringify(arr)}. The node reloads a non-array track as an ` +
          `empty list, silently CLEARING it — omit the field to leave it unchanged-by-default, or ` +
          `pass a proper array.`,
      );
    }
    for (let i = 0; i < arr.length; i++) {
      const el = arr[i];
      if (!isPlainObject(el)) {
        const what =
          el === null
            ? "null"
            : el === undefined
              ? "undefined"
              : Array.isArray(el)
                ? "an array"
                : JSON.stringify(el);
        throw new LtxTimelineWriteError(
          `timeline_data.${field}[${i}] must be a segment OBJECT, not ${what}. The LTXDirector ` +
            `parser THROWS on a non-object segment and silently falls back to an EMPTY timeline, ` +
            `which would WIPE the existing timeline while reporting success — refusing.`,
        );
      }
      // Every track computes timing as `seg.start + seg.length` (and the main track derives
      // an omitted start by accumulating prior lengths). A missing/non-numeric start or
      // length yields NaN timing that corrupts the whole track's layout — with no throw, so
      // it would be applied and reported as success. Require finite numbers for both (they
      // are always present in the shape the node itself saves).
      for (const key of ["start", "length"]) {
        if (!Number.isFinite(el[key])) {
          throw new LtxTimelineWriteError(
            `timeline_data.${field}[${i}].${key} must be a finite number (frames), not ` +
              `${el[key] === undefined ? "undefined" : JSON.stringify(el[key])}. A non-numeric ${key} ` +
              `produces NaN timing that corrupts the track; every segment needs numeric start + ` +
              `length (as in the value the node saves).`,
          );
        }
      }
    }
  }
}

/**
 * Normalize the incoming value into a JSON STRING for _applyLoadedTimeline, returning
 * { jsonStr, timeline } (timeline = the parsed object, used for the result envelope).
 * Accepts an object OR a JSON-object string (the MCP arg schema carries the timeline as a
 * string). Throws LtxTimelineWriteError on invalid JSON, a non-object, or a malformed
 * segment array that would make the node silently wipe the timeline. Pre-validating here
 * matters: the node's own _applyLoadedTimeline swallows parse errors behind an alert() and
 * degrades to an empty timeline, so we must reject bad input BEFORE calling it.
 */
export function normalizeLtxTimelineValue(value) {
  let obj = value;
  if (typeof value === "string") {
    try {
      obj = JSON.parse(value);
    } catch {
      throw new LtxTimelineWriteError(
        `timeline_data must be a JSON object (the LTXDirector timeline), but the string is not valid JSON. ` +
          `Pass the full timeline object, e.g. {"global_prompt":"…","segments":[…]}.`,
      );
    }
  }
  if (!isPlainObject(obj)) {
    throw new LtxTimelineWriteError(
      `timeline_data must be a JSON OBJECT describing the timeline (with segments / global_prompt), ` +
        `not ${Array.isArray(obj) ? "an array" : JSON.stringify(obj)}.`,
    );
  }
  assertTimelineSegments(obj);
  return { jsonStr: JSON.stringify(obj), timeline: obj };
}

/**
 * The node's CLEAN current-timeline snapshot: the JSON it keeps in the timeline_data widget
 * (commitChanges maintains it with all runtime-only segment fields — imgObj/videoEl/blobs —
 * already stripped, so it is safe to JSON round-trip, unlike the live editor.timeline which
 * holds DOM/Image refs). Returns the parsed plain object, or null when it can't be read.
 */
export function parseTimelineSnapshot(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function currentTimelineSnapshot(editor) {
  return parseTimelineSnapshot(editor?.timelineDataWidget?.value);
}

function findWidget(node, name) {
  const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
  return widgets.find((w) => w?.name === name) ?? null;
}

function nodeTimelineSnapshot(node) {
  return parseTimelineSnapshot(findWidget(node, LTX_TIMELINE_MASTER_WIDGET)?.value);
}

function readIntWidget(node, name, { min, fallback }) {
  const n = Number.parseInt(findWidget(node, name)?.value, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/**
 * The clip window commitChanges() uses: start_frame + duration_frames widgets, with the
 * same missing/invalid fallbacks as TimelineEditor.getStartFrames / getDurationFrames.
 */
export function readLtxTimelineWindow(node) {
  return {
    startFrames: readIntWidget(node, "start_frame", { min: 0, fallback: DEFAULT_START_FRAMES }),
    durationFrames: readIntWidget(node, "duration_frames", { min: 1, fallback: DEFAULT_DURATION_FRAMES }),
  };
}

function isReadyLtxEditor(editor) {
  return !!(editor && typeof editor._applyLoadedTimeline === "function" && editor.timelineDataWidget);
}

function mergeOntoCurrent(base, overlay) {
  const merged = base ? { ...base, ...overlay } : overlay;
  const preservedTracks = base
    ? SEGMENT_ARRAY_FIELDS.filter(
        (f) => !Object.prototype.hasOwnProperty.call(overlay, f) && Array.isArray(base[f]) && base[f].length,
      )
    : [];
  return { merged, preservedTracks, mergedOntoCurrent: base != null };
}

function strengthString(v) {
  const n = v !== undefined ? Number(v) : 1.0;
  return (Number.isFinite(n) ? n : 1.0).toFixed(2);
}

/**
 * The node's own derived-widget computation, mirrored from TimelineEditor.commitChanges().
 * local_prompts joins with " | "; segment_lengths and guide_strength join with "," (no
 * space). Gaps inside the start/duration window are absorbed into the adjacent segment;
 * the last kept segment is extended to fill the window. Non-text segments in range emit
 * a two-decimal guide strength (default 1.00).
 */
export function deriveLtxTimelineWidgets(timeline, { startFrames = DEFAULT_START_FRAMES, durationFrames = DEFAULT_DURATION_FRAMES } = {}) {
  const segs = Array.isArray(timeline?.segments) ? [...timeline.segments] : [];
  segs.sort((a, b) => a.start - b.start);
  const endFrames = startFrames + durationFrames;

  if (timeline?.retakeMode) {
    const retakeStart = Number.isFinite(timeline.retakeStart) ? timeline.retakeStart : 0;
    const retakeLength = Number.isFinite(timeline.retakeLength) ? timeline.retakeLength : durationFrames;
    const retakeEnd = retakeStart + retakeLength;
    const retakePrompt = timeline.retakePrompt || "";
    const globalPrompt = timeline.global_prompt || "";
    const retakeStrength = Number.isFinite(Number(timeline.retakeStrength)) ? Number(timeline.retakeStrength) : 1.0;
    const lengths = [];
    const prompts = [];
    const strengths = [];

    const pBeforeLen = Math.min(endFrames, retakeStart) - startFrames;
    if (pBeforeLen > 0) {
      lengths.push(pBeforeLen);
      prompts.push(globalPrompt || "video");
      strengths.push("0.00");
    }
    const rStart = Math.max(startFrames, retakeStart);
    const rEnd = Math.min(endFrames, retakeEnd);
    const rLen = rEnd - rStart;
    if (rLen > 0) {
      lengths.push(rLen);
      prompts.push(retakePrompt || "video");
      strengths.push(retakeStrength.toFixed(2));
    }
    const pAfterLen = endFrames - Math.max(startFrames, retakeEnd);
    if (pAfterLen > 0) {
      lengths.push(pAfterLen);
      prompts.push(globalPrompt || "video");
      strengths.push("0.00");
    }
    return {
      local_prompts: prompts.join(LTX_PROMPT_JOIN),
      segment_lengths: lengths.join(LTX_LENGTH_JOIN),
      guide_strength: strengths.join(LTX_STRENGTH_JOIN),
    };
  }

  const contiguousLengths = [];
  const contiguousPrompts = [];
  let currentCursor = startFrames;
  let pendingGap = 0;
  for (const seg of segs) {
    if (seg.start + seg.length <= startFrames) continue;
    if (seg.start >= endFrames) break;
    const effectiveStart = Math.max(seg.start, startFrames);
    if (effectiveStart > currentCursor) {
      const gapLength = Math.min(effectiveStart, endFrames) - currentCursor;
      if (contiguousLengths.length > 0) {
        contiguousLengths[contiguousLengths.length - 1] += gapLength;
      } else {
        pendingGap += gapLength;
      }
    }
    const clippedEnd = Math.min(seg.start + seg.length, endFrames);
    contiguousLengths.push(clippedEnd - effectiveStart + pendingGap);
    contiguousPrompts.push(seg.prompt || "");
    pendingGap = 0;
    currentCursor = Math.max(currentCursor, seg.start + seg.length);
  }
  const clampedCursor = Math.min(currentCursor, endFrames);
  if (contiguousLengths.length > 0 && clampedCursor < endFrames) {
    contiguousLengths[contiguousLengths.length - 1] += endFrames - clampedCursor;
  }

  const guide = segs
    .filter((s) => s.type !== "text")
    .filter((s) => s.start + s.length > startFrames && s.start < endFrames)
    .map((s) => strengthString(s.guideStrength));

  return {
    local_prompts: contiguousPrompts.join(LTX_PROMPT_JOIN),
    segment_lengths: contiguousLengths.join(LTX_LENGTH_JOIN),
    guide_strength: guide.join(LTX_STRENGTH_JOIN),
  };
}

/** The refusal message for a DERIVED-widget write — explains why + points at timeline_data. */
export function derivedTimelineRefusal(widgetName, nodeId) {
  return (
    `panel_set_widget cannot drive "${widgetName}" on LTXDirector node ${nodeId}: it is a DERIVED ` +
    `OUTPUT that the node's timeline editor REGENERATES from "${LTX_TIMELINE_MASTER_WIDGET}" on every ` +
    `commit — a direct write shows in panel_query_graph but is silently reverted and never reaches the ` +
    `UI (#314). Set the whole timeline instead: panel_set_widget on "${LTX_TIMELINE_MASTER_WIDGET}" with ` +
    `the full timeline JSON (segments + global_prompt), which drives the editor and regenerates ` +
    `"${LTX_DERIVED_TIMELINE_WIDGETS.join('", "')}" for you.`
  );
}

/**
 * Drive the LTXDirector timeline through the node's OWN _applyLoadedTimeline re-hydration.
 * Hooks are injected so this is unit-testable without a browser AND so the lib OWNS the
 * change ordering (mirroring set-widget.js):
 *   - `getEditor(node)` returns the live TimelineEditor instance (default node._timelineEditor).
 *   - `beforeChange` / `afterChange` bracket the mutation in litegraph's undo envelope so
 *     the route honors panel_set_widget's "Undoable with Ctrl+Z" contract — the node's own
 *     _applyLoadedTimeline only schedules async dirty/state-capture work and does NOT take a
 *     pre-change snapshot. afterChange ALWAYS runs (even on throw); beforeChange is only
 *     fired once the value + editor are validated, so a refusal establishes no empty undo step.
 *   - `setDirty` repaints the canvas on success.
 * Returns a result envelope. Throws LtxTimelineWriteError when the value is invalid, or
 * neither a ready editor NOR the serialized timeline_data + derived widgets exist — an
 * HONEST failure rather than a raw write that would be silently reverted. When the editor
 * is missing but the widgets are present (#1308), writes the serialized values and
 * regenerates the derived widgets so execute() sees the new prompts.
 *
 * MERGE, not replace. The node's _applyLoadedTimeline is a whole-timeline REPLACE that
 * DEFAULTS every omitted field (an absent track loads as [], an absent global_prompt as "").
 * A partial write would therefore silently WIPE unmentioned tracks / reset scalars. To match
 * panel_set_widget's "change this" intent — and the #560 composite-widget pattern of merging
 * onto the CURRENT value — we overlay the caller's provided top-level fields onto the node's
 * clean current-timeline snapshot, so anything they don't mention is PRESERVED. An explicit
 * empty array (e.g. `motionSegments: []`) still clears that track; only OMISSION preserves.
 */
function applySerializedLtxTimeline(node, merged, { beforeChange, afterChange, setDirty, preservedTracks, mergedOntoCurrent }) {
  const missing = FALLBACK_REQUIRED_WIDGETS.filter((name) => !findWidget(node, name));
  if (missing.length) {
    throw new LtxTimelineWriteError(
      `LTXDirector node ${node?.id} has no live, ready timeline editor, and cannot use the serialized ` +
        `fallback because the widget(s) ${missing.join(", ")} are missing. The node's Python execute() ` +
        `reads local_prompts / segment_lengths / guide_strength — writing timeline_data alone would ` +
        `leave the render on the OLD prompts (#1308). Refresh the ComfyUI tab so the pack frontend ` +
        `initializes, or open the node on the canvas.`,
    );
  }

  const derived = deriveLtxTimelineWidgets(merged, readLtxTimelineWindow(node));
  const audioOn = merged.audioTrackEnabled !== false;
  const motionOn = merged.motionTrackEnabled !== false;
  const toggles = {};
  if (findWidget(node, LTX_AUDIO_TOGGLE_WIDGET)) toggles[LTX_AUDIO_TOGGLE_WIDGET] = audioOn;
  if (findWidget(node, LTX_MOTION_TOGGLE_WIDGET)) toggles[LTX_MOTION_TOGGLE_WIDGET] = motionOn;

  beforeChange?.();
  try {
    findWidget(node, LTX_TIMELINE_MASTER_WIDGET).value = JSON.stringify(merged);
    for (const name of LTX_DERIVED_TIMELINE_WIDGETS) {
      findWidget(node, name).value = derived[name];
    }
    for (const [name, val] of Object.entries(toggles)) {
      findWidget(node, name).value = val;
    }
    if (Object.prototype.hasOwnProperty.call(merged, "inpaint_audio")) {
      const w = findWidget(node, "inpaint_audio");
      if (w) w.value = !!merged.inpaint_audio;
    }
    if (Object.prototype.hasOwnProperty.call(merged, "overrideAudio")) {
      const w = findWidget(node, "override_audio");
      if (w) w.value = !!merged.overrideAudio;
    }
  } finally {
    afterChange?.();
  }
  setDirty?.();
  const segments = Array.isArray(merged.segments) ? merged.segments.length : undefined;
  return {
    ltx_timeline: {
      node_id: node?.id,
      widget: LTX_TIMELINE_MASTER_WIDGET,
      driven: true,
      fallback: true,
      editor_driven: false,
      merged_onto_current: mergedOntoCurrent,
      preserved_tracks: preservedTracks,
      segments,
      derived_regenerated: [...LTX_DERIVED_TIMELINE_WIDGETS],
      ...derived,
      ...(Object.keys(toggles).length ? { audio_motion_toggles: toggles } : {}),
    },
  };
}

export function applyLtxTimelineWrite(node, value, { getEditor, beforeChange, afterChange, setDirty } = {}) {
  const { timeline } = normalizeLtxTimelineValue(value);
  const editor = typeof getEditor === "function" ? getEditor(node) : node?._timelineEditor;
  const overlay = effectiveTimeline(timeline);

  // Prefer the live editor when it is actually ready. The node's _applyLoadedTimeline
  // re-parses into this.timeline, syncs the DOM, and regenerates the derived widgets.
  if (isReadyLtxEditor(editor)) {
    const { merged, preservedTracks, mergedOntoCurrent } = mergeOntoCurrent(
      currentTimelineSnapshot(editor),
      overlay,
    );
    beforeChange?.();
    try {
      editor._applyLoadedTimeline(JSON.stringify(merged), null);
    } finally {
      afterChange?.();
    }
    setDirty?.();
    const segments = Array.isArray(merged.segments) ? merged.segments.length : undefined;
    return {
      ltx_timeline: {
        node_id: node?.id,
        widget: LTX_TIMELINE_MASTER_WIDGET,
        driven: true,
        fallback: false,
        editor_driven: true,
        merged_onto_current: mergedOntoCurrent,
        preserved_tracks: preservedTracks,
        segments,
        derived_regenerated: [...LTX_DERIVED_TIMELINE_WIDGETS],
      },
    };
  }

  // #1308: no live editor (pack JS not yet initialized, node never rendered). Author the
  // serialized widgets the node already persists — the copy/paste workaround proves that
  // shape is accepted. Still refuse when even timeline_data is absent: there is nothing to
  // write and a "driven" report would be a lie.
  if (findWidget(node, LTX_TIMELINE_MASTER_WIDGET)) {
    const { merged, preservedTracks, mergedOntoCurrent } = mergeOntoCurrent(nodeTimelineSnapshot(node), overlay);
    return applySerializedLtxTimeline(node, merged, {
      beforeChange,
      afterChange,
      setDirty,
      preservedTracks,
      mergedOntoCurrent,
    });
  }

  throw new LtxTimelineWriteError(
    `LTXDirector node ${node?.id} has no live, ready timeline editor to drive (the node UI has not ` +
      `initialized, its timeline_data widget is missing, or this pack version does not expose the ` +
      `timeline load path) and no serialized timeline_data widget to fall back to. Open the node on ` +
      `the canvas, or refresh the ComfyUI tab so the pack frontend initializes; panel_set_widget ` +
      `cannot author the timeline until one of those is available.`,
  );
}
