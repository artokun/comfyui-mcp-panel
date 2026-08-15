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
// WHY RECONCILE (re-derive) RATHER THAN REJECT. The derived widgets are a TOTAL, PURE
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
// told — as is a timeline_data copy that lost to the editor (`superseded_timeline_data`) and an
// editor copy set aside while it was NOT the proven-current record (`overwrote_uncommitted_edit`
// when timeline_data is unreadable and the editor holds the only copy; `discarded_stale_editor` /
// `discarded_unverified_editor_copy` when the filter rejected it). The one state that is REFUSED
// rather than disclosed-after-the-fact is a DETECTED in-flight edit: when the derived-widget
// filter PROVES the live editor holds the text the node would execute right now (timeline_data
// could not have produced it — the mid-debounce signature, indistinguishable from an out-of-band
// master) and the write's explicit `segments` do not reproduce that text, applying them would
// destroy the edit while reporting success. No non-guessing merge of two conflicting segment
// lists exists, so the write FAILS CLOSED with both states disclosed per segment and nothing
// mutated — the same discipline as an unresolved tie. Which name a discarded copy gets depends
// on WHICH branch settled authority and, for a copy the derived-widget filter rejected, on the
// PRE-LOAD SNAPSHOT: the
// filter proves only that a copy disagrees with the widgets, never WHY, and a stale post-load
// editor is indistinguishable from an uncommitted edit whose derived values were refreshed back
// to the master. So recordPreLoadPromptRelayEditors observes what each editor held before the
// current load; an editor still holding exactly that is PROVEN stale (`discarded_stale_editor`,
// no warning — the routine post-load window must not fire a data-loss alarm or the alarm stops
// meaning anything), and anything else is `discarded_unverified_editor_copy` WITH a warning that
// says plainly that we could not tell. Unknown is never treated as safe: a false warning costs
// attention, a suppressed loss costs the user's work. Both carry the prior prompts PER SEGMENT, and both are decided
// by comparing segment ARRAYS (sameSegmentContent), never the derived `" | "` join, which is
// lossy and would hide a real overwrite whenever a prompt contains a literal "|". The same limit
// governs WHICH copy is authoritative: a join comparison can only ask "could this widget hold
// this timeline's serialization?", never "which of two colliding timelines is current?" — so
// chooseMergeBase uses it as a filter, and when the filter cannot separate the two the write
// FAILS CLOSED rather than guess: a tie is REFUSED with both copies disclosed and nothing
// mutated. Keeping the editor's copy could write the previous workflow's timeline back over the
// one a load just restored; keeping the widget's could destroy text still being typed — and
// explicit `segments` are NO exception, because they still destroy whichever copy they do not
// reproduce behind a "reconciled" report. Success requires a resolved base; a tie is usually
// transient (the editor's commit debounce or its post-load re-parse), so the caller re-issues
// once the records agree.
// Anything PromptRelay's python would encode differently from
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
 *
 * THE JOIN IS LOSSY AND MUST NEVER DECIDE WHETHER CONTENT CHANGED. `" | "` is not an
 * injection: `["a | b", "c"]` and `["a", "b | c"]` both join to `"a | b | c"`. It is only
 * valid to compare a derived string against a WIDGET, because the widget itself stores nothing
 * but the join — asking "is this widget consistent with this timeline?". Asking "did the user's
 * segments change?" requires the STRUCTURAL comparison in sameSegmentContent().
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
// The edge characters PromptRelay's PYTHON strips before encoding: `str.strip()` with no
// argument, i.e. exactly the characters `str.isspace()` accepts. Spelled out rather than
// reusing JS `\s`, because the two sets differ in BOTH directions and these notices describe
// what PYTHON will do:
//   * python strips the separator/C1 controls U+001C-U+001F and U+0085; JS trim() does not,
//     so `\s` alone would MISS a prompt python drops entirely (shifting every later segment)
//     - the exact silent mismatch this warning exists to catch;
//   * JS trim() strips U+FEFF; python does NOT, so including it would warn that text will be
//     trimmed when the render actually keeps it verbatim.
const PY_STRIP_CLASS =
  "[\\t\\n\\v\\f\\r \\u001c-\\u001f\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const PY_STRIPPED_EDGE_CHARS = new RegExp(`^${PY_STRIP_CLASS}+|${PY_STRIP_CLASS}+$`, "g");

function edgeTrim(s) {
  return s.replace(PY_STRIPPED_EDGE_CHARS, "");
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

/**
 * Do two segment lists carry the SAME user content? Compared element-by-element on the fields
 * that hold authored data — never through `derivePromptRelayWidgets`, whose `" | "` join is
 * lossy: `["a | b", "c"]` and `["a", "b | c"]` produce an identical `local_prompts` while being
 * completely different timelines. Every "did the content change?" decision goes through here,
 * so a prompt containing a literal "|" can never make a real overwrite look like a no-op.
 */
function sameLength(x, y) {
  // Identical values (including two absent ones) match outright. Otherwise the two sides are
  // equal only when they normalize to the SAME stored frame count through the very rule the
  // write path uses — so "24" matches 24, while "2e3" does NOT match 2000 (the pack's
  // parseInt reads "2e3" as 2, so treating them as equal would suppress the disclosure while
  // a live 2000-frame segment was replaced by a 2-frame one). A plain Number() coercion would
  // do exactly that; stringifying would make `null` equal `"null"`. Anything this cannot
  // prove equal counts as DIFFERENT, which errs toward disclosing rather than hiding a loss.
  if (x === y) return true;
  const nx = normalizeSegmentLength(x);
  const ny = normalizeSegmentLength(y);
  return nx !== null && ny !== null && nx === ny;
}

export function sameSegmentContent(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]?.prompt !== b[i]?.prompt) return false;
    if (!sameLength(a[i]?.length, b[i]?.length)) return false;
  }
  return true;
}

/**
 * A RECOVERABLE snapshot of a segment list for the result envelope: the authored prompt
 * strings themselves, per segment, plus their lengths. Deliberately NOT the joined
 * `local_prompts` — handing back `"a | b | c"` for a timeline whose real segments were
 * `["a | b", "c"]` would tell the caller their text was lost without telling them what it was.
 */
function contentSnapshot(segments) {
  return {
    prompts: segments.map((s) => (typeof s?.prompt === "string" ? s.prompt : "")),
    lengths: segments.map((s) => s?.length),
  };
}

// Where the PRE-LOAD editor snapshot lives, stamped on the node itself (never serialized —
// LiteGraph.serialize() writes only its known fields, so this cannot leak into a workflow).
const PRE_LOAD_SEGMENTS_KEY = "__cmcpPromptRelayPreLoadSegments";

// How long after a load the node's editor may still be holding pre-load content. The pack
// re-parses the editor from timeline_data on a `setTimeout(…, 10)` scheduled by onConfigure, so
// the un-reparsed window is milliseconds; this is generous slack for a loaded machine. It is
// deliberately SHORT rather than generous, because the window is the only period in which
// content equality is allowed to mean "stale": outside it the editor has certainly re-parsed,
// so equal content means a user re-authored it and the write must warn. Erring short costs a
// spurious warning on a very slow load; erring long would quietly discard authored text.
const POST_LOAD_REPARSE_WINDOW_MS = 250;

/**
 * Snapshot every PromptRelayEncodeTimeline editor's CURRENT segments just BEFORE a workflow
 * load replaces the graph. Called from the panel's app.loadGraphData fork. Descends into
 * subgraphs, since a write can target a node inside one.
 *
 * WHY THIS EXISTS. The derived widgets can prove that an editor copy does not match what the
 * node executes — they can NEVER prove WHY. A stale editor left over from the previous
 * workflow (onConfigure restores the widgets ~10ms before it re-parses the editor) and an
 * uncommitted edit whose derived values were refreshed back to the master are indistinguishable
 * from the widget values alone, yet they demand opposite disclosures: a warning on the second
 * would be noise, silence on the first would suppress real loss. No threshold between them can
 * be right, so this records an OBSERVATION instead — the content the editor held before the
 * current load, and when that load began.
 */
export function recordPreLoadPromptRelayEditors(nodes, { getEditor, now = Date.now } = {}) {
  const at = now();
  const seen = new Set();
  const stack = Array.isArray(nodes) ? nodes.slice() : [];
  let stamped = 0;
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node); // identity-keyed, so a cyclic subgraph cannot loop forever
    const nested = node.subgraph?._nodes ?? node.subgraph?.nodes;
    if (Array.isArray(nested)) stack.push(...nested);
    if (!isPromptRelayTimelineNode(node)) continue;
    const ed = typeof getEditor === "function" ? getEditor(node) : node._timelineEditor;
    const tl = liveEditorTimeline(ed);
    // Store only the authored fields — the same ones sameSegmentContent compares.
    node[PRE_LOAD_SEGMENTS_KEY] = {
      at,
      segments: tl ? tl.segments.map((seg) => ({ prompt: seg?.prompt, length: seg?.length })) : null,
    };
    stamped++;
  }
  return stamped;
}

/**
 * Is this editor copy PROVEN to predate the current workflow load? Requires BOTH:
 *   * the editor still holds exactly what it held before the load, AND
 *   * we are still inside the window in which it can not yet have re-parsed.
 * Content equality ALONE is not proof of history: a user who re-types exactly the pre-load text
 * after the re-parse would otherwise have that authored text quietly discarded. Nobody re-types
 * a timeline within a few hundred ms of a load, so the window is what makes equality meaningful.
 * With no snapshot, a stale clock, or a delta outside the window, the answer is not "stale" but
 * "unknown" — and unknown must never be treated as safe.
 */
function editorProvenStale(node, editorSegs, now = Date.now) {
  const stamp = node?.[PRE_LOAD_SEGMENTS_KEY];
  if (!stamp || !Array.isArray(stamp.segments) || !Number.isFinite(stamp.at)) return false;
  const since = now() - stamp.at;
  if (!(since >= 0 && since <= POST_LOAD_REPARSE_WINDOW_MS)) return false;
  return sameSegmentContent(stamp.segments, editorSegs);
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
 * The derived widgets narrow the choice, but they can only ever act as a FILTER, never as a
 * tie-break. A join comparison answers exactly one question — "could this widget hold this
 * timeline's serialization?" — and it is NOT able to answer "which of two timelines is
 * current?", because `" | "` is lossy: `["a", "b | c"]` and `["a | b", "c"]` with equal
 * lengths produce byte-identical `local_prompts` AND `segment_lengths`, so both candidates
 * look consistent while being different timelines. Settling authority on that equality is how
 * a metadata-only overlay (say `{ "zoom": 4 }`) could rebuild from a stale master and destroy
 * a live two-box edit without ever being asked to change a segment.
 *
 * So the order is:
 *   1. only one candidate readable  → it wins;
 *   2. both readable and STRUCTURALLY identical → no authority question exists; the master
 *      field is canonical;
 *   3. they differ and exactly ONE is consistent with the derived widgets → that one is
 *      current (this is what separates the debounce window from the post-load window);
 *   4. they differ and the filter CANNOT separate them (both consistent — colliding joins — or
 *      neither) → UNRESOLVABLE. Choosing a copy here would be a GUESS, and each guess has a
 *      losing scenario with real loss: keeping the editor's copy can write the PREVIOUS
 *      workflow's timeline back over the one a load just restored, keeping the widget's can
 *      destroy text still being typed. So a tie chooses NOTHING — it is returned flagged
 *      (`ambiguous`) with NO base, and the caller fails closed (see applyPromptRelayTimelineWrite).
 *
 * Both derived widgets are compared, not just `local_prompts`: two timelines can share a
 * prompt join while differing in segment lengths, and that difference is worth catching even
 * though the reverse collision above is not detectable this way at all.
 */
/**
 * COULD this timeline's serialization be what the derived widgets currently hold? That is the
 * only question this can answer. It is a FILTER, never a tie-break — see chooseMergeBase.
 */
function derivedMatchesWidgets(timeline, widgets) {
  if (!timeline) return false;
  const d = derivePromptRelayWidgets(timeline.segments);
  return (
    d.local_prompts === widgets.local_prompts.value &&
    d.segment_lengths === widgets.segment_lengths.value
  );
}

/**
 * The merge base for an EDITOR-authoritative write (case 3). The shipped editor's parser
 * retains ONLY prompt/length/color per segment and no other top-level field, so its
 * `this.timeline` must NOT be merged from directly: spreading it would DROP every field the
 * parser does not model (a top-level `zoom`, per-segment metadata, …) that exists only in the
 * widget's JSON. Instead the editor-KNOWN fields are merged ONTO the widget's timeline object:
 * the widget (the persisted record, which the editor never edits around) supplies everything
 * else, the editor stays authoritative for the segment list and the fields it actually holds.
 *
 * Per segment the correspondence between the two lists is the hazard: segments carry no ids,
 * and the editor's list can differ from the widget's by MORE than the keystroke that made it
 * authoritative — a reorder or a shrink inside the 120 ms debounce window. Carrying unmodelled
 * fields BY INDEX would then attach a removed/old segment's metadata to a surviving prompt it
 * was never written for. So the carry is keyed, never positional-by-default:
 *
 *   * ALIGNED lists — same length and AT MOST one index disagreeing on prompt — are the
 *     in-place-typing signature: every position is provably the same segment, so the
 *     same-index widget segment carries (this is what lets a mid-keystroke prompt edit keep
 *     its segment's unmodelled fields).
 *   * Anything else (reorder / shrink / grow / several edits in one window) breaks positional
 *     proof. A segment may still carry from a widget segment with the SAME prompt — but only
 *     when that prompt is UNIQUE on both sides, making the pairing 1:1. A duplicated prompt or
 *     no match means the mapping is AMBIGUOUS, and ambiguous means NO carry: losing an
 *     unmodelled extra field beats writing it onto the WRONG segment, and the write's
 *     disclosures already hand back anything the node loses.
 */
function editorTimelineOntoWidget(fromEditor, fromWidget) {
  const widgetSegs = Array.isArray(fromWidget?.segments) ? fromWidget.segments : [];
  const editorSegs = fromEditor.segments;
  let indexAligned = widgetSegs.length === editorSegs.length;
  if (indexAligned) {
    let promptDiffs = 0;
    for (let i = 0; i < editorSegs.length; i++) {
      if (editorSegs[i]?.prompt !== widgetSegs[i]?.prompt) promptDiffs++;
    }
    indexAligned = promptDiffs <= 1;
  }
  // Prompt popularity on each side, for the 1:1 content match. Only STRING prompts participate
  // — anything else can never prove a pairing.
  const promptCount = (list) => {
    const counts = new Map();
    for (const s of list) {
      if (typeof s?.prompt === "string") counts.set(s.prompt, (counts.get(s.prompt) ?? 0) + 1);
    }
    return counts;
  };
  const inEditor = promptCount(editorSegs);
  const inWidget = promptCount(widgetSegs);
  const carryFor = (seg, i) => {
    if (indexAligned) return isPlainObject(widgetSegs[i]) ? widgetSegs[i] : {};
    if (typeof seg.prompt !== "string") return {};
    if (inEditor.get(seg.prompt) !== 1 || inWidget.get(seg.prompt) !== 1) return {};
    const match = widgetSegs.find((w) => w?.prompt === seg.prompt);
    return isPlainObject(match) ? match : {};
  };
  const segments = editorSegs.map((seg, i) => {
    // A malformed editor segment is passed through untouched so normalizeSegments refuses it
    // loudly, exactly as it would have on the raw editor copy.
    if (!isPlainObject(seg)) return seg;
    const base = carryFor(seg, i);
    // Only fields the editor actually HOLDS may override the widget's; an absent or undefined
    // one keeps the widget's value instead of clobbering it.
    const held = {};
    for (const [key, v] of Object.entries(seg)) {
      if (v !== undefined) held[key] = v;
    }
    return { ...base, ...held };
  });
  return { ...fromWidget, segments };
}

function chooseMergeBase(editor, widgets) {
  const fromEditor = liveEditorTimeline(editor);
  const fromWidget = parsePromptRelayTimeline(widgets[PROMPT_RELAY_MASTER_WIDGET].value);
  // `reason` records WHICH branch settled authority. That matters downstream: a copy set aside
  // by the case-3 filter was proven stale, while one set aside by being superseded was not —
  // and the two deserve very different disclosures.
  const pick = (base, baseSource, reason, ambiguous = false) => ({
    base,
    baseSource,
    reason,
    fromWidget,
    fromEditor,
    ambiguous,
  });
  // 1. Only one record to merge onto (or none).
  if (!fromEditor && !fromWidget) return pick(null, "none", "no-readable-copy");
  if (!fromEditor) return pick(fromWidget, "timeline_data", "only-readable-copy");
  if (!fromWidget) return pick(fromEditor, "editor", "only-readable-copy");
  // 2. The two records carry the SAME content, so there is no authority to settle. The master
  //    field is canonical (it also carries the persisted non-segment fields).
  if (sameSegmentContent(fromEditor.segments, fromWidget.segments)) {
    return pick(fromWidget, "timeline_data", "copies-identical");
  }
  // 3. They differ. Use the derived widgets as a FILTER: whichever record could NOT have
  //    produced what the node would execute right now is the stale one. A record REJECTED here
  //    is stale on positive evidence, not merely different.
  const editorConsistent = derivedMatchesWidgets(fromEditor, widgets);
  const widgetConsistent = derivedMatchesWidgets(fromWidget, widgets);
  if (widgetConsistent && !editorConsistent) return pick(fromWidget, "timeline_data", "filter-rejected-editor");
  // The editor won authority, but its copy is PARTIAL (the parser models only
  // prompt/length/color), so the base is its known fields merged onto the widget's timeline —
  // never the raw editor copy, which would drop every field it does not model.
  if (editorConsistent && !widgetConsistent) {
    return pick(editorTimelineOntoWidget(fromEditor, fromWidget), "editor", "filter-rejected-master");
  }
  // 4. The filter cannot separate them — either both serialize to the same derived strings
  //    (the lossy-join collision) or neither matches at all. The tie is UNRESOLVABLE, so no
  //    copy is chosen: flagged ambiguous with a null base, and the caller fails closed —
  //    merging onto either copy here could write ambiguous old data over the current one.
  return pick(null, "none", "unresolved-tie", true);
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
 *      anything they did not mention is preserved (never defaulted away). When neither copy
 *      can be PROVEN current (an unresolved tie) this step fails closed: refused outright,
 *      with or without explicit `segments` — they would still destroy whichever copy they do
 *      not reproduce behind a "reconciled" report. Symmetrically, when the editor is
 *      PROVEN current (the mid-debounce signature) but the write's explicit `segments` would
 *      not reproduce its text, the write fails closed too — refused with both states
 *      disclosed, because applying it would destroy the in-flight edit while reporting
 *      success,
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
  { getEditor, beforeChange, afterChange, setDirty, now = Date.now } = {},
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
  const chosen = chooseMergeBase(editor, widgets);
  const {
    reason: baseReason,
    fromWidget,
    fromEditor,
    ambiguous: baseAmbiguous,
  } = chosen;
  const { base, baseSource } = chosen;
  if (baseAmbiguous) {
    // A tie FAILS CLOSED — with or without explicit `segments`. The filter could not prove
    // which record is current, so reconciling FROM either copy would be a guess: keeping the
    // editor's segments can write the PREVIOUS workflow's timeline back over the one a load
    // just restored, keeping the widget's can destroy text still being typed. Explicit
    // segments are NO exception: they replace the record they are written onto, but the copy
    // they do not reproduce is still permanently destroyed — and the call would report a
    // reconciled success for it. There is no resolved base, so there is no write: refused
    // with both copies disclosed and NOTHING mutated. The tie is usually TRANSIENT (the
    // editor's ~120 ms commit debounce, or its ~10 ms re-parse after a workflow load), so the
    // remedy is to re-issue once it settles and the two records agree; a PERSISTENT tie can
    // only be converged on the canvas, where an explicit edit commits the editor's copy to
    // timeline_data — a deliberate act, not a guess this route made.
    const editorCopy = contentSnapshot(Array.isArray(fromEditor?.segments) ? fromEditor.segments : []);
    const widgetCopy = contentSnapshot(Array.isArray(fromWidget?.segments) ? fromWidget.segments : []);
    throw new PromptRelayTimelineWriteError(
      `PromptRelayEncodeTimeline node ${node?.id} holds TWO different timelines — one in its live ` +
        `timeline editor, one in its timeline_data widget — and its derived widgets CANNOT tell ` +
        `which is current (the " | " join is lossy, so structurally different timelines can ` +
        `serialize identically). Reconciling from either copy would mean GUESSING which to keep: ` +
        `one may be the timeline a workflow load just restored, the other may hold prompt text ` +
        `that exists nowhere else — and explicit "segments" do NOT settle that, since they would ` +
        `still permanently destroy whichever copy they do not reproduce behind a "reconciled" ` +
        `report. REFUSED, and nothing was written (#506). The editor holds prompts ` +
        `${JSON.stringify(editorCopy.prompts)} (lengths ${JSON.stringify(editorCopy.lengths)}); ` +
        `timeline_data holds prompts ${JSON.stringify(widgetCopy.prompts)} (lengths ` +
        `${JSON.stringify(widgetCopy.lengths)}). This state is usually TRANSIENT — the editor's ` +
        `~120 ms commit debounce or its ~10 ms re-parse after a workflow load — so re-issue once ` +
        `it settles and the two records agree. If it PERSISTS, converge the records first by ` +
        `committing the intended copy in the node's timeline editor on the canvas, then re-issue.`,
    );
  }
  const merged = base ? { ...base, ...overlay } : { ...overlay };
  const segments = normalizeSegments(merged, Array.isArray(base?.segments) ? base.segments : null);
  const finalTimeline = { ...merged, segments };

  // The node is ALREADY out of sync when its current local_prompts / segment_lengths are not
  // what the base timeline produces — e.g. prompt text written straight into local_prompts with
  // the #506 workaround, which exists ONLY there (and which the node's next commit would revert
  // anyway). That text is about to be replaced, so hand it back rather than let it vanish.
  const baseDerived = base ? derivePromptRelayWidgets(base.segments) : null;
  // With NO readable base (no editor yet, unreadable timeline_data) there is no timeline that
  // could have produced the current derived values, so ANY non-empty one is out-of-band by
  // definition — compare against empty rather than skipping the check, which would let a
  // hand-written local_prompts be overwritten with no report at all.
  const expectedDerived = baseDerived ?? { local_prompts: "", segment_lengths: "" };
  const replaced = {};
  for (const name of PROMPT_RELAY_DERIVED_WIDGETS) {
    const current = widgets[name].value;
    if (typeof current === "string" && current !== expectedDerived[name]) replaced[name] = current;
  }

  const derived = derivePromptRelayWidgets(segments);
  const timelineJson = JSON.stringify(finalTimeline);
  const warnings = timelineWarnings(segments);

  // The node keeps TWO copies of the timeline (the editor's in-memory one and the
  // timeline_data widget), and either can be the current one — see chooseMergeBase. When they
  // agree there is nothing hidden: the caller read the node, and discarding the old content is
  // exactly what they asked for. When they DISAGREE the node is in an anomalous state and one
  // copy holds content the caller may never have seen — an edit still being typed, or prompts a
  // raw timeline_data write left behind (the #506 state itself). So whenever the two copies
  // diverge, any copy this write does not reproduce is handed back — and when the discarded
  // copy is the one PROVEN current (the mid-debounce signature below), the write is refused
  // outright instead, because a disclosure cannot un-destroy text.
  //
  // Every comparison here is STRUCTURAL (sameSegmentContent), never the derived join. Gating on
  // the joined local_prompts would miss a real overwrite whenever a prompt contains a literal
  // "|": the persisted pair ["old","c"], an in-flight edit turning segment 0 into "a | b", and
  // an incoming write of ["a","b | c"] all reduce to the SAME string "a | b | c" while being
  // three different timelines.
  const editorSegs = Array.isArray(fromEditor?.segments) ? fromEditor.segments : null;
  const widgetSegs = Array.isArray(fromWidget?.segments) ? fromWidget.segments : null;
  // ANOMALOUS = the node's records do not corroborate each other:
  //   * both readable but DIFFERENT — one of them holds content the caller may not have seen;
  //   * an editor copy with an UNREADABLE timeline_data — the editor is then the only record
  //     of that content anywhere, so discarding it is exactly the case that must be reported.
  // A headless node (no editor, readable widget) is NOT anomalous: the widget is the single
  // normal record and the caller read it, so an ordinary write there stays quiet.
  const anomalous = editorSegs && widgetSegs ? !sameSegmentContent(editorSegs, widgetSegs) : !!editorSegs;

  // HOW a discarded copy is CLASSIFIED depends on WHICH branch settled authority — not merely
  // on the two copies differing. When the case-3 filter chose the master precisely BECAUSE the
  // editor could not have produced what the node executes, the editor is stale on positive
  // evidence: the ordinary post-load window, where onConfigure restores the widgets ~10ms
  // before it re-parses the editor. Calling that an overwritten uncommitted edit would fire a
  // data-loss warning on a routine write and train callers to ignore the signal exactly when it
  // is real — and this disclosure is the safety net for the one residual we accept (a stale
  // post-load editor whose joins collide with a newer master). So its content is still handed
  // back, under a name that says what it is and with NO warning attached.
  const editorWasAuthority = baseSource === "editor";
  const editorDiscarded = !!editorSegs && !sameSegmentContent(editorSegs, segments);

  // The MIRROR of the post-load case FAILS CLOSED instead of disclosing after the fact. Here
  // the case-3 filter PROVED the editor is the current record — it matches what the node would
  // execute right now, and the persisted master could not have produced those derived values.
  // That is the signature of an edit still inside the editor's ~120 ms commit debounce, but a
  // timeline_data written out of band (the persisted #506 state) presents identically, and in
  // BOTH the editor's text is the current one. A write whose explicit `segments` do not
  // reproduce that text would destroy it while reporting a successful reconcile — the exact
  // silent loss this route exists to prevent, and handing the text back in the result envelope
  // does not un-destroy it. There is no non-guessing merge of two conflicting segment lists
  // (each is a TOTAL claim on the list; zipping or concatenating would invent a timeline
  // neither party wrote), so — the same discipline as an unresolved tie — the write is REFUSED
  // with both states disclosed per segment and NOTHING mutated. Every remedy is deterministic:
  // incorporate the editor's text and re-issue; or wait out the debounce, after which the
  // editor's commit has converged the node and the write is ordinary; or, when the state
  // persists — proving no edit is in flight — write the editor's disclosed segments back
  // verbatim to converge the two records first, then re-issue.
  if (editorWasAuthority && baseReason === "filter-rejected-master" && editorDiscarded) {
    const editorCopy = contentSnapshot(editorSegs);
    const suppliedCopy = contentSnapshot(segments);
    throw new PromptRelayTimelineWriteError(
      `PromptRelayEncodeTimeline node ${node?.id} holds an UNCOMMITTED timeline edit: its live ` +
        `editor's segments are what the node would execute right now, but they differ from its ` +
        `timeline_data — either text still inside the editor's ~120 ms commit debounce, or a ` +
        `timeline_data written out of band; the widget values cannot tell which, and either way ` +
        `the editor's text is the current one. This write's explicit "segments" do not reproduce ` +
        `that text, so applying them would DESTROY it while reporting success — REFUSED, and ` +
        `nothing was written (#506). The editor holds prompts ` +
        `${JSON.stringify(editorCopy.prompts)} (lengths ${JSON.stringify(editorCopy.lengths)}); ` +
        `the segments you supplied are prompts ${JSON.stringify(suppliedCopy.prompts)} (lengths ` +
        `${JSON.stringify(suppliedCopy.lengths)}). To keep the editor's text, re-issue with ` +
        `segments that incorporate it. To overwrite it deliberately: wait ~120 ms for the ` +
        `editor's pending commit to reach timeline_data and re-issue — or, when no edit is ` +
        `actually in flight (this state persists), first write the editor's disclosed segments ` +
        `back verbatim to converge the node's two records, then re-issue your segments as an ` +
        `ordinary write.`,
    );
  }

  // After that throw, this disclosure covers the ONE remaining case where the editor is
  // authoritative WITHOUT being proven newer than a readable master: an UNREADABLE
  // timeline_data, where the editor's copy is the only record of that content anywhere.
  // Refusing there could wedge the node (with no readable master there is nothing to converge
  // first, and the lossy join cannot reconstruct the editor's segments reliably), so the write
  // proceeds and hands the replaced copy back.
  const overwroteInFlight =
    editorWasAuthority && editorDiscarded && baseReason !== "filter-rejected-master"
      ? contentSnapshot(editorSegs)
      : null;
  // The filter rejected this editor copy. That alone does NOT say whether it was a stale
  // leftover or text the user typed, so the pre-load snapshot decides:
  //   PROVEN stale (still holds exactly what it held before the current load) → payload only;
  //   UNPROVEN (no snapshot, or the content changed since the load) → payload AND a warning.
  // Unknown is never treated as safe: a false warning costs attention, a suppressed loss costs
  // the user's work.
  const editorSetAside = !editorWasAuthority && anomalous && editorDiscarded;
  const staleProven = editorSetAside && editorProvenStale(node, editorSegs, now);
  const discardedStaleEditor = staleProven ? contentSnapshot(editorSegs) : null;
  const discardedUnverifiedEditor =
    editorSetAside && !staleProven ? contentSnapshot(editorSegs) : null;
  if (discardedUnverifiedEditor) {
    warnings.push(
      `a live editor copy that did not match this node's derived widgets was DISCARDED, and it ` +
        `could NOT be determined whether it was a stale leftover (an editor not yet re-parsed after ` +
        `a workflow load) or prompt text typed into the node that had not been committed — the two ` +
        `look identical from the widget values alone. Its prompts are returned PER SEGMENT as ` +
        `"discarded_unverified_editor_copy.prompts"; write them back if they were yours.`,
    );
  }
  if (overwroteInFlight) {
    warnings.push(
      `this node's live editor held segments (what the node would execute right now) that exist ` +
        `in no READABLE timeline_data — an UNCOMMITTED timeline edit, typically text typed into ` +
        `the prompt box that had not yet been committed. The segments you supplied REPLACED them. ` +
        `Their prompts are returned PER SEGMENT as ` +
        `"overwrote_uncommitted_edit.prompts" — write those back if you meant to keep them.`,
    );
  }

  // Symmetrically: the master is only 'superseded' when it did NOT win authority. When case 3
  // selected it and the caller then replaced its segments, that is the caller's plain intent,
  // not a copy being set aside behind their back.
  const supersededTimelineData =
    editorWasAuthority && widgetSegs && !sameSegmentContent(widgetSegs, segments)
      ? contentSnapshot(widgetSegs)
      : null;
  if (supersededTimelineData) {
    warnings.push(
      `the node's timeline_data widget held DIFFERENT segments from the timeline editor, and your ` +
        `write did not reproduce them. They are returned PER SEGMENT as ` +
        `"superseded_timeline_data.prompts" — if those were the prompts you wanted, write them ` +
        `explicitly as "${PROMPT_RELAY_MASTER_WIDGET}" segments.`,
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
      // Invalidate any IN-FLIGHT pointer interaction: the reorder state and the boundary-drag
      // state both key on segment INDICES into the OLD list. Left intact across this write,
      // the pointer's release would splice sourceIdx→targetIdx of a list that may no longer
      // have those positions — splicing `undefined` into a shrunken list and throwing inside
      // the editor's own commit() BEFORE the derived widgets update — and a boundary drag
      // would keep resizing at stale indices from its stale length snapshot. With the state
      // reset to the pack's idle values, the editor's pointer handlers treat the release as a
      // no-op (pointer capture auto-releases on pointerup), so the drag simply ends. Only the
      // REHYDRATION path does this: a refused write mutates nothing, so a drag in progress
      // there continues undisturbed.
      editor.dragHandle = -1;
      editor.dragStart = null;
      editor.reorder = null;
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
      merge_base_reason: baseReason,
      editor_synced: editorSynced,
      local_prompts: derived.local_prompts,
      segment_lengths: derived.segment_lengths,
      ...(Object.keys(replaced).length ? { replaced_out_of_band: replaced } : {}),
      ...(overwroteInFlight ? { overwrote_uncommitted_edit: overwroteInFlight } : {}),
      ...(discardedStaleEditor ? { discarded_stale_editor: discardedStaleEditor } : {}),
      ...(discardedUnverifiedEditor
        ? { discarded_unverified_editor_copy: discardedUnverifiedEditor }
        : {}),
      ...(supersededTimelineData ? { superseded_timeline_data: supersededTimelineData } : {}),
      ...(uiRefreshError ? { ui_refresh_error: uiRefreshError } : {}),
      ...(warnings.length ? { warnings } : {}),
    },
  };
}
