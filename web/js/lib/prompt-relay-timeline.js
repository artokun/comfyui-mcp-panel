// Targeted support for driving the ComfyUI-PromptRelay `PromptRelayEncodeTimeline` node
// via panel_set_widget (#506). Sibling of ltx-director.js (#314), but a DIFFERENT node with
// DIFFERENT mechanics — kept in its own module so neither can regress the other.
//
// THE PROBLEM (#506). PromptRelayEncodeTimeline has three HIDDEN widgets:
//   * `timeline_data`    — JSON `{ segments: [ { prompt, length, color }, … ] }`; the state
//                          the node's own TimelineEditor parses ONCE (constructor / onConfigure)
//                          into the in-memory `this.timeline` that the canvas draws.
//   * `local_prompts`    — DERIVED: `segments.map(s => s.prompt).join(" | ")`
//   * `segment_lengths`  — DERIVED: `segments.map(s => s.length).join(", ")`
// The editor regenerates BOTH derived widgets from `this.timeline` on every commit
// (`syncWidgetsFromTimeline`).
//
// The node's PYTHON `execute()` reads ONLY `global_prompt`, `local_prompts` and
// `segment_lengths`. It NEVER reads `timeline_data`. So a raw panel_set_widget on
// `timeline_data`:
//   * writes the widget value, so panel_query_graph reflects it (the tool "succeeds"),
//   * does NOT reach the editor's `this.timeline`, so the node UI still shows the old blocks,
//   * leaves `local_prompts` / `segment_lengths` STALE, so the RENDER USES THE OLD PROMPTS, and
//   * is silently REVERTED on the next commit (any UI touch re-derives timeline_data from the
//     stale in-memory timeline).
// That is exactly #506: "timeline_data contains the new prompt while local_prompts still
// contains the prior prompt", and the executed prompt is the stale one.
//
// WHY RECONCILE (regenerate) RATHER THAN REJECT. The derived widgets are a TOTAL, PURE
// function of `timeline.segments` — the node itself defines them that way. And since
// execute() never looks at `timeline_data`, rejecting a `timeline_data` write outright would
// leave NO way to drive this node at all. So a `timeline_data` write regenerates
// `local_prompts` + `segment_lengths` from the SAME segments and writes all three ATOMICALLY,
// then re-hydrates the live editor so the UI matches and the next commit is a no-op.
//
// UNLIKE LTXDirector, this pack exposes NO re-hydration entry point (`_applyLoadedTimeline`
// has no equivalent here). We therefore compute the authoritative values ourselves — the
// derivation is two `join()`s, mirrored verbatim from `syncWidgetsFromTimeline` — and assign
// them. A consequence is that the write is correct EVEN WHEN NO EDITOR EXISTS (node never
// rendered, pack JS not loaded): the widgets are consistent, and the editor's constructor
// re-parses our `timeline_data` when it eventually runs.
//
// DATA-LOSS STANCE. User-authored prompt TEXT lives in `timeline_data.segments[].prompt`.
// Anything the node's own parser would COERCE (a missing prompt → "", a bogus length → 1) or
// that would make it RESET to a blank two-segment default (absent/empty/malformed segments)
// is REFUSED LOUDLY instead of applied — a loud, safe failure over silent destruction. Fields
// the caller does not mention are MERGED from the node's CURRENT timeline — and "current"
// deliberately means the live editor's copy when the user is mid-keystroke, because the
// timeline_data widget lags a typed prompt by up to 120 ms (see chooseMergeBase). And when the
// node is found ALREADY desynced (out-of-band `local_prompts` text that no timeline produces —
// e.g. written with the #506 workaround), the pre-existing value is RETURNED in the result
// envelope before being replaced, so no prompt text ever disappears without the caller being
// told — as is an UNCOMMITTED edit the user was still typing when the write landed
// (`overwrote_uncommitted_edit`). Anything PromptRelay's python would encode differently from
// what the timeline shows (a blank prompt, a literal "|", padding whitespace) comes back as a
// warning. The invariant: the panel never leaves the timeline saying A, the prompts saying B,
// and the caller told nothing.

export const PROMPT_RELAY_TIMELINE_NODE_TYPE = "PromptRelayEncodeTimeline";

// The master widget: the JSON the editor parses into its source-of-truth timeline.
export const PROMPT_RELAY_MASTER_WIDGET = "timeline_data";

// Derived OUTPUTS of the editor's syncWidgetsFromTimeline(). A direct write shows up in
// panel_query_graph but is reverted on the next commit AND desyncs the node the other way
// round ("prompts say A, timeline says B"), so these are refused and redirected.
export const PROMPT_RELAY_DERIVED_WIDGETS = Object.freeze(["local_prompts", "segment_lengths"]);

// Every widget this route reads or writes. All three must exist for a reconcile to be
// possible at all.
const REQUIRED_WIDGETS = Object.freeze([PROMPT_RELAY_MASTER_WIDGET, ...PROMPT_RELAY_DERIVED_WIDGETS]);

// The exact separators the node uses on both sides of the wire: the editor joins with these,
// and the Python `_encode_relay` splits `local_prompts` on "|" and `segment_lengths` on ",".
const PROMPT_JOIN = " | ";
const LENGTH_JOIN = ", ";

// The node clamps every segment to at least one pixel-space frame.
const MIN_SEGMENT_LENGTH = 1;

// COSMETIC ONLY. Mirrors the pack's block palette so a segment that arrives without a
// `color` gets a stable one instead of an undefined fill. If the pack's palette ever drifts,
// the sole effect is a different block colour — no derived value depends on this.
const FALLBACK_SEGMENT_COLORS = Object.freeze([
  "#4f8edc",
  "#e07b3a",
  "#5cb85c",
  "#d9534f",
  "#9b6cd6",
  "#a07060",
  "#e377c2",
  "#7f7f7f",
  "#c4c447",
  "#3fbac4",
]);

/**
 * True for a PromptRelayEncodeTimeline node (matched on the ComfyUI class, never a value
 * shape). Matches when EITHER `type` OR `comfyClass` is the class name — not
 * `type ?? comfyClass`, which would ignore a matching `comfyClass` whenever `type` holds a
 * different non-null value (the #314 review finding, same trap here).
 */
export function isPromptRelayTimelineNode(node) {
  return (
    node?.type === PROMPT_RELAY_TIMELINE_NODE_TYPE ||
    node?.comfyClass === PROMPT_RELAY_TIMELINE_NODE_TYPE
  );
}

/**
 * Classify a set_widget request against the PromptRelay timeline widgets:
 *   "master"  → timeline_data (reconcile: write all three widgets + re-hydrate the editor)
 *   "derived" → local_prompts / segment_lengths (refuse, redirect to timeline_data)
 *   null      → not a PromptRelay timeline widget; use the normal write path
 * Non-PromptRelayEncodeTimeline nodes always return null, so no other node is perturbed.
 */
export function classifyPromptRelayTimelineWrite(node, widgetName) {
  if (!isPromptRelayTimelineNode(node)) return null;
  if (widgetName === PROMPT_RELAY_MASTER_WIDGET) return "master";
  if (PROMPT_RELAY_DERIVED_WIDGETS.includes(widgetName)) return "derived";
  return null;
}

export class PromptRelayTimelineWriteError extends Error {
  constructor(message) {
    super(message);
    this.name = "PromptRelayTimelineWriteError";
  }
}

// A PLAIN JSON object (`{}` literal / Object.create(null)) — not an array, not a Map/Set/
// Date/class instance. The value round-trips through JSON.stringify into the widget, which
// turns any exotic object into `{}` (an empty timeline the node then resets to its blank
// default). Rejecting those up front means we never report success for a wipe.
function isPlainObject(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * The node's segment length, normalized to the integer frame count it stores — or null when
 * the value is one the node's `Math.max(1, parseInt(v, 10) || 1)` would silently MANGLE
 * (missing, fractional, zero/negative, non-numeric).
 * A STRING is accepted only in the forms parseInt handles LOSSLESSLY: optional leading "+",
 * digits, and a zero-valued fraction ("24", "+24", "24.0", "24."). Deliberately refused:
 *   * a non-zero fraction ("24.7") — parseInt TRUNCATES it, silently shortening a segment;
 *   * EXPONENT notation ("2e3") — parseInt stops at the "e" and yields 2, i.e. a caller who
 *     means 2000 frames would get 2. Refusing the whole form (including the harmless "24e0")
 *     is the only way to make that impossible.
 * The result must also be a SAFE integer: `String()` switches to exponent notation at 1e21,
 * and `segment_lengths` is consumed by python's `int()`, which rejects "1e+21" outright while
 * the pack's own parseInt would read it back as 1.
 */
const LOSSLESS_INT_STRING = /^\+?\d+(?:\.0*)?$/;

function normalizeSegmentLength(v) {
  let n;
  if (typeof v === "number") {
    n = v;
  } else if (typeof v === "string") {
    const trimmed = v.trim();
    if (!LOSSLESS_INT_STRING.test(trimmed)) return null;
    n = Number.parseInt(trimmed, 10);
  } else {
    return null;
  }
  if (!Number.isSafeInteger(n) || n < MIN_SEGMENT_LENGTH) return null;
  // Belt-and-braces: only a plain decimal string is round-trippable through the joined
  // `segment_lengths` value that python's int() parses.
  return /^\d+$/.test(String(n)) ? n : null;
}

function describe(v) {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Parse a timeline_data widget string into a plain object, or null when it is empty/invalid.
 * Used both for the merge base and for detecting a pre-existing desync.
 */
export function parsePromptRelayTimeline(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The node's own derivation, mirrored verbatim from `syncWidgetsFromTimeline`:
 *   local_prompts   = segments.map(s => s.prompt).join(" | ")
 *   segment_lengths = segments.map(s => s.length).join(", ")
 * Keeping this in ONE exported place means the production path and the tests agree, and any
 * drift from the pack is a one-line change here.
 */
export function derivePromptRelayWidgets(segments) {
  const segs = Array.isArray(segments) ? segments : [];
  return {
    local_prompts: segs.map((s) => s?.prompt ?? "").join(PROMPT_JOIN),
    segment_lengths: segs.map((s) => s?.length ?? "").join(LENGTH_JOIN),
  };
}

/**
 * Validate + normalize the caller's value into a plain timeline object.
 * Accepts an object OR a JSON-object string (the MCP arg schema carries it as a string).
 * Throws PromptRelayTimelineWriteError on anything the node would silently coerce or reset.
 */
export function normalizePromptRelayTimelineValue(value) {
  let obj = value;
  if (typeof value === "string") {
    try {
      obj = JSON.parse(value);
    } catch {
      throw new PromptRelayTimelineWriteError(
        `timeline_data must be the PromptRelayEncodeTimeline timeline as a JSON object, but the ` +
          `string is not valid JSON. Pass e.g. {"segments":[{"prompt":"…","length":24}]}.`,
      );
    }
  }
  if (!isPlainObject(obj)) {
    throw new PromptRelayTimelineWriteError(
      `timeline_data must be a JSON OBJECT describing the timeline (with a "segments" array), ` +
        `not ${describe(obj)}.`,
    );
  }
  return obj;
}

/**
 * Validate the EFFECTIVE (post-merge) timeline and return its segments normalized to the
 * shape the node stores. Every rejection below is a case where the node's own parseInitial
 * would either RESET to a blank two-segment default (wiping every prompt) or COERCE a field
 * (destroying that segment's prompt / length) while the tool reported success.
 */
function normalizeSegments(timeline, baseSegments) {
  const segments = timeline.segments;
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new PromptRelayTimelineWriteError(
      `timeline_data.segments must be a NON-EMPTY array of segment objects (got ${describe(segments)}). ` +
        `The PromptRelayEncodeTimeline editor resets an absent/empty segment list to a blank ` +
        `two-segment default, which would WIPE every prompt on the node while reporting success — ` +
        `refusing. Read the node's current timeline_data, edit it, and write the whole object back.`,
    );
  }
  return segments.map((seg, i) => {
    if (!isPlainObject(seg)) {
      throw new PromptRelayTimelineWriteError(
        `timeline_data.segments[${i}] must be a segment OBJECT, not ${describe(seg)}. The node's ` +
          `parser falls back to a blank two-segment timeline on a malformed segment, WIPING every ` +
          `prompt — refusing.`,
      );
    }
    if (typeof seg.prompt !== "string") {
      throw new PromptRelayTimelineWriteError(
        `timeline_data.segments[${i}].prompt must be a STRING (got ${describe(seg.prompt)}). The node ` +
          `coerces a missing/non-string prompt to "", which would silently DESTROY that segment's ` +
          `prompt text — refusing. Pass the prompt explicitly, or "" if you really mean empty.`,
      );
    }
    const length = normalizeSegmentLength(seg.length);
    if (length === null) {
      throw new PromptRelayTimelineWriteError(
        `timeline_data.segments[${i}].length must be a whole number of frames >= ${MIN_SEGMENT_LENGTH} ` +
          `(got ${describe(seg.length)}). The node clamps anything else to ${MIN_SEGMENT_LENGTH} frame, ` +
          `silently corrupting the segment lengths that drive the render — refusing.`,
      );
    }
    // A PRESENT `color` must be a string. The node would swap a non-string for a
    // palette entry, so accepting it would mean applying a value the caller did not ask for.
    if (seg.color !== undefined && typeof seg.color !== "string") {
      throw new PromptRelayTimelineWriteError(
        `timeline_data.segments[${i}].color, when present, must be a colour STRING (got ` +
          `${describe(seg.color)}). The node replaces a non-string colour with a palette entry — ` +
          `refusing rather than applying a colour you did not ask for. Omit the field to keep the ` +
          `segment's current colour.`,
      );
    }
    // An OMITTED colour keeps the colour the segment at this position already has, so an edit
    // that only rewrites prompts does not reshuffle the block colours; with no current
    // timeline to inherit from, fall back to the palette position (what the node itself would
    // pick). Either way we WRITE the colour, so the node never has to re-derive it.
    const color =
      seg.color ??
      (typeof baseSegments?.[i]?.color === "string"
        ? baseSegments[i].color
        : FALLBACK_SEGMENT_COLORS[i % FALLBACK_SEGMENT_COLORS.length]);
    // Spread the CALLER's segment first so any field a future pack version adds survives.
    // Deliberately NOT merged with the same-index segment of the current timeline: supplying
    // `segments` REPLACES the list, and index-matching unknown per-segment metadata across a
    // reordered or resized list would attach it to the wrong segment. `color` is the sole
    // exception because it is purely cosmetic and must be present for the canvas to draw.
    return { ...seg, prompt: seg.prompt, length, color };
  });
}

/**
 * Non-fatal notes about states where the node's PYTHON side would execute something other
 * than what the timeline shows. These are legitimate states the node's own UI can produce, so
 * they are reported rather than refused — but they are never left silent.
 *   * `_encode_relay` drops blank entries (`if p.strip()`), so an empty prompt makes the
 *     prompt count disagree with the length count and shifts every later segment.
 *   * `local_prompts` is split on "|", so a literal "|" inside a prompt becomes TWO prompts.
 */
// The edge characters that get stripped before encoding. Python's `str.strip()` and JS's
// `String.trim()` do NOT agree — python also strips the C1/separator controls U+001C…U+001F
// and U+0085, while JS also strips U+FEFF — so the UNION is used, and the padding/blank
// notices fire for anything EITHER side would remove. (Using JS trim() alone would miss a
// prompt padded with U+001C: python drops it, shifting every later segment, with no warning.)
const STRIPPED_EDGE_CHARS = /^[\s\u001c-\u001f\u0085\ufeff]+|[\s\u001c-\u001f\u0085\ufeff]+$/g;

function edgeTrim(s) {
  return s.replace(STRIPPED_EDGE_CHARS, "");
}

function timelineWarnings(segments) {
  const warnings = [];
  const blank = [];
  const piped = [];
  const padded = [];
  for (let i = 0; i < segments.length; i++) {
    const p = segments[i].prompt;
    const trimmed = edgeTrim(p);
    if (trimmed === "") blank.push(i);
    else if (trimmed !== p) padded.push(i);
    if (p.includes("|")) piped.push(i);
  }
  if (blank.length) {
    warnings.push(
      `segment(s) ${blank.join(", ")} have an EMPTY prompt. PromptRelay drops blank entries when it ` +
        `splits local_prompts, so the node will run ${segments.length - blank.length} prompt(s) against ` +
        `${segments.length} segment length(s) and every later segment shifts. Give each segment a prompt, ` +
        `or delete the empty segments.`,
    );
  }
  if (piped.length) {
    warnings.push(
      `segment(s) ${piped.join(", ")} contain a literal "|". PromptRelay splits local_prompts on "|", so ` +
        `each of those becomes MORE than one prompt at run time and the segments misalign. Remove the ` +
        `"|" characters from the prompt text.`,
    );
  }
  if (padded.length) {
    warnings.push(
      `segment(s) ${padded.join(", ")} have leading/trailing whitespace. PromptRelay strips each entry ` +
        `after splitting local_prompts, so the text it actually encodes is the TRIMMED prompt — the ` +
        `padding you set is not part of the render.`,
    );
  }
  return warnings;
}

/** Locate a widget by name on a LiteGraph node. */
function findWidget(node, name) {
  const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
  return widgets.find((w) => w?.name === name) ?? null;
}

/** The live editor's in-memory timeline, when it is a usable one; otherwise null. */
function liveEditorTimeline(editor) {
  const tl = editor && typeof editor === "object" ? editor.timeline : null;
  if (!isPlainObject(tl) || !Array.isArray(tl.segments) || tl.segments.length === 0) return null;
  return tl;
}

/**
 * Pick which timeline the write MERGES onto — the single trickiest decision here, because the
 * two candidates can each be the stale one:
 *
 *   * The `timeline_data` WIDGET lags while the user is typing. The editor's textarea handler
 *     updates `this.timeline` and `local_prompts` IMMEDIATELY but debounces the timeline_data
 *     JSON write by 120 ms. Merging onto the widget in that window would rebuild from the
 *     pre-keystroke timeline and DESTROY the text the user just typed.
 *   * The EDITOR's `this.timeline` lags right after a workflow load: `onConfigure` restores the
 *     widgets first and re-parses the editor 10 ms later. Merging onto the editor in that
 *     window would resurrect the PREVIOUS workflow's timeline — including its lengths and any
 *     per-segment metadata, not just its prompts.
 *
 * The DERIVED widgets break the tie, and the rule is "widget first, editor only as the
 * exception". `timeline_data` is the node's master field, so it wins WHENEVER it still agrees
 * with the derived widgets. The debounce window is the one moment it does not: the keystroke
 * handler has already advanced `local_prompts` past the pre-keystroke JSON. Deferring to the
 * editor only in that case means a stale post-load editor can never be chosen — after a load
 * the restored widgets agree with each other, so the widget wins even if the old editor
 * happens to derive the same strings.
 *
 * Both derived widgets are compared, not just `local_prompts`: two different timelines can
 * share a prompt join while differing in segment lengths.
 */
function derivedMatchesWidgets(timeline, widgets) {
  if (!timeline) return false;
  const d = derivePromptRelayWidgets(timeline.segments);
  return (
    d.local_prompts === widgets.local_prompts.value &&
    d.segment_lengths === widgets.segment_lengths.value
  );
}

function chooseMergeBase(editor, widgets) {
  const fromEditor = liveEditorTimeline(editor);
  const fromWidget = parsePromptRelayTimeline(widgets[PROMPT_RELAY_MASTER_WIDGET].value);
  if (derivedMatchesWidgets(fromWidget, widgets)) return { base: fromWidget, baseSource: "timeline_data" };
  if (derivedMatchesWidgets(fromEditor, widgets)) return { base: fromEditor, baseSource: "editor" };
  // Neither agrees with what the node would execute: it is genuinely desynced. The master
  // field wins and the out-of-band text is reported back to the caller.
  if (fromWidget) return { base: fromWidget, baseSource: "timeline_data" };
  if (fromEditor) return { base: fromEditor, baseSource: "editor" };
  return { base: null, baseSource: "none" };
}

/** The refusal message for a DERIVED-widget write — explains why + points at timeline_data. */
export function promptRelayDerivedRefusal(widgetName, nodeId) {
  return (
    `panel_set_widget cannot drive "${widgetName}" on PromptRelayEncodeTimeline node ${nodeId}: it is a ` +
    `DERIVED OUTPUT that the node's timeline editor REGENERATES from "${PROMPT_RELAY_MASTER_WIDGET}" on ` +
    `every commit — a direct write shows in panel_query_graph but never reaches the timeline UI and is ` +
    `reverted the moment the node is touched, leaving the prompts and the timeline disagreeing (#506). ` +
    `Set the whole timeline instead: panel_set_widget on "${PROMPT_RELAY_MASTER_WIDGET}" with the timeline ` +
    `JSON ({"segments":[{"prompt":"…","length":24}, …]}), which drives the editor and regenerates ` +
    `"${PROMPT_RELAY_DERIVED_WIDGETS.join('", "')}" for you.`
  );
}

/**
 * Reconcile a `timeline_data` write on PromptRelayEncodeTimeline.
 *
 * ORDERING (all synchronous — JavaScript is single-threaded, so no concurrent UI edit can
 * interleave between the read of the current timeline and the write of the new one):
 *   1. validate the caller's value,
 *   2. resolve ALL THREE widgets (refuse if any is missing — a reconcile would be impossible),
 *   3. MERGE the caller's top-level fields onto the node's CURRENT timeline — see
 *      chooseMergeBase for which of the editor / widget copies is the current one — so
 *      anything they did not mention is preserved (never defaulted away),
 *   4. validate + normalize the merged segments (refusing every coerce/reset case),
 *   5. COMPUTE all three final widget values,
 *   6. only then MUTATE — three plain assignments that cannot throw, so there is no path that
 *      leaves timeline_data updated with the derived widgets stale,
 *   7. re-hydrate the live editor (if any) from the same object and repaint.
 *
 * Hooks are injected so this is unit-testable without a browser and so the lib owns the
 * ordering (mirroring ltx-director.js): `getEditor(node)` (default `node._timelineEditor`),
 * `beforeChange`/`afterChange` bracket the mutation in litegraph's undo envelope so the route
 * honors panel_set_widget's "Undoable with Ctrl+Z" contract, and `setDirty` repaints.
 * beforeChange fires only AFTER every refusal has been cleared, so a rejected write leaves no
 * empty undo step; afterChange always runs.
 */
export function applyPromptRelayTimelineWrite(
  node,
  value,
  { getEditor, beforeChange, afterChange, setDirty } = {},
) {
  const overlay = normalizePromptRelayTimelineValue(value);

  const widgets = {};
  const missing = [];
  for (const name of REQUIRED_WIDGETS) {
    const w = findWidget(node, name);
    if (w) widgets[name] = w;
    else missing.push(name);
  }
  if (missing.length) {
    throw new PromptRelayTimelineWriteError(
      `PromptRelayEncodeTimeline node ${node?.id} is missing the widget(s) ${missing.join(", ")}, so ` +
        `"${PROMPT_RELAY_MASTER_WIDGET}" cannot be reconciled with the prompts the node actually ` +
        `executes. Writing timeline_data alone would leave the render using the OLD prompts (#506) — ` +
        `refusing. Check that the ComfyUI-PromptRelay pack is installed and this node is up to date.`,
    );
  }

  // Merge onto the node's CURRENT timeline: a caller who sends only `segments` keeps every
  // other field, matching panel_set_widget's "change this" intent. Providing `segments`
  // explicitly REPLACES the segment list (that is the whole point of the write); only
  // OMISSION preserves. An overlay that omits `segments` entirely is therefore an idempotent
  // RE-RECONCILE of the node's existing timeline — which is also the repair path for a node
  // that is already desynced — and is refused only when there is no current timeline to keep.
  const editor = typeof getEditor === "function" ? getEditor(node) : node?._timelineEditor;
  const { base, baseSource } = chooseMergeBase(editor, widgets);
  const merged = base ? { ...base, ...overlay } : { ...overlay };
  const segments = normalizeSegments(merged, Array.isArray(base?.segments) ? base.segments : null);
  const finalTimeline = { ...merged, segments };

  // The node is ALREADY out of sync when its current local_prompts / segment_lengths are not
  // what the base timeline produces — e.g. prompt text written straight into local_prompts with
  // the #506 workaround, which exists ONLY there (and which the node's next commit would revert
  // anyway). That text is about to be replaced, so hand it back rather than let it vanish.
  const baseDerived = base ? derivePromptRelayWidgets(base.segments) : null;
  const replaced = {};
  if (baseDerived) {
    for (const name of PROMPT_RELAY_DERIVED_WIDGETS) {
      const current = widgets[name].value;
      if (typeof current === "string" && current !== baseDerived[name]) replaced[name] = current;
    }
  }

  const derived = derivePromptRelayWidgets(segments);
  const timelineJson = JSON.stringify(finalTimeline);
  const warnings = timelineWarnings(segments);

  // chooseMergeBase only falls back to the editor when the timeline_data widget has gone
  // stale, which means a prompt edit was IN FLIGHT (typed into the node's prompt box, not yet
  // committed). Merging preserves it — but a caller who supplies `segments` REPLACES the list,
  // and that legitimately discards the in-flight text. That is the caller's stated intent, so
  // it is applied rather than refused, but it is never left silent.
  const overwroteInFlight =
    baseSource === "editor" && baseDerived && baseDerived.local_prompts !== derived.local_prompts
      ? baseDerived.local_prompts
      : null;
  if (overwroteInFlight !== null) {
    warnings.push(
      `this node had an UNCOMMITTED prompt edit in progress (text typed into the node's prompt box ` +
        `that had not yet reached timeline_data). The segments you supplied REPLACED it; the text ` +
        `that was in flight is returned as "overwrote_uncommitted_edit". Re-read the node and write ` +
        `again if you meant to keep it.`,
    );
  }
  if (Object.keys(replaced).length) {
    warnings.push(
      `this node was ALREADY desynced: its ${Object.keys(replaced).join(" / ")} did not match its ` +
        `timeline_data (typically a direct write to a derived widget, which the node reverts anyway). ` +
        `Those values have been REPLACED by the ones derived from the timeline you just set; the ` +
        `previous text is returned as "replaced_out_of_band" so nothing is lost silently.`,
    );
  }

  // ── MUTATE ── Everything above either threw or produced final values, so from here on
  // there are only assignments; no path can leave the three widgets disagreeing.
  beforeChange?.();
  let editorSynced = false;
  let uiRefreshError = null;
  try {
    widgets[PROMPT_RELAY_MASTER_WIDGET].value = timelineJson;
    widgets.local_prompts.value = derived.local_prompts;
    widgets.segment_lengths.value = derived.segment_lengths;

    // Re-hydrate the live editor from the SAME object so its next commit — including a
    // still-pending 120 ms textarea debounce — re-derives exactly what we just wrote (a no-op)
    // instead of reverting to the stale in-memory timeline.
    if (editor && typeof editor === "object") {
      editor.timeline = finalTimeline;
      const last = segments.length - 1;
      const sel = Number.isInteger(editor.selectedIndex) ? editor.selectedIndex : 0;
      editor.selectedIndex = Math.max(0, Math.min(sel, last));
      // Drop the block-position animation state: it is keyed by segment INDEX, so stale
      // entries would animate the new blocks from the old layout. render() falls back to the
      // true position for any index it cannot find, so clearing simply snaps them correct.
      editor._displayedX?.clear?.();
      editor._targetX?.clear?.();
      editor._settling = false;
      editorSynced = true;
      try {
        // updateUIFromSelection refreshes the prompt textarea + length input from the new
        // timeline (and clears the in-progress length-edit baseline, which refers to the old
        // lengths); render repaints the blocks.
        editor.updateUIFromSelection?.();
        editor.render?.();
      } catch (err) {
        // The widgets and editor.timeline are already consistent, so execution is correct;
        // only the repaint failed. Report it instead of failing the whole write.
        uiRefreshError = err?.message ? String(err.message) : String(err);
      }
    }
  } finally {
    afterChange?.();
  }
  setDirty?.();

  return {
    prompt_relay_timeline: {
      node_id: node?.id,
      widget: PROMPT_RELAY_MASTER_WIDGET,
      reconciled: true,
      segments: segments.length,
      merged_onto_current: base != null,
      merge_base: baseSource,
      editor_synced: editorSynced,
      local_prompts: derived.local_prompts,
      segment_lengths: derived.segment_lengths,
      ...(Object.keys(replaced).length ? { replaced_out_of_band: replaced } : {}),
      ...(overwroteInFlight !== null ? { overwrote_uncommitted_edit: overwroteInFlight } : {}),
      ...(uiRefreshError ? { ui_refresh_error: uiRefreshError } : {}),
      ...(warnings.length ? { warnings } : {}),
    },
  };
}
