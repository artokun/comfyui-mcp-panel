import { fireNodeWidgetChanged } from "./node-widget-changed.js";
import { missingWidgetMessage } from "./missing-widget.js";
import { explainNumericNormalization, normalizationNote } from "./widget-normalization.js";
import { isNonSerializingValueSource } from "./virtual-source-promotion.js";
import {
  boundPropertyFailure,
  boundPropertyState,
  boundPropertyUnverifiedNote,
} from "./widget-bound-property.js";

// #976: captured at module load so invoking a widget's callback cannot read any
// property off the callback itself (a poisoned `.call` getter or a Proxy trap would
// throw INSIDE the span that attributes the throw to the callback body) and cannot
// depend on globals a page could later redefine.
const reflectApply = Reflect.apply;
// A module-load capture cannot defend against a `Reflect.apply` that was already
// replaced BEFORE this module evaluated (codex round 2). Nothing here can: at that
// point the page owns the intrinsics the whole panel runs on. Written down rather
// than defended, so the limit is known instead of assumed away.

/**
 * #976: describe a thrown value for a disclosure message.
 *
 * Renders what `${threw?.message ?? threw}` rendered before — `new Error("")` still
 * yields an empty detail, a thrown string still yields itself, `{ message: 0 }` still
 * yields `0` — and adds only what was missing: nullish throws (which the old
 * truthiness test never reached) and totality. `throw` accepts any value, so
 * `.message` may be a getter that throws and `toString` may throw, and a disclosure
 * that exists to REPORT a throw must not itself throw (codex round 3).
 *
 * Not equivalent in the cases where the OLD form threw: a Symbol (or a Symbol-valued
 * `message`) cannot be implicitly coerced, so template interpolation threw where
 * `String()` returns `Symbol(x)`. Deliberate — those are exactly the throws that used
 * to escape the reporting path (codex round 4).
 */
function describeThrown(err) {
  // The one case where a label is warranted: there is nothing else to print, and
  // "(undefined)" alone reads like a bug in the reporting rather than the thrown value.
  if (err === null || err === undefined) return `a non-Error value was thrown: ${String(err)}`;
  try {
    return String(err.message ?? err);
  } catch {
    return "a thrown value that could not be described";
  }
}

/**
 * #976: the first stack frame OUTSIDE this write path, as scrubbed data.
 *
 * `describeThrown` renders the message and nothing else, and the Error is caught
 * inside this lib so it never reaches the console — so a callback's throw used to
 * leave NO evidence of WHERE it threw, and the maintainer was reduced to asking
 * reporters for a stack the panel itself made unobtainable. This emits the single
 * most useful fact: the innermost frame that is not this module or its set-widget
 * driver, which names the FILE the throw surfaced from.
 *
 * A frame is an OBSERVATION, not an attribution — unlike `write_warning_source` it
 * claims nothing about which construct failed, so it is emitted for the
 * unattributed branch too.
 *
 * Totality, same contract as describeThrown: `err.stack` may be a throwing accessor
 * (a hostile Proxy), a non-Error throw has no stack at all, and a frame line may be
 * any shape — so every read is guarded and any surprise yields null, never a throw
 * from the path that exists to report one.
 *
 * Scrubbing, because this text is pasted into public issues: the frame's ORIGIN
 * (scheme://host:port, which identifies the reporter's machine) is stripped, keeping
 * only the URL path — `/extensions/<pack>/<file>.js:LINE:COL` is what a maintainer
 * needs. Length is capped so a minified single-line bundle cannot make the envelope
 * unwieldy.
 */
function describeThrownFrame(err) {
  try {
    const stack = err?.stack;
    if (typeof stack !== "string" || !stack) return null;
    for (const line of stack.split("\n")) {
      const trimmed = line.trim();
      // V8 ("at fn (url:line:col)") and SpiderMonkey ("fn@url:line:col") both carry
      // the URL; the message header and anything else is skipped.
      if (!trimmed.startsWith("at ") && !trimmed.includes("@")) continue;
      // Frames from the write path itself say where the PANEL was, not where the
      // throw surfaced — step past them to the first frame that is not ours.
      if (trimmed.includes("widget-write.js") || trimmed.includes("set-widget.js")) continue;
      // Strip the origin, keep the path. If the URL shape is not recognized the
      // frame is still usable — the path is what carries the information.
      let frame = trimmed.replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s)]+(?=\/)/g, "");
      if (frame.length > 240) frame = frame.slice(0, 237) + "...";
      return frame;
    }
    return null;
  } catch {
    return null;
  }
}

// Widget-value validation + promoted-subgraph-widget target resolution for
// graph_set_widget. Extracted so the write targets the RIGHT widget with the
// RIGHT value and can be unit-tested by driving the SAME code path the handler
// runs (applyWidgetWrite), not a parallel reimplementation.
//
// Three graph-integrity bugs motivate this module:
//   #233 — panel_set_widget on a SUBGRAPH node's PROMOTED widget wrote by a
//          positionally-shifted slot and silently corrupted a DIFFERENT inner
//          widget (an INT slot ended up holding "euler"), reporting success.
//   #240 — a COMBO widget set to a valid enum silently drifted to a different
//          option (index-vs-value reinterpretation).
//   #366 — a PROMOTED widget write landed on the INNER node only; the parent's
//          own rail widget (what serializes at queue time) stayed stale, so the
//          render used the OLD value while the tool reported success (silent
//          wrong output).
//
// Safety contract (all three bugs are silent corruption; we NEVER fail open):
//   * A promoted widget resolves to its ACTUAL inner (node, widget) and the
//     write lands THERE. If it looks promoted but cannot be resolved
//     unambiguously, we THROW before mutating — never fall back to the shifted
//     parent slot.
//   * A promoted write also writes the AUTHORITATIVE parent rail widget —
//     identified by the promotion RELATIONSHIP (host-input↔widget backlink), never
//     a name/label guess — ATOMICALLY with the inner write (one undo; rollback +
//     throw on any callback failure, so never inner=new/parent=stale). If the
//     parent rail widget cannot be positively identified, we FAIL CLOSED (throw)
//     rather than write inner-only and render silently stale (#366).
//   * The value is validated against the target widget's declared type and
//     REJECTED on mismatch (combo must be an exact CURRENT option; numeric must
//     be numeric; boolean must be boolean; a combo whose options we cannot read
//     is refused, not written blindly).

export class WidgetWriteError extends Error {
  constructor(message, { combo = false, emptyOptions = false, unreadableOptions = false, partialWrite = false } = {}) {
    super(message);
    this.name = "WidgetWriteError";
    // #1126 — the graph WAS MUTATED and the rollback did not fully take. Every other
    // WidgetWriteError is a pre-mutation refusal: nothing was applied, and a caller may
    // safely reword it as "refused". This one must never be reworded that way, because
    // telling a caller "nothing was applied" when something was is precisely the class of
    // false report this change exists to eliminate. Callers that frame refusals check it.
    this.partialWrite = partialWrite;
    // #1126 — `unreadableOptions` narrows `combo` to the OTHER unknowable case: the
    // option list could not be READ AT ALL, because `options.values` is a callback that
    // threw, returned a non-list, or is absent. That is an OBSERVATION about the LIST,
    // not a verdict about the VALUE — nothing was ever compared — so runSetWidget's
    // #1126 last-resort may act on it, and never on a "not a valid option" miss against
    // a list it read successfully. Destructured explicitly: this constructor drops meta
    // it does not name, so a flag that is not added here is silently lost.
    this.unreadableOptions = unreadableOptions;
    // `emptyOptions` narrows `combo` to the ONE case runSetWidget's #507 last-resort
    // path may act on: the option list was READ successfully and is EMPTY. It is set
    // ONLY by that branch, so the caller never has to pattern-match a message, and a
    // plain "not a valid option" rejection can never be mistaken for it.
    this.emptyOptions = emptyOptions;
    // `combo` marks the failure as "combo value rejected against the current
    // option list" (unreadable OR not-a-member). runSetWidget uses this as the
    // ONLY signal that a stale-combo refresh + single revalidation may help —
    // no other validation failure (numeric/boolean/promotion/stuck-check) is
    // retryable, so those still fail closed immediately.
    this.combo = combo;
  }
}

/**
 * #1126 — READ a combo's current option list ONCE and report WHAT WAS OBSERVED.
 *
 * `options.values` may be an array or a function `(widget) => string[]` (litegraph
 * dynamic combos). That function is the node's own code: it can mutate the widget and
 * it can fail. So there are two materially different outcomes, and collapsing them into
 * a bare `null` is what made the panel answer "not a valid option" for a list it had
 * never actually read:
 *
 *   * READ  — `{ options: [...] }`. Membership is decidable. An off-list value is a
 *             genuine rejection (a typo, a model that is not installed).
 *   * UNREADABLE — `{ options: null, unreadable: true, reason }`. Nothing was compared
 *             against anything. The valid set is not knowable from here, so a refusal
 *             phrased as a verdict on the VALUE is a false statement about the write.
 *
 * `reason` records WHICH observation, so callers can say it rather than guess it.
 *
 * INVOKED EXACTLY ONCE per call, by design: the callback has side effects (it commonly
 * repopulates the widget), and a second read of a stateful source can disagree with the
 * first — which would turn any decision keyed on it into an escape hatch. Callers keep
 * the returned snapshot; they never re-read to re-derive a verdict.
 */
export function readComboOptions(widget) {
  const raw = widget?.options?.values;
  if (typeof raw === "function") {
    let vals;
    try {
      vals = raw(widget);
    } catch (err) {
      return { options: null, unreadable: true, reason: "threw", detail: describeThrown(err) };
    }
    return Array.isArray(vals)
      ? { options: vals, unreadable: false, reason: null }
      : {
          options: null,
          unreadable: true,
          reason: "not_a_list",
          detail: `the callback returned ${vals === null ? "null" : typeof vals}, not an array`,
        };
  }
  if (Array.isArray(raw)) return { options: raw, unreadable: false, reason: null };
  return {
    options: null,
    unreadable: true,
    reason: "absent",
    detail:
      raw === undefined
        ? "the widget declares no options.values"
        : `options.values is a ${typeof raw}, neither an array nor a callback`,
  };
}

/**
 * The current option list for a combo widget, or null if it cannot be read.
 * Thin wrapper over `readComboOptions` — one invocation of the callback, same
 * null-means-unreadable contract every existing caller was written against.
 */
export function comboOptions(widget) {
  return readComboOptions(widget).options;
}

/** #1126 — the human-readable half of a `readComboOptions` UNREADABLE outcome. */
function describeUnreadable(read) {
  const why = read?.detail ? ` (${read.detail})` : "";
  switch (read?.reason) {
    case "threw":
      return `its option list could not be READ: the widget's own options.values callback threw${why}`;
    case "not_a_list":
      return `its option list could not be READ: the widget's own options.values callback did not return a list${why}`;
    default:
      return `its option list could not be READ${why}`;
  }
}

export function isComboWidget(widget) {
  if (Array.isArray(widget?.options?.values) || typeof widget?.options?.values === "function") {
    return true;
  }
  return String(widget?.type ?? "").toLowerCase() === "combo";
}

/**
 * #667: the index of the option whose stringified LABEL equals the stringified
 * scalar `value`, or -1. Scalars only (string/number/boolean) on both sides.
 * Used by the combo coercion fallback AND by the #507 empty-list sibling rail
 * cross-check, so both apply the SAME matching rule; callers always write back
 * the list's ORIGINAL option, never the incoming scalar, so no number is ever
 * reinterpreted as an index and no mistyped value lands (#240 intact).
 */
function optionLabelIndex(options, value) {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return -1;
  }
  return options.findIndex(
    (o) =>
      (typeof o === "string" || typeof o === "number" || typeof o === "boolean") &&
      String(o) === String(value),
  );
}

// litegraph "number"/"slider" and Comfy "INT"/"FLOAT" all render numeric.
// VHS annotated INT/FLOAT widgets (#1533) use type "VHS.ANNOTATED" / "VHS.TIMESTAMP"
// rather than those names; they still store a number (custom_width/custom_height
// on VHS_LoadVideo) and their callback snaps one. `config[0]` is the backend
// declared type VHS stashes on the widget (`["INT", {…}]`).
export function isNumericWidget(widget) {
  const t = String(widget?.type ?? "").toLowerCase();
  if (t === "number" || t === "slider" || t === "int" || t === "float") return true;
  if (t === "vhs.annotated" || t === "vhs.timestamp") return true;
  const cfg0 = Array.isArray(widget?.config) ? widget.config[0] : null;
  return cfg0 === "INT" || cfg0 === "FLOAT";
}

/**
 * #1533 — put a finite number back when the widget's own callback stored
 * null/NaN/Infinity in its place.
 *
 * VHSINT (Video Helper Suite `getCustomWidgets.VHSINT`, type `VHS.ANNOTATED`)
 * snaps with `Math.round((v - mod) / step) * step + mod`. VHS_LoadVideo's
 * `custom_width`/`custom_height` declare `disable: 0` and no `step`; when the
 * format preset has not injected a dim-step, `step` is undefined, that formula
 * stores NaN, and `JSON.stringify(NaN)` is `"null"` — the write "applied and
 * immediately became null". An INT widget cannot hold NaN/null; the assignment
 * already put the number there, so restore it. A callback that stored a
 * DIFFERENT finite number is still drift (#240 / #805).
 */
function restoreFiniteNumberIfUnstored(widget, expected) {
  if (!widget || typeof expected !== "number" || !Number.isFinite(expected)) return;
  let actual;
  try {
    actual = widget.value;
  } catch {
    return;
  }
  if (actual == null || (typeof actual === "number" && !Number.isFinite(actual))) {
    widget.value = expected;
  }
}

/**
 * Does `node.widgets` have a STABLE IDENTITY — is it one array the node keeps, so that
 * comparing the array OBJECT says something and re-pointing it restores something — or
 * is it rebuilt on every read?
 *
 * Answered by OBSERVATION (two reads), not by the property descriptor, because the
 * descriptor does not settle it: an accessor that memoises one array is every bit as
 * identity-stable as a plain data property, and it is only a getter that BUILDS A NEW
 * ARRAY per read that makes an identity compare meaningless. Classifying by descriptor
 * kind would relax the check for memoising accessors that never needed relaxing.
 *
 * A real ComfyUI SubgraphNode is the rebuilding kind. Read off the installed
 * comfyui-frontend 1.49.6, its constructor installs
 *
 *   Object.defineProperty(this, "widgets", {
 *     get: () => [...this.inputs.flatMap(i => project(i) ?? []), ...this._extraWidgets],
 *     set: () => {}, configurable: true, enumerable: true });
 *
 * — a fresh array every read, behind a setter that swallows assignment. The MEMBERS are
 * stable (`_projectPromotedWidget` memoises each proxy onto `input._widget`); only the
 * containing array is not.
 *
 * The one place this matters is #477 P1's rollback read-back, which compared the outer
 * widget list by ARRAY IDENTITY. On a rebuilt list that compare can only ever fail, so
 * every failed promoted write on a subgraph node reported a partial state for a
 * rollback that had been perfect. The caller gets `false` there and compares
 * MEMBERSHIP/ORDER instead — still by per-widget identity, which is what authenticates
 * a rail, and which the memoised projection preserves.
 */
function widgetsListHasStableIdentity(node) {
  let first;
  let second;
  try {
    first = node.widgets;
    second = node.widgets;
  } catch {
    // Unreadable: identity can say nothing. Answering the other way would hand the
    // identity compare a verdict it has no basis for.
    return false;
  }
  return first === second;
}

export function isBooleanWidget(widget) {
  const t = String(widget?.type ?? "").toLowerCase();
  return t === "toggle" || t === "boolean";
}

/**
 * #1735 — whether `value` has the exact accessor shape installed by Impact Pack's
 * comboBoolMigration. That migration defines an OWN accessor without setting
 * configurable/enumerable, so the descriptor is non-configurable and non-enumerable;
 * its setter can apply the value and then throw when the node's bound-property
 * copy-back invokes that setter a second time.
 *
 * This deliberately does not walk the prototype chain: an ordinary custom accessor
 * must remain on the existing exception-disclosure path. Descriptor reads are
 * best-effort; an unreadable or differently shaped property is not evidence that the
 * write is recoverable.
 */
function hasImpactBooleanAccessor(widget) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(widget, "value");
    return (
      descriptor?.configurable === false &&
      descriptor.enumerable === false &&
      typeof descriptor.get === "function" &&
      typeof descriptor.set === "function"
    );
  } catch {
    return false;
  }
}

/**
 * #1735 — the one accessor failure that may be recovered after read-back.
 *
 * The initial assignment and the node's property assignment have already happened
 * before this is called. The caller still runs the ordinary callback/update path, and
 * the existing widget + bound-property verification remains authoritative. A setter
 * that throws for any other reason stays a warning/refusal, so this cannot turn an
 * arbitrary custom-node side-effect failure into a clean success.
 */
function isRecoverableBooleanAccessorDelete(widget, expected, err) {
  if (!isBooleanWidget(widget) || !hasImpactBooleanAccessor(widget)) return false;
  let message;
  try {
    message = String(err?.message ?? err);
  } catch {
    return false;
  }
  if (!/^Cannot delete property ['"]value['"]/i.test(message)) return false;
  try {
    return Object.is(widget.value, expected);
  } catch {
    return false;
  }
}

/**
 * True for a COMPOSITE widget whose value is a plain object rather than a scalar
 * — e.g. the rgthree Power Lora Loader's `lora_N` rows ({on, lora, strength,
 * strengthTwo, …}). Detected by the CURRENT value's shape (a non-null, non-array
 * object) so it works without an rgthree-specific type tag. Combos are excluded
 * upstream (they are matched before this runs). (#179)
 */
export function isCompositeObjectWidget(widget) {
  const v = widget?.value;
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Resolve a widget name without silently choosing between case-colliding
 * widgets. Exact spelling always wins; a case-insensitive fallback remains for
 * older callers, but only when it names exactly one widget (#524).
 */
function resolveWidgetByName(node, widgetName) {
  const wanted = String(widgetName);
  const widgets = node?.widgets ?? [];
  const exact = widgets.find((cand) => cand?.name === wanted);
  if (exact) return exact;

  const matches = widgets.filter(
    (cand) => typeof cand?.name === "string" && cand.name.toLowerCase() === wanted.toLowerCase(),
  );
  if (matches.length > 1) {
    throw new WidgetWriteError(
      `Node ${node?.id} (${node?.type}) has ${matches.length} widgets matching "${wanted}" ` +
        `case-insensitively (${matches.map((cand) => cand.name).join(", ")}); pass the exact widget name.`,
    );
  }
  return matches[0] ?? null;
}

// #2146 — Fast Groups Bypasser rows are action controls. Their callback can set the mode of
// every node in the selected group, and rgthree's Mute / Bypass Repeater can continue that
// change through linked inputs. The ordinary widget rollback knows only about widget/property
// projections, so keep a deliberately small mode journal for this one runtime shape.
const FAST_GROUPS_BYPASSER_TYPE = "Fast Groups Bypasser (rgthree)";
const FAST_GROUPS_TOGGLE_WIDGET = "RGTHREE_TOGGLE_AND_NAV";
const NODE_MODE_REPEATER_TYPE = "Mute / Bypass Repeater (rgthree)";
const NODE_MODE_RELAY_TYPE = "Mute / Bypass Relay (rgthree)";

function runtimeNodeType(node) {
  try {
    if (typeof node?.type === "string") return node.type;
    if (typeof node?.constructor?.type === "string") return node.constructor.type;
  } catch {
    // An unreadable third-party node is handled by the fail-closed transaction capture below.
  }
  return "";
}

function widgetBaseName(widgetName) {
  if (typeof widgetName !== "string") return "";
  const dot = widgetName.indexOf(".");
  return dot === -1 ? widgetName : widgetName.slice(0, dot);
}

function normalizedWidgetBaseName(widgetName) {
  return widgetBaseName(widgetName).toLowerCase();
}

function isModePassThrough(node) {
  const type = runtimeNodeType(node);
  return type.includes("Reroute") || type.includes("Node Combiner") || type.includes("Node Collector");
}

function modeTransactionFailure(node, detail) {
  return new WidgetWriteError(
    `Cannot set widget on node ${node?.id} (${node?.type}): cannot establish the Fast Groups ` +
      `Bypasser mode rollback boundary (${detail}); refusing before the callback can mutate ` +
      `linked node modes (#2146).`,
  );
}

function relayDispatchesMode(node, owner) {
  try {
    const inputs = node.inputs;
    if (!Array.isArray(inputs)) {
      throw modeTransactionFailure(owner, `relay ${node?.id ?? "?"}'s inputs are unreadable`);
    }
    // rgthree's NodeModeRelay dispatches only when it has at most one input slot,
    // input 0 is unconnected, and an output is connected. A multi-input relay with
    // empty slots is not an input-less dispatcher.
    if (inputs.length > 1) return false;
    if (typeof node.isInputConnected !== "function" || typeof node.isAnyOutputConnected !== "function") {
      throw modeTransactionFailure(owner, `relay ${node?.id ?? "?"}'s runtime connection contract is unreadable`);
    }
    return !node.isInputConnected(0) && node.isAnyOutputConnected();
  } catch {
    throw modeTransactionFailure(owner, `relay ${node?.id ?? "?"}'s connection state is unreadable`);
  }
}

/**
 * Capture only the mode targets a Fast Groups Bypasser row can reach:
 *   - members of each Fast Bypasser group row on this node;
 *   - descendants of those members in a subgraph;
 *   - non-pass-through inputs of rgthree repeaters; and
 *   - non-pass-through outputs of input-less rgthree relays.
 *
 * This intentionally does not walk or snapshot the graph generally. The returned journal is
 * used to verify the canonical action changed a reachable mode and to roll it back on failure.
 */
function captureFastBypasserModeTransaction(node, writtenWidget) {
  if (
    runtimeNodeType(node) !== FAST_GROUPS_BYPASSER_TYPE ||
    normalizedWidgetBaseName(writtenWidget?.name) !== FAST_GROUPS_TOGGLE_WIDGET.toLowerCase()
  ) {
    return null;
  }

  const rows = [
    writtenWidget,
    ...(Array.isArray(node?.widgets) ? node.widgets : []),
  ].filter((candidate, index, all) => {
    if (!candidate || normalizedWidgetBaseName(candidate.name) !== FAST_GROUPS_TOGGLE_WIDGET.toLowerCase()) {
      return false;
    }
    return all.indexOf(candidate) === index;
  });
  const groups = [];
  for (const row of rows) {
    let group;
    try {
      group = row.group;
    } catch {
      throw modeTransactionFailure(node, "a toggle row's group is unreadable");
    }
    if (!group || (typeof group !== "object" && typeof group !== "function")) {
      throw modeTransactionFailure(node, "a toggle row has no live group");
    }
    if (!groups.includes(group)) groups.push(group);
  }
  if (!groups.length) throw modeTransactionFailure(node, "no live toggle-row group was found");

  const entries = [];
  const seenNodes = new Set();
  const entriesByNode = new Map();
  const propagationQueue = [];
  const propagationEdges = new Map();

  const addNodeTree = (candidate) => {
    if (!candidate || typeof candidate !== "object" || seenNodes.has(candidate)) return;
    const type = runtimeNodeType(candidate);
    let mode;
    try {
      mode = candidate.mode;
    } catch {
      throw modeTransactionFailure(node, `node ${candidate.id ?? "?"}'s mode is unreadable`);
    }
    seenNodes.add(candidate);
    const propagates =
      type === NODE_MODE_REPEATER_TYPE ||
      (type === NODE_MODE_RELAY_TYPE && relayDispatchesMode(candidate, node));
    const entry = { node: candidate, previous: mode, propagates };
    entries.push(entry);
    entriesByNode.set(candidate, entry);
    if (propagates) {
      propagationQueue.push(candidate);
    }

    let subgraph = null;
    try {
      const isSubgraph =
        typeof candidate.isSubgraphNode === "function"
          ? candidate.isSubgraphNode()
          : !!candidate.subgraph;
      subgraph = isSubgraph ? candidate.subgraph : null;
    } catch {
      throw modeTransactionFailure(node, `node ${candidate.id ?? "?"}'s subgraph is unreadable`);
    }
    if (subgraph != null) {
      if (!Array.isArray(subgraph.nodes)) {
        throw modeTransactionFailure(node, `node ${candidate.id ?? "?"}'s subgraph nodes are unreadable`);
      }
      for (const child of subgraph.nodes) addNodeTree(child);
    }
  };

  const recordPropagationEdge = (source, target) => {
    const sourceEntry = entriesByNode.get(source);
    const targetEntry = entriesByNode.get(target);
    if (!sourceEntry?.propagates || !targetEntry?.propagates || source === target) return;
    let targets = propagationEdges.get(source);
    if (!targets) {
      targets = new Set();
      propagationEdges.set(source, targets);
    }
    targets.add(target);
  };

  const graphFor = (candidate, group) => candidate?.graph ?? group?.graph ?? node?.graph;
  const connectedRoots = (start, direction, group, skipRelays) => {
    const queue = [{ node: start, source: start }];
    const walked = new Set();
    while (queue.length) {
      const { node: current, source } = queue.shift();
      if (!current || walked.has(current)) continue;
      walked.add(current);
      const graph = graphFor(current, group);
      const slots = direction === "input" ? current.inputs : current.outputs;
      if (!graph || !Array.isArray(slots)) continue;
      for (const slot of slots) {
        let linkId;
        try {
          linkId = direction === "input" ? slot?.link : null;
          if (direction === "output") {
            for (const outputLinkId of Array.isArray(slot?.links) ? slot.links : []) {
              const link = graph.links?.[outputLinkId];
              const connected = graph.getNodeById?.(link?.target_id);
              if (!connected) continue;
              if (isModePassThrough(connected)) queue.push({ node: connected, source });
              else {
                addNodeTree(connected);
                recordPropagationEdge(source, connected);
              }
            }
            continue;
          }
        } catch {
          throw modeTransactionFailure(node, "a linked mode path is unreadable");
        }
        if (linkId == null) continue;
        let link;
        let connected;
        try {
          link = graph.links?.[linkId];
          connected = graph.getNodeById?.(link?.origin_id);
        } catch {
          throw modeTransactionFailure(node, "a linked mode path is unreadable");
        }
        if (!connected) continue;
        if (skipRelays && runtimeNodeType(connected) === NODE_MODE_RELAY_TYPE) continue;
        if (isModePassThrough(connected)) queue.push({ node: connected, source });
        else {
          addNodeTree(connected);
          recordPropagationEdge(source, connected);
        }
      }
    }
  };

  for (const group of groups) {
    let members;
    try {
      group.recomputeInsideNodes?.();
      members = group._children;
    } catch {
      throw modeTransactionFailure(node, "a toggle-row group is unreadable");
    }
    if (members == null) throw modeTransactionFailure(node, "a toggle-row group has no members");
    let groupNodes;
    try {
      groupNodes = Array.from(members);
    } catch {
      throw modeTransactionFailure(node, "a toggle-row group member list is unreadable");
    }
    for (const groupNode of groupNodes) addNodeTree(groupNode);
  }

  while (propagationQueue.length) {
    const current = propagationQueue.shift();
    const type = runtimeNodeType(current);
    if (type === NODE_MODE_REPEATER_TYPE) {
      const group = groups.find((candidate) => candidate?.graph === current?.graph) ?? groups[0];
      connectedRoots(current, "input", group, true);
    } else if (type === NODE_MODE_RELAY_TYPE) {
      if (entriesByNode.get(current)?.propagates) {
        const group = groups.find((candidate) => candidate?.graph === current?.graph) ?? groups[0];
        connectedRoots(current, "output", group, false);
      }
    }
  }

  const propagationRestoreOrder = () => {
    const propagating = entries.filter((entry) => entry.propagates);
    const indegree = new Map(propagating.map((entry) => [entry.node, 0]));
    for (const [source, targets] of propagationEdges) {
      if (!indegree.has(source)) continue;
      for (const target of targets) {
        if (indegree.has(target)) indegree.set(target, indegree.get(target) + 1);
      }
    }
    const ready = propagating.filter((entry) => indegree.get(entry.node) === 0);
    const ordered = [];
    while (ready.length) {
      const entry = ready.shift();
      ordered.push(entry);
      for (const target of propagationEdges.get(entry.node) ?? []) {
        if (!indegree.has(target)) continue;
        const next = indegree.get(target) - 1;
        indegree.set(target, next);
        if (next === 0) ready.push(entriesByNode.get(target));
      }
    }
    // A cyclic mode graph cannot be topologically ordered; keep the captured order and
    // let the authoritative read-back report any irreconcilable mode conflict honestly.
    return ordered.length === propagating.length ? ordered : propagating;
  };

  return {
    changed() {
      let unreadable = false;
      for (const entry of entries) {
        try {
          if (!Object.is(entry.node.mode, entry.previous)) return true;
        } catch {
          unreadable = true;
        }
      }
      return unreadable ? null : false;
    },
    restore() {
      const restoreEntry = (entry) => {
        try {
          if (!Object.is(entry.node.mode, entry.previous)) entry.node.mode = entry.previous;
        } catch {
          // Read-back below turns this into an honest partial-state error.
        }
      };
      // Restore mode-propagating roots in upstream-to-downstream order, then restore every
      // ordinary node after the last propagation. This handles a group whose iteration order
      // places a linked node before its repeater: the repeater may overwrite it during restore,
      // so linked nodes must be the final writes.
      for (const entry of propagationRestoreOrder()) restoreEntry(entry);
      for (const entry of entries) {
        if (!entry.propagates) restoreEntry(entry);
      }
    },
    unrestored() {
      const failed = [];
      for (const entry of entries) {
        try {
          if (!Object.is(entry.node.mode, entry.previous)) failed.push(entry);
        } catch {
          failed.push(entry);
        }
      }
      return failed;
    },
  };
}

function resolveFastBypasserAction(node, widget, coerced, previous) {
  if (
    runtimeNodeType(node) !== FAST_GROUPS_BYPASSER_TYPE ||
    normalizedWidgetBaseName(widget?.name) !== FAST_GROUPS_TOGGLE_WIDGET.toLowerCase()
  ) {
    return null;
  }
  if (
    coerced === null ||
    typeof coerced !== "object" ||
    Array.isArray(coerced) ||
    typeof coerced.toggled !== "boolean"
  ) {
    throw modeTransactionFailure(node, "the toggle action value is unreadable");
  }
  let toggle;
  let doModeChange;
  try {
    toggle = widget.toggle;
    doModeChange = widget.doModeChange;
  } catch {
    throw modeTransactionFailure(node, "the toggle action is unreadable");
  }
  if (typeof toggle !== "function" || typeof doModeChange !== "function") {
    throw modeTransactionFailure(node, "the live row has no canonical toggle action");
  }
  return {
    toggle,
    requested: coerced.toggled,
    requiresModeChange: previous?.toggled !== coerced.toggled,
  };
}

// DECLARED field schema for known composite widgets. Types are enforced from THIS
// schema, never inferred from the current value — a field whose current value is `null`
// still enforces the correct type, so a scalar of the wrong type (e.g. a number into a
// `lora` filename) can never be written on an EMPTY/cleared row (#560 P0). `nullable`
// marks fields that legitimately hold `null` (an empty slot), so clearing them is
// allowed (#560 P2). rgthree Power Lora Loader slot: {on, lora, strength, strengthTwo}.
const RGTHREE_LORA_SLOT_SCHEMA = {
  on: { type: "boolean", nullable: false },
  lora: { type: "string", nullable: true },
  strength: { type: "number", nullable: false },
  strengthTwo: { type: "number", nullable: true },
};

// True for an rgthree Power Lora Loader slot object. Identified by its KEY-SET SHAPE
// ONLY — the keys are a SUBSET of the rgthree slot keys {on, lora, strength, strengthTwo}
// and include the core {on, lora, strength}. The classification does NOT depend on the
// current VALUES being well-formed: a PARTIALLY-CORRUPT row (e.g. lora already holding a
// number from a prior bad write) must STILL be recognized so the schema is ENFORCED and
// the row is repaired-forward — never fall back to inferring a type from a corrupt value,
// which would accept a further wrong-type write and deepen the corruption.
const RGTHREE_LORA_SLOT_KEYS = new Set(["on", "lora", "strength", "strengthTwo"]);
// EXPORTED for #757's creation route (`rgthree-lora-row.js`), which must decide whether an
// incoming value is a lora row before it will mint a slot for it. Exported rather than
// re-implemented there: two copies of a shape test drift, and the drift would show up as a
// slot created for a value the writer then refuses.
export function isLoraSlotObject(obj) {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  if (keys.length === 0) return false;
  if (!keys.every((k) => RGTHREE_LORA_SLOT_KEYS.has(k))) return false; // no foreign/extra keys
  for (const core of ["on", "lora", "strength"]) {
    if (!Object.prototype.hasOwnProperty.call(obj, core)) return false;
  }
  return true;
}

// The declared {type, nullable} schema for `field` of composite `base`, or null when the
// composite is unknown (no declared schema).
function compositeFieldSchema(base, field) {
  if (isLoraSlotObject(base) && Object.prototype.hasOwnProperty.call(RGTHREE_LORA_SLOT_SCHEMA, field)) {
    return RGTHREE_LORA_SLOT_SCHEMA[field];
  }
  return null;
}

// STRICT type coercion to a declared primitive type. Mirrors the whole-widget #240
// strictness. Throws WidgetWriteError on mismatch.
function coerceByType(type, value, where) {
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    const s = String(value).toLowerCase();
    if (s === "true" || s === "1") return true;
    if (s === "false" || s === "0") return false;
    throw new WidgetWriteError(`${where} is boolean but value ${JSON.stringify(value)} is not a boolean.`);
  }
  if (type === "number") {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
    throw new WidgetWriteError(`${where} is numeric but value ${JSON.stringify(value)} is not a number.`);
  }
  if (type === "string") {
    if (typeof value === "string") return value;
    throw new WidgetWriteError(`${where} is a string but value ${JSON.stringify(value)} is not a string.`);
  }
  return value;
}

// True when `value` has the SAME recursive type shape as `existing` — every leaf the
// same primitive type, arrays element-compatible, plain objects carrying no key the
// existing object lacks. Used to validate an unknown composite's OBJECT/ARRAY field
// against its own current value (comfyui-mcp#1711): UI-heavy node packs (e.g.
// ComfyUI-Pixaroma) store state as JSON blobs with nested composites like
// `sizes: [[608,352],...]`, whose element types are perfectly inferable from the
// existing value — so a same-shaped write (including the byte-identical pass-through
// a read-modify-write agent sends back) is provably not a mistype and must be accepted,
// while a shape-DIVERGENT value (string where an array sits, a foreign key) still fails
// closed. An EMPTY existing array/object carries no element type to infer, so only an
// equally-empty value matches it.
function matchesExistingShape(existing, value) {
  if (Array.isArray(existing)) {
    if (!Array.isArray(value)) return false;
    if (existing.length === 0) return value.length === 0;
    return value.every((v) => existing.some((e) => matchesExistingShape(e, v)));
  }
  if (existing !== null && typeof existing === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    return Object.keys(value).every(
      (k) =>
        Object.prototype.hasOwnProperty.call(existing, k) &&
        matchesExistingShape(existing[k], value[k]),
    );
  }
  return typeof value === typeof existing && (existing !== null || value === null);
}

/**
 * Validate + coerce a composite field value. The expected type comes FIRST from the
 * declared schema (so a null current field still enforces the right type, #560 P0), and
 * `null` is accepted only for a nullable field (#560 P2). For an UNKNOWN composite with
 * no schema, fall back to the existing NON-null value's type — a scalar field coerces
 * strictly, and an object/array field is accepted when the value matches the existing
 * value's recursive shape (comfyui-mcp#1711). A null/undefined current value with no
 * schema is genuinely untyped and refused. Throws WidgetWriteError on a mismatch.
 */
function coerceCompositeFieldValue(widgetName, base, field, value) {
  const where = `sub-field "${widgetName}.${field}"`;
  const schema = compositeFieldSchema(base, field);
  if (schema) {
    if (value === null) {
      if (schema.nullable) return null;
      throw new WidgetWriteError(`${where} is not nullable (expected ${schema.type}).`);
    }
    return coerceByType(schema.type, value, where);
  }
  // Unknown composite: infer the expected type from the EXISTING non-null value.
  const existing = base?.[field];
  if (typeof existing === "boolean") return coerceByType("boolean", value, where);
  if (typeof existing === "number") return coerceByType("number", value, where);
  if (typeof existing === "string") return coerceByType("string", value, where);
  // comfyui-mcp#1711: the existing value is an object/array, so the field is a NESTED
  // composite — not untyped. Validate the value against the existing value's recursive
  // shape; a same-shaped value (typically the read-modify-write pass-through of the
  // field's own current content) is safe to write verbatim.
  if (existing != null && matchesExistingShape(existing, value)) return value;
  // No schema AND an untyped current value (null/undefined) OR a shape-DIVERGENT value
  // for a nested composite: the write cannot be proven correctly-typed, so we REFUSE
  // rather than write a possibly-wrong-typed value — #560's principle is a loud, safe
  // failure over silent corruption. (A KNOWN composite, e.g. rgthree, is handled by the
  // schema above and its nullable fields still clear.)
  throw new WidgetWriteError(
    `${where}: cannot validate the value — this composite is not a recognized type and the ` +
      `field's current value is ${existing === undefined ? "undefined" : JSON.stringify(existing)}, ` +
      `so its expected type is unknown. Set a correctly-typed value only if the field already ` +
      `holds one, or edit this widget from the node UI.`,
  );
}

/**
 * Merge `incoming` fields onto composite `base`, FAILING CLOSED on any field that does
 * not already exist (never ADD a member) and validating each value against the field's
 * DECLARED type / an unknown composite's existing type (#560 hardening). Used by BOTH
 * the dotted single-field path and the #179 full-JSON-object path so neither can silently
 * mistype or junk-up a composite row.
 */
function mergeCompositeFields(widgetName, base, incoming) {
  const out = { ...base };
  for (const key of Object.keys(incoming)) {
    if (!Object.prototype.hasOwnProperty.call(base, key)) {
      throw new WidgetWriteError(
        `Composite widget "${widgetName}" has no field "${key}" ` +
          `(fields: ${Object.keys(base).join(", ") || "none"}). Refusing to add an unknown field.`,
      );
    }
    out[key] = coerceCompositeFieldValue(widgetName, base, key, incoming[key]);
  }
  return out;
}

/**
 * Validate + coerce `value` for `widget`, returning the value to write. Throws
 * WidgetWriteError (never silently coerces to a wrong value) when the value is
 * incompatible with the widget's declared type.
 */
export function coerceWidgetValue(
  widget,
  value,
  mergeBaseWidget = widget,
  subFieldPath = null,
  { acceptEmptyComboOptions = false, acceptUnreadableComboOptions = false, out } = {},
) {
  const name = widget?.name ?? "(widget)";

  // #347: distinguish "clear to empty" from "missing value". An EXPLICIT empty
  // string is a valid request to empty a text/string widget (handled by the
  // pass-through at the end); a MISSING value (undefined/null — e.g. an omitted
  // or dropped arg) is not, and must fail loudly instead of silently writing
  // `undefined`. The combo/numeric/boolean branches below still reject "" on
  // their own terms, so #240 strictness is untouched.
  // A MISSING value (undefined) is always refused. An explicit `null` for a WHOLE-widget
  // write is also refused (#347: clear a text widget with ""); but for a SUB-FIELD write
  // `null` is a legitimate CLEAR of a nullable composite field (e.g. `lora_1.lora=null`),
  // so it is allowed through to coerceCompositeFieldValue, which enforces the schema's
  // nullability (a non-nullable field still rejects null).
  if (value === undefined || (value === null && subFieldPath == null)) {
    throw new WidgetWriteError(
      subFieldPath != null
        ? `No value provided for sub-field "${name}.${subFieldPath}".`
        : `No value provided for widget "${name}". To clear a text widget, pass an ` +
            `explicit empty string ("").`,
    );
  }

  // #560: EXPLICIT sub-field addressing (widget "lora_1.on" / "lora_1.strength").
  // Writing a bare scalar to a COMPOSITE object widget (rgthree Power Lora Loader's
  // `lora_N` rows: {on, lora, strength, strengthTwo}) previously corrupted the row —
  // a scalar toggled one field and nulled the rest. Addressing ONE field merges that
  // field onto the CURRENT object and PRESERVES every other field. This runs BEFORE
  // the combo/numeric/boolean branches so a sub-field write is never reinterpreted by
  // the base widget's declared type.
  if (subFieldPath != null && subFieldPath !== "") {
    // Only single-level fields are supported; a nested path needs a per-node schema
    // we do not have — refuse LOUDLY rather than write a wrongly-shaped object.
    if (subFieldPath.includes(".")) {
      throw new WidgetWriteError(
        `Nested sub-field path "${name}.${subFieldPath}" is not supported. Address ONE ` +
          `top-level field (e.g. "${name}.on", "${name}.strength") or pass a full JSON object.`,
      );
    }
    // The AUTHORITATIVE base object to merge onto: the promoted rail's current object
    // when present (#366×#179), else the target widget's own value. The field is only
    // addressable when that base is a real (non-array) object.
    const railBase =
      mergeBaseWidget &&
      mergeBaseWidget.value != null &&
      typeof mergeBaseWidget.value === "object" &&
      !Array.isArray(mergeBaseWidget.value)
        ? mergeBaseWidget.value
        : null;
    const ownBase =
      widget?.value != null && typeof widget.value === "object" && !Array.isArray(widget.value)
        ? widget.value
        : null;
    const base = railBase ?? ownBase;
    if (base == null) {
      throw new WidgetWriteError(
        `Widget "${name}" is not a composite object widget, so its sub-field ` +
          `"${subFieldPath}" cannot be addressed. Sub-field writes (e.g. "lora_1.on") are ` +
          `only valid on widgets whose current value is an object.`,
      );
    }
    // Merge ONLY the addressed field: FAIL CLOSED on an unknown field (a typo like
    // "lora_1.strenght" must not create junk) and validate the value against the
    // existing field's type (no silent mistyping — "false" into a boolean, a number
    // into a filename), mirroring #240 whole-widget strictness. All other fields survive.
    return mergeCompositeFields(name, base, { [subFieldPath]: value });
  }

  if (isComboWidget(widget)) {
    // ONE read, kept as a snapshot. Never re-read to re-derive a verdict below (#1126).
    const read = readComboOptions(widget);
    const options = read.options;
    // #1126 — the list COULD NOT BE READ. That is an observation about the LIST, and the
    // panel used to answer it with a flat refusal — which, after the ladder in
    // set-widget.js re-tried and gave up, reached the user as a message about their
    // VALUE. It was never compared to anything: a node whose runtime handler takes an
    // absolute path had its path refused as though the path were wrong.
    //
    // So the two outcomes are answered differently, and BOTH from what was observed:
    //
    //   * The list was read and the value is not in it  ⇒ REFUSE (below). There is a
    //     real, closed set of choices, and an off-list value is a typo worth catching
    //     before a run fails deep in model loading. #240/#507 unchanged.
    //   * The list could not be read at all ⇒ the valid set is not knowable from here,
    //     exactly like #507's empty list, and #240's reason for strict membership (a
    //     number silently reinterpreted as an INDEX into a real list) has no list to
    //     index into. Accept — but only under `acceptUnreadableComboOptions`, which
    //     runSetWidget sets LAST, after every authoritative recovery has been tried and
    //     the server has confirmed it publishes no list for this input either.
    //
    // Default is unchanged: a retryable combo refusal, so a merely-transient callback
    // failure is refreshed and re-read before anything is decided.
    if (!options) {
      if (acceptUnreadableComboOptions) {
        // A NON-EMPTY STRING only. Two separate rules, neither traded away:
        //   * #347 — clearing a combo to "" is refused, and an unreadable list must not
        //     become a new door to it.
        //   * #240 — a real option list exists on this widget, we simply cannot read it,
        //     so a NUMBER could still be reinterpreted as an index into it. No file path
        //     or model name is a number, so nothing legitimate is lost by refusing one.
        // Marked NON-retryable: no refresh can turn a number into a string.
        if (typeof value !== "string" || value === "") {
          throw new WidgetWriteError(
            `Combo widget "${name}": ${describeUnreadable(read)}, so ` +
              `${JSON.stringify(value)} cannot be validated against it. A value written to a ` +
              `combo whose options cannot be enumerated must be a NON-EMPTY STRING — a number ` +
              `could be reinterpreted as an index into the list that exists but cannot be read, ` +
              `and "" clears the widget. Refusing to write.`,
          );
        }
        // This path's OWN marker. It gates the promoted-write rail cross-check below and
        // drives the reply's disclosure; it is deliberately NOT the empty-list marker,
        // which is a different (stronger) observation and carries a label-adoption rule
        // that must not run here.
        //
        // The observation travels WITH it. A success reply has no error message to carry
        // the reason, and there are three distinct ones (the callback threw, it returned a
        // non-list, there is no callback) — a disclosure that picks one and states it
        // would be wrong two-thirds of the time.
        if (out) {
          out.unreadableAcceptanceUsed = true;
          out.unreadableObservation = describeUnreadable(read);
        }
        return value;
      }
      throw new WidgetWriteError(
        `Combo widget "${name}": ${describeUnreadable(read)}, so ` +
          `${JSON.stringify(value)} could not be checked against it — this is NOT a verdict ` +
          `that the value is wrong, nothing was compared. Refusing to write until the list ` +
          `can be read.`,
        { combo: true, unreadableOptions: true },
      );
    }
    // #507: a DYNAMIC, CLIENT-POPULATED combo declared with an EMPTY option list —
    // e.g. StarNodes' `"model": ((), {...})`, which /object_info reports as
    // `[[], {...}]` and whose dropdown the node's own frontend JS fills at runtime
    // (a "Refresh Models" button). `comboOptions` returns `[]`, which is TRUTHY, so
    // the `!options` guard above never fired and `[].includes(value)` rejected EVERY
    // value — the widget was permanently unwritable by the agent.
    //
    // ZERO options means the option set is NOT KNOWABLE from here — the same state
    // the guard above names, NOT "no value is valid". And the #240 reason for strict
    // membership does not apply: that rule exists so a numeric value cannot be
    // silently reinterpreted as an INDEX into a real list, and with an empty list
    // there is no list to index into. So accept the value as written.
    //
    // This does NOT loosen #233/#240. An empty LIVE list is ambiguous — it can also
    // simply be STALE (never populated yet) while the SERVER publishes a real list —
    // so acceptance is NOT automatic: by default the empty case throws a RETRYABLE
    // combo error, which drives runSetWidget's authoritative /object_info refresh
    // first. Only if the list is STILL empty after that (`acceptEmptyComboOptions`)
    // is the value taken as written. The moment the list is NON-EMPTY — from the
    // server or from the node's own client-side refresh, whichever is richer, since
    // `options` is read from the LIVE widget — strict membership below applies
    // unchanged and an off-list value is refused.
    //
    // Only a SCALAR is ever accepted: an object/array could never be an option under
    // any list and would corrupt the widget, so it fails closed and is marked
    // NON-retryable (no refresh can make it valid).
    if (options.length === 0) {
      if (typeof value === "object") {
        throw new WidgetWriteError(
          `Combo widget "${name}" has an EMPTY option list (a dynamic, client-populated ` +
            `combo), so ${JSON.stringify(value)} cannot be validated against it — and only a ` +
            `scalar (string/number/boolean) can be written to a combo. Refusing to write.`,
        );
      }
      if (acceptEmptyComboOptions) {
        // Record that THIS acceptance — not ordinary membership — is what admitted the
        // value, so applyWidgetWrite can decide the sibling cross-check from the
        // COERCION-TIME verdict. It must never re-read the list to infer this: a
        // stateful dynamic source can answer differently on a second call and would
        // become an escape hatch around the check (codex confirmation round).
        if (out) out.emptyAcceptanceUsed = true;
        return value;
      }
      throw new WidgetWriteError(
        `Combo widget "${name}" has an EMPTY option list; the server's option list may ` +
          `simply be stale — refreshing it before deciding.`,
        { combo: true, emptyOptions: true },
      );
    }
    // STRICT typed membership first: an exact-typed option is always writable.
    if (options.includes(value)) return value;
    // #667: NUMERIC-LABELLED options (VHS ProRes profile ["lt",…,"4444",…], ffv1
    // level ["0","1","3"]). The tool's `value` param is string|number|boolean, so a
    // numeric-looking label can arrive as the NUMBER 4444 after upstream JSON
    // coercion, and strict membership then refused it even though the label sits in
    // the list — the option was unreachable via the panel. Fall back to matching the
    // option's LABEL stringified, and on a match return the option's ORIGINAL value
    // from the list — NEVER the incoming scalar — so no mistyped value lands on the
    // widget and no number is ever reinterpreted as an INDEX: the #240 concern was
    // a number silently read as a dropdown position, and that stays refused below
    // (options ["alpha","beta","gamma"] with value 1 matches no label).
    const labelIdx = optionLabelIndex(options, value);
    if (labelIdx >= 0) return options[labelIdx];
    // The other half of #1126, and the direction that must NOT move: this list WAS read,
    // it holds real choices, and the value is not one of them. That is a verdict about
    // the VALUE, and it is worth keeping — a typo'd sampler or a model that is not
    // installed is caught here instead of failing 40 seconds into a run. The message says
    // which of the two happened, so an agent can tell "your value is wrong" apart from
    // "the panel could not look" and stop treating them as the same failure.
    const preview = options.slice(0, 40).map((o) => JSON.stringify(o)).join(", ");
    throw new WidgetWriteError(
      `Value ${JSON.stringify(value)} is not a valid option for combo widget ` +
        `"${name}". Its option list WAS read successfully and holds ${options.length} ` +
        `option${options.length === 1 ? "" : "s"}, none of them this value — so this is a ` +
        `rejected VALUE, not an unreadable list. Valid options (${options.length}): ${preview}` +
        (options.length > 40 ? ", …" : ""),
      { combo: true },
    );
  }

  if (isNumericWidget(widget)) {
    // Accept ONLY a finite number, or a non-blank numeric string. Reject
    // arrays/objects/booleans/null/whitespace — Number([])===0 and
    // Number([5])===5 would otherwise silently mutate an INT/FLOAT slot.
    let num;
    if (typeof value === "number" && Number.isFinite(value)) {
      num = value;
    } else if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      num = Number(value);
    } else {
      throw new WidgetWriteError(
        `Widget "${name}" is numeric (type ${widget?.type}) but value ` +
          `${JSON.stringify(value)} is not a number.`,
      );
    }
    return num;
  }

  if (isBooleanWidget(widget)) {
    if (typeof value === "boolean") return value;
    const s = String(value).toLowerCase();
    if (s === "true" || s === "1") return true;
    if (s === "false" || s === "0") return false;
    throw new WidgetWriteError(
      `Widget "${name}" is boolean but value ${JSON.stringify(value)} is not ` +
        `a boolean (true/false).`,
    );
  }

  // #179: rgthree Power Lora Loader (and similar) expose a COMPOSITE widget whose
  // value is a plain object ({on, lora, strength, …}), not a scalar. The MCP arg
  // schema allows only string|number|boolean, so a composite is sent as a JSON
  // STRING; writing that string verbatim corrupts the row (rgthree then reads
  // lora=null and drops strength). Parse a JSON-string payload (or accept an
  // object directly) and MERGE onto the current value so fields the caller did
  // not specify (e.g. strengthTwo) are preserved.
  //
  // Detect the composite from the inner widget OR the AUTHORITATIVE promoted RAIL widget
  // (mergeBaseWidget): the value that SERIALIZES is the rail's, so if the rail still holds
  // a composite object while the inner value has gone stale/scalar, the write must STILL
  // be treated as composite — otherwise the JSON payload would fall through as a raw
  // string and clobber the rail (#179/#366 rail-authoritative guarantee).
  if (isCompositeObjectWidget(widget) || isCompositeObjectWidget(mergeBaseWidget)) {
    let incoming = value;
    if (typeof value === "string") {
      try {
        incoming = JSON.parse(value);
      } catch {
        throw new WidgetWriteError(
          `Widget "${name}" holds a composite object value; the string ` +
            `${JSON.stringify(value)} is not valid JSON for it. To change ONE field, ` +
            `address it directly (e.g. "${name}.on" or "${name}.strength"), or pass a full ` +
            `JSON object like {"on":false}.`,
        );
      }
    }
    if (incoming == null || typeof incoming !== "object" || Array.isArray(incoming)) {
      throw new WidgetWriteError(
        `Widget "${name}" is a composite object widget; a bare scalar would corrupt it. ` +
          `Value ${JSON.stringify(value)} must be an object (or JSON object string), e.g. ` +
          `{"on":true,"lora":"name.safetensors","strength":1}. To change ONE field and keep ` +
          `the rest, address it directly: "${name}.on"=false, "${name}.strength"=0.8, or pass ` +
          `a JSON object {"on":false}.`,
      );
    }
    // #366×#179: for a PROMOTED composite, the AUTHORITATIVE base is the RAIL
    // widget's current object (what serializes), not the inner widget's — merging
    // onto a stale inner would clobber the rail's unspecified fields when the same
    // coerced value is written to both. Prefer the rail's object; fall back to the
    // target widget's own value when the rail base isn't a usable object.
    const base =
      mergeBaseWidget && mergeBaseWidget.value != null && typeof mergeBaseWidget.value === "object" && !Array.isArray(mergeBaseWidget.value)
        ? mergeBaseWidget.value
        : widget.value;
    // Validate EACH incoming key against the existing row (fail closed on an unknown
    // field, type-check each value) so a full-object write cannot silently mistype `on`
    // or add junk members either — the same strictness the dotted path enforces (#560).
    const mergeBase =
      base != null && typeof base === "object" && !Array.isArray(base) ? base : {};
    return mergeCompositeFields(name, mergeBase, incoming);
  }

  // STRING / text / unknown widget: pass through unchanged (an explicit "" clears
  // it, #347).
  return value;
}

/**
 * The parent SubgraphNode's OWN projected promoted widget that is backed by
 * `hostInput` — i.e. the widget whose value serializes into the subgraph input
 * rail at queue time (#366).
 *
 * Authenticated by OBJECT IDENTITY, never by a name/label lookup. In the ComfyUI
 * frontend the host input slot stores only a `{ name }` STUB in `input.widget`;
 * the real authoritative rail widget is the PROJECTION object litegraph builds for
 * the slot (`input._widget`), whose get/set `value` proxies the subgraph widget
 * value STORE that is serialized at queue time. `getWidgetFromSlot()` returns that
 * projection when present but otherwise FALLS BACK to a name-based lookup — and a
 * name match (even a unique one) could select an unrelated decoy own-widget while
 * no authenticated rail object exists. So we accept ONLY a candidate that is an
 * actual widget OBJECT AND is `===` a live member of `node.widgets`, and otherwise
 * FAIL CLOSED (return null) — never write inner or parent on a name-only stub.
 *
 * #366 recurrence hardening: during a promoted-input rebind, `_widget` can remain
 * attached to the old/link-driven projection while the host input's `widgetId` and
 * the newly materialized parent rail point at another live widget. When the host
 * carries a key, it is the stronger identity: choose exactly one live projection
 * whose own `widgetId` is that key before applying the legacy `_widget`/`widget`
 * order. A mismatched keyed projection is ignored; an ambiguous or keyless set
 * remains fail-closed unless an unkeyed, directly identity-linked legacy projection
 * is available. This is still relationship authentication, never a name fallback.
 */
export function resolveHostPromotedWidgets(subgraphNode, hostInput) {
  if (!subgraphNode || !hostInput) return [];

  // EXTERNALLY-LINKED host input ⇒ the local projected widget is NOT authoritative.
  // When the host input carries an outer link, ComfyUI's queue compiler IGNORES
  // this node's projected widget and recursively follows the OUTER source (the
  // enclosing subgraph's rail); ComfyUI's own promoted-widget control treats
  // `input.link != null` as "host store is non-authoritative". Writing the local
  // widget here would pass verification yet render the enclosing rail's OLD value —
  // a false success. Refuse (→ caller FAILS CLOSED); the widget must be edited from
  // the OUTERMOST subgraph node, where its host input has no outer link.
  if (hostInput.link != null) return [];

  const inWidgets = Array.isArray(subgraphNode.widgets) ? subgraphNode.widgets : [];

  // OBJECT-IDENTITY authentication. A rail/proxy widget must be an actual projection
  // object the host input LINKS to (`_widget`, or an `input.widget` that is itself a
  // real widget object — NOT a `{ name }` stub) AND must be `===` a live member of
  // this node's projected widgets. A name-only stub is an object too, but it is NOT a
  // member of node.widgets, so it is rejected. This never resolves by name, so an
  // unrelated same-named decoy can never be selected (#233/#366).
  //
  // #477: a single host input can reference TWO distinct authenticated widgets — the
  // serializing rail PROJECTION (`_widget`) AND the parent-facing DISPLAY proxy
  // (`input.widget`, a real widget in newer ComfyUI). BOTH belong to this exact
  // promotion by identity and must be synced, or the display proxy renders/queries
  // the OLD value while the tool reports success. Returned in priority order — the
  // FIRST element is the AUTHORITATIVE serializing rail (what #366 verifies).
  const out = [];
  for (const cand of [hostInput._widget, hostInput.widget]) {
    if (cand && typeof cand === "object" && inWidgets.includes(cand) && !out.includes(cand)) {
      out.push(cand);
    }
  }

  // Newer ComfyUI frontends make the host input's widgetId the serialization
  // binding. A stale `_widget` can still be a live member of node.widgets while
  // belonging to the link-driven inner projection, so object identity alone is
  // insufficient to decide which identity-linked member is the parent rail.
  let hostWidgetId = null;
  try {
    const id = hostInput.widgetId;
    if (typeof id === "string" && id.length > 0) hostWidgetId = id;
  } catch {
    // Keep the legacy identity path below; an unreadable optional key is not a
    // reason to replace a directly linked, otherwise valid projection.
  }
  if (!hostWidgetId) return out;

  const readWidgetId = (widget) => {
    let id = null;
    try {
      const candidateId = widget.widgetId;
      if (typeof candidateId === "string" && candidateId.length > 0) id = candidateId;
    } catch {
      // Treat a projection with an unreadable optional key as legacy-unkeyed.
    }
    return id;
  };
  const described = out.map((widget) => ({ widget, id: readWidgetId(widget) }));
  // The projection list can be rebuilt independently of the host input object.
  // Include a newly materialized member by its exact host-owned key so a stale
  // `_widget` cannot win just because it is still one of the input's references.
  const keyedLive = inWidgets
    .map((widget) => ({ widget, id: readWidgetId(widget) }))
    .filter((entry) => entry.id === hostWidgetId);
  const keyed = keyedLive;
  if (keyed.length > 1) return [];
  if (keyed.length === 1) {
    // The canonical host-keyed projection is the primary safe target here. Keep
    // the other directly identity-linked, unkeyed projections as display views:
    // #477 requires them to be updated too, or the outer node can still render
    // the old value. A keyed projection for a different identity is the stale
    // link-driven view that triggered this recurrence and must not be promoted
    // to a display target by name or list position.
    const primary = keyed[0].widget;
    const displays = described
      .filter((entry) => entry.widget !== primary && entry.id === null)
      .map((entry) => entry.widget);
    return [primary, ...displays];
  }
  // A host key with only mismatched keyed projections is not evidence for any
  // candidate. Legacy unkeyed identity links remain supported only when no
  // competing keyed projection exists; a stale keyed object is never promoted
  // to the rail by its name or list position.
  if (described.some((entry) => entry.id !== null)) return [];
  return described.map((entry) => entry.widget);
}

/**
 * The single AUTHORITATIVE parent rail widget for `hostInput` — the projection whose
 * value serializes at queue time (#366). This is the FIRST identity-authenticated
 * widget resolveHostPromotedWidgets returns, or null when none can be authenticated
 * (→ caller FAILS CLOSED). Kept as the load-bearing #366 accessor; #477's additional
 * display-proxy widgets are synced via resolveHostPromotedWidgets.
 */
export function resolveHostPromotedWidget(subgraphNode, hostInput) {
  return resolveHostPromotedWidgets(subgraphNode, hostInput)[0] ?? null;
}

/**
 * comfyui-mcp#1707 — WHERE a promoted subgraph widget's value actually lives.
 *
 * A `Subgraph` DEFINITION object is SHARED by every instance placed on the canvas:
 * `SubgraphNode.subgraph` is the same object for wrappers 279, 293 and 300 of one
 * reusable subgraph, and so is every node inside it. So an assignment to the inner
 * widget is an assignment to the DEFINITION — a write aimed at one wrapper that
 * every sibling wrapper inherits.
 *
 * The ComfyUI frontend does NOT store a promoted value there. It gives each host
 * input a `widgetId` — `"<rootGraphId>:<encoded nodeId>:<encoded input name>"` —
 * and keeps the value in a per-widgetId store. Both projections it can build for
 * the rail read and write through that key: the plain store-backed projection
 * (`get/set value` → the store) and the app-layer promoted DOM widget (whose
 * `options.getValue/setValue` do the same). It is also the ONLY value the queue
 * compiler reads for an unlinked promoted input — `ExecutableNodeDTO.resolveInput`
 * returns `store.getWidget(input.widgetId)?.value` and never looks at the inner
 * widget. And an on-canvas edit of the promoted control writes ONLY that entry.
 *
 * The node id is IN the key, so the key itself proves the scope: when the key's
 * node segment is THIS wrapper's id, no sibling wrapper can read the entry this
 * write lands in — the scope is established from the data, not assumed from a
 * frontend version. Parsed the way the frontend's own `parseWidgetId` parses it
 * (exactly three colon-separated segments; the id builder percent-encodes the
 * node id and the name, so neither can introduce a colon).
 *
 * Anything else — no `widgetId` at all (an older frontend, where the rail is a live
 * VIEW of the inner widget and there is no per-instance home to write) or a key that
 * does not name this wrapper (an unknown keying whose sharing we cannot establish) —
 * is reported as `"subgraph_definition"`. That is a statement about where the write
 * then goes, not a prediction about siblings, and the caller is told which one it got.
 *
 * @returns {"instance"|"subgraph_definition"}
 */
export function promotedValueScope(subgraphNode, hostInput) {
  let id;
  try {
    id = hostInput?.widgetId;
  } catch {
    return "subgraph_definition";
  }
  if (typeof id !== "string" || id === "") return "subgraph_definition";
  const parts = id.split(":");
  if (parts.length !== 3) return "subgraph_definition";
  let own;
  try {
    own = encodeURIComponent(String(subgraphNode?.id));
  } catch {
    return "subgraph_definition";
  }
  return parts[1] === own ? "instance" : "subgraph_definition";
}

/**
 * Classify a widget request on `subgraphNode` against `widgetName` and, when it
 * is a PROMOTED subgraph widget, resolve it to the ACTUAL inner (node, widget)
 * AND the authoritative parent rail widget (via the promotion relationship).
 *
 * Detection matches ONLY the OUTER alias the caller sees on the parent
 * (host-input name/label and the backing subgraph-input name/label) — never the
 * inner source widget name — so a renamed promotion (`scheduler` on the parent
 * mapping to inner `sampler_name`) is followed to the RIGHT inner widget.
 *
 * `resolveSource(subgraphNode, subgraphInput)` walks the subgraph link and
 * returns `{ sourceNodeId, sourceWidgetName }` (the panel injects its live
 * `sourceForSubgraphInput`).
 *
 * Returns a status object — the caller MUST honour it and never fall back to
 * the parent slot when `promoted` is true but `target` is null:
 *   { promoted: false }                                          → not a promoted widget
 *   { promoted: true, target: {node,widget,input,parentWidget,parentWidgets} } → resolved
 *                                                                  inner target (parentWidget
 *                                                                  may be null; parentWidgets
 *                                                                  is every identity-authenticated
 *                                                                  rail/display proxy, #477)
 *   { promoted: true, target: null, error }                      → promoted but UNRESOLVABLE/ambiguous
 */
export function resolvePromotedInnerTarget(subgraphNode, widgetName, resolveSource) {
  const subgraph = subgraphNode?.subgraph;
  if (!subgraph) return { promoted: false };
  const wanted = String(widgetName).toLowerCase();

  // Host inputs whose OUTER alias matches the requested name. We match on the
  // HOST input's own name/label AND (when present) its backing subgraph slot,
  // so a promoted widget is DETECTED even if `_subgraphSlot` is missing — that
  // must fail CLOSED, never fall through to the shifted parent widget.
  const matches = [];
  for (const input of subgraphNode.inputs ?? []) {
    const subgraphInput = input?._subgraphSlot ?? null;
    const aliases = promotedInputAliases(input, subgraphInput).map((a) => a.toLowerCase());
    // Labels are used ONLY to DETECT which promotion the caller meant (a caller
    // may address by a renamed promotion's display label). Locating the parent's
    // authoritative rail widget is done LATER by the promotion RELATIONSHIP
    // (host-input → backing widget), never by a name match (#366/#233).
    if (aliases.includes(wanted)) matches.push({ input, subgraphInput });
  }

  // No matching host input at all ⇒ a genuine non-promoted own-widget.
  if (matches.length === 0) return { promoted: false };
  if (matches.length > 1) {
    return {
      promoted: true,
      target: null,
      error: `promoted widget "${widgetName}" is ambiguous — ${matches.length} promoted inputs match; refusing to guess.`,
    };
  }

  const { input, subgraphInput } = matches[0];
  // It IS a promoted widget, but its backing subgraph slot is absent — we
  // cannot reach the inner target, so refuse rather than corrupt the parent.
  if (!subgraphInput) {
    return {
      promoted: true,
      target: null,
      error: `promoted widget "${widgetName}" has no backing subgraph slot (_subgraphSlot missing) — cannot resolve inner target.`,
    };
  }
  if (typeof resolveSource !== "function") {
    return {
      promoted: true,
      target: null,
      error: `no resolver available for promoted widget "${widgetName}".`,
    };
  }
  const source = resolveSource(subgraphNode, subgraphInput);
  if (!source) {
    return {
      promoted: true,
      target: null,
      error: `promoted widget "${widgetName}" has no resolvable inner link (stale/empty linkIds).`,
    };
  }
  const innerNode =
    typeof subgraph.getNodeById === "function"
      ? subgraph.getNodeById(source.sourceNodeId)
      : (subgraph._nodes ?? []).find((n) => String(n?.id) === String(source.sourceNodeId));
  if (!innerNode) {
    return {
      promoted: true,
      target: null,
      error: `promoted widget "${widgetName}" links to missing inner node ${source.sourceNodeId}.`,
    };
  }
  const innerWidget = (innerNode.widgets ?? []).find((w) => w?.name === source.sourceWidgetName);
  if (!innerWidget) {
    return {
      promoted: true,
      target: null,
      error: `promoted widget "${widgetName}" links to missing inner widget "${source.sourceWidgetName}" on node ${source.sourceNodeId}.`,
    };
  }
  // AUTHENTICATE the parent's own rail widget by the PROMOTION RELATIONSHIP — the
  // host-input's backing widget — not by any name/label match. This is the widget
  // that serializes into the subgraph input rail at queue time (#366). May be null
  // (e.g. the widget is further promoted OUTWARD to an enclosing subgraph and is
  // exposed here as an input with no settable widget); the caller FAILS CLOSED on
  // null rather than write inner-only and render silently stale.
  const parentWidgets = resolveHostPromotedWidgets(subgraphNode, input);
  const parentWidget = parentWidgets[0] ?? null;
  return { promoted: true, target: { node: innerNode, widget: innerWidget, input, parentWidget, parentWidgets } };
}

/**
 * Follow a promoted write target through any NESTED SubgraphNodes to the ULTIMATE
 * CONCRETE backend node (#458 nested-promotion false-failure). ComfyUI supports
 * promoting an outer subgraph widget from an INNER subgraph that itself promotes from
 * a real node (A → B → KSampler). The immediate resolved target of the outer
 * promotion is the inner SubgraphNode (B) — a VIRTUAL node whose subgraph-id type is
 * absent from /object_info, so authorizing THAT against the backend would wrongly
 * refuse a valid write. Traverse the chain until a node with no `.subgraph` (the
 * concrete backend node) is reached, and return it for fresh authorization; a virtual
 * SubgraphNode type in the chain is TRAVERSED, never authorized. Pure: read-only.
 *
 * `target` is the immediate `{ node, widget }` from resolvePromotedInnerTarget.
 * Returns (always carrying the widget reached at the terminal, for combo-refresh
 * name mapping — nested promotions may RENAME the widget at each level, #366):
 *   { node, widget }                        → the CONCRETE backend node + its widget
 *   { node, widget, terminalVirtual: true } → chain ended on a virtual node's OWN
 *                                             (non-promoted) widget; authorize its type
 *   { node: null, widget: null, error }     → a deeper promotion link is unresolvable
 *   { node, widget, cycle: true }           → a promotion cycle was detected (defensive)
 */
/** Maximum number of nested promoted containers the write path will traverse.
 * A cycle is handled separately, but a bounded walk is still required for
 * hostile/malformed graphs whose resolver keeps producing fresh objects. */
export const MAX_PROMOTION_CHAIN_DEPTH = 16;

export function followPromotionToConcrete(target, resolveSource) {
  let node = target?.node ?? null;
  let widget = target?.widget ?? null;
  const seen = new Set();
  let depth = 0;
  while (node && node.subgraph) {
    if (seen.has(node)) return { node, widget, cycle: true };
    if (depth >= MAX_PROMOTION_CHAIN_DEPTH) {
      return {
        node: null,
        widget: null,
        error: `promoted chain exceeded the maximum depth of ${MAX_PROMOTION_CHAIN_DEPTH}`,
      };
    }
    seen.add(node);
    const res = resolvePromotedInnerTarget(node, widget?.name, resolveSource);
    if (!res.promoted) return { node, widget, terminalVirtual: true };
    if (!res.target) return { node: null, widget: null, error: res.error };
    node = res.target.node;
    widget = res.target.widget;
    depth += 1;
  }
  return { node, widget, depth };
}

/** Every addressable spelling of a promoted host rail. Frontend versions have
 * carried the programmatic name/label on the input, its backing subgraph slot,
 * or the rail widget projection. Keep graph_get_subgraph's witness enumeration
 * and graph_set_widget's live resolver on this exact shared alias contract. */
export function promotedInputAliases(input, subgraphInput = input?._subgraphSlot ?? null) {
  return [
    input?.name,
    input?.label,
    input?.widget?.name,
    input?.widget?.label,
    input?._widget?.name,
    input?._widget?.label,
    subgraphInput?.name,
    subgraphInput?.label,
  ]
    .filter((value) => value != null && String(value).length > 0)
    .map((value) => String(value));
}

/**
 * Collect EVERY INTERMEDIATE virtual SubgraphNode traversed from `target` (the
 * immediate promoted inner) down to — but EXCLUDING — the ultimate concrete node. A
 * nested promotion drives the value THROUGH each of these containers, so each must be
 * authorized (#458 nested-intermediate) — not just the immediate inner and the
 * terminal. Returns nodes in order [immediate, …deeper]; the concrete terminal (no
 * `.subgraph`) is never included, and traversal stops on an unresolvable/cyclic chain
 * (those fail closed elsewhere). Pure: read-only. Mirrors followPromotionToConcrete's
 * walk so the SAME chain is authorized that the write actually drives.
 */
export function collectPromotionIntermediates(target, resolveSource) {
  const out = [];
  let node = target?.node ?? null;
  let widget = target?.widget ?? null;
  const seen = new Set();
  let depth = 0;
  while (node && node.subgraph) {
    if (seen.has(node)) break;
    if (depth >= MAX_PROMOTION_CHAIN_DEPTH) break;
    seen.add(node);
    out.push(node);
    const res = resolvePromotedInnerTarget(node, widget?.name, resolveSource);
    if (!res.promoted || !res.target) break;
    node = res.target.node;
    widget = res.target.widget;
    depth += 1;
  }
  return out;
}

/**
 * Resolve the true write target (inner promoted widget or the node's own
 * widget) and validate/coerce the value. Throws WidgetWriteError on any
 * unresolved-promotion, missing-widget, or value-mismatch condition — BEFORE
 * any mutation. Pure: no graph side effects.
 */
export function resolveWidgetWrite(
  node,
  widgetName,
  value,
  resolveSource,
  assertTargetWritable,
  promotedResolution,
  coerceOpts,
) {
  let targetNode = node;
  let widget = null;
  let promotedFrom = null;
  let promotedParentWidget = null;
  let promotedParentWidgets = [];
  let promotedHostInput = null;
  // #560: sub-field addressing ("lora_1.on") is derived AFTER an exact-name lookup
  // fails — never by pre-splitting the caller's name — so a real widget whose own
  // name contains a dot is never hijacked.
  let subFieldPath = null;

  if (node?.subgraph) {
    // Reuse a promotion resolution the caller already computed (graph_set_widget
    // resolves it ONCE up front to fresh-authorize the inner target, #458), so the
    // write targets the IDENTICAL inner node it authorized — a relink between the
    // async /object_info fetch and the write can't swap in an unauthorized target.
    // Falls back to resolving here for direct callers (e.g. unit fixtures).
    const res = promotedResolution ?? resolvePromotedInnerTarget(node, widgetName, resolveSource);
    if (res.promoted) {
      // Promoted widget: use the resolved inner widget DIRECTLY. Never re-search
      // the inner node by the OUTER name (a rename would hit the wrong inner
      // widget), and never fall back to the shifted parent slot on failure.
      if (!res.target) {
        throw new WidgetWriteError(
          res.error || `promoted widget "${widgetName}" could not be resolved to an inner widget.`,
        );
      }
      targetNode = res.target.node;
      widget = res.target.widget;
      promotedFrom = { subgraph_node_id: node.id, inner_node_id: res.target.node.id };
      promotedHostInput = res.target.input;
      // The AUTHORITATIVE parent rail widget (backed by the host input via the
      // promotion relationship). Null ⇒ FAIL CLOSED right here — BEFORE the
      // assertTargetWritable gate and BEFORE any (potentially side-effecting)
      // coercion. coerceWidgetValue may INVOKE a dynamic combo's
      // `options.values(widget)` callback which can mutate the inner widget; if we
      // refused only after coercion, a missing/linked/ambiguous rail could leave an
      // uncaptured inner mutation. Refusing first guarantees a promoted write with
      // no authoritative rail performs NO side effect at all (#366).
      promotedParentWidget = res.target.parentWidget ?? null;
      // #477: EVERY identity-authenticated projection this host input references —
      // the serializing rail AND the parent-facing display proxy. All are synced +
      // rolled back atomically so no proxy renders/queries the stale value. Falls
      // back to the single primary for older resolutions that omit the list.
      promotedParentWidgets =
        Array.isArray(res.target.parentWidgets) && res.target.parentWidgets.length
          ? res.target.parentWidgets
          : promotedParentWidget
            ? [promotedParentWidget]
            : [];
      if (!promotedParentWidget) {
        // #1181 — when the host input's OUTER link originates at a frontend-only
        // VIRTUAL source (a canvas PrimitiveNode), the generic advice below is
        // wrong in both directions: editing "the outermost subgraph node" cannot
        // help (that IS this node, and its rail is non-authoritative because of
        // the link), and the link itself carries NOTHING — the prompt compiler
        // drops the virtual origin, so the inner node's STORED widget value is
        // what executes. Say so, and point at the two repairs that work. The
        // refusal itself stands: a write here would still report success over a
        // rail nothing serializes from (#366's fail-closed posture is untouched).
        if (promotedHostInput?.link != null) {
          const links = node.graph?.links ?? {};
          const l = links[promotedHostInput.link];
          const originId = l ? (l.origin_id ?? l[1]) : null;
          const origin =
            originId != null && node.graph
              ? (typeof node.graph.getNodeById === "function"
                  ? node.graph.getNodeById(originId)
                  : (node.graph._nodes ?? []).find((nd) => String(nd?.id) === String(originId)))
              : null;
          if (isNonSerializingValueSource(origin)) {
            throw new WidgetWriteError(
              `promoted widget "${widgetName}" on subgraph node ${node.id} is fed by ` +
                `${origin.type ?? "a frontend-only virtual node"} #${originId}, which the prompt ` +
                `compiler DROPS — the value on that link does NOT cross the subgraph boundary, so ` +
                `no write to this rail can take effect and editing the outermost subgraph node ` +
                `cannot help either. What executes is each INNER node's stored widget value: set ` +
                `the widget on the inner node directly (enter the subgraph, then panel_set_widget ` +
                `there), or replace the virtual source with a BACKEND node (e.g. ` +
                `PrimitiveStringMultiline), whose value does cross (#1181). Refusing to write, ` +
                `which would report success over a value that cannot serialize.`,
            );
          }
        }
        throw new WidgetWriteError(
          `promoted widget "${widgetName}" on subgraph node ${node.id} resolves to an inner ` +
            `widget, but its AUTHORITATIVE parent rail widget could not be identified (the value ` +
            `that serializes at queue time). This happens when the widget is further promoted to ` +
            `an enclosing subgraph (fed by an outer link / exposed as an input, not a settable ` +
            `widget), the promotion metadata is malformed, or its name is duplicated. Refusing to ` +
            `write the inner widget alone, which would silently render the OLD value (#366). Edit ` +
            `this widget from the outermost subgraph node, or disconnect the inner input to make ` +
            `the inner value authoritative.`,
        );
      }
    }
  }

  if (!widget) {
    // EXACT-NAME FIRST: a widget whose own name is literally `widgetName` (dots and
    // all) always wins — the split is never taken when an exact match exists.
    widget = resolveWidgetByName(targetNode, widgetName);
  }
  if (!widget && node?.subgraph) {
    // #560 SAFETY: on a SUBGRAPH parent, a dotted name that did not resolve as a
    // promotion alias must NOT fall through to the base-name dotted fallback below —
    // that would write the parent's projected RAIL widget DIRECTLY, bypassing the
    // atomic inner+rail #366 path (inner left stale, silent partial). A promoted
    // composite is driven with a FULL JSON object on the promoted widget instead,
    // which goes through the #366 merge. Refuse the dotted form loudly here.
    const nameStr = String(widgetName);
    if (nameStr.indexOf(".") > 0) {
      const baseName = nameStr.slice(0, nameStr.indexOf("."));
      throw new WidgetWriteError(
        `Dotted sub-field addressing ("${widgetName}") is not supported on subgraph node ` +
          `${node.id}. If "${baseName}" is a promoted composite widget, set it with a full JSON ` +
          `object (e.g. {"on":false}) so the promoted inner + rail update atomically (#366); ` +
          `otherwise address it from the node that owns the widget.`,
      );
    }
  }
  if (!widget) {
    // #560: no exact widget — try DOTTED sub-field addressing ("lora_1.on") on a DIRECT
    // node. Resolve the BASE widget (before the first dot); the field is only
    // addressable when the base is a COMPOSITE object widget. An empty suffix ("foo.")
    // is rejected LOUDLY rather than silently degrading to a bare write on the base.
    const nameStr = String(widgetName);
    const dot = nameStr.indexOf(".");
    if (dot > 0) {
      const baseName = nameStr.slice(0, dot);
      const sub = nameStr.slice(dot + 1);
      const baseWidget = resolveWidgetByName(targetNode, baseName);
      if (baseWidget) {
        if (sub === "") {
          throw new WidgetWriteError(
            `Widget "${widgetName}" has an empty sub-field after the dot. Address a field, ` +
              `e.g. "${baseName}.on" or "${baseName}.strength".`,
          );
        }
        if (!isCompositeObjectWidget(baseWidget)) {
          throw new WidgetWriteError(
            `Widget "${baseName}" is not a composite object widget, so its sub-field ` +
              `"${sub}" cannot be addressed. Sub-field writes are only valid on widgets ` +
              `whose current value is an object (e.g. an rgthree Power Lora Loader row).`,
          );
        }
        widget = baseWidget;
        subFieldPath = sub;
      }
    }
  }
  if (!widget) {
    // #757 — pressable-widget hint for a button that CREATES the missing slot.
    // #1956 — if the name is a node PROPERTY (rgthree Fast Groups matchTitle/…),
    // point at panel_set_property instead of a click dead-end, and list each
    // available widget name once (Fast Groups repeats RGTHREE_TOGGLE_AND_NAV).
    throw new WidgetWriteError(missingWidgetMessage(targetNode, widgetName));
  }

  // Gate on the RESOLVED target BEFORE coercion (#458). coerceWidgetValue reads —
  // and thus may INVOKE — a dynamic combo's `options.values(widget)` callback,
  // which can mutate; so the registration/placeholder refusal must land here,
  // before ANY value handling touches the (possibly placeholder) node. The panel
  // injects a registry check; it throws to refuse.
  assertTargetWritable?.(targetNode, widget);

  // For a promoted COMPOSITE write, merge onto the AUTHORITATIVE rail widget's
  // current object (#366×#179) so its unspecified fields are preserved; scalars are
  // unaffected (they don't merge). Non-promoted writes merge onto their own value.
  // (A promoted write with no authoritative rail already threw above, BEFORE this
  // possibly side-effecting coercion — so `promotedParentWidget` is non-null here.)
  const coerced = coerceWidgetValue(widget, value, promotedParentWidget ?? widget, subFieldPath, coerceOpts);

  return { targetNode, widget, coerced, promotedFrom, promotedParentWidget, promotedParentWidgets, promotedHostInput };
}

/**
 * The COMPLETE graph_set_widget body as a driveable unit: resolve target →
 * validate/coerce → write (with the widget's own callback) → verify the value
 * stuck EXACTLY (fail loudly on drift, #240). Graph hooks are injected so this
 * runs both live and under unit test. Throws WidgetWriteError on any failure.
 */
export function applyWidgetWrite(
  node,
  widgetName,
  value,
  {
    resolveSource,
    canvas,
    beforeChange,
    afterChange,
    setDirty,
    assertTargetWritable,
    promotedResolution,
    // #507: only the FINAL attempt (after the authoritative /object_info combo refresh
    // has had its chance) may treat a still-EMPTY combo option list as "not knowable"
    // and take the value as written. Default false ⇒ the empty case is a RETRYABLE
    // combo rejection, so a merely-stale empty list is refreshed before any decision.
    acceptEmptyComboOptions = false,
    // #1126: only the FINAL attempt may treat an UNREADABLE option list (the widget's
    // own options.values callback threw / returned a non-list) as "not knowable" and take
    // a non-empty string as written. Default false ⇒ the unreadable case is a RETRYABLE
    // combo rejection, so a transient callback failure is re-read before any decision.
    acceptUnreadableComboOptions = false,
  } = {},
) {
  // resolveWidgetWrite runs assertTargetWritable on the RESOLVED target (inner
  // promoted node for a subgraph write, or the node's own) BEFORE it coerces the
  // value, so no coercion callback and no mutation can touch an unregistered
  // placeholder that is about to be refused (#458). A caller-supplied
  // promotedResolution is reused so the write targets the EXACT node the fresh
  // /object_info gate authorized (#458), and resolveWidgetWrite also fails closed if
  // the AUTHORITATIVE parent rail widget can't be identified (#366).
  const coerceOutcome = {};
  // `coerced` is mutable: the #507 empty-list sibling cross-check below may ADOPT a
  // rail option's original value when the numeric-labelled fallback matches there
  // (#667 codex round-3) — the write then lands the list's own value, not the
  // caller's coerced scalar.
  let { targetNode, widget: w, coerced, promotedFrom, promotedParentWidget, promotedParentWidgets, promotedHostInput } =
    resolveWidgetWrite(node, widgetName, value, resolveSource, assertTargetWritable, promotedResolution, {
      acceptEmptyComboOptions,
      acceptUnreadableComboOptions,
      // Filled in by coerceWidgetValue with WHICH acceptance admitted the value — the
      // EMPTY-LIST one (#507) or the UNREADABLE-LIST one (#1126) — rather than ordinary
      // membership. Read below; NEVER re-derived by reading the option list again, since
      // a stateful dynamic source can answer differently on a second call.
      out: coerceOutcome,
    });

  // #366: for a promoted subgraph widget the AUTHORITATIVE value lives on the
  // parent's OWN rail widget (resolved by the promotion RELATIONSHIP in
  // resolveWidgetWrite, which already FAILED CLOSED if it could not be identified).
  // We now write BOTH the inner widget AND the parent rail widget ATOMICALLY inside
  // one undo envelope: either both land, or neither does and we throw — a thrown
  // callback on EITHER side must never leave inner=new / parent=stale (a silent
  // partial write that renders the OLD value while reporting success).
  const parentWidget = promotedFrom ? promotedParentWidget : null;
  // #477: the SECONDARY parent-facing DISPLAY proxy widgets this promotion references
  // by identity (every authenticated projection beyond the authoritative rail). #366
  // synced only the primary rail, leaving a distinct display proxy stale so a query of
  // the parent node saw the OLD value even though the tool reported success. Sync +
  // roll them back alongside the rail, atomically. Empty for the common single-widget
  // shape (all existing #366/#233 fixtures), so those paths are byte-identical; and
  // resolved by IDENTITY, never by name, so a same-named decoy is never touched (#233).
  const displayWidgets =
    promotedFrom && Array.isArray(promotedParentWidgets)
      ? promotedParentWidgets.filter((dw) => dw && dw !== w && dw !== parentWidget)
      : [];

  // comfyui-mcp#1707 — WHICH STORE THIS WRITE OWNS.
  //
  // The promoted rail and the inner widget are not two views of one value: in a
  // frontend that gives the host input a `widgetId`, the rail is this WRAPPER's own
  // store entry and the inner widget is the SHARED DEFINITION, read by every sibling
  // instance of the subgraph. Writing both therefore turned a write aimed at wrapper
  // 293 into a write every sibling inherits (279 and 300 both went to 1024x1024) —
  // and the definition write is one the UI itself never performs: an on-canvas edit
  // of a promoted control writes the store entry and nothing else.
  //
  // So on the instance-scoped path this write owns the RAIL, and the shared
  // definition is left exactly as it was — which is also VERIFIED below, because
  // "the rail is instance-scoped" is a claim about the frontend's plumbing that this
  // module must not take on trust: if the rail turns out to forward to the inner
  // widget after all, the definition changes, and that is a failure, not a success.
  const valueScope = promotedFrom ? promotedValueScope(node, promotedHostInput) : null;
  const instanceScoped = valueScope === "instance";
  // The widget this write's VALUE lands on, and the node that OWNS that widget.
  // Everything downstream — the bound-property binding, the widget callback, the
  // read-back verification, normalization and the reported result — keys on these,
  // so each one describes the write that actually happened. On every non-promoted
  // and every definition-scoped write they are the inner/own target, unchanged.
  const valueWidget = instanceScoped ? parentWidget : w;
  const valueNode = instanceScoped ? node : targetNode;

  // #507 (codex round-3, MODERATE): coerceWidgetValue validated the value against the
  // IMMEDIATE inner widget's option list only — but a promoted write assigns the SAME
  // value to the parent's authoritative RAIL widget and to every display proxy, whose
  // own option lists can DIFFER from the inner's. That is harmless while the inner list
  // is authoritative, but the empty-list acceptance deliberately writes a value nothing
  // validated, so an inner combo that is (server-declared) EMPTY could push an OFF-LIST
  // value into a rail/proxy that DOES have a real list. Scoped strictly to that path:
  // when acceptEmptyComboOptions is in force, every OTHER mutated combo with a readable
  // NON-EMPTY list must contain the value, or the whole write fails closed BEFORE any
  // mutation. A rail whose own list is unreadable or empty adds no information and is
  // skipped (the inner's server declaration already governs).
  // …and ONLY when the EMPTY-LIST acceptance is what actually admitted the value. Keying
  // on the caller's FLAG alone over-reached: with a stateful inner options function the
  // final attempt may have been validated by ordinary membership, and refusing the rail
  // then would be the very "guard rejects a legitimate case" bug this PR exists to fix.
  // The verdict is taken from COERCION TIME (coerceOutcome, set inside coerceWidgetValue)
  // and never re-derived by reading the list again: a second read of a stateful dynamic
  // source can disagree with the first, which would turn the narrowing into an escape
  // hatch around this very check (codex confirmation round).
  //
  // #1126 extends the SAME gate to the UNREADABLE-list acceptance, for the identical
  // reason: it too writes a value the inner list did not validate, so a rail/proxy with a
  // real closed list must still be satisfied. What it does NOT inherit is the #667
  // label-ADOPTION below. Adoption replaces the caller's value with the rail list's own
  // original — sound when the inner list is EMPTY (any scalar was admissible there, so the
  // rail's own option is at least as valid), but wrong here: the inner list EXISTS and
  // could not be read, so a rail label like the NUMBER 4444 would be written to a widget
  // whose real, unread list may not contain it — reintroducing exactly the #240 index
  // hazard the string-only rule above preserves. Unreadable ⇒ verify or refuse, never
  // substitute.
  const emptyAccepted = coerceOutcome.emptyAcceptanceUsed === true;
  const unreadableAccepted = coerceOutcome.unreadableAcceptanceUsed === true;
  // The inner-widget OBSERVATION, stated once and reused in every refusal below so the
  // message can never describe the wrong one (the empty-list wording on an unreadable
  // list said "the inner widget's option list is empty" about a list nobody had read).
  const innerObservation = emptyAccepted
    ? "the inner widget's option list is empty"
    : "the inner widget's option list could not be READ";
  // #1126 — set when the AUTHORITATIVE PARENT RAIL's readable, non-empty list contains the
  // value. Only meaningful on the unreadable path, where it narrows an otherwise-unqualified
  // "nothing validated this" down to the truth.
  //
  // Deliberately NOT "any sibling". A promotion can mutate two kinds of widget: the parent
  // subgraph's RAIL — the one that SERIALIZES at queue time — and #477's display proxies,
  // which are read-only mirrors the outer node shows. On a dual-projection promotion a
  // display proxy can hold a list the rail does not, so a match there would emit
  // `promoted_rail_validated` and make the reply and the activity summary both claim the
  // serializing rail vouched for a value it never listed. On a change whose whole value is
  // telling the truth about what was and was not validated, an overstated disclosure is
  // worse than a missing one — a proxy match therefore stays silent and the write is
  // reported as fully unvalidated, which is what it is as far as the rail is concerned.
  let railValidated = false;
  if (emptyAccepted || unreadableAccepted) {
    let adoptedOption = false;
    // Each sibling's option list AS READ during admission. A STATEFUL non-function
    // source (an accessor/proxy answering differently per read) must not be read a
    // second time: the post-adoption re-validation below checks the SAME snapshots
    // admission was decided against — a fresh read could produce a false DISAGREE
    // or pass against a list that has since changed (codex delta-gate 2), the same
    // never-read-twice rule `emptyAcceptanceUsed` itself follows (above).
    const siblingSnapshots = [];
    for (const other of [parentWidget, ...displayWidgets]) {
      if (!other || !isComboWidget(other)) continue;
      // A DYNAMIC (function) sibling list is UNVERIFIABLE from here (codex round-5): it
      // can return [] during this check and a real, non-empty list immediately afterwards
      // — a one-shot read proves nothing, and the off-list value would still land on the
      // mutated, serializing rail. Only the value's membership matters, and we cannot
      // establish it, so fail closed rather than report a success we cannot stand behind.
      if (typeof other.options?.values === "function") {
        throw new WidgetWriteError(
          `Cannot verify value ${JSON.stringify(coerced)} against the parent subgraph's combo ` +
            `widget "${other.name}", which this promoted write also mutates: its option list is ` +
            `computed dynamically and ${innerObservation}, so nothing authoritative ` +
            `validates the value. Refusing to write.`,
        );
      }
      const otherOptions = comboOptions(other);
      if (!Array.isArray(otherOptions) || otherOptions.length === 0) continue;
      // Snapshot the list AS READ (a stateful non-function source can answer
      // differently per read — the re-validation below must check the SAME list
      // admission was decided against, codex delta-gate 2). The copy itself can
      // throw: a buggy-but-in-scope array with a THROWING later-index getter must
      // not crash a write `includes()` would admit from an early member (codex
      // final gate) — so a failed copy records a NULL snapshot and admission
      // proceeds exactly as before. Only if an adoption later REPLACES the value
      // does the missing snapshot matter, and then the write fails closed (below)
      // rather than skip re-validation.
      let snapshot = null;
      try {
        snapshot = otherOptions.slice();
      } catch {
        snapshot = null;
      }
      siblingSnapshots.push({ name: other.name, options: snapshot });
      if (otherOptions.includes(coerced)) {
        // #1126 — a POSITIVE validation, recorded, but ONLY from the authoritative rail.
        // Its list WAS readable and WAS non-empty and DOES contain the value, so on the
        // unreadable path the claim "nothing checked the value" stops being true: the target
        // widget's own list could not be read, but the widget that SERIALIZES at queue time
        // vouched for it. A #477 display proxy matching proves nothing about what gets
        // queued, so it is not recorded — see the declaration above. Reported as data so the
        // reply and the activity summary can scope their disclosure to what was actually
        // unchecked instead of asserting a blanket "unvalidated" the code itself contradicts.
        if (other === parentWidget) railValidated = true;
        continue;
      }
      // #667 (codex round-3): the SAME numeric-labelled-option rule applies here —
      // a numeric request (4444) against a rail list holding the string "4444" must
      // not refuse an option the rail itself publishes. On a label match ADOPT the
      // rail list's ORIGINAL value for the whole write (the inner's empty list
      // accepted any scalar, so writing the rail's own option there is at least as
      // valid), never the incoming scalar — the #240 no-index guarantee holds.
      //
      // #1126 — EMPTY-list acceptance ONLY. Its justification is "the inner list admitted
      // any scalar", which is true of an empty list and FALSE of one that exists but could
      // not be read: adopting there would write a rail's NUMBER onto a widget whose own
      // (unread) list may not hold it, and would silently replace the value the caller
      // sent. The unreadable path therefore falls straight through to the refusal below —
      // recoverable, and it never invents a value.
      const siblingLabelIdx = emptyAccepted ? optionLabelIndex(otherOptions, coerced) : -1;
      if (siblingLabelIdx >= 0) {
        adoptedOption = true;
        coerced = otherOptions[siblingLabelIdx];
        continue;
      }
      throw new WidgetWriteError(
        `Value ${JSON.stringify(coerced)} is not a valid option for the parent subgraph's ` +
          `combo widget "${other.name}" (${otherOptions.length} options), which this promoted ` +
          `write also mutates — ${innerObservation}, but this one WAS read and does not ` +
          `contain the value. Refusing to write.`,
      );
    }
    // Codex delta-gate: an adoption REPLACES the value mid-loop, and a later sibling
    // can adopt a DIFFERENTLY-TYPED original of the same label (rail lists "4444",
    // a display proxy lists 4444) — the final write would then land a value an
    // earlier-validated sibling's list does not contain. When any adoption
    // happened, re-validate the FINAL value against every sibling's SNAPSHOT: a
    // sibling that does not strictly contain it conflicts (same label, different
    // type — or the value absent there), so no single value satisfies every list;
    // fail closed.
    if (adoptedOption) {
      for (const snap of siblingSnapshots) {
        // A NULL snapshot (the list could not be fully copied — a member access
        // threw) means the adopted value cannot be re-validated against this
        // sibling at all: fail closed rather than skip the check. A snapshot's
        // elements are plain copies, so `includes` here cannot throw.
        if (snap.options && snap.options.includes(coerced)) continue;
        throw new WidgetWriteError(
          snap.options
            ? `The sibling combo widgets this promoted write mutates DISAGREE about option ` +
              `${JSON.stringify(coerced)}: after matching it by label, "${snap.name}"'s list ` +
              `(${snap.options.length} options) does not contain the resulting value — the lists ` +
              `hold the same label with different types (or not at all), so no single value ` +
              `satisfies every list. Refusing to write.`
            : `The sibling combo widget "${snap.name}"'s option list could not be fully read ` +
              `(a member access threw), so the label-adopted value ${JSON.stringify(coerced)} ` +
              `cannot be re-validated against it. Refusing to write.`,
        );
      }
    }
  }

  // Snapshot the EXPECTED value BEFORE the callback runs. For a COMPOSITE object
  // write (#179) `w.value` and `coerced` are the SAME reference, so a callback
  // that mutates the object IN PLACE would change our "expected" too — making a
  // post-hoc compare trivially pass and hiding real drift. A structural clone
  // taken up front preserves the drift check (a scalar clones to itself).
  const objectWrite = coerced !== null && typeof coerced === "object";
  const expected = objectWrite ? JSON.parse(JSON.stringify(coerced)) : coerced;

  // #2146 — the live Fast Bypasser row's supported action mutates `value.toggled` in place.
  // Resolve it before taking the prior-value snapshot so rollback can isolate the complete
  // row object from that mutation without changing generic widget-write identity semantics.
  const fastBypasserAction = resolveFastBypasserAction(targetNode, w, coerced, w.value);

  const matchesExpected = (actual) =>
    objectWrite
      ? actual !== null &&
        typeof actual === "object" &&
        Object.keys(expected).every((k) => JSON.stringify(actual[k]) === JSON.stringify(expected[k]))
      : actual === expected;

  // Snapshot the PRIOR values AND deep clones of them. Rollback restores the prior
  // OBJECT REFERENCE (`previous`), but a subsequent afterChange hook could mutate
  // that object IN PLACE (e.g. `inner.value.strength = …`), so an identity compare
  // (Object.is) would pass while the restored object holds corrupted fields. We
  // verify rollback STRUCTURALLY against the pre-mutation deep clone instead.
  // `panel_set_widget` is addressed to the OUTER subgraph widget, even though a
  // promoted write mutates its inner implementation widget too. Its result must
  // therefore report the prior value the caller could observe on the requested
  // outer rail, not the (potentially divergent) inner widget's prior value (#583).
  // Keep the latter separately for diagnostics; it is not the API-level
  // `previous` for a promoted request.
  const previousParent = parentWidget ? parentWidget.value : undefined;
  const deepClone = (v) => (v !== null && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v);
  const structurallyEqual = (a, b) =>
    (a !== null && typeof a === "object") || (b !== null && typeof b === "object")
      ? JSON.stringify(a) === JSON.stringify(b)
      : Object.is(a, b);
  // #2146 — toggle(value) mutates the live row's value object in place. Keep a complete
  // structural snapshot for this action path so `w.value = previous` cannot reattach the
  // already-mutated object and leave a false partial-write result. Generic widgets retain
  // their historical prior-reference behavior; only this known action shape needs isolation.
  const previous = fastBypasserAction ? deepClone(w.value) : w.value;
  const previousClone = deepClone(previous);
  const previousParentClone = parentWidget ? deepClone(previousParent) : undefined;
  // #477: prior values (+ deep clones) of the secondary display proxies, so rollback
  // restores them exactly and a stateful hook mutating a restored object in place is
  // caught structurally, mirroring the rail's rollback rigor.
  const previousDisplays = displayWidgets.map((dw) => dw.value);
  const previousDisplayClones = displayWidgets.map((dw) => deepClone(dw.value));
  // #1268 / comfyui-mcp#1658 — the SECOND STORE this write has to keep in step, when
  // litegraph declares one. `w.value` read back after `w.value = coerced` cannot tell a
  // write that took effect from a write that landed on a view of state held elsewhere;
  // a widget carrying `options.property` names that elsewhere itself. Classified BEFORE
  // the envelope so the write, the verification and the rollback all act on ONE reading
  // (`node.setProperty` mutates `properties`, so a second classification taken later
  // would describe the state this write already produced). See widget-bound-property.js
  // for the two litegraph paths that make the binding load-bearing.
  // comfyui-mcp#1707 — taken on the widget this write actually assigns, and on the
  // node that owns it. On an instance-scoped promoted write that is the RAIL on the
  // WRAPPER: litegraph's `BaseWidget.setValue` calls `setProperty` on the node whose
  // widget is being edited, and the inner node's property is definition state this
  // write deliberately does not touch. Every other write passes the same pair it
  // always did.
  const boundProperty = boundPropertyState(valueNode, valueWidget);
  const previousPropertyClone = boundProperty?.reachable ? deepClone(boundProperty.previous) : undefined;
  // #1492 — WHAT AN INSTANCE-SCOPED PROMOTED WRITE DELIBERATELY DOES NOT DO.
  //
  // On that path the shared subgraph DEFINITION is left exactly as it was (see the
  // envelope below), and so is the inner widget's OWN callback: it is never invoked,
  // because invoking it would run a SHARED node's side effects for an edit made on
  // ONE instance. That trade is right and it was also SILENT — the reply carried
  // `parent_widget_synced: true` and `value_scope: "instance"` and nothing else, so a
  // caller whose inner widget does more than store a value read a clean success while
  // the things that callback drives stayed exactly as they were. The reported case: a
  // promoted BOOLEAN feeding a status-switch node that flips ANOTHER node's mode — the
  // wrapper's controls moved, the bypassed/active nodes did not, and nothing said so.
  //
  // So OBSERVE whether there was a callback to skip, and disclose it when there was.
  // Read ONCE and BEFORE the envelope: the rail's callback can install or remove one,
  // and the claim is about the callback this write declined to invoke — not about
  // whatever happens to be on the widget afterwards.
  //
  // Read TOTALLY. `callback` may be an accessor, and a throw while merely CLASSIFYING
  // must never fail a write that is otherwise fine. A throw is also not evidence of
  // ABSENCE, and absence is the only thing that justifies staying silent — so an
  // unreadable callback discloses too, worded so it never claims one exists.
  //
  // Scoped to `instanceScoped`. On every other path the inner widget IS the written
  // widget and its callback fires as it always did, so those replies are unchanged.
  let innerCallbackSkipped = false;
  let innerCallbackUnreadable = false;
  if (instanceScoped) {
    try {
      const innerCallback = w.callback;
      innerCallbackSkipped = innerCallback !== null && innerCallback !== undefined;
    } catch {
      innerCallbackSkipped = true;
      innerCallbackUnreadable = true;
    }
  }
  // The ACTUAL serialization binding for an unlinked subgraph input is its
  // `widgetId` (the widget-value STORE key that queue compilation reads). A callback
  // could keep the SAME host input and projection objects but re-point `widgetId` to
  // another store entry holding the OLD value — passing every object-identity check
  // while the render reads the stale entry. Snapshot it so the recheck can detect a
  // swap (#366).
  const promotedHostWidgetId = promotedHostInput ? promotedHostInput.widgetId : undefined;
  // #477: snapshot the promotion TOPOLOGY (the host input's projection references), so
  // a rollback restores not just the values but the WIRING. A callback can swap
  // `hostInput.widget`/`_widget` to a live replacement proxy; the drift recheck catches
  // it and throws, but without restoring these refs the replacement stays installed
  // after a "clean" rollback — violating the atomic snapshot→verify→rollback contract.
  const promotedHostWidgetRef = promotedHostInput ? promotedHostInput.widget : undefined;
  const promotedHostProjectionRef = promotedHostInput ? promotedHostInput._widget : undefined;
  // #477 P1: snapshot the OUTER node's widget-LIST membership too. Authentication of a
  // rail/proxy is by identity-membership in node.widgets (resolveHostPromotedWidgets),
  // so a callback that not only swaps hostInput.widget but ALSO replaces/reorders
  // node.widgets (natural cleanup when substituting a live proxy) detaches a captured
  // proxy while leaving a replacement live. Restoring only the host refs would leave
  // node.widgets corrupt yet pass read-back. Snapshot the array REFERENCE + its contents
  // so rollback can re-point and refill it — where the node KEEPS one array — and
  // read-back verifies membership/order either way.
  const prevOuterWidgetsRef = promotedFrom && Array.isArray(node.widgets) ? node.widgets : null;
  const prevOuterWidgets = prevOuterWidgetsRef ? prevOuterWidgetsRef.slice() : null;
  // Whether that list KEEPS its identity or is rebuilt per read decides how the
  // rollback restores it and how the read-back verifies it — see the helper. Read
  // BEFORE the write, so the recheck can also notice the list changing from one kind
  // to the other mid-write, which would otherwise slip past the identity compare.
  const prevOuterWidgetsIdentityStable = prevOuterWidgetsRef ? widgetsListHasStableIdentity(node) : false;

  // #2146 — capture the narrow Fast Bypasser mode boundary before the undo envelope opens.
  // If the live row shape cannot be bounded, refuse before invoking the action rather than
  // allowing it to mutate linked modes that this writer cannot restore.
  const fastBypasserModes = captureFastBypasserModeTransaction(targetNode, w);
  // #2146 — Fast Bypasser rows do not expose a widget.callback. Their supported UI action is
  // the row's own toggle(value), which mutates the row value and invokes doModeChange().
  // Bridge that canonical action instead of assigning the value and falsely reporting success.
  // The undo hooks are BOOKKEEPING (litegraph history). Invoke them exception-SAFE
  // so a throwing hook can never bypass our verification/rollback and leave a silent
  // partial write; a stateful hook that mutates values is still caught because ALL
  // verification runs AFTER the hook fires.
  const safeBefore = () => {
    try {
      beforeChange?.();
    } catch {
      /* history hook is best-effort */
    }
  };
  const safeAfter = () => {
    try {
      afterChange?.();
    } catch {
      /* history hook is best-effort */
    }
  };

  // Perform the write + callbacks inside ONE undo envelope. A thrown callback is
  // CAPTURED (not rethrown here) so that VERIFICATION runs AFTER afterChange has
  // fired its hooks: an afterChange hook can itself re-stale a widget or change the
  // promotion topology, and that must be caught too (not just callback-time drift).
  let threw = null;
  // #976 (codex NO-SHIP round 2): a captured throw cannot be detected by testing
  // `threw` for truthiness — `throw undefined`, `throw null`, `throw 0`, `throw ""`
  // are all legal, and a callback that did any of them produced NO disclosure at all:
  // the write reported clean while its side effects had not run. Pre-existing, and it
  // silently defeats the whole attribution, so it is fixed here.
  let didThrow = false;
  // #976: TRUE when the throw arose from this write's INVOCATION of the widget's own
  // callback — including a callback that could not be invoked at all. It is the one
  // step in this envelope whose throw the mechanism can attribute, and only because
  // the lookup and the argument evaluation are hoisted out of it below (see the note
  // there). Everything else stays unattributed, exactly as #639 requires.
  //
  // It does NOT establish that the callback's BODY ran: a non-callable value, a class
  // constructor, a revoked Proxy and a throwing `apply` trap all throw at the
  // invocation without entering any body (codex NO-SHIP round 2). The wording below is
  // written to be true of all of them, and never says the callback executed.
  let threwFromCallback = false;
  // Captured at lookup so the disclosure can describe it WITHOUT reading `w.callback`
  // a second time (it may be an accessor with side effects, or a throwing one).
  let widgetCallback = null;
  safeBefore();
  try {
    // Assign BOTH values first — EXCEPT on an instance-scoped promoted write, where
    // the inner widget is not a second copy of this value but the SHARED SUBGRAPH
    // DEFINITION every sibling instance reads (comfyui-mcp#1707). There the rail IS
    // the store, so assigning the inner widget would not make this write land — it
    // would only broadcast it to wrappers the caller never addressed.
    //
    // On the definition-scoped path (a frontend that gives the host input no
    // per-instance key) nothing changes: the parent's projected promoted widget is a
    // VIEW of the inner widget; its own callback typically FORWARDS to the inner one,
    // so we fire the SEMANTIC widget callback exactly ONCE (the inner target's), NOT
    // the rail's — otherwise a forwarding view would double-invoke the side effect.
    // The rail's value serializes directly from `parentWidget.value`, which we set
    // here, so it needs no callback of its own.
    if (!instanceScoped) {
      if (fastBypasserAction) {
        Reflect.apply(fastBypasserAction.toggle, valueWidget, [fastBypasserAction.requested]);
      } else {
        w.value = coerced;
      }
    }
    if (parentWidget) parentWidget.value = coerced;
    // #477: sync the parent-facing DISPLAY proxies too. They are VIEWS of the same
    // promoted value (no semantic callback of their own — the inner target's fires
    // once below), so we assign their value directly, same as the rail.
    for (const dw of displayWidgets) dw.value = coerced;
    // #1268 / comfyui-mcp#1658 — drive the BOUND PROPERTY, in litegraph's own position:
    // `BaseWidget.setValue` assigns the widget, then calls `node.setProperty(...)`, then
    // fires the callback. Placed here so a programmatic write leaves the node in the SAME
    // state an on-canvas edit leaves it in — rather than in the half-updated state that
    // reads back clean and is overwritten by the node's next `setProperty`.
    //
    // Inside the SAME undo envelope as the value assignments, so this cannot land while
    // the widget write rolls back.
    //
    // WHAT THE COPY-BACK COSTS, stated rather than waved at. `setProperty`'s last step
    // assigns the value into the bound widget. On a plain data-property widget that is a
    // no-op — `w.value` already holds `coerced`. On a widget whose `value` is an ACCESSOR
    // (ComfyUI's DOM widgets are: `set value(v) { options.setValue?.(v); callback?.(…) }`)
    // it runs that setter a second time, so a bound DOM widget's callback fires once more
    // than it would for an unbound one. That is not a regression introduced here: it is
    // exactly what `BaseWidget.setValue` does on an on-canvas edit of the same widget —
    // assign, `setProperty`, then the callback. Matching the interactive path is the whole
    // point, and the alternative (assigning `properties` and invoking `onPropertyChanged`
    // by hand) would skip a `setProperty` a pack has overridden.
    //
    // A throw from here is captured by the same catch as everything else in this envelope
    // and stays UNATTRIBUTED — `onPropertyChanged` is a node's own code and this is not
    // the widget-callback invocation #976 can name.
    if (boundProperty?.reachable) {
      try {
        valueNode.setProperty(boundProperty.property, coerced);
      } catch (err) {
        // #1735: Impact Pack's accessor-backed BooleanWidget can throw after the
        // property and widget already hold the requested value, when setProperty's
        // normal copy-back invokes its setter a second time. Continue into the same
        // callback path only for that exact, verified shape; the read-back below still
        // fails closed if either store did not actually take the value.
        if (!isRecoverableBooleanAccessorDelete(valueWidget, expected, err)) throw err;
      }
    }
    // Fire the WRITTEN widget's own callback so combo/number side effects run — the
    // same single invocation a manual UI edit of the promoted control performs.
    //
    // comfyui-mcp#1707: on an instance-scoped promoted write that is the RAIL's
    // callback on the WRAPPER, not the inner definition widget's. This is not a
    // preference — it is the only coherent choice once the definition is left alone:
    // invoking the inner node's callback would announce a new value for a widget
    // whose value did not change, and would run that shared node's side effects for
    // an edit made on ONE instance. It is also what the UI does, for the same reason:
    // a canvas edit of a promoted control runs the projection's callback (which
    // writes the store) and never reaches the inner widget's.
    //
    // #976: the flagged span contains the INVOCATION and nothing else, because the
    // flag is an attribution and an attribution that can be raised by anything but
    // the callback body is a lie. Hoisted out of it, in order:
    //   - the `valueWidget.callback` LOOKUP: it may be a throwing accessor, which is
    //     not the callback failing (it never ran)
    //   - the ARGUMENTS, including `valueNode.pos`, which may be a throwing getter
    //   - and they are built INSIDE the nullish guard, because the original
    //     `w.callback?.(…)` short-circuited: with no callback, `pos` was never read,
    //     and a node with a throwing `pos` getter and no callback must keep the clean
    //     verified write it had (codex NO-SHIP round 1)
    //
    // `Reflect.apply` rather than `widgetCallback.call(…)`: `.call` is a property read
    // ON the callback, so a poisoned getter or a Proxy `get` trap could throw INSIDE
    // the flagged span without the callback running — and, worse, a non-callable
    // `{ call() {} }` would have been INVOKED through its own `.call` method and
    // reported as a clean write, where the optional-call form correctly threw
    // (codex NO-SHIP round 1). Reflect.apply checks callability first, so a
    // non-callable callback still throws a TypeError exactly as before, and it takes
    // the argument list without spreading — no `Symbol.iterator` to poison either.
    // `reflectApply` is captured at module load for the same reason.
    if (!fastBypasserAction) {
      widgetCallback = valueWidget.callback;
      if (widgetCallback !== null && widgetCallback !== undefined) {
        const callbackArgs = [coerced, canvas, valueNode, valueNode.pos, undefined];
        threwFromCallback = true;
        reflectApply(widgetCallback, valueWidget, callbackArgs);
        threwFromCallback = false; // reached only when it RETURNED — a throw leaves it set
      }
    }
    // #1533 — AFTER the callback, still inside this envelope so afterChange
    // captures the restored number. A VHSINT missing-step snap stores NaN (and a
    // Vue setter may coerce that to null); neither is a retained INT value.
    restoreFiniteNumberIfUnstored(valueWidget, expected);
    if (parentWidget) restoreFiniteNumberIfUnstored(parentWidget, expected);
    for (const dw of displayWidgets) restoreFiniteNumberIfUnstored(dw, expected);
  } catch (err) {
    // #639 (codex round-3 + delta-gate): WHICH construct threw is not recorded for
    // anything but the callback invocation — a value setter can invoke the callback
    // itself, `w.callback` can be a throwing accessor, a setter can throw before OR
    // after applying, a rail/proxy setter or a `targetNode.pos` getter can throw,
    // and a write to a frozen widget throws with no user code at all. For every one
    // of those `threwFromCallback` is FALSE and the disclosure names no construct,
    // unchanged. #976 adds the single case the mechanism CAN establish: the throw
    // arose from this write's invocation of the widget's own callback.
    didThrow = true;
    threw = err;
  } finally {
    safeAfter();
  }

  // VERIFY AFTER afterChange. Compute the failure reason (if any) WITHOUT mutating,
  // so rollback happens in its own envelope below. Order: a value that did not stick
  // on the inner (#240) or the authoritative rail (#366); then a promotion-
  // relationship change (re-resolved from the LIVE graph, catching an outer link, a
  // replaced/detached host input, or a re-pointed slot→widget map).
  //
  // #639: a THROWN callback is deliberately NOT a verdict in this chain. The value
  // assignments above run BEFORE the callback fires, so when the callback throws the
  // write may ALREADY be in effect — #976's MiniMaxH3Director `duration` write was
  // verified present by read-back while its callback's throw was still reported.
  // (An earlier draft of this note claimed that callback throws on ANY programmatic
  // invocation; that was never measured — the only repro was a synthetic probe on a
  // stock node — and the installed pack version has no `duration` widget at all, so
  // the claim is withdrawn. `write_warning_frame` now carries the evidence instead.)
  // Rolling a VERIFIED write back and refusing would report failure for work that
  // succeeded and invite a destructive retry — so the structural checks below
  // decide. A throw on a verified write is DISCLOSED on the success result
  // (`write_warning`); only a write that ALSO fails verification fails + rolls
  // back, with the throw named as the likely cause.
  let failure = null;
  let originalErr = null;
  let driftFailure = false;
  let writeWarning = null;
  let threwFrame = null;
  // #1268 — read the bound property TOTALLY. It is ordinary node state on every real
  // node, but `properties` can be swapped for a Proxy or the key defined as a throwing
  // accessor by a callback that ran inside the envelope above, and a verification that
  // throws would escape past the rollback with the write left applied. A read that could
  // not be taken yields a sentinel that matches nothing, so the write fails CLOSED and
  // rolls back rather than being reported as verified.
  const UNREADABLE_PROPERTY = Symbol("bound property unreadable");
  const readBoundProperty = () => {
    if (!boundProperty) return UNREADABLE_PROPERTY;
    try {
      const props = valueNode.properties;
      if (!props || typeof props !== "object") return UNREADABLE_PROPERTY;
      return props[boundProperty.property];
    } catch {
      return UNREADABLE_PROPERTY;
    }
  };
  // Read ONCE, after the envelope closed. Two reads of a stateful accessor can disagree,
  // and the verdict and the message it prints must be the same observation.
  const boundPropertyActual = boundProperty?.reachable ? readBoundProperty() : undefined;
  // #805 — a value the widget's OWN declared grid explains is NORMALIZATION, not a
  // failed write. `matchesExpected` is a strict equality, so a numeric widget doing
  // exactly its job (min 1 / step 2 snaps 4096 -> 4097) was reported as "did not
  // retain the requested value" for a mutation that had APPLIED. Worse than merely
  // wrong: the natural response to "did not retain" is a retry, and the retry
  // normalizes identically forever.
  //
  // Only an EXACTLY reproducible snap counts. If the config does not explain the
  // observed value, this stays the failure it was — no tolerance, because a
  // tolerance would eventually swallow a real revert that landed nearby.
  const normalization = matchesExpected(valueWidget.value)
    ? null
    : explainNumericNormalization(expected, valueWidget.value, valueWidget);
  // comfyui-mcp#1707 — the SHARED DEFINITION must be exactly as it was.
  //
  // This is the check that makes the scope classification safe rather than merely
  // hopeful. `promotedValueScope` reads the frontend's own store key and concludes
  // the rail is this wrapper's alone; if that plumbing is not what this frontend
  // actually does — a rail that still forwards to the inner widget — the inner value
  // moves, and the write silently becomes the cross-instance write this change
  // exists to stop. Observed, not assumed: a definition that moved is a FAILURE, so
  // the write rolls back and says so instead of reporting an instance-scoped write it
  // did not perform. Compared structurally against the pre-mutation clone, so a
  // callback mutating a captured object in place is caught too.
  const definitionMoved = instanceScoped && !structurallyEqual(w.value, previousClone);
  if (!matchesExpected(valueWidget.value) && !normalization) {
    failure =
      `Widget "${valueWidget.name}" on node ${valueNode.id} (${valueNode.type}) did not retain the ` +
      `requested value: wrote ${JSON.stringify(expected)} but it became ${JSON.stringify(valueWidget.value)}.` +
      // #698 — "did not retain" reads as a transient failure worth retrying. For a
      // non-value-bearing DOM widget it is STRUCTURAL: the widget is a view, its
      // real state lives on the node, and no number of retries will change that.
      // Appended ONLY here, in the branch where the revert has already been
      // OBSERVED — so this can never turn into a pre-emptive refusal of a widget
      // that would have worked. Diagnosis, never a gate.
      describeNonValueBearingWidget(valueWidget, valueNode);
  } else if (definitionMoved) {
    // comfyui-mcp#1707 — the rail took the value AND the shared definition moved, so
    // the two are not independent after all and this write did reach every sibling
    // instance. Reported as a failure and rolled back: the alternative is a success
    // result whose `value_scope: "instance"` would be false, which is the exact class
    // of claim this change exists to remove.
    failure =
      `Promoted widget "${valueWidget.name}" on subgraph node ${node.id} is backed by a ` +
      `per-instance value store (widgetId ${JSON.stringify(promotedHostWidgetId)}), but writing it ` +
      `ALSO changed the shared subgraph definition's inner widget "${w.name}" on node ` +
      `${targetNode.id} (${JSON.stringify(previous)} → ${JSON.stringify(w.value)}). That value is ` +
      `read by every other instance of this subgraph, so the write is not scoped to the ` +
      `instance it was addressed to. Rolled back rather than report an instance-scoped write ` +
      `that was not one (comfyui-mcp#1707).`;
  } else if (boundProperty?.reachable && !matchesExpected(boundPropertyActual)) {
    // #1268 / comfyui-mcp#1658 — the widget kept the value and the node's own bound
    // property did NOT. This is the read the old verification never took: `w.value` came
    // back equal to what was assigned to it two statements earlier, which is true whether
    // or not the write reached anything the node reads.
    //
    // Compared against `expected` — the value that was WRITTEN to the property — and not
    // against `w.value`. That distinction is what keeps a legitimate write passing: when a
    // widget callback normalizes `w.value` (a numeric grid snapping 4096 to 4097, #805),
    // the property still holds 4096 and the two stores diverge, but an ON-CANVAS edit
    // leaves them diverged in exactly the same way — litegraph's `BaseWidget.setValue`
    // calls `setProperty` BEFORE the callback runs. Failing there would refuse a write the
    // UI itself performs. What this branch catches is the property not holding what was
    // written to it at all: `onPropertyChanged` returning false, which litegraph documents
    // as the abort signal and honours by restoring the previous value.
    failure = boundPropertyFailure({
      property: boundProperty.property,
      widgetName: valueWidget.name,
      nodeId: valueNode.id,
      expected,
      actual: boundPropertyActual,
      unreadable: boundPropertyActual === UNREADABLE_PROPERTY,
    });
  } else if (parentWidget && parentWidget !== valueWidget && !matchesExpected(parentWidget.value)) {
    // comfyui-mcp#1707 — `parentWidget !== valueWidget` because on an instance-scoped
    // promoted write the rail IS the widget this write assigned, and the branch above
    // has already verified it — with the #805 normalization allowance this one does not
    // have. Checking it a second time by strict equality would fail a rail that did
    // exactly what a numeric widget is supposed to do, reporting "did not retain" for a
    // write that applied. Nothing is verified less: it is the same object, checked once,
    // by the check that knows about grids.
    failure =
      `Promoted rail widget "${parentWidget.name}" on subgraph node ${node.id} did not retain ` +
      `the requested value: wrote ${JSON.stringify(expected)} but it became ` +
      `${JSON.stringify(parentWidget.value)}. Refusing to report success with a stale rail that ` +
      `would render the OLD value (#366).`;
  } else if (displayWidgets.some((dw) => !matchesExpected(dw.value))) {
    // #477: a parent-facing display proxy did not retain the value. Fail closed +
    // roll back rather than report success while the parent node still shows/queries
    // the OLD value (the exact stale-outer-widget symptom).
    const bad = displayWidgets.find((dw) => !matchesExpected(dw.value));
    failure =
      `Promoted display widget "${bad.name}" on subgraph node ${node.id} did not retain the ` +
      `requested value: wrote ${JSON.stringify(expected)} but it became ${JSON.stringify(bad.value)}. ` +
      `Refusing to report success with a stale parent-facing widget (#477).`;
  } else if (parentWidget) {
    // RE-RESOLVE the promotion from the LIVE graph. This is wrapped so that ANY
    // exception thrown DURING the recheck (e.g. a callback replaced `_subgraphSlot`
    // and the injected resolveSource now THROWS for the replacement) is treated as a
    // topology change and drives the FULL rollback below — a recheck throw must NEVER
    // escape with inner/rail left mutated.
    let recheck = null;
    let recheckThrew = false;
    try {
      recheck = resolvePromotedInnerTarget(node, widgetName, resolveSource);
    } catch {
      recheckThrew = true;
    }
    // #477: the FULL identity-authenticated projection set (rail + display proxies)
    // must be UNCHANGED too. A callback can swap `hostInput.widget` to a NEW live
    // same-named display proxy holding the OLD value while leaving `_widget`, the
    // inner widget, and our CAPTURED old proxy untouched — every rail-only check would
    // pass yet the current outer-facing proxy renders/queries stale. Re-resolve the
    // whole set and identity-compare it (fixed order [_widget, widget]) against what we
    // synced; any membership/identity difference is drift.
    const reWidgets = Array.isArray(recheck?.target?.parentWidgets)
      ? recheck.target.parentWidgets
      : [];
    const capturedWidgets = Array.isArray(promotedParentWidgets) ? promotedParentWidgets : [];
    const projectionSetDrifted =
      reWidgets.length !== capturedWidgets.length ||
      reWidgets.some((rw, i) => rw !== capturedWidgets[i]);
    const drifted =
      recheckThrew ||
      !recheck ||
      !recheck.promoted ||
      !recheck.target ||
      recheck.target.input !== promotedHostInput ||
      recheck.target.widget !== w ||
      recheck.target.parentWidget !== parentWidget ||
      projectionSetDrifted ||
      // The host input's serialization binding (`widgetId`, the store key queue
      // compilation reads) must be UNCHANGED — a swap re-points serialization to a
      // different store entry even though the input/projection objects are identical.
      !Object.is(promotedHostInput ? promotedHostInput.widgetId : undefined, promotedHostWidgetId);
    if (drifted) {
      driftFailure = true;
      failure =
        `Promotion of "${w.name}" on subgraph node ${node.id} CHANGED during the write (a widget ` +
        `or afterChange hook altered the host input, its link, or the slot→widget mapping${
          recheckThrew ? "; re-resolving the promotion threw" : ""
        }), so the rail that was synced is no longer the value that serializes at queue time. Rolled ` +
        `back to avoid a silently-stale render (#366).`;
    }
  }

  // #2146 — a canonical Fast Bypasser action is not a successful widget write unless the
  // action actually changed a reachable linked mode when the requested toggle changed. This
  // catches the old false success path where only the composite row value was assigned.
  if (!failure && fastBypasserAction?.requiresModeChange) {
    const modeChanged = fastBypasserModes?.changed();
    if (modeChanged !== true) {
      failure =
        modeChanged === null
          ? `Fast Bypasser row action changed the toggle, but its linked node modes could not be ` +
            `verified.`
          : `Fast Bypasser row action did not change any linked node modes; refusing to report ` +
            `the toggle as applied.`;
    }
  }

  // #639: reconcile a captured throw with the verification verdict. The write
  // VERIFIED (value + rail + proxies retained, promotion topology intact) — the
  // throw came from applying the write: DISCLOSE it on the success result, never
  // report a clean failure for an applied write. The write did NOT verify — the
  // throw is the likely cause: compose BOTH causes into the failure (codex
  // round-1: a thrown WidgetWriteError saved un-composed discarded the structural
  // detail), keeping the error's retry flags (combo/emptyOptions) through the
  // composition.
  //
  // Attribution (codex rounds 2-3 + delta-gates): only what the mechanism can
  // ESTABLISH is claimed. The write envelope evaluates value setters on the inner,
  // rail, and display proxies, property reads (`w.callback` may be a throwing
  // accessor, `targetNode.pos` a getter), and the callback invocation — and a
  // plain write to a frozen widget throws with NO user code involved. So for all of
  // those the message names NO construct: only that an exception was thrown while
  // applying the write. And read-back verifies only that the requested value IS
  // present — not that THIS write put it there (a frozen widget may already have
  // held it), so the disclosure claims "IS in effect", never "DID take effect".
  // What IS established and claimed: the requested value is present by read-back,
  // and the write's side effects may not have run or completed.
  //
  // #976: the callback INVOCATION is the one construct that is establishable, once
  // its lookup and arguments are hoisted out of it (see the envelope above) — and
  // naming it matters, because the unattributed wording leads with "an exception was
  // thrown while applying the write", which reads as THE PANEL FAILED TO APPLY YOUR
  // WRITE. That is the opposite of what happened, and #976 was filed here as a panel
  // defect because of it.
  //
  // The attributed wording says exactly what the mechanism observed — the exception
  // arose from the INVOCATION step, not from the assignment — and stops there. Three
  // things it deliberately does NOT claim, each a codex NO-SHIP finding on an earlier
  // draft of this text, each right:
  //   * whose code the callback is. A pack, an extension, a prototype or the frontend
  //     itself may have installed it.
  //   * that anyone is at FAULT. This write invokes the callback PROGRAMMATICALLY, and
  //     a callback written for a click can throw for that reason alone (measured on
  //     #757), which would make the throw ours as much as anyone's.
  //   * that the callback's BODY ran. A non-callable value, a class constructor, a
  //     revoked Proxy and a throwing `apply` trap all throw at the invocation without
  //     entering a body. "came from this write's invocation of" is true of every one
  //     of them; "the callback threw" would not be.
  // An attribution that overshoots just relocates the wrong blame.
  if (didThrow) {
    const threwDetail = describeThrown(threw);
    // #976: WHERE the throw surfaced, as scrubbed data — emitted for BOTH the
    // attributed and the unattributed branch, because a stack frame is an
    // observation (unlike `write_warning_source`, it claims nothing about which
    // construct failed). Without it the Error is swallowed inside this lib and the
    // one fact that could route the report — the file the throw came from — is
    // destroyed.
    threwFrame = describeThrownFrame(threw);
    // "ATTEMPT to invoke", uniformly (codex round 3). A class constructor and a
    // revoked Proxy both satisfy `typeof === "function"` and then throw before any
    // body runs, so any wording that says the callback RAN is false for them — and
    // the mechanism cannot tell them from a body that threw. The weaker claim is true
    // of every case, so it is the only one made.
    const threwLabel = threwFromCallback
      ? `an exception came from attempting to invoke the widget's OWN callback while applying the write`
      : `an exception was thrown while applying the write`;
    // Establishable and worth saying when it holds: a value that is not a function
    // cannot have been entered at all. Reads the value CAPTURED at lookup time —
    // never `w.callback` again, which would invoke a throwing accessor a second time.
    const notCallable = threwFromCallback && typeof widgetCallback !== "function";
    if (!failure) {
      writeWarning = threwFromCallback
        ? `the write itself SUCCEEDED: the requested value IS in effect — verified present by ` +
          `read-back — and was NOT rolled back. The exception (${threwDetail}) came from this ` +
          `write's attempt to invoke the widget's own callback, which happens AFTER the value ` +
          `is assigned — the assignment itself did not throw.` +
          (notCallable
            ? // No indefinite article: `typeof` yields "object", where "a object" reads
              // as a bug in the panel — which is the exact impression this whole fix
              // exists to stop giving. Caught in the browser, not by a unit test.
              ` The widget's callback is of type "${typeof widgetCallback}", not a function, so it ` +
              `could not be invoked at all and none of its side effects ran.`
            : ` Side effects that callback would normally perform (refreshing dependent widgets, ` +
              `previews, thumbnails) may not have run or completed; inspect the node if dependents ` +
              `look stale. Note that this write invokes callbacks programmatically, which is by ` +
              `itself enough to make a callback written for a click throw.`)
        : `${threwLabel} (${threwDetail}); the requested value IS in effect — ` +
          `verified present by read-back — and was NOT rolled back. Side effects the write ` +
          `would normally trigger (refreshing dependent widgets, previews, thumbnails) may ` +
          `not have run or completed; inspect the node if dependents look stale.`;
    } else {
      failure = `${threwLabel} (${threwDetail}); ${failure}`;
      // #976 round 3: CLASSIFYING the thrown value can itself throw — a Proxy with a
      // hostile `getPrototypeOf` trap breaks `instanceof`, and hostile `combo` /
      // `emptyOptions` getters break the property reads that follow a successful one.
      // That would escape from the branch whose whole job is to report a failure we
      // ALREADY know, losing it. A thrown value gets to be described and, if it
      // cooperates, classified — never to decide whether we report at all.
      try {
        if (threw instanceof WidgetWriteError) {
          originalErr = new WidgetWriteError(failure, {
            combo: threw.combo,
            emptyOptions: threw.emptyOptions,
          });
        }
      } catch {
        // Composed message stands on its own; the retry flags are simply unavailable.
        originalErr = null;
      }
    }
  }

  if (failure) {
    // ROLL BACK in its OWN (exception-safe) undo envelope. The restore assignments
    // are each guarded, then we READ BACK the FINAL values AFTER the envelope closes
    // — so a setter that throws OR silently ignores the restore, AND a stateful
    // afterChange hook that re-stales the restored value, are ALL detected. `w.value`
    // is a plain data property on real widgets so this normally succeeds; when it
    // does not, we report an HONEST partial-state failure rather than falsely claim
    // a clean rollback.
    //
    // #477 P1: only restore the OUTER widget-list membership when the ORIGINAL host
    // input is STILL wired into node.inputs. If a callback replaced the host input
    // ENTIRELY (a new promotion), restoring node.widgets would DETACH the live
    // replacement while it still serializes via the changed input — masking a genuine
    // partial state. In that case we leave node.widgets and REPORT partial-state below.
    const hostStillWired =
      !!promotedHostInput && Array.isArray(node.inputs) && node.inputs.includes(promotedHostInput);
    safeBefore();
    try {
      // Restore the serialization BINDING + the promotion TOPOLOGY first (the store key
      // queue compilation reads, and the projection references the outer node exposes),
      // so restoring the rail value below lands on the entry that actually serializes and
      // the original proxies are re-wired — a callback may have re-pointed the store entry
      // OR swapped in a replacement proxy (#366/#477).
      if (promotedHostInput) {
        try {
          promotedHostInput.widgetId = promotedHostWidgetId;
        } catch {
          /* restore best-effort; read-back below is authoritative */
        }
        try {
          promotedHostInput.widget = promotedHostWidgetRef;
        } catch {
          /* restore best-effort; read-back below is authoritative */
        }
        try {
          promotedHostInput._widget = promotedHostProjectionRef;
        } catch {
          /* restore best-effort; read-back below is authoritative */
        }
      }
      // #477 P1: restore the OUTER node's widget-list membership/order — undo any
      // replacement/reorder a callback did, so a detached captured proxy is re-attached
      // and a swapped-in replacement is dropped. ONLY when the original host input is
      // still wired (else a wholesale-replaced promotion is left for partial-state
      // reporting rather than masked) — and only when the node KEEPS one array.
      //
      // On a real SubgraphNode the list is rebuilt per read from `node.inputs`:
      // refilling the array a read handed out mutates a throwaway, and the assignment
      // is swallowed by a no-op setter, so this would be theatre. Its members follow
      // `inputs` / `hostInput.widget` / `hostInput._widget`, which the block above has
      // already restored; the by-value read-back below judges whether that landed.
      if (prevOuterWidgetsRef && prevOuterWidgetsIdentityStable && hostStillWired) {
        try {
          prevOuterWidgetsRef.length = 0;
          for (const wd of prevOuterWidgets) prevOuterWidgetsRef.push(wd);
          if (node.widgets !== prevOuterWidgetsRef) node.widgets = prevOuterWidgetsRef;
        } catch {
          /* restore best-effort; read-back below is authoritative */
        }
      }
      // #1268 — restore the BOUND PROPERTY before the widget values, through the same
      // `setProperty` litegraph uses, so the node's own `onPropertyChanged` sees the
      // rollback the way it sees any other property change. Its last step copies the
      // restored value into the bound widget, and `w.value = previous` follows, so the
      // widget ends on its own captured value either way.
      if (boundProperty?.reachable) {
        try {
          valueNode.setProperty(boundProperty.property, boundProperty.previous);
        } catch {
          /* restore best-effort; read-back below is authoritative */
        }
      }
      // comfyui-mcp#1707 — restore the inner definition widget only when this write
      // could have moved it: it was written (the definition-scoped path), or it moved
      // anyway (the instance-scoped path's own failure branch above). An instance-scoped
      // write that left it alone must not assign it here either — the assignment is a
      // no-op for a plain widget but a side effect for a DOM one, and rolling back a
      // write this path never made is exactly the shared-definition touch it avoided.
      // The read-back below still compares it against the captured clone either way.
      if (!instanceScoped || definitionMoved) {
        try {
          w.value = previous;
        } catch {
          /* restore best-effort; read-back below is authoritative */
        }
      }
      if (parentWidget) {
        try {
          parentWidget.value = previousParent;
        } catch {
          /* restore best-effort; read-back below is authoritative */
        }
      }
      // #477: restore the secondary display proxies too, so no proxy is left holding
      // the just-written value after a failed write.
      for (let i = 0; i < displayWidgets.length; i++) {
        try {
          displayWidgets[i].value = previousDisplays[i];
        } catch {
          /* restore best-effort; read-back below is authoritative */
        }
      }
      // #2146 — restore the Fast Bypasser's group/repeater mode journal inside the same
      // rollback envelope. Repeater setters may themselves propagate to linked nodes, so the
      // journal restores the roots first and then verifies every captured primitive mode below.
      fastBypasserModes?.restore();
    } finally {
      safeAfter();
    }
    // Authoritative read-back AFTER the rollback envelope, compared STRUCTURALLY
    // against the pre-mutation deep clones — so a setter that throws or silently
    // ignores the restore, AND a stateful afterChange hook that mutates the restored
    // object IN PLACE (which an identity compare would miss), are ALL detected.
    let rollbackFailed = null;
    if (!structurallyEqual(w.value, previousClone)) rollbackFailed = `inner "${w.name}"`;
    // #1268 — the bound property must be back to its captured value too. A node whose
    // `onPropertyChanged` refuses the write ALSO refuses the restore, which leaves the
    // node holding a value neither the caller nor the previous state asked for; that is
    // an honest partial state and is reported as one rather than hidden behind a clean
    // rollback. Compared structurally against the pre-mutation clone, exactly as the
    // widget values are, so a hook mutating a restored object in place is caught.
    if (boundProperty?.reachable) {
      const restored = readBoundProperty();
      if (restored === UNREADABLE_PROPERTY || !structurallyEqual(restored, previousPropertyClone)) {
        const label = `bound property "${boundProperty.property}"`;
        rollbackFailed = rollbackFailed ? `${rollbackFailed} and ${label}` : label;
      }
    }
    if (parentWidget && !structurallyEqual(parentWidget.value, previousParentClone)) {
      rollbackFailed = rollbackFailed
        ? `${rollbackFailed} and rail "${parentWidget.name}"`
        : `rail "${parentWidget.name}"`;
    }
    // #477: a display proxy whose rollback did not take effect is an honest partial
    // state too — report it rather than falsely claim a clean rollback.
    for (let i = 0; i < displayWidgets.length; i++) {
      if (!structurallyEqual(displayWidgets[i].value, previousDisplayClones[i])) {
        const label = `display "${displayWidgets[i].name}"`;
        rollbackFailed = rollbackFailed ? `${rollbackFailed} and ${label}` : label;
      }
    }
    const unrestoredFastModes = fastBypasserModes?.unrestored() ?? [];
    if (unrestoredFastModes.length) {
      const label = `Fast Bypasser linked node modes (${unrestoredFastModes.length} node(s))`;
      rollbackFailed = rollbackFailed ? `${rollbackFailed} and ${label}` : label;
    }
    // The serialization binding must be back to its original store key, else queue
    // compilation still reads whatever entry a callback re-pointed it to.
    if (promotedHostInput && !Object.is(promotedHostInput.widgetId, promotedHostWidgetId)) {
      rollbackFailed = rollbackFailed
        ? `${rollbackFailed} and the serialization binding (widgetId)`
        : `the serialization binding (widgetId)`;
    }
    // #477: the promotion TOPOLOGY (the host input's projection references) must be back
    // to the originals too, else a callback-swapped replacement proxy stays wired to the
    // outer node after a supposedly-clean rollback.
    if (promotedHostInput && !Object.is(promotedHostInput.widget, promotedHostWidgetRef)) {
      rollbackFailed = rollbackFailed
        ? `${rollbackFailed} and the promotion topology (host input.widget)`
        : `the promotion topology (host input.widget)`;
    }
    if (promotedHostInput && !Object.is(promotedHostInput._widget, promotedHostProjectionRef)) {
      rollbackFailed = rollbackFailed
        ? `${rollbackFailed} and the promotion topology (host input._widget)`
        : `the promotion topology (host input._widget)`;
    }
    // #477 P1: after rollback the OUTER promotion topology must be EXACTLY intact.
    // node.widgets must be the SAME array reference AND hold the SAME members in the
    // SAME order as the pre-write snapshot — so a stateful afterChange that RE-ADDS a
    // replacement proxy (leaving the captured members present but adding an extra/
    // reordered one), a replaced array, or an in-place push are ALL surfaced as partial
    // state, never a falsely-clean rollback. The LIVE host input must also still be the
    // captured one (a replaced input — even one referencing the same proxies but a
    // different widgetId — serializes differently). This holds whether or not the gated
    // restore above ran.
    if (promotedFrom) {
      // Read the list ONCE: a projected `widgets` rebuilds on every access, so four
      // reads would compare four different arrays.
      let liveOuterWidgets;
      let outerWidgetsReadable = true;
      try {
        liveOuterWidgets = node.widgets;
      } catch {
        // A list we cannot read is a list we cannot clear. Report the partial state —
        // and, just as importantly, keep the throw from escaping and replacing the
        // WidgetWriteError that explains why the write failed with a bare TypeError.
        outerWidgetsReadable = false;
      }
      const listExact =
        prevOuterWidgets == null ||
        (outerWidgetsReadable &&
          // A `widgets` that swapped KIND between snapshot and read-back has been cut
          // off from what feeds it — a rebuilt list frozen into a plain array no
          // longer tracks `node.inputs`. That is outer-topology drift in its own
          // right, and catching it is what stops the relaxed identity rule below from
          // being a door: a list cannot buy its exemption after the fact.
          widgetsListHasStableIdentity(node) === prevOuterWidgetsIdentityStable &&
          Array.isArray(liveOuterWidgets) &&
          // Array identity is evidence only for a list the node KEEPS. A rebuilt one
          // hands out a FRESH array per read, so this compare could only ever fail —
          // which is how a PERFECT rollback on a subgraph node came to be reported as
          // a partial state. Membership/order below is the real #477 P1 check: a
          // replaced or reordered list, an added proxy, or a dropped rail all still
          // fail it, because each member is compared by the same object identity that
          // authenticates a rail (and the frontend memoises each projected proxy onto
          // `input._widget`, so those identities are stable across reads).
          (!prevOuterWidgetsIdentityStable || liveOuterWidgets === prevOuterWidgetsRef) &&
          liveOuterWidgets.length === prevOuterWidgets.length &&
          liveOuterWidgets.every((wd, i) => wd === prevOuterWidgets[i]));
      let liveInput = undefined;
      try {
        const live = resolvePromotedInnerTarget(node, widgetName, resolveSource);
        if (live && live.target) liveInput = live.target.input;
      } catch {
        liveInput = undefined;
      }
      const inputReplaced = promotedHostInput != null && liveInput !== promotedHostInput;
      if (!listExact || inputReplaced) {
        rollbackFailed = rollbackFailed
          ? `${rollbackFailed} and the promotion host input / parent widget list (node.inputs/widgets)`
          : `the promotion host input / parent widget list (node.inputs/widgets)`;
      }
    }
    // On a TOPOLOGY DRIFT, the captured `parentWidget` we just restored may be
    // DETACHED — a callback could have swapped in a DIFFERENT live authoritative
    // rail. Restoring the old rail does not touch that replacement, so if the LIVE
    // promotion now resolves to a different rail that holds the just-written value,
    // the serialized value is NOT what our rollback restored: report a PARTIAL STATE
    // rather than falsely claim a clean rollback.
    if (driftFailure) {
      let liveRail = null;
      let liveWidgets = [];
      try {
        const live = resolvePromotedInnerTarget(node, widgetName, resolveSource);
        liveRail = live && live.target ? live.target.parentWidget : null;
        liveWidgets =
          live && live.target && Array.isArray(live.target.parentWidgets)
            ? live.target.parentWidgets
            : [];
      } catch {
        liveRail = null;
        liveWidgets = [];
      }
      if (liveRail && liveRail !== parentWidget && structurallyEqual(liveRail.value, expected)) {
        rollbackFailed = rollbackFailed
          ? `${rollbackFailed} and a live replacement rail "${liveRail.name}"`
          : `a live replacement rail "${liveRail.name}"`;
      }
      // #477: a callback could also have swapped in a NEW live DISPLAY PROXY (a member
      // of the freshly-resolved set that was NOT in our captured set) holding the
      // just-written value. Restoring our captured proxies does not touch it — so if
      // any such replacement still carries `expected`, report a PARTIAL STATE rather
      // than falsely claim a clean rollback.
      const capturedSet = Array.isArray(promotedParentWidgets) ? promotedParentWidgets : [];
      for (const lw of liveWidgets) {
        if (lw && lw !== liveRail && !capturedSet.includes(lw) && structurallyEqual(lw.value, expected)) {
          rollbackFailed = rollbackFailed
            ? `${rollbackFailed} and a live replacement display proxy "${lw.name}"`
            : `a live replacement display proxy "${lw.name}"`;
        }
      }
    }
    setDirty?.();
    if (rollbackFailed) {
      throw new WidgetWriteError(
        `Widget "${valueWidget.name}" on node ${valueNode.id} (${valueNode.type}) write failed: ${failure} ` +
          `Rollback of ${rollbackFailed} did not take effect (a value setter or history hook ` +
          `rejected/overrode it) — the graph may be in a partial state; re-set the widget or undo.`,
        // The one WidgetWriteError raised AFTER the graph was mutated and NOT cleanly
        // restored. Marked so no caller can reword it into a "refused, nothing applied"
        // frame — see the flag's declaration.
        { partialWrite: true },
      );
    }
    // Rollback succeeded: preserve the original WidgetWriteError message where there
    // was one, else throw the computed failure.
    if (originalErr) throw originalErr;
    throw new WidgetWriteError(failure);
  }

  setDirty?.();

  // #1519 — FIRE THE NODE-LEVEL HOOK, here and nowhere else.
  //
  // `node.onWidgetChanged(name, value, prevValue, widget)` is the litegraph hook a pack
  // patches onto a node TYPE (in `beforeRegisterNodeDef`) to rebuild slot topology from
  // a widget. It is not the widget's own callback and a pack cannot use the callback
  // instead — the callback lives on a widget the rebuild replaces. The frontend fires
  // both, in this order, on every interactive edit; this file fired only the callback,
  // so a programmatic write left such a node holding the NEW widget value and its OLD
  // slots, silently. See lib/node-widget-changed.js for the frontend call sites this
  // reproduces and the reported `SWF_Subworkflow` case.
  //
  // PLACED AFTER THE VERIFICATION VERDICT, which is the whole of the ordering question
  // the report raised. Every failure path above has already rolled back and THROWN by
  // the time control reaches here, so the hook cannot run for a write that did not
  // stick — a pack rebuilt against a value that was subsequently restored is the one
  // outcome worse than the stale slots this fixes. Nothing in the rollback machinery is
  // touched; this is reachable only from the success path.
  //
  // FIRED ONCE, on the node/widget pair whose callback this write fired — `valueNode`
  // and `valueWidget`, which on an instance-scoped promoted write are the wrapper and
  // its rail, and otherwise the concrete target. Announcing the change a second time
  // for the other end of a promotion would report a change for a widget whose value
  // did not move, which is the same reasoning the callback note above records.
  //
  // ARGUMENTS: the VERIFIED value read back off the widget, not `coerced`. Where a
  // widget's own grid normalized the write (#805) the two differ, and handing a pack a
  // value the widget does not hold is how a rebuild lands on state nothing agrees with.
  // For every write that did not normalize they are identical. `previousForHook` is
  // that same widget's own prior value, never the other end of the promotion's.
  //
  // Unlike the frontend's `BaseWidget.setValue`, this is NOT gated on the value having
  // changed. The gate does not exist for the callback invocation above either, and
  // adding one only here would make re-issuing the same `panel_set_widget` — the
  // obvious way a caller recovers from exactly this bug — a silent no-op.
  //
  // It NEVER decides this write's verdict: a throwing hook is disclosed on the success
  // result, the same containment the widget callback and #1282's refresh press get.
  const verifiedValue = valueWidget.value;
  const verifiedName = valueWidget.name;
  const previousForHook = instanceScoped ? previousParent : previous;
  const widgetChanged = fireNodeWidgetChanged(valueNode, valueWidget, {
    name: verifiedName,
    value: verifiedValue,
    previous: previousForHook,
    beforeChange,
    afterChange,
    setDirty,
  });

  // On success, a promoted write has ALWAYS synced the authoritative parent rail
  // widget (verified AFTER afterChange, or it would have rolled back + thrown).
  // parent_widget_synced is reported for observability / defense-in-depth in the
  // panel summary. display_widgets_synced counts the additional parent-facing display
  // proxies also synced so the outer node no longer shows a stale value (#477).
  // #639: write_warning discloses a widget callback that threw AFTER the verified
  // write landed — the value IS in effect, its side effects are uncertain.
  // #976: `write_warning_source` carries the attribution as DATA, so a caller does not
  // have to pattern-match prose to render it. Present ONLY for the establishable case;
  // its absence means "not attributable", never "the panel's fault".
  // comfyui-mcp#1707 — `node_id`/`widget`/`value` name the widget this write ACTUALLY
  // assigned. For an instance-scoped promoted write that is the wrapper the caller
  // addressed and its promoted widget — not the inner definition widget, which this
  // path deliberately leaves untouched, and which the panel's own activity line would
  // otherwise announce as "Set width = 1024 on node 54" for a node whose value did not
  // change. Provenance is not lost: `promoted_from.inner_node_id` still names the inner
  // node and `inner_previous` still reports its (unchanged) value. Every definition-scoped
  // and non-promoted write reports exactly the fields it always did.
  // #1519 — `widget`/`value` are the captures taken BEFORE the node hook fired, not a
  // fresh read. They are what the verification above ESTABLISHED, and a hook that
  // rebuilds a node can replace the widget object or move its value; reporting a
  // post-hook read would put a value in the reply that nothing verified. With no hook
  // (every stock node) the captures are the same reads this returned before.
  return {
    node_id: valueNode.id,
    widget: verifiedName,
    previous: parentWidget ? previousParent : previous,
    value: verifiedValue,
    // #1126 — the COERCION-TIME verdict, so the caller reports WHAT HAPPENED instead of
    // inferring it from the rejection that led here. `options.values` is a callback and
    // can answer differently per call: the final attempt may well have been admitted by
    // ordinary membership after the list became readable, and claiming an unvalidated
    // write then would be false. Set ONLY when the unreadable-list acceptance is what
    // admitted the value — same never-read-twice discipline `emptyAcceptanceUsed` follows.
    ...(coerceOutcome.unreadableAcceptanceUsed
      ? {
          option_list_unreadable: true,
          // WHICH observation, verbatim from the read that decided it — so the reply
          // states the reason instead of a plausible-sounding default.
          option_list_unreadable_detail: coerceOutcome.unreadableObservation,
          // #1126 — and whether the AUTHORITATIVE parent rail's real list nonetheless
          // vouched for the value. Emitted only when it is TRUE, so a reader that does not
          // know the field sees exactly what it saw before, and the disclosure never claims
          // a check that did not happen. The cross-check above is what establishes it, and
          // only a match on the serializing rail counts — never a #477 display proxy.
          ...(railValidated ? { promoted_rail_validated: true } : {}),
        }
      : {}),
    // #1268 / comfyui-mcp#1658 — WHAT THE VERIFICATION ACTUALLY ESTABLISHED for a widget
    // litegraph binds to one of its node's own properties. Two mutually exclusive shapes,
    // and the second is the whole point of this pair of issues:
    //
    //   bound_property             the property was driven with `setProperty` and READ BACK
    //                              holding the written value. The effect is established, not
    //                              just the assignment.
    //   bound_property_unverified  the node declares the property but exposes no way to
    //                              drive or read it from here. The widget's stored value was
    //                              verified and the value the NODE reads was not — reported
    //                              as UNKNOWN on a successful write, because "success" for a
    //                              value that may be about to be replaced is the false claim
    //                              both reporters received, and a refusal would block writes
    //                              that are very likely fine.
    //
    // Neither field appears for a widget with no `options.property`, which is every stock
    // ComfyUI widget built from /object_info — those replies are byte-identical to before.
    ...(boundProperty?.reachable
      ? { bound_property: { name: boundProperty.property, previous: boundProperty.previous } }
      : {}),
    ...(boundProperty && !boundProperty.reachable
      ? {
          bound_property_unverified: { name: boundProperty.property, reason: boundProperty.reason },
          bound_property_note: boundPropertyUnverifiedNote({
            property: boundProperty.property,
            widgetName: w.name,
            nodeId: targetNode.id,
            reason: boundProperty.reason,
          }),
        }
      : {}),
    // #507/#1126 — the empty-list acceptance is what admitted the value. Reported here so a
    // caller reaching that acceptance from EITHER ladder branch sees one field with one
    // name, rather than the #507 branch alone naming it at the runSetWidget level.
    ...(coerceOutcome.emptyAcceptanceUsed ? { empty_option_list: true } : {}),
    // #1519 — what the node's own onWidgetChanged hook did, as DATA. Both fields are
    // emitted ONLY on an OBSERVATION, so every node without the hook — which is every
    // stock ComfyUI node — replies byte-identically to before:
    //
    //   widget_changed_slots        the hook rebuilt the node's slots synchronously;
    //                               these are the input/output names AFTER it, so the
    //                               caller can wire the node without a re-read.
    //   widget_changed_hook_failed  attempting to invoke the hook threw. The WRITE is
    //                               unaffected — it is verified and was not rolled back
    //                               — but the state the hook rebuilds may be stale or
    //                               partially rebuilt, and that is stated rather than
    //                               left for a later `panel_connect` to discover.
    //
    // A hook that ran and changed no slots reports NOTHING, because a pack that rebuilds
    // from a `fetch` (the reported `SWF_Subworkflow` does) resolves after this returns:
    // a synchronous snapshot showing no change means "not yet", not "nothing happened".
    ...(widgetChanged?.changed ? { widget_changed_slots: widgetChanged.changed } : {}),
    ...(widgetChanged?.failed ? { widget_changed_hook_failed: widgetChanged.failed } : {}),
    ...(writeWarning
      ? {
          write_warning: writeWarning,
          ...(threwFromCallback ? { write_warning_source: "widget_callback" } : {}),
          // #976: the innermost non-panel stack frame, scrubbed of origin — present
          // whenever the throw cooperated, on either attribution branch. Its absence
          // means "no readable stack", never "no throw".
          ...(threwFrame ? { write_warning_frame: threwFrame } : {}),
        }
      : {}),
    // #805 — the write applied and the node quantized it. Report BOTH values so the
    // caller can carry the stored one forward instead of retrying the request.
    ...(normalization
      ? {
          normalized: true,
          requested_value: expected,
          normalization_rule: normalization.rule,
          normalization_note: normalizationNote({
            // #1519 — the same pre-hook captures the verdict was computed from, so the
            // note cannot describe a value the normalization check never saw.
            name: verifiedName,
            requested: expected,
            actual: verifiedValue,
            rule: normalization.rule,
          }),
        }
      : {}),
    ...(promotedFrom
      ? {
          inner_previous: previous,
          promoted_from: {
            ...promotedFrom,
            parent_widget_synced: parentWidget != null,
            ...(displayWidgets.length ? { display_widgets_synced: displayWidgets.length } : {}),
            // comfyui-mcp#1707 — WHOSE value this changed, as DATA rather than something
            // a caller has to infer from the shape of the reply:
            //
            //   "instance"            the wrapper's own promoted-value store entry was
            //                         written and the shared subgraph definition was
            //                         verified UNCHANGED, so sibling instances of the same
            //                         subgraph keep their own values.
            //   "subgraph_definition" this frontend exposes no per-instance store for this
            //                         promoted widget, so the value was written into the
            //                         subgraph DEFINITION's inner widget — which every
            //                         instance of this subgraph reads.
            //
            // Always present on a promoted write, so "the field is missing" can never be
            // read as either verdict, and never emitted for a write that took the other
            // path — the failure branch above rolls back rather than let "instance" stand
            // for a write that moved the definition.
            value_scope: valueScope,
            // #1492 — the side effects this write did NOT run, stated as DATA next to
            // the scope decision that caused it. Emitted ONLY when a callback was
            // actually observed on the shared inner widget (or could not be read at
            // all): an instance-scoped write of a plain stock widget skipped nothing,
            // and an unconditional flag there would train a caller to ignore the one
            // case that matters. Every definition-scoped, non-promoted and
            // callback-free reply is byte-identical to what it always was.
            ...(innerCallbackSkipped
              ? {
                  inner_callback_not_invoked: true,
                  inner_callback_note: innerCallbackNotInvokedNote({
                    widgetName: w?.name,
                    innerNodeId: targetNode?.id,
                    innerNodeType: targetNode?.type,
                    innerValue: previous,
                    subgraphNodeId: node?.id,
                    unreadable: innerCallbackUnreadable,
                  }),
                }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * #1492 — say what an instance-scoped promoted write left undone, and what to do about it.
 *
 * The value itself IS in effect: it landed on the wrapper's own promoted-value store,
 * which is what queue compilation reads for an unlinked promoted input. What did not
 * happen is the inner (shared definition) widget's own callback, and a callback that
 * mutates OTHER nodes — a status switch flipping a branch between ACTIVE and BYPASS is
 * the reported one — leaves the graph in a state no field on the old reply described.
 *
 * WORDED FOR WHAT IS ESTABLISHED, not for what is likely:
 *   * "was not invoked" — observed, not inferred: this path never calls it.
 *   * it does NOT claim the callback has side effects. Plenty do nothing but store a
 *     value, and telling every caller their graph is stale would be its own false alarm.
 *   * on the unreadable branch it does not claim a callback EXISTS, because the read
 *     that would have established it threw.
 *
 * The remedy is named because the report's own workaround was to drive the affected
 * nodes by hand and it had to be discovered: `panel_set_node_mode` for a node mode,
 * `panel_enter_subgraph` to look at the inner nodes. Deliberately NOT a refusal — the
 * write is correct and the caller usually wants exactly it.
 */
export function innerCallbackNotInvokedNote({
  widgetName,
  innerNodeId,
  innerNodeType,
  innerValue,
  subgraphNodeId,
  unreadable = false,
} = {}) {
  const inner = `node ${innerNodeId}${innerNodeType ? ` (${innerNodeType})` : ""}`;
  return (
    `The value IS in effect on subgraph node ${subgraphNodeId} — it was written to this ` +
    `instance's own promoted-value store, which is what serializes at queue time. What this ` +
    `write did NOT do is run the shared subgraph definition's inner widget callback: ` +
    `"${widgetName}" on ${inner} still holds ${JSON.stringify(innerValue)} and its own callback ` +
    (unreadable
      ? `could not even be READ here, so it certainly was not invoked. `
      : `was not invoked. `) +
    `That is deliberate — the inner node is SHARED by every instance of this subgraph, so ` +
    `running its callback for an edit made on one instance would apply that instance's change ` +
    `to all of them. But if that callback does more than store a value — toggling another ` +
    `node's mode, bypassing a branch, refreshing dependent widgets — none of it ran, and the ` +
    `nodes it drives are still in their PREVIOUS state. Check them before treating this write ` +
    `as complete: panel_enter_subgraph to inspect the inner nodes, and panel_set_node_mode to ` +
    `set a node ACTIVE/BYPASS/MUTE explicitly.`
  );
}

/**
 * #698 — explain a write that reverted, when the widget structurally cannot hold
 * a value.
 *
 * Custom packs register DOM widgets that are pure VIEWS: ComfyUI's `addDOMWidget`
 * gives them an `element`, and the pack supplies `getValue`/`setValue` that read
 * and write the node's own state instead of the widget's `.value`. Pixaroma's
 * `PixaromaPrompt` is the reported case — `pix_prompt_ui` returns null from
 * `getValue`, `setValue` is a no-op, and the prompt actually lives in
 * `node.properties.promptState.text`.
 *
 * Assigning `.value` on one of those appears to work and then reverts, so the
 * caller was told the widget "did not retain the requested value" — indistinguishable
 * from a transient failure, and the reporter reasonably retried before working
 * around it. This makes the structural case say so.
 *
 * DELIBERATELY DIAGNOSIS-ONLY. It is called from the failure branch, after the
 * revert has been observed, and never decides whether a write may proceed. A
 * pre-emptive version would have to guess "this widget cannot hold a value" from
 * `serialize === false` — and #715 established that `serialize:false` is normal
 * for perfectly healthy widgets (LoadImage's `upload` button is one), so gating on
 * it would manufacture exactly the kind of false refusal this file exists to avoid.
 */
export function describeNonValueBearingWidget(w, node) {
  if (!w || typeof w !== "object") return "";
  const hasElement = !!w.element;
  const opts = w.options && typeof w.options === "object" ? w.options : null;
  const hasAccessors = !!(opts && (typeof opts.getValue === "function" || typeof opts.setValue === "function"));
  if (!hasElement && !hasAccessors) return "";
  const where = hasAccessors
    ? "its owning node's own state (commonly `node.properties`), reached through the widget's getValue/setValue"
    : "its owning node's own state (commonly `node.properties`)";
  return (
    ` This looks like a DOM-backed display widget rather than a value widget` +
    `${hasElement ? " (it owns a DOM element" : " (it defines getValue/setValue"}` +
    `${hasElement && hasAccessors ? " and defines getValue/setValue" : ""}), so its` +
    ` real value is held in ${where} — assigning the widget does not reach it.` +
    ` Retrying will not help.` +
    describeNodeStateProperties(node) +
    ` Otherwise drive the node another way (an equivalent serialized input, or a node` +
    ` whose value is a plain widget), or ask the pack's author to expose a settable value.`
  );
}


/** Cap the enumeration so a property-heavy node cannot turn one refusal into a wall
 *  of text. The count is exact, so a truncated list still says how much it hid. */
const MAX_STATE_KEYS = 12;

/**
 * #698 — name the properties this node actually carries, so the refusal above is a
 * ROUTE rather than a dead end. The reporter was told the value did not stick and had
 * nothing to try; PixaromaPrompt keeps its prompt in `properties.promptState.text`,
 * which is reachable with panel_set_property.
 *
 * NAMES ONLY, NO PAIRING. Which property backs a given DOM widget is not something
 * this can determine, and a heuristic guess (name similarity, "looks texty") would
 * eventually point an agent at an unrelated property and have it overwrite real node
 * state — a destructive wrong answer in place of an honest dead end. So it lists what
 * exists and says to verify after writing.
 */
function describeNodeStateProperties(node) {
  const props = node?.properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return "";
  const keys = Object.keys(props);
  if (!keys.length) return "";
  const shown = keys.slice(0, MAX_STATE_KEYS).map((k) => `"${k}"`).join(", ");
  const more = keys.length > MAX_STATE_KEYS ? ` … and ${keys.length - MAX_STATE_KEYS} more` : "";
  return (
    ` This node carries ${keys.length} propert${keys.length === 1 ? "y" : "ies"}` +
    ` (${shown}${more}) — for this kind of widget the live value is commonly one of them.` +
    ` Read them with panel_query_graph and write with panel_set_property. WHICH property` +
    ` backs this widget cannot be determined from here, so verify against the canvas` +
    ` (panel_screenshot) after writing instead of assuming.`
  );
}
