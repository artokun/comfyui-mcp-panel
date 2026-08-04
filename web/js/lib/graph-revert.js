// Pure snapshot selection for the per-turn graph revert (#44 rollback, bug #327).
//
// The panel keeps a bounded ring of pre-turn graph snapshots (oldest → newest).
// The naive "revert" restored graphSnapshots[last] unconditionally. But after an
// agent turn REPLACES or CLEARS the graph, the user's next message captures a
// fresh pre-turn snapshot of the ALREADY-changed graph, so the newest snapshot
// equals the current canvas — reverting to it is a silent no-op that can't
// recover the prior workflow (#327).
//
// pickRevertSnapshot walks newest → oldest and returns the first snapshot whose
// serialized graph actually DIFFERS from the current state, so /revert lands on
// the nearest genuinely-different pre-turn graph. Returns null when every
// snapshot equals the current graph (nothing to revert to) — the caller surfaces
// that honestly instead of pretending a no-op succeeded.
//
// Dependency-free (no LiteGraph, no DOM). Comparison is by a STABLE canonical
// form (object keys sorted recursively; array order preserved, since node/link
// order is semantically meaningful) so two structurally-equal graphs that merely
// serialized their object keys in a different insertion order still compare
// equal — otherwise a logically-identical latest snapshot could slip through the
// difference test and reintroduce the no-op revert this fix removes. A
// pre-stringified snapshot.data is re-parsed so it canonicalizes the same way.
// Unit-testable with plain object fixtures.

/** Recursively key-sorted JSON so equality is independent of key insertion order. */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/** Stable string form of a serialized graph (or a pre-stringified snapshot). */
function canonicalize(data) {
  if (data == null) return "";
  try {
    // Re-parse a pre-stringified snapshot so it goes through the same key-sort.
    const obj = typeof data === "string" ? JSON.parse(data) : data;
    return stableStringify(obj);
  } catch {
    // Unparseable / circular — treat as its own unique value so it never
    // spuriously matches the current graph and blocks a legitimate revert.
    return null;
  }
}

/**
 * @param {Array<{data:unknown}>} snapshots  pre-turn ring, oldest → newest
 * @param {unknown} currentSerialized  the LIVE graph's serialize() output (object or string)
 * @returns the most recent snapshot that differs from the current graph, or null
 */
export function pickRevertSnapshot(snapshots, currentSerialized) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) return null;
  const current = canonicalize(currentSerialized);
  for (let i = snapshots.length - 1; i >= 0; i -= 1) {
    const snap = snapshots[i];
    if (!snap) continue;
    const snapForm = canonicalize(snap.data);
    // A snapshot that can't be compared (null) is always eligible; otherwise
    // require a genuine difference from the current graph.
    if (snapForm === null || current === null || snapForm !== current) return snap;
  }
  return null;
}

// ---- revert OUTCOMES (#604 follow-up) --------------------------------------
//
// The restore path used to answer with `snapshot | null`, and every consumer
// (/revert, double-Esc rewind, the per-message rollback modal) rendered `null`
// as "nothing to revert / no snapshot for this message". That collapsed FOUR
// different answers into the one that ends the user's attempt:
//
//   • there genuinely is no eligible snapshot            ("none" — truthful)
//   • a snapshot EXISTS but the panel REFUSED to load it ("refused")
//   • the load was attempted and did not complete        ("failed")
//
// The refusal case is the damaging one, and it fires at exactly the worst
// moment: `getGraphCtx()` now refuses `[canvas-root-divergence]` when a backend
// restart leaves the canvas on a graph the panel cannot identify — which is
// precisely when someone reaches for /revert. Telling them "no graph snapshot
// captured in this session yet" is false, drops the save/export/reload remedy
// the refusal was carrying, and ends the recovery attempt. The refusal is
// right; converting it to `null` is what is wrong.
//
// "failed" is separate on purpose: a load that threw MAY have partially applied,
// so it must be DISCLOSED, never reported as "nothing happened" (which would
// invite a retry on top of a half-changed canvas).

export const REVERT_STATUS = Object.freeze({
  RESTORED: "restored",
  NONE: "none",
  REFUSED: "refused",
  FAILED: "failed",
});

/** What `none` says when the caller supplies nothing usable. A caller may WORD
 *  this variant, never SUPPRESS it: `none` means the canvas was not restored, and
 *  an entry point that renders it as an empty string words it away by omission —
 *  a variant that renders as nothing is indistinguishable from one that never
 *  fired. That is exactly how the rewind path went on reporting "Rewound your last
 *  turn" over an evicted ring, without ever saying the canvas still held that
 *  turn's edits — which is an unknown canvas read as permission to resend. */
const DEFAULT_NONE_TEXT =
  "The canvas was NOT restored — there is no graph snapshot available for this, so it still " +
  "holds the edits you were trying to undo.";

/** Does this string SAY anything? At least one letter or digit that a renderer
 *  is actually obliged to draw.
 *
 *  An ALLOWLIST plus one principled subtraction, after four escalations of the
 *  opposite approach: trim() missed the zero-width space; a hand-listed range set
 *  missed the bidi isolates; excluding Cf/Cc/Default_Ignorable missed U+2800
 *  BRAILLE PATTERN BLANK (a Symbol that draws nothing); and a bare letter/digit
 *  allowlist still admits U+3164 HANGUL FILLER, which is category Lo and also
 *  draws nothing. There is no Unicode property for "draws ink", so:
 *    - name what carries MEANING (\p{L} across every script, \p{N}) rather than
 *      chasing an open-ended list of invisibles, and
 *    - subtract Default_Ignorable_Code_Point, the property that exists precisely
 *      to say "a renderer may show nothing here" — which is what the Hangul
 *      fillers are.
 *  Punctuation- and symbol-only text falls back to the default too: an arrow or
 *  an emoji is not a statement that the canvas was not restored. */
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
const SAYS_SOMETHING = /[\p{L}\p{N}]/u;

/** Does this value put a readable statement on screen? */
function hasReadableText(value) {
  return typeof value === "string" && SAYS_SOMETHING.test(value.replace(IGNORABLE, ""));
}

/**
 * The system line for a revert-family outcome. `restoredText` / `noneText` are
 * the caller's own wording (each entry point says something different); the
 * REFUSED and FAILED lines are shared and ALWAYS carry the panel's own reason,
 * because that reason is the recovery instruction.
 *
 * `noneText` is the caller's WORDING, not an opt-out: a missing or blank one falls
 * back to DEFAULT_NONE_TEXT rather than rendering nothing. `restoredText` may be
 * blank — a caller whose own summary already states the restore has nothing to add,
 * and an unstated SUCCESS misleads no one.
 *
 * An UNRECOGNIZED or absent outcome is its own answer, NOT `noneText`. Rendering
 * it as "no snapshot" would be the same defect this vocabulary exists to remove:
 * turning "could not determine" into a definite verdict. It can only arise from a
 * producer that broke the contract, and the truthful thing to say then is that the
 * panel does not know what happened.
 *
 * REFUSED deliberately says "no graph edits were applied" — the narrowest true
 * statement — rather than "nothing was changed". Reaching a refusal is not
 * side-effect free: `getGraphCtx()` may legitimately have reconciled the VIEW (the
 * proven-content-free stranded-canvas repaint), and the binding assert resolves the
 * active workflow's identity, which for an unsaved tab can mint and embed one
 * (pre-existing #570 behaviour on every graph command). Neither touches the user's
 * GRAPH, so retrying is safe and that is what the message promises; a blanket
 * "nothing changed" would be claiming more than the path delivers.
 */
export function describeRevertOutcome(outcome, { restoredText, noneText, action = "revert" } = {}) {
  const status = outcome?.status;
  const statedNone = hasReadableText(noneText) ? noneText : DEFAULT_NONE_TEXT;
  if (status === REVERT_STATUS.RESTORED) return restoredText;
  if (status === REVERT_STATUS.NONE) return statedNone;
  const reason = typeof outcome?.reason === "string" ? outcome.reason.trim() : "";
  if (status === REVERT_STATUS.REFUSED) {
    // Says nothing about a snapshot EXISTING. A refusal can happen before one is
    // ever selected — the no-active-workflow branches refuse without consulting the
    // ring at all — so "the snapshot is still here" would fabricate its existence
    // for exactly the caller least able to check. What is true of every refusal is
    // that nothing was loaded; the specifics ride in `reason`.
    return (
      `⚠️ Could not ${action} — nothing was loaded, so no graph edits were applied and retrying ` +
      `is safe. ${reason || "No reason was reported."}`
    );
  }
  if (status === REVERT_STATUS.FAILED) {
    // "RAN but could not be confirmed", never "did not finish". FAILED covers three
    // shapes and only one of them stopped early: a rejected load (may be partly
    // applied), a load still running past its deadline, and a load that RESOLVED but
    // failed the post-load proof. Asserting it did not finish contradicts that last
    // one's own reason ("The load reported success, but…") — a fabricated detail
    // inside a disclosure, which is the thing this vocabulary exists to remove.
    // What holds for all three: it ran, the result is unconfirmed, the canvas may
    // have changed.
    return (
      `⚠️ The ${action} RAN but the panel could not confirm the result, so the canvas may have ` +
      `changed — check it before doing anything else. ${reason || "No reason was reported."}`
    );
  }
  return (
    `⚠️ Could not tell whether the ${action} happened — the panel got back an outcome it does ` +
    `not recognize, so check the canvas before doing anything else.`
  );
}

/** Did this outcome actually put the snapshot back on the canvas? The ONLY
 *  condition a caller may treat as success — an outcome object is always truthy,
 *  so a bare `if (outcome)` would read every refusal as a restore. */
export function revertDidRestore(outcome) {
  return outcome?.status === REVERT_STATUS.RESTORED;
}
